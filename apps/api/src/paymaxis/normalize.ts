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

/** Shared state predicates, so the dashboard classifies exactly as the
 *  ingest does. */
export const isSettledState = (state: string) => SETTLED.test(state ?? '');
export const isFailedState = (state: string) => FAILED.test(state ?? '');

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

/**
 * Terminal name -> PSP. Paymaxis names the terminal, not the provider:
 * "Paystrax_Tradin SL", "MT_Tradin SL" (MatchTrade, i.e. Match2pay),
 * "ForumPay_Tradin SL". Resolving it gives live data the same PSP dimension the
 * reconciliation uses, so the two can be compared.
 */
const TERMINAL_PSP: [RegExp, string][] = [
  [/paystrax/i, 'Paystrax'],
  [/forumpay|forum/i, 'ForumPay'],
  [/\bmt[_\s-]|matchtrade|match2pay/i, 'Match2pay'],
  [/virtualpay/i, 'VirtualPay'],
  [/beem/i, 'Beem'],
  [/rapyd/i, 'Rapyd'],
  [/hero/i, 'Hero Payments'],
  [/limepay|lime/i, 'LimePay'],
];

export function pspForTerminal(terminal: string): string {
  if (!terminal) return '';
  for (const [re, name] of TERMINAL_PSP) if (re.test(terminal)) return name;
  // Unknown terminal: fall back to its leading token rather than inventing a
  // name, so a new provider shows up as itself instead of silently as "other".
  return terminal.split(/[_\s]/)[0];
}

function deepGet(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/**
 * Reads the first present key. Accepts dotted paths, because the real payload
 * nests the things we need — the customer reference lives at
 * `customer.referenceId`, not at a flat `customerReferenceId`.
 */
export function pick(obj: Record<string, unknown>, keys: string[]): string {
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    let v: unknown;
    if (k.includes('.')) v = deepGet(obj, k);
    else {
      const real = lower.get(k.toLowerCase());
      if (real === undefined) continue;
      v = obj[real];
    }
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
  /** The PSP's own id for this payment — the link to a PSP settlement file. */
  externalId: string;
  /** Terminal/connector name, e.g. "Paystrax_Tradin SL" — identifies the PSP. */
  terminal: string;
  /** PSP resolved from the terminal, e.g. "Paystrax", "Match2pay", "ForumPay". */
  psp: string;
  /** For a REFUND, the payment being refunded. */
  parentPaymentId: string;
  /** On-chain hash for a crypto payment — the link to a crypto PSP's export. */
  cryptoTxHash: string;
  /** Provider error code on a failure, e.g. "5.00". */
  errorCode: string;
  /** Human-readable failure reason, e.g. "Declined by 3DS". */
  errorMessage: string;
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
  const shop = pick(inner, ['shopName', 'shop', 'shopId', 'shop_id']);
  // externalId is the PSP's id for the same payment (Paymaxis externalId ==
  // Paystrax UniqueId), which is what links live data to a PSP settlement file.
  const externalId = pick(inner, ['externalId', 'externalRefs.paymentId', 'external_id']);
  const terminal = pick(inner, ['terminalName', 'terminal', 'connectorName']);
  // A refund carries the payment it reverses; without this a refund cannot be
  // tied back to the deposit it belongs to.
  const parentPaymentId = pick(inner, ['parentPaymentId', 'parentPaymentID', 'parentId']);
  // Crypto payments settle on-chain; the hash is what a crypto PSP's export is
  // keyed on, so it is the join for those providers.
  const cryptoTxHash = pick(inner, [
    'externalRefs.cryptoTransactionHash', 'cryptoTransactionHash',
    'additionalParameters.cryptoTransactionHash', 'hash',
  ]);
  // Why a payment failed is the most actionable thing on a declined row:
  // "Declined by 3DS" and "insufficient funds" call for completely different
  // responses. externalResultCode carries the acquirer's own detail and is used
  // when the provider gives no friendly message.
  const errorCode = pick(inner, ['errorCode', 'error_code', 'resultCode']);
  const errorMessage =
    pick(inner, ['errorMessage', 'error_message', 'declineReason', 'resultDescription']) ||
    pick(inner, ['externalResultCode']).split('|').slice(1).join('|').trim();
  // The customer block is NESTED in the real payload, so flat names alone
  // silently yielded nothing.
  const customer = pick(inner, [
    'customer.referenceId', 'customerReferenceId',
    'customer.email', 'customerEmail',
    'customer.accountNumber', 'customerAccountNumber', 'customerId',
  ]);
  const occurred = pick(inner, ['updatedAt', 'updated', 'finalized', 'createdAt', 'created', 'timestamp']);
  const occurredAt =
    occurred && !Number.isNaN(Date.parse(occurred)) ? new Date(occurred) : null;

  return {
    paymentId,
    externalId,
    terminal,
    psp: pspForTerminal(terminal),
    parentPaymentId,
    cryptoTxHash,
    errorCode,
    errorMessage,
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

/**
 * Strips personal data from a payload before it is stored.
 *
 * Real payloads carry date of birth, IP address, cardholder name, card expiry
 * and 3-D Secure material. None of that is needed to run an operations
 * dashboard or a reconciliation, and storing it turns this database into a
 * personal-data store with the retention and access obligations that follow —
 * so it is removed on the way in rather than guarded afterwards.
 *
 * Keys are matched by NAME anywhere in the object, so a provider moving a field
 * cannot quietly reintroduce it. Set PAYMAXIS_STORE_RAW=full to keep everything
 * (only sensible while debugging), or list your own keys in
 * PAYMAXIS_REDACT_KEYS.
 */
const DEFAULT_REDACT_KEYS = [
  'dateOfBirth', 'birthDate', 'ip', 'ipAddress',
  'cardholderName', 'holder', 'givenName', 'surname', 'firstName', 'lastName',
  'cardExpiryMonth', 'cardExpiryYear', 'expiryMonth', 'expiryYear',
  'cardToken', 'recurringToken', 'threeDSecure', 'verificationId',
];

export function redactPayload(value: unknown): unknown {
  if (process.env.PAYMAXIS_STORE_RAW === 'full') return value;
  const extra = (process.env.PAYMAXIS_REDACT_KEYS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const deny = new Set([...DEFAULT_REDACT_KEYS, ...extra].map((k) => k.toLowerCase()));

  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, val]) =>
          deny.has(k.toLowerCase()) ? [k, '«redacted»'] : [k, walk(val)],
        ),
      );
    }
    return v;
  };
  return walk(value);
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
