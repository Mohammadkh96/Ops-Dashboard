/**
 * Every field Paymaxis records about a payment, in one place.
 *
 * The dashboard used to show nine of them. The rest were in the stored payload
 * all along — card brand, issuing country, billing address, crypto network,
 * lifetime deposit counts — but reaching them meant opening the raw JSON, which
 * is not something anyone does while a customer is on the phone.
 *
 * One catalogue serves the table's column picker, the detail drawer and the CSV
 * export, so a field cannot appear in one and be missing from another, and a
 * new field is added by adding a line here.
 *
 * Values are read through candidate key lists rather than fixed paths: provider
 * payloads disagree with their own documentation and change without notice, and
 * a missing field should read as empty rather than break the row.
 */

import { pick, providerLabel } from '../paymaxis/normalize';

export type FieldGroup =
  | 'payment'
  | 'amounts'
  | 'references'
  | 'customer'
  | 'clientTotals'
  | 'billing'
  | 'card'
  | 'crypto'
  | 'routing'
  | 'lifecycle';

export type FieldSpec = {
  key: string;
  label: string;
  group: FieldGroup;
  /** Shown by default in the table. Everything else is opt-in per user. */
  table?: boolean;
  align?: 'right';
  /**
   * Stripped from the payload on ingest, so it is always empty unless the
   * redaction list is changed. Declared here so the UI can say why it is blank
   * instead of leaving the reader to wonder whether the provider sent it.
   */
  redacted?: boolean;
};

