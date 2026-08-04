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
  private async get(path: string, params: Record<string, string | number | undefined>): Promise<unknown> {
    const url = new URL(path.replace(/^\//, ''), this.baseUrl.replace(/\/?$/, '/'));
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    });

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (/^authorization$/i.test(this.authHeader)) headers.Authorization = `Bearer ${this.apiKey}`;
    else headers[this.authHeader] = this.apiKey;

    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(Number(process.env.PAYMAXIS_TIMEOUT_MS ?? 20000)),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Never log the key or the full URL (it can carry identifiers).
      throw new Error(`Paymaxis GET ${path} -> HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    return res.json();
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
    const path = process.env.PAYMAXIS_PAYMENTS_PATH ?? '/api/v1/payment';
    const sinceParam = process.env.PAYMAXIS_SINCE_PARAM ?? 'updatedAtFrom';
    const pageParam = process.env.PAYMAXIS_PAGE_PARAM ?? 'page';
    const limitParam = process.env.PAYMAXIS_LIMIT_PARAM ?? 'limit';

    const json = (await this.get(path, {
      [sinceParam]: opts.updatedSince,
      [pageParam]: opts.page,
      [limitParam]: opts.limit ?? 100,
    })) as Record<string, unknown> | unknown[];

    const records = extractRecords(json);
    // Absent explicit paging metadata, a full page implies there may be more.
    const hasMore = records.length >= (opts.limit ?? 100);
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
  for (const key of ['content', 'data', 'items', 'results', 'payments', 'records']) {
    if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
  }
  const anyArray = Object.values(obj).find(
    (v) => Array.isArray(v) && v.every((x) => x && typeof x === 'object'),
  );
  return (anyArray as Record<string, unknown>[]) ?? [];
}
