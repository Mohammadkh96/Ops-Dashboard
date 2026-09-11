import type { VerificationRow } from './kyc.service';

/**
 * KYCAID, read directly.
 *
 * THIS FILE EXISTS BECAUSE I WAS WRONG. The import screen was built on the
 * finding that KYCAID "reads back one record at a time and will not enumerate",
 * and that finding was drawn from four probes — `/applicants`, `/verifications`,
 * `/applicants/{id}/verifications`, `/forms/{id}` — every one of which returns
 * `404 not_found` or something unrelated. The conclusion followed from the
 * evidence and was still false: the enumeration lives at
 * `GET /verifications/report`, one day at a time, and returns very nearly the
 * columns the console export produces. Four 404s are not a proof, and a
 * negative from a provider's API only ever means "not that path".
 *
 * The file import that preceded it has been deleted. Once the provider reads
 * back directly, a second way in is a second way to be wrong about where the
 * numbers came from.
 *
 * READ-ONLY, STRUCTURALLY. There is one request function here, its method is
 * the literal string 'GET', and no caller can express another. That is what
 * makes this safe to point at a live compliance account: nothing in this file
 * can create, edit or delete a verification, whatever it is called with.
 *
 * WHAT IS DELIBERATELY NOT READ. The report carries `name`, `dob`, `email`,
 * `phone`, `tax_id_number`, `wallet_address` and `telegram_username`. None of
 * them are mapped. `country_code` is the one exception and a deliberate one:
 * two letters of jurisdiction, no person attached, and the thing a
 * prohibited-jurisdiction decline is actually about. The dashboard's job is
 * to know who is verified, not to hold a second copy of everybody's identity
 * documents, and the browser-side import drops exactly the same columns — so
 * the two paths store the same narrow thing.
 */

const DEFAULT_BASE_URL = 'https://api.kycaid.com';
const DEFAULT_TIMEOUT_MS = 20_000;

/** The provider's maximum, and its default. Asking for more is silently 1000. */
export const REPORT_PAGE_SIZE = 1000;

/**
 * One row of `GET /verifications/report`.
 *
 * Written as the provider writes it — snake_case, their spelling — so that the
 * mapping below is the only place the two vocabularies meet. Everything is
 * optional because a report row for an abandoned application carries almost
 * nothing, and a client that assumes otherwise throws on the first one.
 */
export type ReportRow = {
  created_at?: string | null;
  verification_id?: string | null;
  applicant_id?: string | null;
  external_applicant_id?: string | null;
  form_id?: string | null;
  status?: string | null;
  service?: string | null;
  method?: string | null;
  verification_types?: string[] | null;
  country_code?: string | null;
  decline_reasons?: unknown;
  /** MINUTES, whatever the reference says — see the note on the mapping. */
  processing_time?: number | string | null;
  /** EUROS, whatever the reference says — see the note on the mapping. */
  price?: number | string | null;
  mode?: string | null;
};

/**
 * One row of `GET /forms`, in every spelling it has been seen to use.
 *
 * THE SCREEN'S "12666" IS NOT THIS CALL FAILING. Measured against the live
 * account, `/forms` answers 200 with seven forms whose ids are 36 hex
 * characters, while the report sends `form_id: 12666` — two namespaces, and
 * `/forms/12666` answers `422 Form ID is not valid`. So this map is correct,
 * complete, and cannot name a single row the report returns. See `formNamesFor`
 * for what does. Kept because it costs one request per sync and would resolve
 * the ids immediately if the provider ever reported them in this namespace.
 */
export type KycaidForm = {
  form_id?: string | null;
  id?: string | null;
  name?: string | null;
  form_name?: string | null;
  title?: string | null;
};

/**
 * One row of `GET /countries` — a code and its name in several languages.
 *
 * The report sends `country_code` and nothing else, so "PH" is as much as the
 * table can say without this. The labels arrive as a list rather than a field
 * per language:
 *
 *   { country_code: "AD", labels: [ { language_code: "EN", label: "Andorra" } ] }
 *
 * Read leniently — `labels` is the documented spelling, but a provider that
 * has twice been described wrongly by its own reference is worth reading in
 * both the shape it documents and the flat one it might send instead.
 */
