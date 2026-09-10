import { BadRequestException, Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  KycaidClient,
  REPORT_PAGE_SIZE,
  kycaidConfigured,
  toVerificationRow,
} from './kycaid.client';

/**
 * Verifications from the KYC provider, and the client standing derived from
 * them.
 *
 * TWO WAYS IN, AND A CORRECTION.
 *
 * This was built as a file import on the finding that KYCAID "will not
 * enumerate" — `GET /applicants/{id}` answers in 237ms with the whole
 * applicant, while `/applicants`, `/verifications` and
 * `/applicants/{id}/verifications` all return `404 not_found` and `/forms/{id}`
 * returns country-name translations. That finding was drawn from evidence and
 * was still wrong. The enumeration is `GET /verifications/report?date=…`, one
 * day at a time, and it returns very nearly the columns the console export
 * produces. Four 404s never proved absence; they proved four wrong paths.
 *
 * So there are two ways in and both are kept. `syncFromProvider` reads the
 * provider directly and is what keeps this current. `importVerifications` takes
 * a console export parsed in the browser — it needs no credential, it is how
 * history from before this was wired up gets loaded, and it still works on a
 * day the provider does not. They write the same rows, keyed the same way, so
 * running both is safe: the second one updates what the first created.
 *
 * THE JOIN. `external_applicant_id` is the CRM's own account reference —
 * `CU65081`, `CU447` — the same identifier carried by every payment in the
 * ledger. That is the whole reason this integration is worth having: it is the
 * first thing that connects a person to their money.
 */

/**
 * How many statements travel together.
 *
 * Small enough that one transaction is an ordinary request and the row locks it
 * takes are held for a moment; large enough that a thirty-thousand-row export
 * is a few hundred round trips rather than sixty thousand.
 *
 * Lowered from 500 defensively. A serverless instance holds ONE pooled
 * connection to a database that is itself behind a pooler, and a transaction of
 * five hundred statements is a large thing to ask of that even though it runs
 * comfortably against a local Postgres. This is the number that is cheap to be
 * wrong about in the safe direction.
 */
const WRITE_CHUNK = 200;

/**
 * The most rows one request may carry.
 *
 * Comfortably above what the import screen sends (a thousand) and far below
 * what a whole export is, so the two failures this endpoint has actually had —
 * a 9MB body refused at the edge, and a 3.6MB body that reached the handler
 * and timed out after 36,000 round trips — both become a sentence instead of a
 * silence.
 */
const MAX_ROWS_PER_REQUEST = 5000;

/** What the export calls a decided verification. Their words, not ours. */
const SETTLED_OK = ['valid', 'approved', 'completed', 'verified', 'success'];
const SETTLED_BAD = ['invalid', 'declined', 'rejected', 'failed'];
/**
 * A form issued and never filled in.
 *
 * `unused` is KYCAID's word for it, and without this it falls through to
 * PENDING — which reads as "somebody is looking at it" for a verification
 * nobody has started. The distinction is the difference between a queue and a
 * chase list.
 */
const NOT_STARTED_WORDS = ['unused', 'not started', 'not_started', 'new'];

/**
 * A row of the provider's export, once the columns have been read.
 *
 * Deliberately narrow. The export carries names, dates of birth, passport
 * numbers, tax ids, phone numbers and full addresses; none of that is needed to
 * know who is verified, and a KYC record should not travel further than the job
 * requires. The browser drops those columns before anything is sent, so they
 * never reach this process at all.
 */
export type VerificationRow = {
  verificationId: string;
  applicantId: string | null;
  externalApplicantId: string | null;
  status: string;
  /**
   * Passed or failed, where the provider's status word does not say.
   *
   * The API's report calls a finished verification `completed` whether it was
   * approved or declined — the same record the console export calls `INVALID`.
   * Read the word alone and every decline of the last year becomes an
   * approval. So the direct reader works the verdict out from whether a reason
   * to decline was recorded, and sets it here; the file import leaves it unset,
   * because its export says `VALID` or `INVALID` outright.
   */
  verdict?: 'PASS' | 'FAIL' | null;
  at: Date | null;
  form: string | null;
  method: string | null;
  declineReasons: string[];
  priceEur: number | null;
  processingMin: number | null;
};

