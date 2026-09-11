import { BadRequestException, Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  KycaidClient,
  REPORT_PAGE_SIZE,
  kycaidAccounts,
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
 * So there is ONE way in: `syncFromProvider` reads the provider directly, and
 * nothing else writes this table. The file import that was built on the wrong
 * finding is gone, endpoint and screen both — a second way in that nobody
 * should use is a second way to be wrong about where the numbers came from.
 * `importVerifications` survives it as the shared write path underneath, which
 * is why it is still named for a file it no longer reads.
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
  /**
   * KYC, KYB or SERVICE, where the provider says.
   *
   * SERVICE is the one that matters: a paid lookup rather than a person being
   * verified. It has a price and no applicant, so unlabelled it reads as a
   * verification that failed to link to an account.
   */
  service?: string | null;
  /** TEST or LIVE. The direct reader drops TEST before it gets this far. */
  mode?: string | null;
  /** Residence country, two letters. The jurisdiction, not the person. */
  country?: string | null;
  /**
   * Which KYCAID account it came from — "MU", "SL".
   *
   * Set by the direct reader from the credential that fetched the row, so it
   * cannot be wrong about which entity paid for it. The file import leaves it
   * unset: a console export does not say which account produced it.
   */
  account?: string | null;
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

/**
 * The period and the entity a screen is asking about.
 *
 * The cards used to be totals over everything held while the table beneath them
 * answered to a date range, so the two disagreed by a year and neither said so.
 * Every figure a screen shows now comes through this.
 */
export type KycWindow = {
  /** `YYYY-MM-DD`, inclusive. */
  from?: string;
  /** `YYYY-MM-DD`, inclusive — the whole of that day, not midnight. */
  to?: string;
  /** A KYCAID account label: `MU`, `SL`. Blank means both. */
  account?: string;
};

/**
 * The window as a Prisma filter.
 *
 * `to` is read as "up to the end of that day" and applied as `< to + 1 day`.
 * Written as `lte: to` it would cover exactly the midnight instant and drop the
 * rest — the same off-by-one that once cost a month of payment reconciliation.
 */
function windowWhere(w: KycWindow = {}): Prisma.KycCaseWhereInput {
  const where: Prisma.KycCaseWhereInput = {};
  const account = (w.account ?? '').trim().toUpperCase();
  if (account) where.account = account;

  const from = (w.from ?? '').trim();
  const to = (w.to ?? '').trim();
  if (from || to) {
    const end = to ? new Date(to + 'T00:00:00.000Z') : null;
    if (end) end.setUTCDate(end.getUTCDate() + 1);
    where.submittedAt = {
      ...(from ? { gte: new Date(from + 'T00:00:00.000Z') } : {}),
      ...(end ? { lt: end } : {}),
    };
  }
  return where;
}

export type SyncOptions = {
  /** First day to read, `YYYY-MM-DD`. Defaults to `to`. */
  from?: string;
  /** Last day to read, inclusive. Defaults to today, UTC. */
  to?: string;
  /** How long this call may spend before handing back a cursor. */
  budgetMs?: number;
  provider?: string;
  /**
   * The accounts to read, injected by the checks so they never touch a live
   * one. Left unset, they are discovered from the environment — one per
   * `KYCAID_API_TOKEN…` variable.
   */
  clients?: { label: string; client: KycaidClient }[];
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
  /** Rows the provider returned in TEST mode, dropped rather than counted. */
  testSkipped: number;
  /** What each entity's account returned. A zero here is the finding. */
  accounts: { account: string; rows: number }[];
  /**
   * Accounts whose form names could not be read, and why.
   *
   * The Form column showing "12666" where the console says "DEFAULT KYC Tradin
   * MAU" is this, and it used to be entirely silent — `forms()` swallowed the
   * failure and the ids looked like the best the provider offers.
   */
  formNamesUnavailable: { account: string; why: string }[];
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
        service: row.service?.trim().toUpperCase() || null,
        account: row.account?.trim().toUpperCase() || null,
        country: row.country?.trim().toUpperCase() || null,
        declineReasons: row.declineReasons.filter(Boolean),
        priceEur: row.priceEur,
        /**
         * ROUNDED, because the column is an integer and the sources are not.
         *
         * The API reports processing time in SECONDS, so 137 seconds is 2.28
         * minutes, and Prisma refuses a fraction for an Int column — the
         * backfill would have died on the first verification that did not take
         * a whole number of minutes. The file export has the same shape of
         * trap: a spreadsheet will happily write 4.5 into a minutes column.
         *
         * Rounded here rather than in either reader, so both paths are covered
         * by one rule.
         */
        processingMin:
          row.processingMin === null ? null : Math.round(row.processingMin),
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
        'No KYCAID token is configured, so there is nothing to read from. Set KYCAID_API_TOKEN on the API and redeploy — or one per entity, KYCAID_API_TOKENMU and KYCAID_API_TOKENSL. The file import needs no credential and still works meanwhile.',
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

    /**
     * Every account, not one.
     *
     * The two entities hold separate KYCAID accounts, and a token reads one of
     * them. Walking a single client would fetch one brand in full, report
     * "done", and leave the other invisible — which on screen is
     * indistinguishable from a brand that verifies fewer people.
     */
    const accounts =
      opts.clients ??
      kycaidAccounts().map((a) => ({
        label: a.label,
        client: new KycaidClient({ token: a.token }),
      }));

    // Once per sync per account, not once per day. Each account has its own
    // forms, so one shared map would name the other entity's forms wrongly.
    const formNames = new Map<string, Map<string, string>>();
    const formNamesUnavailable: { account: string; why: string }[] = [];
    for (const a of accounts) {
      formNames.set(a.label, await a.client.forms());
      const why = a.client.formsFailed;
      if (why) formNamesUnavailable.push({ account: a.label, why });
    }

    const total = emptyResult();
    const statuses = new Map<string, number>();
    const forms = new Map<string, number>();
    const truncated: string[] = [];
    const perAccount = new Map<string, number>();
    let testSkipped = 0;
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

      // The whole day for every account before moving on, so a budget that
      // runs out leaves both entities read up to the same date rather than one
      // of them a week ahead of the other.
      for (const account of accounts) {
        let offset = 0;
        for (let page = 0; page < MAX_PAGES_PER_DAY; page++) {
          const raw = await account.client.report(
            day,
            offset,
            REPORT_PAGE_SIZE,
          );
          fetched += raw.length;
          const mapped = raw
            .map((r) => toVerificationRow(r, formNames.get(account.label)))
            .filter((r): r is VerificationRow => r !== null)
            // Which entity paid for it, taken from the credential that fetched
            // it rather than inferred from the form. A form can be renamed; a
            // token can only ever see its own account.
            .map((r) => ({ ...r, account: account.label }));

          /**
           * TEST rows never reach the compliance table.
           *
           * KYCAID's own documentation says test mode "is no different from
           * the live mode except the priority", and the report returns both
           * mixed together. That is exactly what makes them dangerous: same
           * columns, same prices, same statuses, and nothing on the screen
           * would ever look wrong. Dropped here — and counted, because quietly
           * discarding rows is the other way to get this wrong.
           */
          const rows = mapped.filter((r) => r.mode !== 'TEST');
          testSkipped += mapped.length - rows.length;

          if (rows.length) {
            const r = await this.importVerifications(rows, {
              provider: opts.provider,
            });
            mergeInto(total, r, statuses, forms);
            perAccount.set(
              account.label,
              (perAccount.get(account.label) ?? 0) + rows.length,
            );
          }

          if (raw.length < REPORT_PAGE_SIZE) break;
          offset += REPORT_PAGE_SIZE;
          if (page === MAX_PAGES_PER_DAY - 1)
            truncated.push(
              `${day}${account.label ? ` (${account.label})` : ''}`,
            );
        }
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
      testSkipped,
      // Per entity, so "nothing came back for SL" is visible rather than
      // hidden inside a healthy-looking total.
      accounts: accounts.map((a) => ({
        account: a.label,
        rows: perAccount.get(a.label) ?? 0,
      })),
      formNamesUnavailable,
    };
  }

  /**
   * The nightly catch-up: everything since the newest verification held.
   *
   * FROM THE NEWEST DAY, not the day after it. A verification that arrived at
   * 23:50 while the previous run was reading that same day would otherwise
   * never be fetched at all — and re-reading one day costs one request and
   * changes nothing, because the verification id is the key.
   *
   * Self-healing across runs. If the budget stops it short of today, `newest`
   * has still moved forward, so the next run resumes from there rather than
   * from the beginning. A week of downtime catches up over a few nights
   * without anybody deciding anything.
   */
  async syncRecent(opts: { days?: number; budgetMs?: number } = {}) {
    if (!kycaidConfigured()) {
      // Not an error. A scheduler firing against a deployment with no token is
      // an unfinished setup, and a nightly red line in the log trains people to
      // ignore the log.
      return {
        skipped: 'KYCAID_API_TOKEN is not set',
        ranAt: new Date().toISOString(),
      };
    }
    const newest = await this.prisma.kycCase.findFirst({
      orderBy: { submittedAt: 'desc' },
      select: { submittedAt: true },
    });
    const to = today();
    let from = newest?.submittedAt.toISOString().slice(0, 10) ?? null;
    if (!from) {
      // Nothing held at all, so there is no "since". A short window rather than
      // a guess at how far back the account goes — the whole history is a
      // deliberate act on the Compliance screen, not something a cron should
      // start on its own at three in the morning.
      const back = new Date(to + 'T00:00:00Z');
      back.setUTCDate(back.getUTCDate() - (opts.days ?? 7));
      from = back.toISOString().slice(0, 10);
    }
    return this.syncFromProvider({ from, to, budgetMs: opts.budgetMs });
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
    const accounts = kycaidAccounts();
    /**
     * Held per account as well as in total.
     *
     * Two entities, two KYCAID accounts. A combined total looks healthy while
     * one of them is empty, so the only number that answers "is SL loaded" is
     * SL's own.
     */
    const held = await this.prisma.kycCase.groupBy({
      by: ['account'],
      _count: { _all: true },
    });
    const byAccount = new Map(
      held.map((h) => [h.account ?? '', h._count._all] as const),
    );

    return {
      provider: 'kycaid',
      configured: accounts.length > 0,
      /** Named so the screen can say which variable is missing. */
      variable: 'KYCAID_API_TOKEN',
      accounts: accounts.map((a) => ({
        account: a.label,
        variable: a.variable,
        verifications: byAccount.get(a.label) ?? 0,
      })),
      /**
       * Rows loaded before any of this existed, from a console export that
       * does not say which account produced it. Named rather than folded into
       * either entity — re-fetching those days from the provider fills it in.
       */
      unattributed: byAccount.get('') ?? 0,
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
  /**
   * The two brands, side by side.
   *
   * WHY THE FORM IS THE BRAND. Each entity runs its own KYCAID form — "DEFAULT
   * KYC Tradin MAU" and "DEFAULT KYC" — and they are not the same check: one
   * includes ADDRESS and the other does not. So the form column is the only
   * record that two clients were held to different standards, and a single
   * total across both averages away the difference.
   *
   * `null` is kept as a row of its own rather than folded into either. A
   * verification whose form did not come through is a gap in the import, and a
   * gap silently added to one brand's count is worse than a gap that says so.
   */
  async byForm(window: KycWindow = {}) {
    return this.breakdown('form', window);
  }

  /**
   * The same figures per KYCAID ACCOUNT — which is per entity.
   *
   * The account is the stronger record of the two. A form can be renamed and a
   * console export need not carry one, but a verification is fetched with the
   * credential of exactly one account and cannot be attributed to the other.
   */
  async byAccount(window: KycWindow = {}) {
    /**
     * Entities only, and never a row for the ones with no account.
     *
     * The screen puts one card per entity side by side, and a third card headed
     * "Unattributed" was sitting beside them holding every row loaded before the
     * account column existed. It answered no question anybody has — the rows are
     * in the table either way, and re-fetching those dates attributes them — and
     * it read as a third brand. The count is still reported by
     * `providerStatus()`, where it belongs: a note on what is loaded.
     */
    const rows = await this.breakdown('account', window);
    return rows.filter((r) => (r.form ?? '') !== '');
  }

  private async breakdown(key: 'form' | 'account', window: KycWindow = {}) {
    const scope = windowWhere(window);
    const [grouped, unlinked] = await Promise.all([
      this.prisma.kycCase.groupBy({
        by: [key, 'status'],
        where: scope,
        _count: { _all: true },
        _sum: { priceEur: true },
      }),
      this.prisma.kycCase.groupBy({
        by: [key],
        where: { ...scope, clientId: null },
        _count: { _all: true },
      }),
    ]);

    const forms = new Map<
      string,
      {
        /** The group's value — a form name, or an account label. */
        form: string | null;
        verifications: number;
        byStatus: Record<string, number>;
        spentEur: number;
        /** Settled against no account of ours — see ImportResult.unlinked. */
        unlinked: number;
      }
    >();
    // A sentinel that no form name can collide with, written as an ESCAPE.
    // A literal NUL in the source makes the whole file read as binary to
    // grep, which is how it hid the last time this trick was used.
    const keyOf = (form: string | null) => form ?? '\u0000none';

    for (const g of grouped) {
      const value = (g as Record<string, unknown>)[key] as string | null;
      const mapKey = keyOf(value);
      const row = forms.get(mapKey) ?? {
        form: value,
        verifications: 0,
        byStatus: {},
        spentEur: 0,
        unlinked: 0,
      };
      row.verifications += g._count._all;
      row.byStatus[g.status] = (row.byStatus[g.status] ?? 0) + g._count._all;
      row.spentEur += g._sum.priceEur === null ? 0 : Number(g._sum.priceEur);
      forms.set(mapKey, row);
    }
    for (const u of unlinked) {
      const row = forms.get(
        keyOf((u as Record<string, unknown>)[key] as string | null),
      );
      if (row) row.unlinked = u._count._all;
    }

    return [...forms.values()].sort(
      (a, b) => b.verifications - a.verifications,
    );
  }

  /**
   * The figures a screen shows, over the period and entity it is showing.
   *
   * Unfiltered by default, which is what the older callers pass.
   */
  async summary(window: KycWindow = {}) {
    const scope = windowWhere(window);
    const [total, byStatus, byReason, cost, repeats] = await Promise.all([
      this.prisma.kycCase.count({ where: scope }),
      this.prisma.kycCase.groupBy({
        by: ['status'],
        where: scope,
        _count: { _all: true },
      }),
      this.prisma.kycCase.findMany({
        where: { ...scope, NOT: { declineReasons: { isEmpty: true } } },
        select: { declineReasons: true },
      }),
      this.prisma.kycCase.aggregate({
        where: scope,
        _sum: { priceEur: true },
        _avg: { processingMin: true },
      }),
      this.prisma.kycCase.groupBy({
        by: ['clientId'],
        where: { ...scope, clientId: { not: null } },
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
      byForm: await this.byForm(window),
      byAccount: await this.byAccount(window),
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