export type KycaidCountry = {
  country_code?: string | null;
  code?: string | null;
  labels?: { language_code?: string | null; label?: string | null }[] | null;
  name?: string | null;
  label?: string | null;
};

/** One KYCAID account: one entity, one token, one set of verifications. */
export type KycaidAccount = {
  /** MU, SL… taken from the variable name. Empty for an unsuffixed token. */
  label: string;
  token: string;
  /** Which variable it came from, so a screen can name it. */
  variable: string;
};

const TOKEN_VARIABLE = /^KYCAID_API_TOKEN(.*)$/;

/**
 * Every KYCAID account this deployment can read.
 *
 * TWO ENTITIES MEANS TWO ACCOUNTS, and that is not a detail. Tradin Mauritius
 * and Tradin Saint Lucia hold separate KYCAID accounts with separate tokens,
 * separate forms and separate verifications: a token reads ONE of them and
 * cannot see the other. Built for a single token, this integration would have
 * fetched one brand in full, reported "done", and left the other invisible —
 * which looks exactly like a brand that simply verifies fewer people.
 *
 * Discovered from the environment rather than configured in a list, because
 * adding an entity should be adding a variable. Anything named
 * `KYCAID_API_TOKEN…` is an account and the rest of the name is its label:
 * `KYCAID_API_TOKENMU` is MU, `KYCAID_API_TOKEN_SL` is SL, and a bare
 * `KYCAID_API_TOKEN` is the one unlabelled account a single-entity setup has.
 */
export function kycaidAccounts(
  env: NodeJS.ProcessEnv = process.env,
): KycaidAccount[] {
  const accounts: KycaidAccount[] = [];
  for (const [variable, value] of Object.entries(env)) {
    const m = TOKEN_VARIABLE.exec(variable);
    const token = (value ?? '').trim();
    if (!m || !token) continue;
    accounts.push({
      label: m[1].replace(/^_+/, '').trim().toUpperCase(),
      token,
      variable,
    });
  }
  // Stable order, so two runs read the accounts in the same sequence and a
  // budget that runs out stops in a repeatable place.
  return accounts.sort((a, b) => a.label.localeCompare(b.label));
}

/** Whether a direct read is possible at all. */
export function kycaidConfigured(env?: NodeJS.ProcessEnv): boolean {
  return kycaidAccounts(env).length > 0;
}

/**
 * The form names, which the provider will not give us.
 *
 * MEASURED, AND IT OVERTURNS WHAT THIS FILE USED TO SAY. `GET /forms` answers
 * 200 with seven forms whose `form_id` is 36 hex characters —
 * `017ec21701bf374cb728753376077c03767d`, "DEFAULT KYC Tradin MAU". The report
 * sends `form_id: 12666`. Those are two different identifier spaces: asking
 * `/forms/12666` returns `422 validation — Form ID is not valid`, so there is
 * no call that turns one into the other. The `12666` in the Form column was
 * never a failed request and never a parsing bug; it is the provider handing
 * out an id in one namespace and a directory in another.
 *
 * Measured across fourteen days: Mauritius reports one id on every row (12666);
 * Saint Lucia reports three (14482, 14483, 14954). So it IS a form — one
 * entity runs everything through a single form and the other through three —
 * and the only thing missing is the name.
 *
 * WHICH LEAVES CONFIGURATION, and configuration is the honest answer here.
 * `KYCAID_FORM_NAMES_MU="12666=DEFAULT KYC Tradin MAU"` names one; the account
 * suffix follows the token variables, and a bare `KYCAID_FORM_NAMES` covers a
 * single-account deployment. An id nobody has named keeps showing as the
 * number, because inventing a form name on a compliance screen — asserting
 * which checks a client was held to — is worse than showing an id that cannot
 * be read.
 *
 * Applied when the rows are READ, not when they are written, so naming a form
 * fixes the rows already stored instead of requiring a year to be fetched
 * again.
 */
const FORM_NAMES_VARIABLE = 'KYCAID_FORM_NAMES';
const formNameCache = new Map<string, Map<string, string>>();

