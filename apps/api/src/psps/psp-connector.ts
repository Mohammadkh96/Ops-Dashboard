import { createHmac } from 'node:crypto';

/**
 * One HTTP call to a payment provider.
 *
 * Generic on purpose. Seven providers arrived at once and an eighth will come;
 * a hand-written client each means a deploy to add one, which is the opposite
 * of what the "Add PSP" button is for. Everything that differs between
 * providers is configuration — the base URL, how the key is presented, which
 * path to call, where the numbers are in the reply.
 *
 * READ-ONLY, STRUCTURALLY. The method is not configurable and is always GET.
 * That is not a policy note, it is the reason this is safe to point at a live
 * payment provider with real keys: there is no code path here that can move
 * money, whatever gets typed into the form.
 */

/** How the credential is presented to the provider. */
export type AuthMode =
  /** Authorization: Bearer <key> */
  | 'bearer'
  /** A named header, e.g. X-API-KEY: <key> */
  | 'header'
  /** Authorization: Basic base64(key:secret) */
  | 'basic'
  /** A query parameter, e.g. ?api_key=<key> — worse, but some require it. */
  | 'query'
  /** An HMAC-SHA256 of the path, signed with the secret. */
  | 'hmac';

export const AUTH_MODES: AuthMode[] = [
  'bearer',
  'header',
  'basic',
  'query',
  'hmac',
];

/** Where in a response the interesting values are. */
export type EndpointConfig = {
  /** Path appended to the base URL, e.g. /v1/balances */
  path: string;
  /**
   * Dotted path to the array of records, e.g. "data.balances". Empty when the
   * response IS the array, or when a single object is returned.
   */
  recordsPath?: string;
  /** Dotted path, within one record, to each value we want. */
  fields?: {
    amount?: string;
    currency?: string;
    /** Which account or wallet this balance belongs to, when there are several. */
    account?: string;
    // Transactions only. Same mapping idea, different columns.
    /** The provider's own id, which is what a dispute is argued with. */
    id?: string;
    /** Their word for the state, kept verbatim — see readTransactions. */
    status?: string;
    /** When it happened, as the provider writes it. */
    date?: string;
    /**
     * When the payment SETTLED, where the provider reports that separately.
     *
     * ForumPay stamps `inserted` on creation and `settled` on completion, and
     * they are routinely days apart. The ledger is listed by the first — that
     * is the date on their portal — but a BALANCE has to be moved by the
     * second, because that is when the money moved. A payment raised before an
     * anchor and settled after it is otherwise never counted at all.
     *
     * Optional, and never guessed: a wrong field name here silently moves
     * payments in time.
     */
    settled?: string;
    /**
     * The provider's cut on this transaction, where it reports one apart from
     * the amount.
     *
     * ForumPay does, and it is money that left the balance: a payout of
     * 1,570.45 also costs a processing fee, so the balance falls by more than
     * the payout. Ignoring it ran the estimate about 0.2% high, always in the
     * same direction.
     *
     * MUST be in the same currency as the amount. ForumPay reports several
     * fees, some denominated in the crypto rather than the fiat, and
     * subtracting a crypto fee from a USD balance is not arithmetic — it is
     * two different units added together. Never guessed for that reason.
     */
    fee?: string;
    /** Our reference on their side: order id, POS id, invoice number. */
    reference?: string;
    /**
     * Which way the money went — ForumPay's `type` is "Buy" or "Sell".
     *
     * Not cosmetic. A list that mixes deposits and withdrawals with no way to
     * tell them apart is not a ledger, it is a pile of numbers: totalling it
     * gives a figure that means nothing, and reconciling it against Paymaxis
     * would match a payout to a deposit of the same amount and call it agreed.
     */
    direction?: string;
    /**
     * Their id for the payer. ForumPay's `payer_id` is the CRM's own client
     * id, which turns "we disagree about $443.47" into "we disagree about
     * client CU31923" — the version somebody can act on.
     */
    customer?: string;
    /**
     * Extra columns, as `Label` → path.
     *
     * The seven named fields above are the ones every provider has in some
     * form and the ones the desk compares across providers. Everything else is
     * particular: ForumPay reports the crypto side of a fiat payment, the
     * network fee, the originally invoiced amount before a partial was
     * accepted. Naming a column for each of those would be a schema change per
     * provider, which is the thing the "Add PSP" button exists to avoid.
     *
     * Projected from the stored record at READ time, not at sync time, so
     * adding a column shows it on rows that were synced last week.
     */
    extras?: Record<string, string>;
  };
  /** Fixed query parameters this endpoint needs. */
  query?: Record<string, string>;
  /**
   * How to ask for the next page.
   *
   * Every provider caps a list — ForumPay silently returns 50 however many you
   * ask for — so reading a full ledger means asking repeatedly. The names
   * differ, and getting one wrong is the worst kind of wrong: an ignored
   * pagination parameter means every page is page one, and a sync that looks
   * like it is working re-reads the newest fifty records for ever.
   */
  pagination?: {
    /** Parameter carrying the page size, e.g. "limit". */
    limitParam?: string;
    /** Parameter carrying the offset, e.g. "offset". */
    offsetParam?: string;
    /** Rows per request. Capped by the provider whatever we send. */
    pageSize?: number;
  };
};