/** Ordered: the table's column picker and the drawer both follow this. */
export const PAYMENT_FIELDS: FieldSpec[] = [
  // -- payment
  { key: 'reference', label: 'Reference', group: 'payment', table: true },
  { key: 'paymentId', label: 'Payment ID', group: 'payment' },
  { key: 'type', label: 'Type', group: 'payment', table: true },
  { key: 'stateLabel', label: 'State', group: 'payment', table: true },
  { key: 'methodLabel', label: 'Method', group: 'payment', table: true },
  { key: 'description', label: 'Description', group: 'payment' },
  { key: 'createdAt', label: 'Created', group: 'payment' },
  { key: 'updatedAt', label: 'Updated', group: 'payment' },
  { key: 'finalizedAt', label: 'Finalized', group: 'payment' },
  { key: 'time', label: 'Time', group: 'payment', table: true, align: 'right' },
  { key: 'settled', label: 'Settled', group: 'payment' },

  // -- amounts
  {
    key: 'amount',
    label: 'Amount',
    group: 'amounts',
    table: true,
    align: 'right',
  },
  { key: 'currency', label: 'Currency', group: 'amounts' },
  {
    key: 'amountInBaseCurrency',
    label: 'Amount in Base Currency',
    group: 'amounts',
    align: 'right',
  },
  { key: 'baseCurrency', label: 'Base Currency', group: 'amounts' },
  {
    key: 'amountInShopBaseCurrency',
    label: 'Amount in Shop Base Currency',
    group: 'amounts',
    align: 'right',
  },
  { key: 'shopBaseCurrency', label: 'Shop Base Currency', group: 'amounts' },
  {
    key: 'customerAmount',
    label: 'Customer Amount',
    group: 'amounts',
    align: 'right',
  },
  { key: 'customerCurrency', label: 'Customer Currency', group: 'amounts' },
  { key: 'commission', label: 'Commission', group: 'amounts', align: 'right' },
  {
    key: 'refundedAmount',
    label: 'Refunded Amount',
    group: 'amounts',
    align: 'right',
  },

  // -- references
  { key: 'externalId', label: 'External ID', group: 'references' },
  { key: 'externalRefs', label: 'External Refs', group: 'references' },
  {
    key: 'externalResultCode',
    label: 'External Result Code',
    group: 'references',
  },
  { key: 'parentPaymentId', label: 'Parent Payment ID', group: 'references' },
  {
    key: 'parentReferenceId',
    label: 'Parent Reference ID',
    group: 'references',
  },
  {
    key: 'additionalParameters',
    label: 'Additional Parameters',
    group: 'references',
  },
  { key: 'returnUrl', label: 'Return URL', group: 'references' },

  // -- customer
  {
    key: 'customer',
    label: 'Customer Reference ID',
    group: 'customer',
    table: true,
  },
  // Not fields on the payment: aggregates over everything held for the client
  // on the row, served by POST /clients/totals. Catalogued here so the column
  // picker offers them like any other column — the alternative was a second,
  // separate list of columns that the picker did not know about.
  {
    key: 'clientTotalDeposits',
    label: 'Client · Total Deposits',
    group: 'clientTotals',
    align: 'right',
    table: true,
  },
  {
    key: 'clientTotalWithdrawals',
    label: 'Client · Total Withdrawals',
    group: 'clientTotals',
    align: 'right',
    table: true,
  },
  { key: 'customerEmail', label: 'Customer Email', group: 'customer' },
  { key: 'customerPhone', label: 'Customer Phone', group: 'customer' },
  {
    key: 'customerAccountNumber',
    label: 'Customer Account Number',
    group: 'customer',
  },
  {
    key: 'customerFirstName',
    label: 'Customer First Name',
    group: 'customer',
    redacted: true,
  },
  {
    key: 'customerLastName',
    label: 'Customer Last Name',
    group: 'customer',
    redacted: true,
  },
  {
    key: 'dateOfBirth',
    label: 'Date of Birth',
    group: 'customer',
    redacted: true,
  },
  { key: 'documentNumber', label: 'Document Number', group: 'customer' },
  {
    key: 'citizenshipCountry',
    label: 'Citizenship Country',
    group: 'customer',
  },
  { key: 'kycStatus', label: 'Customer KYC Status', group: 'customer' },
  {
    key: 'instrumentKycStatus',
    label: 'Payment Instrument KYC Status',
    group: 'customer',
  },
  { key: 'ipAddress', label: 'IP Address', group: 'customer', redacted: true },
  { key: 'ipCountry', label: 'IP Country', group: 'customer' },
  {
    key: 'dateOfFirstDeposit',
    label: 'Date of First Deposit',
    group: 'customer',
  },
  {
    key: 'depositsCount',
    label: 'Lifetime Number of Deposits',
    group: 'customer',
    align: 'right',
  },
  {
    key: 'depositsAmount',
    label: 'Lifetime Deposits Amount',
    group: 'customer',
    align: 'right',
  },
  {
    key: 'withdrawalsCount',
    label: 'Lifetime Number of Withdrawals',
    group: 'customer',
    align: 'right',
  },
  {
    key: 'withdrawalsAmount',
    label: 'Lifetime Withdrawals Amount',
    group: 'customer',
    align: 'right',
  },

  // -- billing
  { key: 'billingCountry', label: 'Billing Country', group: 'billing' },
  { key: 'billingState', label: 'Billing State', group: 'billing' },
  { key: 'billingCity', label: 'Billing City', group: 'billing' },
  {
    key: 'billingAddressLine1',
    label: 'Billing Address Line 1',
    group: 'billing',
  },
  {
    key: 'billingAddressLine2',
    label: 'Billing Address Line 2',
    group: 'billing',
  },
  { key: 'billingPostalCode', label: 'Billing Postal Code', group: 'billing' },

  // -- card
  { key: 'cardBrand', label: 'Card Brand', group: 'card' },
  { key: 'cardType', label: 'Card Type', group: 'card' },
  { key: 'cardIssuingCountry', label: 'Card Issuing Country', group: 'card' },
  {
    key: 'cardIssuingOrganization',
    label: 'Card Issuing Organization',
    group: 'card',
  },
  {
    key: 'cardholderName',
    label: 'Cardholder Name',
    group: 'card',
    redacted: true,
  },

  // -- crypto
  {
    key: 'cryptoAmount',
    label: 'Crypto Amount',
    group: 'crypto',
    align: 'right',
  },
  { key: 'cryptoCurrency', label: 'Crypto Currency', group: 'crypto' },
  { key: 'cryptoNetwork', label: 'Network', group: 'crypto' },
  { key: 'cryptoSourceAddress', label: 'Source Address', group: 'crypto' },
  {
    key: 'cryptoDestinationAddress',
    label: 'Destination Address',
    group: 'crypto',
  },
  { key: 'cryptoDestinationTag', label: 'Destination Tag', group: 'crypto' },
  { key: 'cryptoTxHash', label: 'Transaction Hash', group: 'crypto' },

  // -- routing
  { key: 'psp', label: 'PSP', group: 'routing', table: true },
  { key: 'provider', label: 'Provider', group: 'routing' },
  { key: 'terminal', label: 'Terminal', group: 'routing' },
  { key: 'connectorId', label: 'Connector ID', group: 'routing' },
  { key: 'shop', label: 'Shop', group: 'routing' },
  { key: 'entity', label: 'Entity', group: 'routing' },
  { key: 'routingGroup', label: 'Routing Group', group: 'routing' },

  // -- lifecycle
  { key: 'errorCode', label: 'Error Code', group: 'lifecycle' },
  { key: 'errorMessage', label: 'Error Reason', group: 'lifecycle' },
  { key: 'webhookStatus', label: 'Webhook Status', group: 'lifecycle' },
  { key: 'recurringStart', label: 'Start Recurring', group: 'lifecycle' },
  {
    key: 'recurringToken',
    label: 'Recurring Token',
    group: 'lifecycle',
    redacted: true,
  },
  { key: 'ingestedVia', label: 'Ingested Via', group: 'lifecycle' },
  { key: 'signatureOk', label: 'Signature Verified', group: 'lifecycle' },
];