export function formNamesFor(
  label: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Map<string, string> {
  const account = (label ?? '').trim().toUpperCase();
  const cached = formNameCache.get(account);
  if (cached && env === process.env) return cached;

  // The account's own list wins; the unsuffixed one is the fallback a
  // single-account deployment sets. Read in that order so a shared name can be
  // overridden per entity — the ids are per account and could collide.
  const names = new Map<string, string>();
  for (const variable of [
    FORM_NAMES_VARIABLE,
    account ? `${FORM_NAMES_VARIABLE}_${account}` : '',
    account ? `${FORM_NAMES_VARIABLE}${account}` : '',
  ]) {
    if (!variable) continue;
    for (const pair of (env[variable] ?? '').split(/[;,\n]/)) {
      const at = pair.indexOf('=');
      if (at < 1) continue;
      const id = pair.slice(0, at).trim();
      const name = pair.slice(at + 1).trim();
      if (id && name) names.set(id, name);
    }
  }
  if (env === process.env) formNameCache.set(account, names);
  return names;
}

/** Forget the parsed names. For the checks, which change the environment. */
export function forgetFormNames() {
  formNameCache.clear();
}

/**
 * A stored form value, named if anybody has named it.
 *
 * Takes the row's account as well as its form, because `14483` means one thing
 * on Saint Lucia's account and nothing at all on Mauritius's.
 */
export function formLabel(
  form: string | null | undefined,
  account: string | null | undefined,
): string | null {
  const id = (form ?? '').trim();
  if (!id) return null;
  const named = formNamesFor(account).get(id);
  if (named) return named;

  /**
   * No account on the row, so try them all.
   *
   * The breakdown groups by form alone — the figure it answers is "how many
   * verifications went through this form", not "per form per account" — and
   * rows loaded before the account column existed carry none either. The
   * namespaces are disjoint in the data measured (Mauritius 12666, Saint Lucia
   * 14482/14483/14954), so this is unambiguous in practice; where two accounts
   * did name the same id differently, the first account alphabetically wins
   * and the row is no worse off than the number it would otherwise show.
   */
  if (!(account ?? '').trim()) {
    for (const a of kycaidAccounts()) {
      const guess = formNamesFor(a.label).get(id);
      if (guess) return guess;
    }
  }
  return id;
}

/**
 * The country names, fetched once and kept.
 *
 * `GET /countries` is the answer to "PH" — a reference list of every country
 * the account may verify, each with its name in several languages. It is the
 * one KYCAID endpoint whose answer does not change between requests, so
 * fetching it per page load would be a round trip spent on a constant.
 *
 * CACHED IN THE PROCESS, NOT IN THE DATABASE, and on purpose. Stored, it would
 * be a second copy of an ISO table that has to be kept current; resolved on the
 * way out, a failed lookup costs an hour of two-letter codes and nothing more.
 * That is the mistake the Form column is still showing: a name resolved once at
 * import time and written into the row, so one failed request left `12666`
 * sitting in the column permanently.
 *
 * TRIES EACH ACCOUNT. The list is per account — it is what that account is
 * configured to accept — but a token that answers is better than a column of
 * codes, so the first account to reply wins and the rest are not asked.
 *
 * Lives here rather than in either service because both read it, and because
 * the account discovery it depends on is in this file.
 */
const COUNTRY_TTL_MS = 12 * 60 * 60 * 1000;
let countryCache: {
  at: number;
  names: Map<string, string>;
  why: string | null;
} | null = null;

/** Forget the cached list. For the checks, which must not share state. */
export function forgetCountries() {
  countryCache = null;
}

export async function countryNames(): Promise<{
  names: Map<string, string>;
  /** Why the names are missing, if they are. Null when they resolved. */
  why: string | null;
}> {
  if (countryCache && Date.now() - countryCache.at < COUNTRY_TTL_MS) {
    return { names: countryCache.names, why: countryCache.why };
  }
  const accounts = kycaidAccounts();
  if (!accounts.length) {
    countryCache = {
      at: Date.now(),
      names: new Map(),
      why: 'No KYCAID token is configured, so the country list cannot be read.',
    };
    return { names: countryCache.names, why: countryCache.why };
  }

  let why: string | null = null;
  for (const account of accounts) {
    /**
     * A SHORT LEASH, because a table waits on this.
     *
     * The default twenty seconds is right for a report page worth fetching and
     * wrong for a decoration: a provider that has stopped answering would hold
     * the compliance table for twenty seconds per account before rendering the
     * codes it already had. Five is long enough for a reference list and short
     * enough that the failure is a pause rather than an outage — and it is
     * paid twice a day, not once per request.
     */
    const client = new KycaidClient({ token: account.token, timeoutMs: 5_000 });
    const names = await client.countries();
    if (names.size) {
      countryCache = { at: Date.now(), names, why: null };
      return { names, why: null };
    }
    why ??= `${account.label || 'the account'}: ${client.countriesFailed ?? 'no countries returned'}`;
  }
  // Cached even in failure, so a provider that is refusing this endpoint is
  // asked twice a day rather than on every request that renders a table.
  countryCache = { at: Date.now(), names: new Map(), why };
  return { names: countryCache.names, why };
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  // Only a string is worth reading. An object here would stringify to
  // "[object Object]" and then to NaN, which is a null with extra steps.
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Their decline reasons, whatever shape they arrive in.
 *
 * The callback sends objects with a `code`; the export sends one comma-joined
 * string; the report is documented as a list. All three are read here rather
 * than assumed, because the cost of guessing is an empty `declineReasons` on
 * every rejected verification — a column that looks answered and is not.
 */
export function readDeclineReasons(value: unknown): string[] {
  if (!value) return [];
  const one = (v: unknown): string => {
    if (typeof v === 'string') return v.trim();
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const pick = o.reason ?? o.code ?? o.name ?? o.title ?? o.message;
      return typeof pick === 'string' ? pick.trim() : '';
    }
    return '';
  };
  if (Array.isArray(value)) return value.map(one).filter(Boolean);
  if (typeof value === 'string')
    return value
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
  const single = one(value);
  return single ? [single] : [];
}

/**
 * A report row, in the shape the importer already takes.
 *
 * THE UNITS ARE THE PROVIDER'S OWN, AND THE DOCUMENTATION IS WRONG ABOUT THEM.
 *
 * The reference says `price` is in euro CENTS and `processing_time` in
 * SECONDS, so this converted both. The live data says otherwise, and says it
 * unambiguously — the same account holds verifications from both routes:
 *
 *   30,444 rows read from this API averaged  €0.0074 each
 *    7,983 rows from the vendor's own export averaged €0.8625 each
 *
 * A hundred-and-sixteen-fold gap between two populations of the same
 * verifications from the same vendor is not a difference in pricing, it is a
 * division that should not have happened. `processing_time` failed the same
 * way and more visibly: every Mins column on the screen read 0, because a
 * four-minute manual check divided by sixty rounds to nothing.
 *
 * So both are taken as the export writes them — euros and minutes — and the
 * documentation is treated as the less reliable witness. Measured, not
 * assumed: the arithmetic above is the reason, and a day fetched twice will
 * keep the same figures if this is right.
 *
 * THE VERDICT IS NOT THE STATUS. `status` here is a processing state —
 * `unused`, `pending`, `completed` — and `completed` says the check finished,
 * not that it passed. The same verification is `INVALID` in the console export
 * and `completed` in this report. So the verdict is taken from whether the
 * provider recorded a reason to decline, and the raw word is still stored
 * verbatim beside it.
 */
export function toVerificationRow(
  row: ReportRow,
  formNames?: Map<string, string>,
): VerificationRow | null {
  const verificationId = String(row.verification_id ?? '').trim();
  if (!verificationId) return null;

  const declineReasons = readDeclineReasons(row.decline_reasons);
  const status = String(row.status ?? '').trim();
  const settled = status.toLowerCase() === 'completed';

  const at = row.created_at ? new Date(row.created_at) : null;
  const formId = String(row.form_id ?? '').trim();

  const price = num(row.price);
  const minutes = num(row.processing_time);

  return {
    verificationId,
    applicantId: String(row.applicant_id ?? '').trim() || null,
    externalApplicantId: String(row.external_applicant_id ?? '').trim() || null,
    status,
    // A verdict only where there is one to give. A pending verification has
    // decided nothing, and calling it a pass because no reason was recorded yet
    // is how a half-finished check becomes an approval.
    verdict: settled ? (declineReasons.length ? 'FAIL' : 'PASS') : null,
    at: at && !Number.isNaN(at.getTime()) ? at : null,
    // The export names the form and the API numbers it. Resolved to the name
    // where `/forms` gave one, so the same verification read either way lands
    // in the same column rather than splitting the form counts in two.
    form: (formId && formNames?.get(formId)) || formId || null,
    method: String(row.method ?? row.service ?? '').trim() || null,
    declineReasons,
    priceEur: price,
    processingMin: minutes,
    /**
     * KYC, KYB or SERVICE — and the third is not a person being checked.
     *
     * A SERVICE row is a lookup the account paid for (a Brazilian CPF check,
     * say). It has a price and no applicant, so without this it lands beside
     * the real verifications as one more record with no account reference: it
     * inflates the count, it inflates the spend per client, and the By-form
     * panel reports it as a gap in the import. Kept and labelled instead.
     */
    service:
      String(row.service ?? '')
        .trim()
        .toUpperCase() || null,
    /**
     * TEST or LIVE.
     *
     * The report returns both. KYCAID's test mode is "no different from the
     * live mode except the priority", which is precisely why its rows look
     * real: same shape, same price field, same statuses. Counted into a
     * compliance total they are simply false, so the sync drops them — and
     * says how many it dropped, because silently discarding rows is the other
     * way to be wrong here.
     */
    mode:
      String(row.mode ?? '')
        .trim()
        .toUpperCase() || null,
    /**
     * The jurisdiction, and the one identifying field this file reads.
     *
     * IT WAS DECLARED, DOCUMENTED AND NEVER ASSIGNED. `country_code` is on the
     * row type above with a paragraph explaining why it is the single
     * exception to reading no personal data — and the mapping simply did not
     * set it, so every verification fetched from the API landed with an empty
     * country while the provider's own console showed Philippines, Albania,
     * Nigeria. The column read "—" on ten thousand rows and looked like a
     * provider that does not report country.
     */
    country:
      String(row.country_code ?? '')
        .trim()
        .toUpperCase() || null,
    /**
     * WHICH CHECKS RAN — the console's "Checks" column.
     *
     * "Profile, Document, Liveness, Address, Database Screening, Adverse Media
     * Check". It is the only record of what an approval actually covered, and
     * it matters here more than at most brokers: the two entities run
     * different forms, one of them includes ADDRESS and the other does not, so
     * the same word means two different things on the two halves of this
     * table.
     */
    checks: readList(row.verification_types),
    /**
     * The rest of the row, for the column nobody has asked for yet.
     *
     * STRIPPED OF THE IDENTITY FIELDS, which is what makes it safe to keep.
     * The report carries name, date of birth, email, phone, tax id, wallet
     * address and telegram username; those are removed here rather than
     * anywhere later, so nothing downstream can store them by accident. What
     * is left is the provider's own record of the check, and re-pulling a year
     * of it is 365 requests.
     */
    raw: withoutIdentity(row),
  };
}

/**
 * The identity fields this integration refuses to hold.
 *
 * Listed rather than inferred: a field is personal because it names a person,
 * and no rule over key spellings is going to be right about that. Anything the
 * provider adds later arrives in `raw` until somebody looks at it, which is
 * the trade — so this list is the thing to extend when they do.
 */
const IDENTITY_FIELDS = [
  'name',
  'first_name',
  'last_name',
  'middle_name',
  'full_name',
  'dob',
  'date_of_birth',
  'email',
  'phone',
  'phone_number',
  'tax_id_number',
  'wallet_address',
  'telegram_username',
];

function withoutIdentity(row: ReportRow): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>))
    if (!IDENTITY_FIELDS.includes(k.toLowerCase())) kept[k] = v;
  return kept;
}

