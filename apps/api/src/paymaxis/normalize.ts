/**
 * Maps a Paymaxis payment object onto our columns.
 *
 * Shared by the webhook receiver and the poller so both interpret a payment
 * identically. Field names are looked up from candidate lists rather than
 * hard-coded, because provider payloads differ from their own documentation and
 * change without notice.
 */

import type { LiveTick } from '../live/live.types';

const SETTLED = /complete|success|settle|approv|paid|finish|confirm/i;
const FAILED = /declin|cancel|fail|reject|expire|error|void|chargeback/i;

/** Shared state predicates, so the dashboard classifies exactly as the
 *  ingest does. */
export const isSettledState = (state: string) => SETTLED.test(state ?? '');
export const isFailedState = (state: string) => FAILED.test(state ?? '');

/**
 * The provider's own name for a value, written the way Paymaxis writes it.
 *
 * Used for both payment states and payment methods, which had the same defect
 * for the same reason.
 *
 * The dashboard collapses states into four colours — approved, declined,
 * pending, processing — which is right for scanning a list and wrong for
 * reading a row. AWAITING_WEBHOOK, CHECKOUT and RECONCILIATION all landed on
 * "Pending", so a payment waiting on a callback from the PSP looked identical
 * to one the customer had not finished paying for. Those need different
 * actions from whoever is on the desk.
 *
 * Only shapes what is already there: underscores become spaces and SHOUTING
 * becomes Title Case, but a value the provider already wrote for humans is
 * passed through untouched. Nothing is renamed or mapped, so a state Paymaxis
 * adds tomorrow shows up under its real name rather than as "Unknown".
 */
export function providerLabel(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  const spaced = raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (/[a-z]/.test(spaced)) return spaced;
  return spaced
    .split(' ')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}

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
    .reduce<unknown>(
      (o, k) =>
        o && typeof o === 'object'
          ? (o as Record<string, unknown>)[k]
          : undefined,
      obj,
    );
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
    if (v === null || v === undefined || v === '' || typeof v === 'object')
      continue;
    return String(v);
  }
  return '';
}

/**
 * Parses a provider timestamp as an instant in UTC.
 *
 * Paymaxis returns "2026-08-17T10:22:21" — no Z, no offset. JavaScript reads a
 * bare date-time as LOCAL time, so on a UTC+3 host every payment was recorded
 * three hours early, and on a UTC-5 host it would be five hours late. The same
 * data therefore meant different things depending on where the poller ran.
 *
 * It also broke the poller silently: the watermark is compared against these
 * timestamps, so a shift into the past meant it never advanced.
 *
 * Payment APIs quote UTC unless they say otherwise, so a bare timestamp gets an
 * explicit Z. Anything that already carries a zone is left exactly as it is.
 */
export function parseInstant(value: string): Date | null {
  const s = (value ?? '').trim();
  if (!s) return null;
  const bare = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s);
  const t = Date.parse(bare ? `${s.replace(' ', 'T')}Z` : s);
  return Number.isNaN(t) ? null : new Date(t);
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
export function unwrapPayment(
  body: Record<string, unknown>,
): Record<string, unknown> {
  return (
    (body.payment as Record<string, unknown>) ??
    (body.data as Record<string, unknown>) ??
    body
  );
}

export function normalizePayment(
  inner: Record<string, unknown>,
): NormalizedPayment {
  const paymentId = pick(inner, [
    'id',
    'paymentId',
    'payment_id',
    'transactionId',
  ]);
  const reference = pick(inner, [
    'referenceId',
    'reference_id',
    'reference',
    'merchantReference',
    'orderId',
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
  const externalId = pick(inner, [
    'externalId',
    'externalRefs.paymentId',
    'external_id',
  ]);
  const terminal = pick(inner, ['terminalName', 'terminal', 'connectorName']);
  // A refund carries the payment it reverses; without this a refund cannot be
  // tied back to the deposit it belongs to.
  const parentPaymentId = pick(inner, [
    'parentPaymentId',
    'parentPaymentID',
    'parentId',
  ]);
  // Crypto payments settle on-chain; the hash is what a crypto PSP's export is
  // keyed on, so it is the join for those providers.
  const cryptoTxHash = pick(inner, [
    'externalRefs.cryptoTransactionHash',
    'cryptoTransactionHash',
    'additionalParameters.cryptoTransactionHash',
    'hash',
  ]);
  // Why a payment failed is the most actionable thing on a declined row:
  // "Declined by 3DS" and "insufficient funds" call for completely different
  // responses. externalResultCode carries the acquirer's own detail and is used
  // when the provider gives no friendly message.
  const errorCode = pick(inner, ['errorCode', 'error_code', 'resultCode']);
  const errorMessage =
    pick(inner, [
      'errorMessage',
      'error_message',
      'declineReason',
      'resultDescription',
    ]) ||
    pick(inner, ['externalResultCode']).split('|').slice(1).join('|').trim();
  // The customer block is NESTED in the real payload, so flat names alone
  // silently yielded nothing.
  const customer = pick(inner, [
    'customer.referenceId',
    'customerReferenceId',
    'customer.email',
    'customerEmail',
    'customer.accountNumber',
    'customerAccountNumber',
    'customerId',
  ]);
  const occurred = pick(inner, [
    'updatedAt',
    'updated',
    'finalized',
    'createdAt',
    'created',
    'timestamp',
  ]);
  const occurredAt = parseInstant(occurred);

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
    settled: SETTLED.test(state)
      ? true
      : FAILED.test(state)
        ? false
        : undefined,
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
export const DEFAULT_REDACT_KEYS = [
  'dateOfBirth',
  'birthDate',
  'ip',
  'ipAddress',
  'cardholderName',
  'holder',
  'givenName',
  'surname',
  'firstName',
  'lastName',
  'cardExpiryMonth',
  'cardExpiryYear',
  'expiryMonth',
  'expiryYear',
  'cardToken',
  'recurringToken',
  'threeDSecure',
  'verificationId',
];

export function redactPayload(value: unknown): unknown {
  if (process.env.PAYMAXIS_STORE_RAW === 'full') return value;
  const extra = (process.env.PAYMAXIS_REDACT_KEYS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const deny = new Set(
    [...DEFAULT_REDACT_KEYS, ...extra].map((k) => k.toLowerCase()),
  );

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
/**
 * Maps a payment to the dashboard's feed row.
 *
 * Takes only the fields it reads rather than a whole NormalizedPayment, so a row
 * read back out of the database can be mapped by the same function the ingest
 * path uses — one definition of what a feed row looks like.
 */
export type QueueItemSource = Pick<
  NormalizedPayment,
  | 'paymentId'
  | 'reference'
  | 'type'
  | 'customer'
  | 'amount'
  | 'currency'
  | 'settled'
  | 'state'
>;

// Annotated rather than inferred: the status ternary infers as `string` on its
// own, which then fails to satisfy LiveTick's status union at every call site.
export function toQueueItem(p: QueueItemSource): LiveTick['queueItem'] {
  return {
    id: p.paymentId || p.reference || 'unknown',
    type: /withdraw/i.test(p.type)
      ? 'Withdrawal'
      : /refund/i.test(p.type)
        ? 'Refund'
        : 'Deposit',
    client: p.customer || '—',
    amount: p.amount ? `${p.currency || '$'}${p.amount.toLocaleString()}` : '—',
    status:
      p.settled === true
        ? 'settled'
        : p.settled === false
          ? 'failed'
          : 'processing',
    stateLabel: providerLabel(p.state),
  };
}
