import { BadRequestException, Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { KycaidAccount } from './kycaid.client';
import {
  KycaidClient,
  REPORT_PAGE_SIZE,
  countryNames,
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
   * Which checks ran — Profile, Document, Liveness, Address, Database
   * Screening, Adverse Media. What an approval actually covered.
   */
  checks?: string[];
  /**
   * The provider's row, less the identity fields it is never given.
   *
   * Kept so the column somebody asks for next month does not cost a year of
   * re-fetching. Stripped in the reader, so nothing downstream can store a
   * name by accident.
   */
  raw?: Record<string, unknown> | null;
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
/**
 * Which column of ours each field of theirs ends up in.
 *
 * The answer to "what can we get from this API", written where it can be
 * checked against the data rather than against the documentation. Anything the
 * provider sends that is not in this map is available and unused.
 */
const STORED_AS: Record<string, string> = {
  verification_id: 'verificationId',
  applicant_id: 'applicantId',
  external_applicant_id: 'client (the CU reference, and the join to payments)',
  created_at: 'submittedAt',
  status: 'providerStatus, and the verdict derived from decline_reasons',
  form_id: 'form (resolved to its name via GET /forms)',
  method: 'method',
  service: 'service (KYC / KYB / SERVICE)',
  verification_types: 'checks',
  country_code: 'country',
  decline_reasons: 'declineReasons',
  price: 'priceEur',
  processing_time: 'processingMin',
  mode: 'dropped where TEST — never stored, and counted in the reply',
};

/**
 * What the provider sends and this integration will not keep.
 *
 * Not a technical limit: the report carries all of these and reading them
 * would be one line each. The dashboard's job is to know who is verified and
 * what it cost, not to be a second copy of everybody's identity documents held
 * to a lower standard than the system that is meant to hold them. Available
 * live, per row, from `GET /applicants/{id}` — see applicantDetail.
 */
const REFUSED_FIELDS = [
  // The report's own identity columns, named as the reference names them. This
  // list was written from the applicant object by mistake and claimed the
  // report sends `first_name`/`last_name`/`middle_name`; it sends one `name`,
  // so the screen reported refusing three fields that never arrive and did not
  // mention the one that does.
  'name',
  'dob',
  'tax_id_number',
  'email',
  'phone',
  'wallet_address',
  'telegram_username',
];

/**
 * Which KYCAID token can see this row.
 *
 * TWO ENTITIES, TWO ACCOUNTS, AND A TOKEN ONLY SEES ITS OWN. Asking Saint
 * Lucia's account about a Mauritius verification returns 404 — which on screen
 * reads as a deleted record rather than as the wrong credential, and sends
 * somebody to the provider's console to look for a row that is sitting there
 * perfectly intact. So the row's own account picks the token, and every failure
 * to find one says which variable is missing.
 *
 * The single-account fallback is for the deployment that has one unlabelled
 * `KYCAID_API_TOKEN`: there is no ambiguity to resolve, so an unattributed row
 * is read with the only token there is.
 */
function accountFor(label: string | null): KycaidAccount {
  const wanted = (label ?? '').trim().toUpperCase();
  const accounts = kycaidAccounts();
  const account =
    accounts.find((a) => a.label === wanted) ??
    (accounts.length === 1 ? accounts[0] : undefined);
  if (!account) {
    throw new BadRequestException(
      wanted
        ? `No token is configured for ${wanted}, so its verifications cannot be read. Set KYCAID_API_TOKEN${wanted} on the API.`
        : 'This verification does not record which KYCAID account it came from, and more than one is configured — fetch its date again to attribute it.',
    );
  }
  return account;
}

/**
 * The provider's per-check verdicts, in the shape the drawer shows them.
 *
 * `GET /verifications/{id}` answers with a `verifications` object keyed by the
 * check — `profile`, `document`, `facial`, `address`, `aml` — each carrying a
 * `verified` boolean and a `comment`. Read defensively: the set of keys is the
 * form's, not a fixed list, so this maps whatever arrives rather than asking
 * for the five it has seen.
 *
 * NOTHING PERSONAL PASSES THROUGH HERE. A comment is the provider's note on a
 * check ("document expired", "face does not match") and the rest of the reply
 * is ids and booleans, which is why this can load without anyone pressing
 * anything while the applicant lookup beside it cannot.
 */
export function readChecks(body: Record<string, unknown>) {
  const bag = body.verifications;
  if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return [];
  return Object.entries(bag as Record<string, unknown>).map(([type, v]) => {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    return {
      type,
      /**
       * Three states, not two. `undefined` is a check that has not finished,
       * and rendering it as a failure is how a pending verification becomes a
       * rejection on the screen.
       */
      verified: typeof o.verified === 'boolean' ? o.verified : null,
      comment: pick(o, 'comment', 'reason', 'message'),
    };
  });
}

/** A string field of a provider object, under any of its spellings. */
function pick(o: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
}

function objects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object',
  );
}