export type Credentials = { key?: string; secret?: string };

export type CallResult =
  | { ok: true; status: number; body: unknown; ms: number }
  | {
      ok: false;
      status: number | null;
      error: string;
      body?: unknown;
      /** A few response headers, when they say something worth acting on. */
      headers?: Record<string, string>;
      ms: number;
    };

/**
 * Response headers worth showing a person configuring a connection.
 *
 * An allow-list, not a filter. A provider's headers are its own and mostly
 * noise, but www-authenticate is the answer to "which auth mode does this
 * want" written down by the only party that knows — a 401 carrying
 * `WWW-Authenticate: Basic realm="api"` turns five guesses into one setting.
 *
 * Cookies are deliberately absent: a session cookie in a diagnostic panel is a
 * credential on a screen, and none of these calls use one.
 */
const HEADERS_WORTH_SHOWING = [
  'www-authenticate',
  'content-type',
  'x-ratelimit-remaining',
  'retry-after',
];

function usefulHeaders(res: Response): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const name of HEADERS_WORTH_SHOWING) {
    const v = res.headers.get(name);
    if (v) out[name] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** How long a provider gets before we give up. */
const TIMEOUT_MS = 15_000;

/**
 * Makes the call.
 *
 * Never throws. A provider being down, slow, or answering with something
 * unexpected is an ordinary Tuesday, and a thrown error here would take down
 * whatever screen asked — including the one whose whole job is to report that
 * the provider is down.
 */
export async function callPsp(
  conn: {
    baseUrl?: string | null;
    authMode?: string | null;
    authName?: string | null;
  },
  endpoint: EndpointConfig,
  creds: Credentials,
): Promise<CallResult> {
  const started = Date.now();
  const base = (conn.baseUrl ?? '').trim().replace(/\/$/, '');
  if (!base) {
    return { ok: false, status: null, error: 'No base URL configured.', ms: 0 };
  }
  if (!/^https:\/\//i.test(base)) {
    // Not a style preference. These are live payment credentials, and http://
    // puts them on the wire in the clear.
    return {
      ok: false,
      status: null,
      error:
        'The base URL must be https. Plain http would send the API key unencrypted.',
      ms: 0,
    };
  }

  let url: URL;
  try {
    url = new URL(
      `${base}${endpoint.path.startsWith('/') ? '' : '/'}${endpoint.path}`,
    );
  } catch {
    return {
      ok: false,
      status: null,
      error: `"${base}${endpoint.path}" is not a valid URL.`,
      ms: 0,
    };
  }
  for (const [k, v] of Object.entries(endpoint.query ?? {})) {
    url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  const mode = (conn.authMode ?? 'bearer') as AuthMode;

  switch (mode) {
    case 'bearer':
      headers.authorization = `Bearer ${creds.key ?? ''}`;
      break;
    case 'header':
      headers[(conn.authName || 'x-api-key').toLowerCase()] = creds.key ?? '';
      break;
    case 'basic':
      headers.authorization = `Basic ${Buffer.from(
        `${creds.key ?? ''}:${creds.secret ?? ''}`,
      ).toString('base64')}`;
      break;
    case 'query':
      url.searchParams.set(conn.authName || 'api_key', creds.key ?? '');
      break;
    case 'hmac': {
      // The common shape: the key identifies you, a signature over the path and
      // a timestamp proves you hold the secret. Providers differ on exactly
      // what is signed; this covers the usual one and the Test button is how a
      // variant gets found.
      const ts = Math.floor(Date.now() / 1000).toString();
      const payload = `${ts}${url.pathname}${url.search}`;
      headers[(conn.authName || 'x-api-key').toLowerCase()] = creds.key ?? '';
      headers['x-timestamp'] = ts;
      headers['x-signature'] = createHmac('sha256', creds.secret ?? '')
        .update(payload)
        .digest('hex');
      break;
    }
  }

  try {
    const res = await fetch(url, {
      // GET, always. Not configurable — see the note at the top of this file.
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* Not JSON. Kept as text so the Test button can show what did arrive —
         an HTML login page is the most useful error a wrong base URL gives. */
    }
    const ms = Date.now() - started;

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: describeStatus(res.status),
        body,
        headers: usefulHeaders(res),
        ms,
      };
    }
    return { ok: true, status: res.status, body, ms };
  } catch (e) {
    const ms = Date.now() - started;
    const timedOut = e instanceof DOMException && e.name === 'TimeoutError';
    return {
      ok: false,
      status: null,
      error: timedOut
        ? `No answer within ${TIMEOUT_MS / 1000}s.`
        : e instanceof Error
          ? e.message
          : String(e),
      ms,
    };
  }
}

/**
 * An HTTP status as something to act on.
 *
 * "Request failed with status code 401" tells somebody nothing they did not
 * already see. Which of the four likely mistakes it is, does.
 */
export function describeStatus(status: number): string {
  switch (status) {
    case 401:
      return 'The provider rejected the credential (401). Check the API key, and whether it expects a different auth mode.';
    case 403:
      return 'Authenticated, but not allowed (403). The key is probably real but lacks permission for this endpoint, or this IP is not allow-listed.';
    case 404:
      return 'No such endpoint (404). Check the base URL and the path.';
    case 429:
      return 'Rate limited (429). Slow down, or ask the provider to raise the limit.';
    default:
      return status >= 500
        ? `The provider had an error (${status}). Usually theirs, not ours — try again.`
        : `The provider refused the request (${status}).`;
  }
}

/**
 * What a 401's `WWW-Authenticate` header says to set the auth mode to.
 *
 * There are five modes and a provider whose documentation nobody here has.
 * That is five attempts, each needing a save, a call and a reading of the
 * result — unless the provider already answered the question, which on a 401 it
 * usually has: `WWW-Authenticate: Basic realm="api"` IS the answer, in the
 * words of the only party that knows.
 */
export function suggestAuthMode(
  headers?: Record<string, string>,
): string | null {
  const challenge = headers?.['www-authenticate'];
  if (!challenge) return null;
  const scheme = challenge.trim().split(/[\s,]/)[0].toLowerCase();
  if (scheme === 'basic') {
    return 'The provider asked for Basic authentication — set the auth mode to “basic”, with the user in the key box and the password in the secret box.';
  }
  if (scheme === 'bearer') {
    return 'The provider asked for Bearer authentication — set the auth mode to “bearer”.';
  }
  if (scheme) {
    // Digest, Negotiate, AWS4-HMAC-SHA256 and friends. Saying so beats
    // silence: none of the five modes will do it, and that is the finding.
    return `The provider asked for "${scheme}" authentication, which none of the auth modes here can produce. This connection needs support from the provider, or a different credential.`;
  }
  return null;
}

/**
 * Whether what came back is a web page rather than API data.
 *
 * The commonest configuration mistake there is: a provider's portal and its API
 * live on different hosts, and the address a person knows is the portal — it is
 * the one they log into. That returns `200 OK` and an HTML shell, so the call
 * "succeeded" and simply contained no balances, and the screen sent them to
 * check field paths against a page of font declarations.
 */
export function looksLikeWebPage(body: unknown): boolean {
  if (typeof body !== 'string') return false;
  return /^\s*(<!doctype\s+html|<html[\s>])/i.test(body);
}

/** The <title> of a returned page, which usually names what was reached. */
function pageTitle(body: unknown): string | null {
  if (typeof body !== 'string') return null;
  const m = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(body);
  return m ? m[1].trim() : null;
}

/**
 * What to tell somebody who got a web page back.
 *
 * Names the likely cause rather than the symptom, because "no balances found"
 * and "you are pointed at the wrong server" want completely different actions.
 */
export function describeWebPage(body: unknown): string {
  const title = pageTitle(body);
  return (
    'That address returned a web page, not API data' +
    (title ? ` (“${title}”)` : '') +
    '. This is almost always the provider’s PORTAL rather than its API — they ' +
    'are usually different hosts. Ask the provider for the API base URL, and ' +
    'check the endpoint path.'
  );
}

/**
 * An error a provider reported inside a 200.
 *
 * Not every provider uses HTTP status codes to say no. ForumPay answers a
 * refused call with `200 OK` and `{"err":"Permission denied!"}`, and there are
 * others. Without this the call counts as a success that happened to contain no
 * balances, and the screen says "check your field paths" — sending somebody to
 * re-read JSON paths that were right all along, while the provider's own
 * explanation sits unread in the response.
 *
 * Deliberately narrow: only an object (a records array is never this), only
 * these two keys, only a non-empty string. A record that happens to have an
 * `error` column must not take a whole reading down.
 */
export function providerError(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  for (const k of ['err', 'error']) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) {
      const code = typeof o.err_code === 'string' ? ` (${o.err_code})` : '';
      return `${v.trim()}${code}`;
    }
  }
  return null;
}

