import { Logger } from '@nestjs/common';

/**
 * Read-only Paymaxis HTTP client.
 *
 * The keys we hold carry BOTH read and write permission — Paymaxis does not
 * issue read-only keys. So "read-only" is enforced here structurally rather
 * than by convention: this class exposes no way to express a method, a body, or
 * any verb other than GET. There is no code path from the dashboard to a write
 * endpoint.
 */
export class PaymaxisClient {
  private readonly log = new Logger('PaymaxisClient');

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly authHeader = 'X-Api-Key',
  ) {}

  /** Issues a GET and returns parsed JSON. The only request this class can make. */
  private async get(
    path: string,
    params: Record<string, string | number | undefined>,
  ): Promise<unknown> {
    const url = new URL(
      path.replace(/^\//, ''),
      this.baseUrl.replace(/\/?$/, '/'),
    );
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    });

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (/^authorization$/i.test(this.authHeader))
      headers.Authorization = `Bearer ${this.apiKey}`;
    else headers[this.authHeader] = this.apiKey;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(
          Number(process.env.PAYMAXIS_TIMEOUT_MS ?? 20000),
        ),
      });
    } catch (e) {
      // Distinguish "the host does not exist" from "the request failed". A wrong
      // PAYMAXIS_BASE_URL is the single most likely misconfiguration and its
      // native error ("fetch failed") says nothing useful. Note that
      // api.paymaxis.com does NOT exist — the host is app.paymaxis.com.
      const cause = (e as { cause?: { code?: string } }).cause?.code ?? '';
      if (cause === 'ENOTFOUND' || cause === 'EAI_AGAIN') {
        throw new Error(
          `Paymaxis host "${url.host}" does not resolve — check PAYMAXIS_BASE_URL. ` +
            `Run apps/api/scripts/discover-paymaxis.mjs to find the right one.`,
        );
      }
      throw new Error(
        `Paymaxis GET ${path} failed: ${(e as Error).message}${cause ? ` (${cause})` : ''}`,
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Never log the key or the full URL (it can carry identifiers).
      const hint =
        res.status === 401 || res.status === 403
          ? ' — key rejected, or the auth header name is wrong (PAYMAXIS_AUTH_HEADER)'
          : res.status === 404
            ? ' — path not found (PAYMAXIS_PAYMENTS_PATH); Paymaxis may not expose a list endpoint at all'
            : '';
      throw new Error(
        `Paymaxis GET ${path} -> HTTP ${res.status}${hint} ${body.slice(0, 200)}`,
      );
    }
    return res.json();
  }

  /**
   * An arbitrary read against the payments endpoint.
   *
   * Exists for the history probe, which has to try parameter names that are not
   * in the configuration precisely because nobody knows yet which ones work.
   * Still GET-only, like everything on this class.
   */
  async probe(params: Record<string, string | number | undefined>): Promise<{
    status: number;
    records: Record<string, unknown>[];
    hasMore?: boolean;
  }> {
    const path = process.env.PAYMAXIS_PAYMENTS_PATH ?? '/api/v1/payments';
    try {
      const json = (await this.get(path, params)) as Record<string, unknown> | unknown[];
      const records = extractRecords(json);
      const hasMore = !Array.isArray(json) ? (json?.hasMore as boolean | undefined) : undefined;
      return { status: 200, records, hasMore };
    } catch (e) {
      // The probe reports failures rather than throwing them: a 400 from one
      // candidate parameter is a result, not an outage.
      const m = /HTTP (\d{3})/.exec((e as Error).message ?? '');
      return { status: m ? Number(m[1]) : 0, records: [] };
    }
  }

  /**
   * One page of payments. Parameter and response field names come from config,
   * so adapting to the real API is a settings change rather than a code change.
   */
  async listPayments(opts: {
    updatedSince?: string;
    page?: number;
    limit?: number;
  }): Promise<{ records: Record<string, unknown>[]; hasMore: boolean }> {
    // Confirmed against the live API: GET /api/v1/payments, records under
    // "result". The singular /api/v1/payment (an earlier guess) returns 404.
    const path = process.env.PAYMAXIS_PAYMENTS_PATH ?? '/api/v1/payments';
    const limitParam = process.env.PAYMAXIS_LIMIT_PARAM ?? 'limit';
    // `offset` is the only pagination parameter the API honours. `page`, `skip`,
    // `after`, `startingAfter` and `startId` are all accepted and ignored, which
    // is why a page-numbered poller silently re-read the same records forever.
    const pageParam = process.env.PAYMAXIS_PAGE_PARAM ?? 'offset';
    const byOffset = (process.env.PAYMAXIS_PAGE_MODE ?? 'offset') === 'offset';

    const limit = opts.limit ?? Number(process.env.PAYMAXIS_LIMIT ?? 100);
    const page = opts.page ?? 0;
    const cursor = byOffset ? page * limit : page;

    const params: Record<string, string | number | undefined> = {
      [limitParam]: limit,
      // Omitted on the first request: offset=0 is the default anyway.
      [pageParam]: cursor || undefined,
    };

    // No date-range filter exists on this endpoint — nine candidate names were
    // all accepted and silently ignored. Sending one would be noise pretending
    // to be a filter, so it goes only when explicitly configured, ready for the
    // day they add one.
    const sinceParam = process.env.PAYMAXIS_SINCE_PARAM;
    if (sinceParam && opts.updatedSince) params[sinceParam] = opts.updatedSince;

    const json = (await this.get(path, params)) as Record<string, unknown> | unknown[];

    const records = extractRecords(json);
    // Paymaxis returns an explicit hasMore boolean; trust it over the guess.
    // The fallback — "a full page implies more" — is wrong at the boundary,
    // claiming another page whenever the last one happens to be exactly full.
    const reported = !Array.isArray(json) ? json?.hasMore : undefined;
    const hasMore = typeof reported === 'boolean' ? reported : records.length >= limit;
    return { records, hasMore };
  }
}

/**
 * Finds the array of records wherever the provider put it: at the root, under a
 * configured key, or under whichever key happens to hold an array of objects.
 */
export function extractRecords(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json as Record<string, unknown>[];
  if (!json || typeof json !== 'object') return [];
  const obj = json as Record<string, unknown>;

  const configured = process.env.PAYMAXIS_RECORDS_PATH;
  if (configured && Array.isArray(obj[configured])) {
    return obj[configured] as Record<string, unknown>[];
  }
  // "result" (singular) first — that is where Paymaxis actually puts the array.
  // It sat behind the plural "results" for a while, which never matched.
  for (const key of [
    'result',
    'content',
    'data',
    'items',
    'results',
    'payments',
    'records',
  ]) {
    if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
  }
  const anyArray = Object.values(obj).find(
    (v) => Array.isArray(v) && v.every((x) => x && typeof x === 'object'),
  );
  return (anyArray as Record<string, unknown>[]) ?? [];
}