export type ImportResult = {
  read: number;
  created: number;
  updated: number;
  /** Rows with no verification id — nothing to key on, so nothing stored. */
  unusable: number;
  /**
   * Verifications the provider settled against no account of ours.
   *
   * Counted and kept, never dropped. An application abandoned before it reached
   * an account still cost money and still carries a decline reason.
   */
  unlinked: number;
  clientsCreated: number;
  clientsUpdated: number;
  /** Every distinct status seen, with a count. The vocabulary to map. */
  statuses: { status: string; rows: number }[];
  /** Every distinct form seen. One entity's checks differ from the other's. */
  forms: { form: string; rows: number }[];
};

/**
 * How many pages one day may take before the sync moves on.
 *
 * Twenty thousand verifications in a single day is an order of magnitude beyond
 * anything these two forms have ever done, so hitting this means the paging is
 * not advancing — a provider that ignores `offset` would otherwise re-read page
 * one until the request is killed. The days that hit it are named in the reply
 * rather than passed over in silence.
 */
const MAX_PAGES_PER_DAY = 20;

export type SyncOptions = {
  /** First day to read, `YYYY-MM-DD`. Defaults to `to`. */
  from?: string;
  /** Last day to read, inclusive. Defaults to today, UTC. */
  to?: string;
  /** How long this call may spend before handing back a cursor. */
  budgetMs?: number;
  provider?: string;
  /** Injected by the checks, so they never touch the live provider. */
  client?: KycaidClient;
};

export type SyncResult = ImportResult & {
  from: string;
  to: string;
  /** Days actually read in this call — not the size of the range. */
  days: number;
  /** Rows the provider returned, before any were dropped or written. */
  fetched: number;
  /** The day to resume from, or null when the range is finished. */
  nextDate: string | null;
  done: boolean;
  /** Days that hit the page cap, and may therefore be incomplete. */
  truncated: string[];
};

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A day, or nothing.
 *
 * Strict on purpose. The provider takes `date` as a plain string and answers
 * cheerfully to a malformed one with an empty report — so a slip in the date
 * format arrives as "no verifications that day" rather than as an error, and a
 * sync that reads nothing looks exactly like a quiet month.
 */