/** Follows a dotted path into a parsed response. */
export function at(value: unknown, path?: string): unknown {
  if (!path) return value;
  return path.split('.').reduce<unknown>((v, part) => {
    if (v === null || v === undefined) return undefined;
    if (Array.isArray(v)) {
      const i = Number(part);
      return Number.isInteger(i) ? v[i] : undefined;
    }
    if (typeof v === 'object') return (v as Record<string, unknown>)[part];
    return undefined;
  }, value);
}

export type Balance = {
  account: string | null;
  currency: string | null;
  amount: number;
};

/**
 * Pulls balances out of whatever the provider sent.
 *
 * Tolerant by design: the config is typed in by a person reading a provider's
 * documentation, and getting `recordsPath` slightly wrong should produce "no
 * balances found" rather than a crash — with the raw reply still visible in the
 * Test panel so they can see what the right path would be.
 */
export function readBalances(
  body: unknown,
  endpoint: EndpointConfig,
): Balance[] {
  const found = at(body, endpoint.recordsPath);
  const rows = Array.isArray(found) ? found : found ? [found] : [];
  const f = endpoint.fields ?? {};

  return (
    rows
      .map((row) => ({
        // Alternatives allowed here too, written "available|balance". Same
        // reason: a provider can name the same fact differently per row.
        amount: toNumber(pick(row, f.amount ?? 'amount')),
        account: toText(pick(row, f.account ?? 'account')),
        currency: toText(pick(row, f.currency ?? 'currency')),
      }))
      // A row whose amount could not be read is a mapping that does not fit, not
      // a balance of zero. Dropping it is right: a zero here would reach the desk
      // as a fact, and "no balances found" sends somebody to check the field path
      // where "0.00" sends them to ask the provider where their money went.
      .filter((b): b is Balance & { amount: number } => b.amount !== null)
  );
}

