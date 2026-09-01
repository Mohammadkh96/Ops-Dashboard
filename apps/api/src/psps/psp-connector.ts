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
  };
  /** Fixed query parameters this endpoint needs. */
  query?: Record<string, string>;
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
        amount: toNumber(at(row, f.amount ?? 'amount')),
        account: toText(at(row, f.account ?? 'account')),
        currency: toText(at(row, f.currency ?? 'currency')),
      }))
      // A row whose amount could not be read is a mapping that does not fit, not
      // a balance of zero. Dropping it is right: a zero here would reach the desk
      // as a fact, and "no balances found" sends somebody to check the field path
      // where "0.00" sends them to ask the provider where their money went.
      .filter((b): b is Balance & { amount: number } => b.amount !== null)
  );
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