export const GROUP_LABELS: Record<FieldGroup, string> = {
  payment: 'Payment',
  amounts: 'Amounts',
  references: 'References',
  customer: 'Customer',
  billing: 'Billing address',
  card: 'Card',
  crypto: 'Crypto',
  routing: 'Routing',
  lifecycle: 'Lifecycle',
  clientTotals: 'Client totals (all held)',
};

export type FieldValues = Record<string, string | number | boolean | null>;

const REDACTED = '«redacted»';

/** Empty, and empty for the same reason the ingest says: not "unknown". */
function clean(v: string): string | null {
  const s = v.trim();
  if (!s || s === REDACTED) return null;
  return s;
}

function str(payload: Record<string, unknown>, keys: string[]): string | null {
  return clean(pick(payload, keys));
}

function numOrNull(
  payload: Record<string, unknown>,
  keys: string[],
): number | null {
  const s = str(payload, keys);
  if (s === null) return null;
  const n = Number(s.replace(/[^0-9.-]/g, ''));
  return Number.isNaN(n) ? null : n;
}

/**
 * Paymaxis returns some structured values as a JSON string rather than an
 * object — externalRefs and additionalParameters both arrive that way, and the
 * crypto destination address for a payout lives inside them. Parsed so those
 * fields can be read individually instead of only as a wall of JSON.
 */
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (s.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(s);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        /* not JSON after all: treated as opaque text by the caller */
      }
    }
  }
  return {};
}

function flatten(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return clean(value);
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return clean(JSON.stringify(value));
}