export type Txn = {
  id: string | null;
  amount: number | null;
  currency: string | null;
  /** The provider's own word for the state, verbatim. */
  status: string | null;
  /** As the provider wrote it, plus our reading of it when we could. */
  at: string | null;
  atISO: string | null;
  /**
   * When the money actually moved, if the provider says so separately.
   *
   * ForumPay stamps `inserted` when a payment is CREATED and `settled` when it
   * completes, and those can be days apart: a payment raised on the 31st that
   * confirms on the 2nd moved money on the 2nd. A balance anchored in between
   * has to place it by the second date or it never counts the payment at all.
   *
   * Null where the provider offers nothing better, and then the created date
   * stands in.
   */
  settledISO: string | null;
  /** The provider's cut, in the same currency as the amount. See fields.fee. */
  fee: number | null;
  reference: string | null;
  /** The provider's own word for the direction: "Buy", "Sell", "payout"… */
  direction: string | null;
  customer: string | null;
  /** The configured extra columns, as `Label` → value. */
  extras: Record<string, string | null>;
  /**
   * The record exactly as it arrived.
   *
   * Kept because a field nobody mapped today is the field a dispute turns on
   * next month, and re-fetching is not always possible — several providers
   * keep only ninety days. ForumPay's rows carry an original_invoice_amount,
   * a network fee and an exchange rate that no column here has a place for.
   */
  raw: unknown;
};

