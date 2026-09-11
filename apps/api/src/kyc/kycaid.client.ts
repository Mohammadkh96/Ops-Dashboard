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
 * The file import stays. It is the only way to load history from before this
 * was wired up in one go, it needs no credential at all, and it is what runs
 * when the provider is down. This is the path that keeps the dashboard current
 * without anybody exporting anything.
 *
 * READ-ONLY, STRUCTURALLY. There is one request function here, its method is
 * the literal string 'GET', and no caller can express another. That is what
 * makes this safe to point at a live compliance account: nothing in this file
 * can create, edit or delete a verification, whatever it is called with.
 *
 * WHAT IS DELIBERATELY NOT READ. The report carries `name`, `dob`, `email`,
 * `phone` and `tax_id_number`. None of them are mapped. The dashboard's job is
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
  decline_reasons?: unknown;
  /** Seconds. The console export writes the same measurement in minutes. */
  processing_time?: number | string | null;
  /** EURO CENTS. The console export writes the same money in euros. */
  price?: number | string | null;
  mode?: string | null;
};

export type KycaidForm = { form_id?: string | null; name?: string | null };

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
 * THE TWO UNIT CONVERSIONS ARE THE WHOLE RISK HERE. `price` is euro CENTS and
 * `processing_time` is SECONDS, while the console export writes euros and
 * minutes into the same two columns. Import both paths without converting and
 * the compliance spend reads a hundred times too high for whichever half came
 * from the API — a number nobody would question, because it is only wrong by a
 * factor that looks like a busy month.
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

  const priceCents = num(row.price);
  const seconds = num(row.processing_time);

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
    priceEur: priceCents === null ? null : priceCents / 100,
    processingMin: seconds === null ? null : seconds / 60,
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
        const id = String(f.form_id ?? '').trim();
        const name = String(f.name ?? '').trim();
        if (id && name) names.set(id, name);
      }
    } catch {
      // Not worth failing a sync over. Without it the form column holds ids
      // instead of names, which is legible and correctable; refusing to import
      // anything because a decoration could not be resolved is not.
    }
    return names;
  }
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