/** The columns the ingest maps onto its own fields, passed in from the row. */
export type MappedRow = {
  id: string;
  paymentId: string | null;
  reference: string | null;
  externalId: string | null;
  parentPaymentId: string | null;
  cryptoTxHash: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  customer: string | null;
  entity: string | null;
  shop: string | null;
  psp: string | null;
  terminal: string | null;
  currency: string | null;
  amount: number;
  type: string | null;
  state: string | null;
  source: string;
  signatureOk: boolean;
  occurredAt: Date | null;
  receivedAt: Date;
  payload: unknown;
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * Every catalogued field for one payment.
 *
 * Mapped columns win over the payload where both exist: the ingest has already
 * resolved the PSP from the terminal and the jurisdiction from the shop, and
 * those resolutions are what the rest of the dashboard groups by.
 */
export function paymentFieldValues(r: MappedRow): FieldValues {
  const payload = (r.payload ?? {}) as Record<string, unknown>;
  const customer = asRecord(payload.customer);
  const billing = asRecord(customer.billingAddress ?? payload.billingAddress);
  const card = asRecord(payload.cardData ?? payload.card);
  const refs = asRecord(payload.externalRefs);
  const extra = asRecord(payload.additionalParameters);
  // The crypto details for a payout are spread across both bags.
  const crypto = { ...extra, ...refs };

  const state = r.state ?? '';
  const method = str(payload, ['paymentMethod', 'method']);

  return {
    // payment
    reference: r.paymentId || r.reference || r.externalId || r.id,
    paymentId: r.paymentId,
    type: providerLabel(r.type),
    stateLabel: providerLabel(state),
    methodLabel: providerLabel(method),
    description: str(payload, ['description']),
    createdAt: str(payload, ['createdAt', 'created']) ?? iso(r.occurredAt),
    updatedAt: str(payload, ['updatedAt', 'updated']),
    finalizedAt: str(payload, ['finalizedAt', 'finalized', 'completedAt']),
    time: iso(r.occurredAt ?? r.receivedAt),
    settled: str(payload, ['settled']),

    // amounts
    amount: Math.abs(r.amount),
    currency: r.currency,
    amountInBaseCurrency: numOrNull(payload, ['amountInBaseCurrency']),
    baseCurrency: str(payload, ['baseCurrency']),
    amountInShopBaseCurrency: numOrNull(payload, ['amountInShopBaseCurrency']),
    shopBaseCurrency: str(payload, ['shopBaseCurrency']),
    customerAmount: numOrNull(payload, ['customerAmount']),
    customerCurrency: str(payload, ['customerCurrency']),
    commission: numOrNull(payload, ['commission', 'commissionAmount']),
    refundedAmount: numOrNull(payload, ['refundedAmount']),

    // references
    externalId: r.externalId,
    externalRefs: flatten(payload.externalRefs),
    externalResultCode: str(payload, ['externalResultCode']),
    parentPaymentId: r.parentPaymentId,
    parentReferenceId: str(payload, ['parentReferenceId']),
    additionalParameters: flatten(payload.additionalParameters),
    returnUrl: str(payload, ['returnUrl']),

    // customer
    customer: r.customer,
    customerEmail: str(customer, ['email']) ?? str(payload, ['customerEmail']),
    customerPhone: str(customer, ['phone']) ?? str(payload, ['customerPhone']),
    customerAccountNumber:
      str(customer, ['accountNumber']) ??
      str(payload, ['customerAccountNumber']),
    customerFirstName: str(customer, ['firstName', 'givenName']),
    customerLastName: str(customer, ['lastName', 'surname']),
    dateOfBirth: str(customer, ['dateOfBirth', 'birthDate']),
    documentNumber: str(customer, ['documentNumber']),
    citizenshipCountry: str(customer, [
      'citizenshipCountryCode',
      'citizenshipCountry',
    ]),
    kycStatus: providerLabel(str(customer, ['kycStatus'])),
    instrumentKycStatus: providerLabel(
      str(customer, ['paymentInstrumentKycStatus']) ??
        str(payload, ['paymentInstrumentKycStatus']),
    ),
    ipAddress: str(customer, ['ip', 'ipAddress']),
    ipCountry: str(customer, ['ipCountry']) ?? str(payload, ['ipCountry']),
    dateOfFirstDeposit: str(customer, ['dateOfFirstDeposit']),
    depositsCount: numOrNull(customer, [
      'depositsCount',
      'lifetimeNumberOfDeposits',
    ]),
    depositsAmount: numOrNull(customer, [
      'depositsAmount',
      'lifetimeDepositsAmount',
    ]),
    withdrawalsCount: numOrNull(customer, [
      'withdrawalsCount',
      'lifetimeNumberOfWithdrawals',
    ]),
    withdrawalsAmount: numOrNull(customer, [
      'withdrawalsAmount',
      'lifetimeWithdrawalsAmount',
    ]),

    // billing
    billingCountry: str(billing, ['countryCode', 'country']),
    billingState: str(billing, ['state']),
    billingCity: str(billing, ['city']),
    billingAddressLine1: str(billing, ['addressLine1', 'address']),
    billingAddressLine2: str(billing, ['addressLine2']),
    billingPostalCode: str(billing, ['postalCode', 'zip']),

    // card
    cardBrand: providerLabel(str(card, ['brand', 'cardBrand'])),
    cardType: providerLabel(str(card, ['type', 'cardType'])),
    cardIssuingCountry: str(card, ['issuingCountry', 'issuerCountry']),
    cardIssuingOrganization: str(card, [
      'issuingOrganization',
      'issuer',
      'bank',
    ]),
    cardholderName: str(card, ['cardholderName', 'holder']),

    // crypto
    cryptoAmount: numOrNull(crypto, ['cryptoAmount']),
    cryptoCurrency: str(crypto, ['cryptoCurrency', 'providerCryptoCurrency']),
    cryptoNetwork: str(crypto, ['cryptoNetwork', 'network']),
    cryptoSourceAddress: str(crypto, ['cryptoSourceAddress', 'sourceAddress']),
    cryptoDestinationAddress: str(crypto, [
      'cryptoDestinationAddress',
      'destinationAddress',
      'address',
    ]),
    cryptoDestinationTag: str(crypto, [
      'cryptoDestinationTag',
      'destinationTag',
    ]),
    cryptoTxHash: r.cryptoTxHash ?? str(crypto, ['transactionHash', 'txHash']),

    // routing
    psp: r.psp,
    provider: str(payload, ['provider']),
    terminal: r.terminal,
    connectorId: str(payload, ['connectorId']),
    shop: r.shop ?? str(payload, ['shop', 'shopName']),
    entity: r.entity,
    routingGroup:
      str(customer, ['routingGroup']) ?? str(payload, ['routingGroup']),

    // lifecycle
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    webhookStatus: providerLabel(str(payload, ['webhookStatus'])),
    recurringStart: str(payload, ['startRecurring', 'recurringStart']),
    recurringToken: str(payload, ['recurringToken']),
    // Three sources now, not two. An imported row reading "Webhook" would say
    // the provider pushed us a signed callback for a payment that actually came
    // off a spreadsheet — and this column exists precisely to answer "where did
    // this figure come from?".
    ingestedVia:
      r.source === 'poll'
        ? 'API poll'
        : r.source === 'import'
          ? 'File import'
          : 'Webhook',
    signatureOk: r.signatureOk,
  };
}