/** A list of words, however the provider chose to send it this time. */
export function readList(value: unknown): string[] {
  if (Array.isArray(value))
    return value.map((v) => String(v ?? '').trim()).filter(Boolean);
  if (typeof value === 'string')
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  return [];
}

export class KycaidError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'KycaidError';
  }
}

/**
 * The provider, read one day at a time.
 *
 * Constructed per sync rather than injected, so a token that is not set is a
 * refusal at the moment somebody presses the button — with the name of the
 * variable to set — rather than a service that fails to start.
 */
export class KycaidClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    opts: { token?: string; baseUrl?: string; timeoutMs?: number } = {},
  ) {
    this.token = (opts.token ?? process.env.KYCAID_API_TOKEN ?? '').trim();
    this.baseUrl = (
      opts.baseUrl ??
      process.env.KYCAID_BASE_URL ??
      DEFAULT_BASE_URL
    ).replace(/\/+$/, '');
    this.timeoutMs =
      opts.timeoutMs ??
      Number(process.env.KYCAID_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  }

  /**
   * The only request this file can make.
   *
   * No verb parameter, no body, no caller-supplied host. `Authorization: Token`
   * rather than `Bearer` — KYCAID answers 401 to the latter, which reads as a
   * bad key and sends you to rotate a credential that was fine.
   */
  private async get<T>(
    path: string,
    params: Record<string, string> = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Token ${this.token}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new KycaidError(`Could not reach ${url.pathname}: ${why}`, 0);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) {
      // Their own words, trimmed. A 401 here means the token, a 404 means the
      // path — and the difference is worth being able to read on screen.
      throw new KycaidError(
        `KYCAID answered ${res.status} to GET ${url.pathname}: ${text.slice(0, 300)}`,
        res.status,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new KycaidError(
        `KYCAID answered ${res.status} to GET ${url.pathname} with something that is not JSON: ${text.slice(0, 200)}`,
        res.status,
      );
    }
  }

  /**
   * One day of verifications, one page at a time.
   *
   * `date` is required by the provider and the report is per-day, which is why
   * the sync walks days rather than asking for a range: there is no range to
   * ask for.
   */
  async report(
    date: string,
    offset = 0,
    count = REPORT_PAGE_SIZE,
  ): Promise<ReportRow[]> {
    const body = await this.get<unknown>('/verifications/report', {
      date,
      offset: String(offset),
      count: String(count),
    });
    return readRows(body);
  }

  /**
   * Everything the provider holds about one applicant, read at the moment
   * somebody opens the row.
   *
   * READ AND SHOWN, NEVER STORED. This is the endpoint that answers with the
   * person — name, date of birth, addresses, documents — and it is the one
   * thing this integration will not keep a copy of. Fetched live, handed to
   * the screen that asked, and gone; the database keeps the account reference,
   * the jurisdiction and the outcome, which is what the desk needs to work
   * from. The trade is a request per row opened, against a second permanent
   * copy of every client's identity documents sitting in a dashboard.
   *
   * `GET /applicants/{id}` is the one by-id route that was answering while the
   * enumeration attempts were 404ing — 237ms with the whole applicant.
   */
  async applicant(applicantId: string): Promise<Record<string, unknown>> {
    const id = applicantId.trim();
    if (!id) throw new KycaidError('No applicant id to look up.', 400);
    return await this.get<Record<string, unknown>>(
      `/applicants/${encodeURIComponent(id)}`,
    );
  }

  /**
   * One verification's checks, and what the provider said about each.
   *
   * THE REPORT SAYS WHICH CHECKS RAN; THIS SAYS WHICH ONES PASSED. The report's
   * `verification_types` is a list of words — "Profile, Document, Liveness" —
   * and a `decline_reasons` beside it that names the failure in the provider's
   * own vocabulary, with no way to tell which of the six checks produced it. A
   * row reading FAIL with "document_expired" leaves the desk guessing whether
   * the face matched. This endpoint answers per check:
   *
   *   { status, verified, verifications: { document: { verified, comment }, … } }
   *
   * NON-PERSONAL, which is why the screen loads it on opening a row without
   * asking first — unlike the applicant lookup beside it, there is no name, no
   * date of birth and no document here, only the verdicts. Still not stored:
   * it is one request against a figure that can change when a check is re-run,
   * and a cached verdict that disagrees with the provider is worse than none.
   */
  async verification(verificationId: string): Promise<Record<string, unknown>> {
    const id = verificationId.trim();
    if (!id) throw new KycaidError('No verification id to look up.', 400);
    return await this.get<Record<string, unknown>>(
      `/verifications/${encodeURIComponent(id)}`,
    );
  }

  /** The forms, so the report's form ids can be stored as their names. */
  async forms(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    try {
      const body = await this.get<unknown>('/forms');
      for (const f of readRows(body) as KycaidForm[]) {
        const id = String(f.form_id ?? f.id ?? '').trim();
        const name = String(f.name ?? f.form_name ?? f.title ?? '').trim();
        if (id && name) names.set(id, name);
      }
      this.formsFailed = names.size ? null : 'the list came back empty';
    } catch (e) {
      // Not worth failing a sync over. Without it the form column holds ids
      // instead of names, which is legible and correctable; refusing to import
      // anything because a decoration could not be resolved is not.
      //
      // But it IS worth saying. Swallowed in silence, this is a screen full of
      // "12666" where the console says "DEFAULT KYC Tradin MAU", and nothing
      // anywhere to suggest a request failed.
      this.formsFailed = e instanceof Error ? e.message : String(e);
    }
    return names;
  }

  /**
   * The countries this account may verify, code to English name.
   *
   * NOT THE LIST OF COUNTRIES — the list of countries KYCAID will accept an
   * applicant from on THIS account. That makes it two answers at once: the
   * names behind the report's `country_code`, and the jurisdictions the
   * provider is configured to take. A code in our rows that is absent here is
   * worth looking at.
   *
   * Reference data, so it is cached by the caller rather than fetched per
   * request, and — unlike the form names — it is never written into a row.
   * The stored column keeps the ISO code, which does not change; the name is
   * resolved on the way out, so a failing lookup shows "PH" for an hour
   * instead of baking an unresolved value into the table the way `12666` was.
   */
  async countries(language = 'EN'): Promise<Map<string, string>> {
    let names = new Map<string, string>();
    try {
      names = readCountryNames(await this.get<unknown>('/countries'), language);
      this.countriesFailed = names.size ? null : 'the list came back empty';
    } catch (e) {
      // Same judgement as the form names: a country name is a decoration on a
      // code that is already correct, and no read should fail for want of one.
      this.countriesFailed = e instanceof Error ? e.message : String(e);
    }
    return names;
  }

  /** Why the country names are missing, if they are. Null once they resolve. */
  countriesFailed: string | null = null;

  /**
   * Why the form names are missing, if they are. Null once they resolve.
   *
   * Read after `forms()`, so a sync can report "form names unavailable: 404"
   * instead of quietly filling the column with ids.
   */
  formsFailed: string | null = null;
}