export function readDay(value: string | undefined | null): string | null {
  const s = (value ?? '').trim();
  const m = DAY.exec(s);
  if (!m) return null;
  const [, y, mo, d] = m;
  const at = new Date(Date.UTC(+y, +mo - 1, +d));
  // Rejects 2026-02-31, which Date.UTC would roll forward into March.
  return at.toISOString().slice(0, 10) === s ? s : null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function nextDay(day: string): string {
  const at = new Date(day + 'T00:00:00Z');
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}

function emptyResult(): ImportResult {
  return {
    read: 0,
    created: 0,
    updated: 0,
    unusable: 0,
    unlinked: 0,
    clientsCreated: 0,
    clientsUpdated: 0,
    statuses: [],
    forms: [],
  };
}

function mergeInto(
  total: ImportResult,
  r: ImportResult,
  statuses: Map<string, number>,
  forms: Map<string, number>,
) {
  total.read += r.read;
  total.created += r.created;
  total.updated += r.updated;
  total.unusable += r.unusable;
  total.unlinked += r.unlinked;
  total.clientsCreated += r.clientsCreated;
  total.clientsUpdated += r.clientsUpdated;
  for (const s of r.statuses)
    statuses.set(s.status, (statuses.get(s.status) ?? 0) + s.rows);
  for (const f of r.forms) forms.set(f.form, (forms.get(f.form) ?? 0) + f.rows);
}

const KYC_STATUS = [
  'NOT_STARTED',
  'PENDING',
  'IN_REVIEW',
  'APPROVED',
  'REJECTED',
  'EDD_REQUIRED',
] as const;
export type KycStatusName = (typeof KYC_STATUS)[number];

/**
 * The provider's word, mapped onto ours.
 *
 * A default, not a decision. The same vendor says "VALID" in its export and
 * "completed" in its callback, so anything hard-coded here is wrong for half
 * its own output — which is why the import reports every distinct status it
 * saw, and a mapping typed on the screen overrides this.
 */
export function defaultStatus(word: string | null): KycStatusName {
  const w = (word ?? '').trim().toLowerCase();
  if (!w) return 'PENDING';
  if (NOT_STARTED_WORDS.includes(w)) return 'NOT_STARTED';
  if (SETTLED_OK.includes(w)) return 'APPROVED';
  if (SETTLED_BAD.includes(w)) return 'REJECTED';
  if (w.includes('review') || w.includes('manual')) return 'IN_REVIEW';
  return 'PENDING';
}

function isStatusName(v: string): v is KycStatusName {
  return (KYC_STATUS as readonly string[]).includes(v);
}

@Injectable()
export class KycService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Loads an export, keyed on the provider's verification id.
   *
   * Re-importing the same file updates rather than duplicates, which matters
   * because the honest way to keep this current is to export again and re-run
   * it — and a compliance table that doubles every month is worse than one that
   * is a week stale.
   */
  async importVerifications(
    rows: VerificationRow[],
    opts: { provider?: string; mapping?: Record<string, string> } = {},
  ): Promise<ImportResult> {
    if (!rows.length) {
      throw new BadRequestException(
        'That file had no verifications in it. Export again from the provider and upload the file it produced.',
      );
    }
    /**
     * A ceiling, said out loud rather than discovered as a timeout.
     *
     * The browser sends this in batches precisely so a request stays small,
     * but an older page — or anything calling the endpoint directly — will
     * post the whole file. That reaches the handler only to spend a minute
     * failing, and a serverless timeout arrives as a bare 500 with nothing to
     * act on. Refusing it immediately, by name, is the kinder failure.
     */
    if (rows.length > MAX_ROWS_PER_REQUEST) {
      throw new BadRequestException(
        `${rows.length.toLocaleString()} verifications in one request is too many — the limit is ${MAX_ROWS_PER_REQUEST.toLocaleString()}. ` +
          'The import screen sends a large export in batches; if you are seeing this, the page is older than the API. Reload the dashboard and try again.',
      );
    }
    const provider = opts.provider?.trim() || 'kycaid';

    // A mapping typed on screen wins over the default. Validated here rather
    // than trusted: a status name that is not one of ours would be written
    // straight into an enum column and fail at the database with a message
    // about a type, not about a mapping.
    const mapping = new Map<string, KycStatusName>();
    for (const [word, name] of Object.entries(opts.mapping ?? {})) {
      const clean = name.trim().toUpperCase();
      if (!isStatusName(clean)) {
        throw new BadRequestException(
          `"${name}" is not a status this dashboard has. Use one of: ${KYC_STATUS.join(', ')}.`,
        );
      }
      mapping.set(word.trim().toLowerCase(), clean);
    }
    /**
     * Three sources, in the order a person would want them believed.
     *
     * A mapping typed on the screen is somebody looking at the vocabulary and
     * saying what it means, so it wins. Failing that, a verdict the reader
     * worked out from the provider's own decline reasons beats the status word,
     * because `completed` describes a finished check and not a passed one.
     * Only with neither is the word read on its own.
     */
    const statusFor = (
      word: string | null,
      verdict?: 'PASS' | 'FAIL' | null,
    ) => {
      const typed = mapping.get((word ?? '').trim().toLowerCase());
      if (typed) return typed;
      if (verdict === 'FAIL') return 'REJECTED';
      if (verdict === 'PASS') return 'APPROVED';
      return defaultStatus(word);
    };

    const statuses = new Map<string, number>();
    const forms = new Map<string, number>();
    let created = 0;
    let updated = 0;
    let unusable = 0;
    let unlinked = 0;
    let clientsCreated = 0;
    let clientsUpdated = 0;

    // The clients this file mentions, resolved once rather than per row: an
    // applicant verified four times is four rows and one person.
    const references = [
      ...new Set(
        rows
          .map((r) => r.externalApplicantId?.trim())
          .filter((r): r is string => Boolean(r)),
      ),
    ];
    /**
     * Resolved in bulk, because a real export is not a handful of rows.
     *
     * The first version asked the database once per reference and then twice
     * more per verification. On the 30,111-row export that is sixty thousand
     * sequential round trips — several minutes against a serverless function
     * with a sixty-second ceiling, so it would never have finished no matter
     * how the file arrived.
     */
    const clientIds = new Map<string, string>();
    const known = await this.prisma.client.findMany({
      where: { externalId: { in: references } },
      select: { id: true, externalId: true },
    });
    for (const c of known) if (c.externalId) clientIds.set(c.externalId, c.id);

    const missing = references.filter((r) => !clientIds.has(r));
    if (missing.length) {
      // Created from the reference alone. The name is deliberately NOT taken
      // from the export: this row exists to hang verifications and payments off
      // a single account id, and a KYC file is not the place a dashboard should
      // be learning people's names from.
      //
      // skipDuplicates because two imports can run at once and losing the whole
      // batch to one racing insert would be a poor trade.
      const made = await this.prisma.client.createMany({
        data: missing.map((externalId) => ({
          externalId,
          fullName: externalId,
        })),
        skipDuplicates: true,
      });
      clientsCreated = made.count;
      const fresh = await this.prisma.client.findMany({
        where: { externalId: { in: missing } },
        select: { id: true, externalId: true },
      });
      for (const c of fresh)
        if (c.externalId) clientIds.set(c.externalId, c.id);
    }

    // Which verifications we already hold, asked once for the whole batch
    // rather than once per row.
    const ids = rows
      .map((r) => r.verificationId?.trim())
      .filter((v): v is string => Boolean(v));
    const seen = new Set(
      (
        await this.prisma.kycCase.findMany({
          where: { provider, verificationId: { in: ids } },
          select: { verificationId: true },
        })
      )
        .map((c) => c.verificationId)
        .filter((v): v is string => Boolean(v)),
    );

    const writes: Prisma.PrismaPromise<unknown>[] = [];

    for (const row of rows) {
      const word = row.status?.trim() ?? '';
      statuses.set(
        word || '(blank)',
        (statuses.get(word || '(blank)') ?? 0) + 1,
      );
      if (row.form) forms.set(row.form, (forms.get(row.form) ?? 0) + 1);

      if (!row.verificationId?.trim()) {
        unusable++;
        continue;
      }
      const externalId = row.externalApplicantId?.trim();
      const clientId = externalId ? (clientIds.get(externalId) ?? null) : null;
      if (!clientId) unlinked++;

      const data = {
        provider,
        clientId,
        applicantId: row.applicantId?.trim() || null,
        providerStatus: word || null,
        status: statusFor(word, row.verdict),
        form: row.form?.trim() || null,
        method: row.method?.trim() || null,
        declineReasons: row.declineReasons.filter(Boolean),
        priceEur: row.priceEur,
        processingMin: row.processingMin,
        submittedAt: row.at ?? new Date(),
        reviewedAt: row.at,
      };

      const verificationId = row.verificationId.trim();
      // One upsert per row, but queued rather than awaited — the whole batch
      // then travels as a single round trip. Upsert rather than a create/update
      // decision made here, so two imports racing on the same verification end
      // with one row instead of a unique-constraint failure.
      writes.push(
        this.prisma.kycCase.upsert({
          where: { provider_verificationId: { provider, verificationId } },
          create: { ...data, verificationId },
          update: data,
        }),
      );
      if (seen.has(verificationId)) updated++;
      else created++;
    }

    // Sent in chunks. One transaction of thirty thousand statements is a
    // request big enough to be refused and a lock held long enough to matter;
    // a few hundred at a time is neither.
    for (let i = 0; i < writes.length; i += WRITE_CHUNK) {
      await this.prisma.$transaction(writes.slice(i, i + WRITE_CHUNK));
    }

    clientsUpdated = await this.refreshClientStatus([...clientIds.values()]);

    return {
      read: rows.length,
      created,
      updated,
      unusable,
      unlinked,
      clientsCreated,
      clientsUpdated,
      statuses: [...statuses.entries()]
        .map(([status, rows]) => ({ status, rows }))
        .sort((a, b) => b.rows - a.rows),
      forms: [...forms.entries()]
        .map(([form, rows]) => ({ form, rows }))
        .sort((a, b) => b.rows - a.rows),
    };
  }

  /**
   * The provider, read directly, one day at a time.
   *
   * WHY DAYS. `GET /verifications/report` requires a `date` and returns that
   * date. There is no range to ask for, so a year is three hundred and
   * sixty-five requests and the only question is who counts them.
   *
   * WHY A CURSOR RATHER THAN A LOOP THAT FINISHES. This runs in a function with
   * a sixty-second ceiling. A sync that tries to read a year in one request
   * gets killed at fifty-nine seconds and reports nothing — not even the eleven
   * months it had already written. So it spends a budget, stops on a day
   * boundary, and hands back the day it did not reach. The caller asks again
   * with that date and the whole range gets read across as many requests as it
   * takes, with every one of them landing its own rows permanently.
   *
   * Re-reading a day is free of consequence: the verification id is the key, so
   * a day read twice updates rather than duplicates. That is what makes it safe
   * to resume from a date that was already half-done.
   */
  async syncFromProvider(opts: SyncOptions = {}): Promise<SyncResult> {
    if (!kycaidConfigured()) {
      throw new BadRequestException(
        'No KYCAID token is configured, so there is nothing to read from. Set KYCAID_API_TOKEN on the API and redeploy — the file import needs no credential and still works meanwhile.',
      );
    }

    const to = readDay(opts.to) ?? today();
    const from = readDay(opts.from) ?? to;
    if (from > to) {
      throw new BadRequestException(
        `The range runs backwards: ${from} is after ${to}.`,
      );
    }

    /**
     * Bounded at both ends.
     *
     * The ceiling is the platform's: a serverless function is killed at sixty
     * seconds, and a reply that never arrives loses the report of work that
     * was actually done. The floor is only there so a zero cannot turn the
     * budget off; one day always runs whatever this says, so the walk always
     * advances and a sync can never sit still.
     */
    const budgetMs = Math.min(
      Math.max(
        opts.budgetMs ?? Number(process.env.KYCAID_SYNC_BUDGET_MS ?? 20_000),
        100,
      ),
      45_000,
    );
    const started = Date.now();

    const client = opts.client ?? new KycaidClient();
    // Once per sync, not once per day. Only worth the round trip if there is
    // more than a page of work ahead of it, but it is one call either way.
    const formNames = await client.forms();

    const total = emptyResult();
    const statuses = new Map<string, number>();
    const forms = new Map<string, number>();
    const truncated: string[] = [];
    let fetched = 0;
    let days = 0;
    let nextDate: string | null = null;

    for (let day = from; day <= to; day = nextDay(day)) {
      // Checked BEFORE a day rather than after, so the budget is a promise
      // about when this returns and not a description of when it noticed.
      if (days > 0 && Date.now() - started > budgetMs) {
        nextDate = day;
        break;
      }

      let offset = 0;
      for (let page = 0; page < MAX_PAGES_PER_DAY; page++) {
        const raw = await client.report(day, offset, REPORT_PAGE_SIZE);
        fetched += raw.length;
        const rows = raw
          .map((r) => toVerificationRow(r, formNames))
          .filter((r): r is VerificationRow => r !== null);

        if (rows.length) {
          const r = await this.importVerifications(rows, {
            provider: opts.provider,
          });
          mergeInto(total, r, statuses, forms);
        }

        if (raw.length < REPORT_PAGE_SIZE) break;
        offset += REPORT_PAGE_SIZE;
        if (page === MAX_PAGES_PER_DAY - 1) truncated.push(day);
      }
      days++;
    }

    total.statuses = [...statuses.entries()]
      .map(([status, rows]) => ({ status, rows }))
      .sort((a, b) => b.rows - a.rows);
    total.forms = [...forms.entries()]
      .map(([form, rows]) => ({ form, rows }))
      .sort((a, b) => b.rows - a.rows);

    return {
      ...total,
      from,
      to,
      days,
      fetched,
      nextDate,
      done: nextDate === null,
      truncated,
    };
  }

  /**
   * What the direct reader can do here, and what is already loaded.
   *
   * The two dates are what makes "fetch everything" a real button rather than a
   * guess: `newest` is where an update should start, and its absence is how the
   * screen knows this database has never been filled and should be offering a
   * range instead.
   */
  async providerStatus() {
    const [oldest, newest, verifications] = await Promise.all([
      this.prisma.kycCase.findFirst({
        orderBy: { submittedAt: 'asc' },
        select: { submittedAt: true },
      }),
      this.prisma.kycCase.findFirst({
        orderBy: { submittedAt: 'desc' },
        select: { submittedAt: true },
      }),
      this.prisma.kycCase.count(),
    ]);
    return {
      provider: 'kycaid',
      configured: kycaidConfigured(),
      /** Named so the screen can say which variable is missing. */
      variable: 'KYCAID_API_TOKEN',
      verifications,
      oldest: oldest?.submittedAt ?? null,
      newest: newest?.submittedAt ?? null,
      today: today(),
    };
  }

  /**
   * A client's standing, recomputed from their verifications.
   *
   * THE LATEST, not the best. A client who passed in March and was declined in
   * September is declined — taking the most favourable attempt would let a
   * revoked verification stand for ever, which is the failure mode a compliance
   * table exists to prevent.
   */
  async refreshClientStatus(clientIds: string[]): Promise<number> {
    if (!clientIds.length) return 0;
    let touched = 0;
    // Set-based, in chunks. Per client this was two queries — twenty thousand
    // round trips for the real export, on top of the sixty thousand the import
    // itself was making. DISTINCT ON is Postgres saying "the latest row per
    // group" in one statement, which is exactly the question.
    for (let i = 0; i < clientIds.length; i += WRITE_CHUNK) {
      const slice = clientIds.slice(i, i + WRITE_CHUNK);
      touched += await this.prisma.$executeRaw`
        UPDATE "Client" c
        SET "kycStatus" = s.status
        FROM (
          SELECT DISTINCT ON ("clientId") "clientId", status
          FROM "KycCase"
          WHERE "clientId" IN (${Prisma.join(slice)})
          ORDER BY "clientId", "submittedAt" DESC
        ) s
        WHERE c.id = s."clientId" AND c."kycStatus" IS DISTINCT FROM s.status`;
    }
    return touched;
  }

  /**
   * How much of the trading book is actually verified.
   *
   * The question a KYC table exists to answer and the one that needed the join:
   * every payment carries a `CU…` reference, so the clients who have moved money
   * and the clients who have been verified can finally be compared. A client
   * trading without a verification is the finding; the rest is bookkeeping.
   */
  async coverage() {
    const [verified, payers] = await Promise.all([
      this.prisma.client.findMany({
        where: { externalId: { not: null } },
        select: { externalId: true, kycStatus: true },
      }),
      // Distinct customers seen in the payment ledger, in their own words.
      this.prisma.paymentEvent.groupBy({
        by: ['customer'],
        where: { customer: { not: null } },
        _count: { _all: true },
      }),
    ]);

    const byRef = new Map(
      verified.map((c) => [c.externalId as string, c.kycStatus]),
    );
    const traded = payers
      .map((p) => p.customer)
      .filter((c): c is string => Boolean(c));

    const missing: string[] = [];
    const counts = new Map<string, number>();
    for (const ref of traded) {
      const status = byRef.get(ref);
      if (!status) {
        missing.push(ref);
        continue;
      }
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }

    return {
      tradingClients: traded.length,
      verifiedClients: byRef.size,
      /** Clients who have moved money and have no verification on record. */
      tradingWithoutKyc: missing.length,
      examples: missing.slice(0, 25),
      byStatus: [...counts.entries()]
        .map(([status, clients]) => ({ status, clients }))
        .sort((a, b) => b.clients - a.clients),
    };
  }

  /** Verifications, newest first, for the compliance screen. */
  async cases(limit = 200) {
    const rows = await this.prisma.kycCase.findMany({
      orderBy: { submittedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 1000),
      include: { client: { select: { externalId: true, country: true } } },
    });
    return rows.map((c) => ({
      id: c.id,
      verificationId: c.verificationId,
      applicantId: c.applicantId,
      reference: c.client?.externalId ?? null,
      country: c.client?.country ?? null,
      status: c.status,
      providerStatus: c.providerStatus,
      form: c.form,
      method: c.method,
      declineReasons: c.declineReasons,
      priceEur: c.priceEur === null ? null : Number(c.priceEur),
      processingMin: c.processingMin,
      submittedAt: c.submittedAt.toISOString(),
    }));
  }

  /**
   * What the file said, summarised — attempts, cost, and why they failed.
   *
   * Re-verification is the expensive part and nothing was counting it. One
   * client in the sample export was verified four times in an afternoon and
   * billed for all four, and the reasons are in the data: wrong name, expired
   * document, document not visible. Those are fixable at the form, not at the
   * desk.
   */
  async summary() {
    const [total, byStatus, byReason, cost, repeats] = await Promise.all([
      this.prisma.kycCase.count(),
      this.prisma.kycCase.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.kycCase.findMany({
        where: { NOT: { declineReasons: { isEmpty: true } } },
        select: { declineReasons: true },
      }),
      this.prisma.kycCase.aggregate({
        _sum: { priceEur: true },
        _avg: { processingMin: true },
      }),
      this.prisma.kycCase.groupBy({
        by: ['clientId'],
        where: { clientId: { not: null } },
        _count: { _all: true },
      }),
    ]);

    const reasons = new Map<string, number>();
    for (const r of byReason)
      for (const reason of r.declineReasons)
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);

    const retried = repeats.filter((r) => r._count._all > 1);
    return {
      verifications: total,
      byStatus: byStatus.map((s) => ({
        status: s.status,
        count: s._count._all,
      })),
      declineReasons: [...reasons.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
      spentEur: cost._sum.priceEur === null ? 0 : Number(cost._sum.priceEur),
      averageMinutes:
        cost._avg.processingMin === null
          ? null
          : Math.round(cost._avg.processingMin * 10) / 10,
      /** Clients who needed more than one attempt, and the worst case. */
      clientsRetried: retried.length,
      mostAttempts: retried.reduce((m, r) => Math.max(m, r._count._all), 0),
    };
  }
}
