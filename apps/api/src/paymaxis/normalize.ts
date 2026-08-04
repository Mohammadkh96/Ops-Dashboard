/**
 * Maps a Paymaxis payment object onto our columns.
 *
 * Shared by the webhook receiver and the poller so both interpret a payment
 * identically. Field names are looked up from candidate lists rather than
 * hard-coded, because provider payloads differ from their own documentation and
 * change without notice.
 */

const SETTLED = /complete|success|settle|approv|paid|finish|confirm/i;
const FAILED = /declin|cancel|fail|reject|expire|error|void|chargeback/i;

/** Paymaxis shop -> jurisdiction. Each shop is its own merchant account. */
const DEFAULT_SHOP_ENTITIES: Record<string, string> = {
  '5141': 'Mauritius',
  '6321': 'Saint Lucia',
};

export function entityForShop(shop: string): string {
  if (!shop) return '';
  const map = { ...DEFAULT_SHOP_ENTITIES };
  const overrides = process.env.PAYMAXIS_SHOP_ENTITIES;
  if (overrides) {
    overrides.split(',').forEach((pair) => {
      const [k, v] = pair.split('=').map((x) => x.trim());
      if (k && v) map[k] = v;
    });
  }
  if (map[shop]) return map[shop];
  // Shops are also reported by name ("Cashier_Tradin_SL"), where the _SL suffix
  // is the jurisdiction marker — the rule the recon engine already uses.
  if (/_sl\b|saint\s*lucia/i.test(shop)) return 'Saint Lucia';
  if (/tradin/i.test(shop)) return 'Mauritius';
  return '';
}

/** Reads the first present key, case-insensitively, skipping nested objects. */
export function pick(obj: Record<string, unknown>, keys: string[]): string {
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    const real = lower.get(k.toLowerCase());
    if (real === undefined) continue;
    const v = obj[real];
    if (v === null || v === undefined || v === '' || typeof v === 'object') continue;
    return String(v);
  }
  return '';
}

export function num(v: string): number {
  const n = Number.parseFloat(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isNaN(n) ? 0 : n;
}

export type NormalizedPayment = {
  paymentId: string;
  reference: string;
  state: string;
  type: string;
  amount: number;
  currency: string;
  shop: string;
  entity: string;
  customer: string;
  occurredAt: Date | null;
  /** true = settled, false = failed, undefined = still in flight. */
  settled: boolean | undefined;
  /** Stable identity so the same payment state is never stored or shown twice. */
  dedupeKey: string;
};

/** Unwraps the common envelope shapes a provider might use. */
export function unwrapPayment(body: Record<string, unknown>): Record<string, unknown> {
  return (
    (body.payment as Record<string, unknown>) ??
    (body.data as Record<string, unknown>) ??
    body
  );
}

export function normalizePayment(inner: Record<string, unknown>): NormalizedPayment {
  const paymentId = pick(inner, ['id', 'paymentId', 'payment_id', 'transactionId']);
  const reference = pick(inner, [
    'referenceId', 'reference_id', 'reference', 'merchantReference', 'orderId',
  ]);
  const state = pick(inner, ['state', 'status', 'paymentState']);
  const type = pick(inner, ['type', 'paymentType', 'transactionType']);
  const amount = num(
    pick(inner, ['amountInShopBaseCurrency', 'amount', 'value', 'totalAmount']),
  );
  const currency = pick(inner, ['currency', 'currencyCode']);
  const shop = pick(inner, ['shop', 'shopId', 'shopName', 'shop_id']);
  const customer = pick(inner, [
    'customerReferenceId', 'customerEmail', 'customerAccountNumber', 'customer', 'customerId',
  ]);
  const occurred = pick(inner, ['updatedAt', 'updated', 'finalized', 'createdAt', 'created', 'timestamp']);
  const occurredAt =
    occurred && !Number.isNaN(Date.parse(occurred)) ? new Date(occurred) : null;

  return {
    paymentId,
    reference,
    state,
    type,
    amount,
    currency,
    shop,
    entity: entityForShop(shop),
    customer,
    occurredAt,
    settled: SETTLED.test(state) ? true : FAILED.test(state) ? false : undefined,
    // State is part of the identity: a payment legitimately appears again when
    // it moves PENDING -> COMPLETED, and that transition IS news. Re-polling
    // the same unchanged payment is not.
    dedupeKey: `paymaxis:${paymentId || reference}:${state}:${occurredAt?.toISOString() ?? ''}`,
  };
}

/** Maps a normalized payment onto the dashboard's live-feed item. */
export function toQueueItem(p: NormalizedPayment) {
  return {
    id: p.paymentId || p.reference || 'unknown',
    type: /withdraw/i.test(p.type) ? 'Withdrawal' : /refund/i.test(p.type) ? 'Refund' : 'Deposit',
    client: p.customer || '—',
    amount: p.amount ? `${p.currency || '$'}${p.amount.toLocaleString()}` : '—',
    status: (p.settled === true ? 'settled' : p.settled === false ? 'failed' : 'processing') as
      | 'settled'
      | 'failed'
      | 'processing',
  };
}