/**
 * The array in a reply, whether or not it is wrapped.
 *
 * Providers move this around between versions — a bare array, `{data: []}`,
 * `{verifications: []}` — and a client that insists on one of them reports "no
 * verifications" for a day that had four hundred.
 */
/**
 * `GET /countries` as a code-to-name map, in one language.
 *
 * Separate from the request so the shape can be checked without a network
 * call, and because the shape is the part that goes wrong: the names arrive as
 * a LIST of `{language_code, label}` rather than as a field, so a reader that
 * expects `name` finds nothing and reports an empty list — indistinguishable
 * from an account with no countries.
 *
 * Falls back through the language: the one asked for, then a flat `name` or
 * `label` if the provider ever sends one, then the first label there is. A
 * country named in Russian is more use than a country not named at all.
 */
export function readCountryNames(
  body: unknown,
  language = 'EN',
): Map<string, string> {
  const names = new Map<string, string>();
  const want = language.trim().toUpperCase();
  for (const c of readRows(body) as KycaidCountry[]) {
    const code = String(c.country_code ?? c.code ?? '')
      .trim()
      .toUpperCase();
    if (!code) continue;
    const labels = Array.isArray(c.labels) ? c.labels : [];
    const wanted = labels.find(
      (l) =>
        String(l?.language_code ?? '')
          .trim()
          .toUpperCase() === want,
    );
    const name = String(
      wanted?.label ?? c.name ?? c.label ?? labels[0]?.label ?? '',
    ).trim();
    if (name) names.set(code, name);
  }
  return names;
}

export function readRows(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (body && typeof body === 'object') {
    for (const key of [
      'data',
      'verifications',
      'items',
      'results',
      'report',
      'countries',
      'forms',
    ]) {
      const v = (body as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}