/**
 * Pulls a transaction list out of whatever the provider sent.
 *
 * Two things are deliberately different from readBalances.
 *
 * A row with no readable amount is KEPT, not dropped. For a balance an
 * unreadable number means the mapping is wrong and a zero would be a lie; for a
 * transaction list the row itself is evidence — "there is a payment here we
 * cannot read" is a finding worth seeing, and silently shortening a list that
 * gets compared against Paymaxis would hide exactly the discrepancy somebody
 * came to find.
 *
 * And the status is passed through untranslated. Every provider has its own
 * vocabulary — ForumPay says `confirmed`, Match2Pay says `DONE` — and mapping
 * them onto our own words here would put a guess between the desk and the
 * provider on the one question a dispute turns on.
 */
export function readTransactions(
  body: unknown,
  endpoint: EndpointConfig,
): Txn[] {
  const found = at(body, endpoint.recordsPath);
  const rows = Array.isArray(found) ? found : found ? [found] : [];
  const f = endpoint.fields ?? {};

  return rows.map((row) => {
    const raw = toText(pick(row, f.date ?? 'date'));
    // Only when configured. Guessing a field name here would be worse than
    // having none: a wrong guess silently moves payments in time.
    const settled = f.settled ? toText(pick(row, f.settled)) : null;
    return {
      id: toText(pick(row, f.id ?? 'id')),
      amount: toNumber(pick(row, f.amount ?? 'amount')),
      currency: toText(pick(row, f.currency ?? 'currency')),
      status: toText(pick(row, f.status ?? 'status')),
      at: raw,
      atISO: toISO(raw),
      settledISO: toISO(settled),
      // Absolute: a fee is a deduction whichever sign the provider writes it
      // with, and providers are not consistent. Subtracting a negative fee
      // would add money.
      fee: feeOf(pick(row, f.fee)),
      reference: toText(pick(row, f.reference ?? 'reference')),
      direction: toText(pick(row, f.direction ?? 'type')),
      customer: toText(pick(row, f.customer ?? 'customer')),
      extras: readExtras(row, f.extras),
      raw: row,
    };
  });
}