/**
 * The applicant, cut down to what a compliance desk asks about.
 *
 * NOT A PASSTHROUGH. The provider's object carries whatever the provider
 * decides it carries; returning it whole would put all of that into a browser
 * and into whatever records a response on the way. These fields are chosen.
 *
 * DOCUMENT NUMBERS ARE MASKED to their last four. The desk's question is
 * "which document, issued where, expiring when" — the full number is in
 * KYCAID, which is the system of record for it and is one click away. Showing
 * it in full is a one-line change here if the work actually needs it.
 */
function narrowApplicant(a: Record<string, unknown>) {
  const mask = (n: string | null) =>
    !n ? null : n.length <= 4 ? '••••' : `••••${n.slice(-4)}`;

  return {
    name:
      pick(a, 'full_name') ??
      ([pick(a, 'first_name'), pick(a, 'middle_name'), pick(a, 'last_name')]
        .filter(Boolean)
        .join(' ') ||
        null),
    dob: pick(a, 'dob', 'date_of_birth'),
    gender: pick(a, 'gender'),
    residenceCountry: pick(a, 'residence_country', 'country', 'country_code'),
    citizenshipCountry: pick(a, 'citizenship_country', 'nationality'),
    email: pick(a, 'email'),
    phone: pick(a, 'phone', 'phone_number'),
    externalApplicantId: pick(a, 'external_applicant_id'),
    createdAt: pick(a, 'created_at'),
    type: pick(a, 'type'),
    addresses: objects(a.addresses).map((ad) => ({
      country: pick(ad, 'country', 'country_code'),
      region: pick(ad, 'region', 'state'),
      city: pick(ad, 'city'),
      street: pick(ad, 'street', 'address', 'full_address'),
      postalCode: pick(ad, 'postal_code', 'postcode', 'zip'),
    })),
    documents: objects(a.documents).map((d) => ({
      type: pick(d, 'type', 'document_type'),
      number: mask(pick(d, 'number', 'document_number')),
      issuedCountry: pick(d, 'issue_country', 'country', 'country_code'),
      issuedAt: pick(d, 'issue_date', 'issued_at'),
      expiresAt: pick(d, 'expiry_date', 'expires_at'),
      status: pick(d, 'status'),
    })),
  };
}

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
        /** What an approval covered. The file import carries none, hence []. */
        checks: (row.checks ?? []).filter(Boolean),
        /**
         * The rest of the provider's row, identity fields already removed by
         * the reader. Null rather than {} where there is nothing, so "we never
         * stored this" and "the provider sent an empty row" stay different
         * answers.
         */
        raw: (row.raw ?? undefined) as Prisma.InputJsonValue | undefined,
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
   * WHAT THE PROVIDER ACTUALLY SENDS, from the rows it actually sent.
   *
   * Every column on this screen has at some point been argued from the
   * documentation, and the documentation has been wrong twice: it says `price`
   * is euro cents and `processing_time` seconds, and this account's data says
   * neither. Meanwhile `country_code` sat in every response for a year while
   * the Country column read "—", because nothing was looking at the response.
   *
   * So this reads the stored rows and reports what is in them: which keys
   * arrive, how often they carry a value, one example, and whether anything
   * here stores it. A field at 100% with "not stored" beside it is a column
   * available for the asking; a mapped field at 0% is a column that will never
   * fill however the screen is written.
   *
   * It reads `raw`, which is the row minus the identity fields — so rows
   * fetched before `raw` was written have nothing to report, and the answer
   * says how many of those there are rather than reporting no fields.
   */
  async providerFields(limit = 1000) {
    const take = Math.min(Math.max(limit, 1), 5000);
    const [rows, held] = await Promise.all([
      this.prisma.kycCase.findMany({
        // `not: DbNull` rather than a NOT wrapper: for a nullable Json column
        // Prisma expresses "has a value" inside the filter, and the outer form
        // does not typecheck.
        where: { raw: { not: Prisma.DbNull } },
        select: { raw: true },
        orderBy: { submittedAt: 'desc' },
        take,
      }),
      this.prisma.kycCase.count(),
    ]);

    const seen = new Map<
      string,
      { rows: number; filled: number; example: string | null }
    >();
    for (const r of rows) {
      const row = r.raw as Record<string, unknown> | null;
      if (!row || typeof row !== 'object') continue;
      for (const [key, value] of Object.entries(row)) {
        const f = seen.get(key) ?? { rows: 0, filled: 0, example: null };
        f.rows++;
        const empty =
          value === null ||
          value === undefined ||
          value === '' ||
          (Array.isArray(value) && value.length === 0);
        if (!empty) {
          f.filled++;
          f.example ??= JSON.stringify(value).slice(0, 60);
        }
        seen.set(key, f);
      }
    }

    return {
      /** How many rows this was measured over, and how many are held. */
      sampled: rows.length,
      held,
      /**
       * Rows stored before the whole row was kept. Not a gap in the provider's
       * data — a gap in ours, and fetching those dates again fills it.
       */
      withoutRaw: held - rows.length,
      fields: [...seen.entries()]
        .map(([field, f]) => ({
          field,
          filled: f.filled,
          fillRate: f.rows ? Math.round((f.filled / f.rows) * 100) : 0,
          example: f.example,
          storedAs: STORED_AS[field] ?? null,
        }))
        .sort(
          (a, b) => b.fillRate - a.fillRate || a.field.localeCompare(b.field),
        ),
      /**
       * Named, because their absence is the point. These are in the provider's
       * response and deliberately never stored, so they will never appear in
       * the list above however many rows are sampled.
       */
      refused: REFUSED_FIELDS,
    };
  }

  /**
   * Everything the provider holds about one verification's applicant, live.
   *
   * NOT STORED, AND THAT IS THE DESIGN. The report gives the outcome; this
   * gives the person. Keeping it would make this dashboard a second permanent
   * copy of every client's identity documents, held to a lower standard than
   * the system that is supposed to hold them — so it is fetched when somebody
   * opens a row, shown, and forgotten.
   *
   * THE TOKEN IS CHOSEN BY THE ROW'S OWN ACCOUNT. Mauritius and Saint Lucia
   * hold separate KYCAID accounts, and each token can only see its own: asking
   * the wrong one returns 404, which reads as a deleted applicant rather than
   * as the wrong credential. The row records which account fetched it, so this
   * asks that one.
   */
  async applicantDetail(caseId: string) {
    const row = await this.prisma.kycCase.findUnique({
      where: { id: caseId },
      select: {
        applicantId: true,
        account: true,
        verificationId: true,
        country: true,
      },
    });
    if (!row) throw new BadRequestException('No such verification.');
    if (!row.applicantId) {
      // A SERVICE row is a paid database lookup, not a person. Saying so is
      // better than a 404 that looks like a provider failure.
      throw new BadRequestException(
        'This verification carries no applicant — a paid lookup rather than a person being checked, or an application abandoned before one was created.',
      );
    }

    const account = accountFor(row.account);
    const client = new KycaidClient({ token: account.token });
    const applicant = await client.applicant(row.applicantId);
    return {
      account: account.label,
      applicantId: row.applicantId,
      verificationId: row.verificationId,
      /**
       * Narrowed on the way out, not passed through.
       *
       * The applicant object carries whatever KYCAID decides it carries, and
       * a passthrough would put all of it into a browser and into any log that
       * records a response. These are the fields a compliance desk asks about.
       */
      applicant: narrowApplicant(applicant),
      /** The whole thing is deliberately not returned. Say so on the screen. */
      note: 'Read live from KYCAID and not stored. Close this and it is gone.',
    };
  }

  /**
   * Which checks passed and which did not, read live for one verification.
   *
   * THE TABLE SAYS *WHICH* CHECKS RAN; THIS SAYS WHICH ONES THE PROVIDER WAS
   * SATISFIED BY. The stored row carries `verification_types` — Profile,
   * Document, Liveness, Address, Database Screening — and a decline reason in
   * the provider's own vocabulary, and no link between the two. A rejected
   * Mauritius application reading "Profile, Document, Liveness" with
   * `document_expired` beside it leaves the desk unable to say whether the face
   * matched, which is the difference between re-requesting one document and
   * re-running the whole check.
   *
   * NOT STORED, AND UNLIKE THE APPLICANT LOOKUP, NOT GATED EITHER. There is no
   * person in this reply — ids, booleans and the provider's note on each check
   * — so the screen loads it on opening a row. It is not cached because a check
   * can be re-run: a verdict of ours that disagrees with the provider's is
   * worse than no verdict at all.
   */
  async verificationChecks(caseId: string) {
    const row = await this.prisma.kycCase.findUnique({
      where: { id: caseId },
      select: { verificationId: true, account: true },
    });
    if (!row) throw new BadRequestException('No such verification.');
    if (!row.verificationId)
      throw new BadRequestException(
        'This row carries no verification id, so the provider cannot be asked about it.',
      );

    const account = accountFor(row.account);
    const client = new KycaidClient({ token: account.token });
    const body = await client.verification(row.verificationId);

    return {
      account: account.label,
      verificationId: row.verificationId,
      /** Their processing state — `unused`, `pending`, `completed`. */
      status: pick(body, 'status'),
      /**
       * Their overall verdict, which the report does not send.
       *
       * The report gives `status: completed` for a verification that failed,
       * and this integration derives the pass/fail from `decline_reasons`
       * being empty. This is the provider stating it outright — worth showing
       * beside ours, because the day the two disagree is a day the derivation
       * needs looking at.
       */
      verified: typeof body.verified === 'boolean' ? body.verified : null,
      checks: readChecks(body),
      note: 'Read live from KYCAID and not stored.',
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
    const [rows, countries] = await Promise.all([
      this.prisma.kycCase.findMany({
        orderBy: { submittedAt: 'desc' },
        take: Math.min(Math.max(limit, 1), 1000),
        include: { client: { select: { externalId: true, country: true } } },
      }),
      countryNames(),
    ]);
    return rows.map((c) => {
      /**
       * THE VERIFICATION'S OWN COUNTRY FIRST, the client's only as a fallback.
       *
       * This read the client's column alone, which is the country the CRM holds
       * — so a verification KYCAID settled against a Philippine passport showed
       * blank for every client the payments side had never seen. The row itself
       * carries `country_code` from the report, assessed at the time of the
       * check, and that is the one a decline for a prohibited jurisdiction is
       * actually about.
       */
      const code = c.country ?? c.client?.country ?? null;
      return {
        id: c.id,
        verificationId: c.verificationId,
        applicantId: c.applicantId,
        reference: c.client?.externalId ?? null,
        country: code,
        /** Resolved live from `GET /countries`; null when it could not be. */
        countryName: code ? (countries.names.get(code) ?? null) : null,
        status: c.status,
        providerStatus: c.providerStatus,
        form: c.form,
        method: c.method,
        declineReasons: c.declineReasons,
        priceEur: c.priceEur === null ? null : Number(c.priceEur),
        processingMin: c.processingMin,
        submittedAt: c.submittedAt.toISOString(),
      };
    });
  }

  /**
   * Verifications by country — what each jurisdiction costs, and how it fares.
   *
   * The one breakdown the compliance desk did not have. Pass rate by entity
   * says Mauritius approves 44% against Saint Lucia's 89%; pass rate by country
   * says whether that is the form or the applicants, because a brand that draws
   * from different jurisdictions is being held to the same checks with
   * different inputs.
   *
   * `allowed` is the other half, and it comes from the provider rather than
   * from us: `GET /countries` is the list this account is configured to accept.
   * A country with rows here and `allowed: false` is either a jurisdiction that
   * was turned off after the fact or a code the provider does not use — both
   * worth somebody's attention, and neither visible from our own table.
   */
  async byCountry(window: KycWindow = {}) {
    const scope = windowWhere(window);
    const [grouped, countries] = await Promise.all([
      this.prisma.kycCase.groupBy({
        by: ['country', 'status'],
        where: scope,
        _count: { _all: true },
        _sum: { priceEur: true },
      }),
      countryNames(),
    ]);

    const rows = new Map<
      string,
      {
        country: string | null;
        name: string | null;
        allowed: boolean | null;
        verifications: number;
        byStatus: Record<string, number>;
        spentEur: number;
      }
    >();
    for (const g of grouped) {
      const code = g.country;
      // The same sentinel as `breakdown` above, and written as an ESCAPE for
      // the same reason: a literal NUL makes the whole file read as binary to
      // grep, which is how it hid the first time.
      const key = code ?? '\u0000none';
      const row = rows.get(key) ?? {
        country: code,
        name: code ? (countries.names.get(code) ?? null) : null,
        /**
         * Null, not false, when the list could not be read. "We do not know
         * whether this jurisdiction is accepted" and "the provider does not
         * accept it" are different answers and only one of them is alarming.
         */
        allowed: !countries.names.size
          ? null
          : code
            ? countries.names.has(code)
            : null,
        verifications: 0,
        byStatus: {},
        spentEur: 0,
      };
      row.verifications += g._count._all;
      row.byStatus[g.status] = (row.byStatus[g.status] ?? 0) + g._count._all;
      row.spentEur += g._sum.priceEur === null ? 0 : Number(g._sum.priceEur);
      rows.set(key, row);
    }

    return {
      countries: [...rows.values()].sort(
        (a, b) => b.verifications - a.verifications,
      ),
      /** How many countries the provider says this account may verify. */
      accepted: countries.names.size,
      /** Why the names and the accepted list are missing, if they are. */
      namesUnavailable: countries.why,
    };
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
