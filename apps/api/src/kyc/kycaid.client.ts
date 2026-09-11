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
 * The screen is showing raw form ids — "12666" where the console says "DEFAULT
 * KYC Tradin MAU" — which means this lookup came back with nothing. Either the
 * endpoint refused, or it names its columns differently from the report that
 * references them. Both spellings are read rather than guessed at, and the
 * failure is no longer swallowed silently: `formsFailed` says so.
 */
export type KycaidForm = {
  form_id?: string | null;
  id?: string | null;
  name?: string | null;
  form_name?: string | null;
  title?: string | null;
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
  };
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
export function readRows(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (body && typeof body === 'object') {
    for (const key of ['data', 'verifications', 'items', 'results', 'report']) {
      const v = (body as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}