/**
 * The configured extra columns for one record.
 *
 * Exported because the ledger projects these from the stored JSON when a page
 * is read, rather than at sync time — so a column added today appears on rows
 * that arrived last week, with no re-sync and no call to the provider.
 */
export function readExtras(
  row: unknown,
  spec?: Record<string, string>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [labelText, path] of Object.entries(spec ?? {})) {
    out[labelText] = toText(pick(row, path));
  }
  return out;
}

/**
 * The first of several paths that actually holds something.
 *
 * Written `reference_no|pos_id`. One field name is not always enough, because a
 * provider can put the same fact in different places depending on the KIND of
 * row: ForumPay's Sell rows carry the reference in `reference_no` and leave
 * `pos_id` as the literal string "widget", while its Buy rows have no
 * `reference_no` at all and put the reference in `pos_id`. Either name alone
 * blanks out half the ledger.
 *
 * First NON-EMPTY wins, not first present — a provider that sends `""` for the
 * field it is not using is the common case, and "present but empty" is the same
 * fact as absent.
 *
 * Fields can also be JOINED, written `Transaction ID+Transaction Type`, and
 * that exists because of what happens to an id that is not unique. BEEM's
 * wallet export gives a payment and its network fee THE SAME Transaction ID —
 * 116 ids across 232 rows — so importing on that column alone would dedupe
 * every fee row into its payment, store half the file, and leave a balance
 * wrong by the whole of the fees with nothing on screen to say so. Joined, the
 * pair is unique for all 232.
 *
 * A join needs EVERY part filled. A missing part would silently produce the
 * same value for two different rows, which is the exact failure it is here to
 * prevent; so an incomplete join is skipped and the next alternative is tried.
 *
 * Alternatives are split before joins, so `a+b|c` reads "a joined to b, or
 * else c".
 */
export function pick(row: unknown, spec?: string): unknown {
  if (!spec) return undefined;
  for (const path of spec.split('|')) {
    const p = path.trim();
    if (!p) continue;

    if (p.includes('+')) {
      const parts = p
        .split('+')
        .map((x) => x.trim())
        .filter(Boolean);
      const values = parts.map((x) => at(row, x));
      if (!parts.length || values.some(isEmpty)) continue;
      return values.map((v) => String(v)).join(':');
    }

    const v = at(row, p);
    if (isEmpty(v)) continue;
    return v;
  }
  return undefined;
}

/** A fee as a positive magnitude, or null when there is none to read. */
function feeOf(v: unknown): number | null {
  const n = toNumber(v);
  return n === null ? null : Math.abs(n);
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  return typeof v === 'string' && v.trim() === '';
}

/**
 * A provider's timestamp as an instant, when it can be read as one.
 *
 * BOTH are kept — theirs verbatim and ours parsed — because these are written
 * in every format there is, and several are ambiguous. "2021-08-06 08:23:24"
 * carries no timezone at all, and reading it as UTC when the provider meant
 * local moves a payment across the 04:00 ops-day boundary and into the wrong
 * shift. When ours is wrong, theirs is still on screen to check against.
 */
function toISO(v: string | null): string | null {
  if (!v) return null;
  // A bare seconds epoch, which several providers send as a number-in-a-string.
  if (/^\d{10}$/.test(v)) return new Date(Number(v) * 1000).toISOString();
  if (/^\d{13}$/.test(v)) return new Date(Number(v)).toISOString();
  // "2021-08-06 08:23:24" is not what Date accepts everywhere; the T makes it so.
  const t = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(v) ? v.replace(' ', 'T') : v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    // Providers send "1,234.56", "1 234,56" and "1234.56". Separators are
    // stripped rather than guessed at, because a wrong guess here is a balance
    // out by a factor of a thousand.
    const cleaned = v.replace(/[^\d.,-]/g, '');
    const n = Number(cleaned.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toText(v: unknown): string | null {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : null;
}
