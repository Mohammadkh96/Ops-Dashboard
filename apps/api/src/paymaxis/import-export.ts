/**
 * Payments from a file exported out of the Paymaxis console.
 *
 * The merchant API serves a rolling 24 hours — measured, on both shops. The
 * console shows everything, but it is an Oracle APEX application with its own
 * session: every request carries a session instance, a signed plugin token and
 * a CSRF salt that die when the login does. Driving that from a server would be
 * automating somebody's back office, and it would break the first time they
 * logged out.
 *
 * What the console CAN do is export the worksheet. That file is a normal
 * download, it contains the whole period the operator selected, and it needs
 * nobody's permission — so it is the way the history gets in.
 *
 * Rows land in the same table as polled payments, keyed the same way, so an
 * imported payment and a polled one are the same record: re-importing a period
 * that overlaps what is already held adds nothing, and a payment that later
 * moves state still arrives through the poll as its own row.
 */

import {
  DEFAULT_REDACT_KEYS,
  entityForShop,
  paymentIdentity,
  pspForTerminal,
} from './normalize';

export type ExportRow = Record<string, unknown>;

/** Punctuation- and case-insensitive key, so "Card Holder" == "cardholderName". */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export type MappedImport = {
  paymentId: string;
  reference: string;
  externalId: string;
  parentPaymentId: string;
  terminal: string;
  psp: string;
  shop: string;
  entity: string;
  state: string;
  type: string;
  amount: number;
  currency: string;
  customer: string;
  errorCode: string;
  errorMessage: string;
  occurredAt: Date | null;
  dedupeKey: string;
};

/** Header lookup that ignores case, spaces and punctuation. */
function field(row: ExportRow, names: string[]): string {
  const index = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) index.set(norm(k), v);
  for (const n of names) {
    const v = index.get(norm(n));
    // Only a cell that IS a value. An object or an array stringifies to
    // "[object Object]", which is a perfectly good-looking reference id right
    // up until somebody searches for the payment it belongs to.
    if (
      typeof v !== 'string' &&
      typeof v !== 'number' &&
      typeof v !== 'boolean'
    ) {
      continue;
    }
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

/**
 * A number as the export writes it.
 *
 * Exports quote thousands and decimals by locale, so "1.500,00" and "1,500.00"
 * both occur and mean the same money. The rightmost separator is the decimal
 * point — the rule the reconciliation engine already uses, and the one that
 * stops €1,500 being read as €1.50.
 */
export function parseAmount(raw: string): number {
  const s = raw.replace(/[^\d.,-]/g, '').trim();
  if (!s) return 0;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let normalized = s;
  if (lastComma > -1 && lastDot > -1) {
    normalized =
      lastComma > lastDot
        ? s.replace(/\./g, '').replace(',', '.')
        : s.replace(/,/g, '');
  } else if (lastComma > -1 || lastDot > -1) {
    // One separator, and no second one to say which kind it is. Money is
    // written with two decimals or none, so a separator followed by exactly
    // three digits is a thousands separator — "1,500" and "1.500" are both
    // fifteen hundred — and anything else is a decimal point ("12,50",
    // "12.5"). The rule has to hold for BOTH characters: applying it only to
    // the comma read the European "1.500" as one and a half.
    const sep = lastComma > -1 ? ',' : '.';
    const thousands = new RegExp(`\\${sep}\\d{3}$`).test(s);
    normalized = thousands ? s.split(sep).join('') : s.split(sep).join('.');
  }
  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A timestamp as the export writes it, always read as UTC.
 *
 * Accepts ISO, "YYYY-MM-DD HH:mm:ss" and slash dates. A slash date is read
 * DAY-first — the European convention this provider and this merchant both use
 * — EXCEPT when the first number cannot be a day, which settles it either way.
 * The import reports the span it read so a misread format is visible
 * immediately rather than silently filing a year of payments in the wrong month.
 */
export function parseWhen(raw: string): Date | null {
  const s = raw.trim();
  if (!s) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(
    s,
  );
  if (iso) {
    const [, y, mo, d, h, mi, sec] = iso;
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(sec ?? 0)));
  }
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    return new Date(Date.UTC(+y, +mo - 1, +d));
  }
  const slash =
    /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(
      s,
    );
  if (slash) {
    const [, a, b, y, h, mi, sec] = slash;
    const first = +a;
    const second = +b;
    // >12 can only be a day, whichever convention the file uses.
    const dayFirst = first > 12 ? true : second > 12 ? false : true;
    const day = dayFirst ? first : second;
    const month = dayFirst ? second : first;
    return new Date(
      Date.UTC(+y, month - 1, day, +(h ?? 0), +(mi ?? 0), +(sec ?? 0)),
    );
  }
  // Any other all-numeric date is REFUSED rather than guessed. "04/03/26" is
  // the case that matters: it misses the four-digit pattern above and
  // Date.parse then reads it American-style as 3 April, silently contradicting
  // the day-first rule two lines up. A payment with no date is placed by
  // arrival and counted in `undated`, which is visible; a payment dated a month
  // out is neither.
  if (/^\d{1,4}\s*[/.-]\s*\d{1,4}\s*[/.-]\s*\d{1,4}/.test(s)) return null;

  // Named-month forms ("4 Mar 2026", "Mar 4, 2026 09:15") carry their own
  // ordering, so there is nothing left to guess.
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  // A spreadsheet serial lands centuries away; refuse it rather than filing a
  // payment in 1899.
  const year = d.getUTCFullYear();
  return year >= 2000 && year <= 2100 ? d : null;
}

/**
 * One exported row as a payment.
 *
 * Column names are looked up rather than positioned, and every field has
 * several accepted spellings, because an export's headers depend on which
 * columns the operator had shown when they pressed Download.
 */
export function mapExportRow(row: ExportRow): MappedImport | null {
  const paymentId = field(row, ['ID', 'Payment ID', 'paymentId']);
  const reference = field(row, ['Reference ID', 'referenceId', 'Reference']);
  if (!paymentId && !reference) return null; // nothing to key on

  const state = field(row, ['State', 'Status', 'Payment State']);
  const shop = field(row, ['Shop', 'Shop Name', 'shopName', 'Shop ID']);
  const terminal = field(row, [
    'Terminal',
    'Terminal Name',
    'Connector',
    'Provider',
  ]);
  const occurredAt = parseWhen(
    field(row, [
      'Updated',
      'Updated At',
      'Finalized',
      'Created',
      'Created At',
      'Date',
    ]),
  );

  return {
    paymentId,
    reference,
    externalId: field(row, ['External Id', 'External ID', 'externalId']),
    parentPaymentId: field(row, [
      'Parent Payment Id',
      'Parent Payment ID',
      'parentPaymentId',
    ]),
    terminal,
    psp: pspForTerminal(terminal),
    shop,
    entity: entityForShop(shop),
    state,
    type: field(row, ['Type', 'Payment Type', 'Transaction Type']),
    // Shop-base first: it is the figure that is addable across currencies, and
    // the one every other total in this dashboard is built from.
    amount: parseAmount(
      field(row, [
        'Amount in Shop Base Currency',
        'Amount In Shop Base Currency',
        'Shop Base Amount',
        'Amount',
      ]),
    ),
    currency: field(row, ['Currency', 'Payment Currency']),
    customer: field(row, [
      'Customer Reference ID',
      'Customer Reference Id',
      'customerReferenceId',
      'Customer Account Number',
      'Customer Email',
    ]),
    errorCode: field(row, ['Error Code', 'errorCode', 'External Result Code']),
    errorMessage: field(row, [
      'Error Message',
      'errorMessage',
      'Decline Reason',
    ]),
    // Built by the same function the poller uses, not a copy of its formula.
    // The copy was the bug: both spelled the identity with the timestamp in it,
    // and the two sources write timestamps differently, so every payment held
    // from the API was stored a second time from the file.
    dedupeKey: paymentIdentity(paymentId || reference, state),
    occurredAt,
  };
}

/**
 * Where each exported column belongs in a payment as the PROVIDER writes one.
 *
 * The dashboard reads almost everything it shows — amounts in other currencies,
 * commission, external references, billing, card, crypto, lifetime client
 * totals — out of the stored payload, by the provider's own field names. An
 * imported payment was stored under the export's human column headings
 * instead, so "Amount in Shop Base Currency" sat in the payload right next to a
 * lookup for `amountInShopBaseCurrency` that could never find it, and three
 * quarters of the table read as "—" for every one of the 70,023 imported rows.
 *
 * So a row is reshaped on the way in. After this an imported payment and a
 * polled one are the same object, and every consumer — table, drawer, CSV
 * export, anything added later — works on both without knowing the difference.
 *
 * `n` marks a money column, read with the same locale rules as the amount, and
 * `d` a timestamp, normalised to ISO. Dotted paths nest.
 */
const PROVIDER_SHAPE: Record<string, { path: string; kind?: 'n' | 'd' }> = {
  // payment
  ID: { path: 'id' },
  'Payment ID': { path: 'id' },
  'Reference ID': { path: 'referenceId' },
  Type: { path: 'paymentType' },
  'Payment Type': { path: 'paymentType' },
  State: { path: 'state' },
  Status: { path: 'state' },
  'Payment Method': { path: 'paymentMethod' },
  Method: { path: 'paymentMethod' },
  'Payment Method Details': { path: 'paymentMethodDetails' },
  Description: { path: 'description' },
  Created: { path: 'createdAt', kind: 'd' },
  'Created At': { path: 'createdAt', kind: 'd' },
  Updated: { path: 'updatedAt', kind: 'd' },
  'Updated At': { path: 'updatedAt', kind: 'd' },
  Finalized: { path: 'finalizedAt', kind: 'd' },
  'Finalized At': { path: 'finalizedAt', kind: 'd' },

  // amounts
  Amount: { path: 'amount', kind: 'n' },
  Currency: { path: 'currency' },
  'Amount in Base Currency': { path: 'amountInBaseCurrency', kind: 'n' },
  'Base Currency': { path: 'baseCurrency' },
  'Amount in Shop Base Currency': {
    path: 'amountInShopBaseCurrency',
    kind: 'n',
  },
  'Shop Base Currency': { path: 'shopBaseCurrency' },
  'Customer Amount': { path: 'customerAmount', kind: 'n' },
  'Customer Currency': { path: 'customerCurrency' },
  Commission: { path: 'commission', kind: 'n' },
  'Refunded Amount': { path: 'refundedAmount', kind: 'n' },

  // references
  'External ID': { path: 'externalId' },
  'External Id': { path: 'externalId' },
  'External Refs': { path: 'externalRefs' },
  'External Result Code': { path: 'externalResultCode' },
  'Parent Payment ID': { path: 'parentPaymentId' },
  'Parent Payment Id': { path: 'parentPaymentId' },
  'Parent Reference ID': { path: 'parentReferenceId' },
  'Additional Parameters': { path: 'additionalParameters' },
  'Return URL': { path: 'returnUrl' },

  // customer — nested, exactly as the live payload nests it
  'Customer Reference ID': { path: 'customer.referenceId' },
  'Customer Email': { path: 'customer.email' },
  'Customer Phone': { path: 'customer.phone' },
  'Customer Account Number': { path: 'customer.accountNumber' },
  'Customer First Name': { path: 'customer.firstName' },
  'Customer Last Name': { path: 'customer.lastName' },
  'Date of Birth': { path: 'customer.dateOfBirth' },
  'Document Number': { path: 'customer.documentNumber' },
  'Citizenship Country': { path: 'customer.citizenshipCountryCode' },
  'Customer KYC Status': { path: 'customer.kycStatus' },
  'KYC Status': { path: 'customer.kycStatus' },
  'Payment Instrument KYC Status': {
    path: 'customer.paymentInstrumentKycStatus',
  },
  'IP Address': { path: 'customer.ip' },
  'Customer IP': { path: 'customer.ip' },
  'IP Country': { path: 'customer.ipCountry' },
  'Date of First Deposit': { path: 'customer.dateOfFirstDeposit', kind: 'd' },
  'Lifetime Number of Deposits': { path: 'customer.depositsCount', kind: 'n' },
  'Lifetime Deposits Amount': { path: 'customer.depositsAmount', kind: 'n' },
  'Lifetime Number of Withdrawals': {
    path: 'customer.withdrawalsCount',
    kind: 'n',
  },
  'Lifetime Withdrawals Amount': {
    path: 'customer.withdrawalsAmount',
    kind: 'n',
  },
  'Routing Group': { path: 'customer.routingGroup' },

  // billing
  'Billing Country': { path: 'customer.billingAddress.countryCode' },
  'Billing State': { path: 'customer.billingAddress.state' },
  'Billing City': { path: 'customer.billingAddress.city' },
  'Billing Address Line 1': { path: 'customer.billingAddress.addressLine1' },
  'Billing Address Line 2': { path: 'customer.billingAddress.addressLine2' },
  'Billing Postal Code': { path: 'customer.billingAddress.postalCode' },

  // card
  'Card Brand': { path: 'cardData.brand' },
  'Card Type': { path: 'cardData.type' },
  'Card Issuing Country': { path: 'cardData.issuingCountry' },
  'Card Issuing Organization': { path: 'cardData.issuingOrganization' },
  'Cardholder Name': { path: 'cardData.cardholderName' },

  // crypto — the live payload spreads these across externalRefs and
  // additionalParameters, and the dashboard reads both bags merged, so one
  // bag is enough here.
  'Crypto Amount': { path: 'additionalParameters.cryptoAmount', kind: 'n' },
  'Crypto Currency': { path: 'additionalParameters.cryptoCurrency' },
  Network: { path: 'additionalParameters.cryptoNetwork' },
  'Source Address': { path: 'additionalParameters.cryptoSourceAddress' },
  'Destination Address': {
    path: 'additionalParameters.cryptoDestinationAddress',
  },
  'Destination Tag': { path: 'additionalParameters.cryptoDestinationTag' },
  'Transaction Hash': { path: 'additionalParameters.transactionHash' },

  // routing
  Shop: { path: 'shopName' },
  'Shop Name': { path: 'shopName' },
  Terminal: { path: 'terminalName' },
  'Terminal Name': { path: 'terminalName' },
  'Connector ID': { path: 'connectorId' },
  Provider: { path: 'provider' },

  // lifecycle
  'Error Code': { path: 'errorCode' },
  'Error Message': { path: 'errorMessage' },
  'Decline Reason': { path: 'errorMessage' },
  'Webhook Status': { path: 'webhookStatus' },
  'Start Recurring': { path: 'startRecurring' },
};

const SHAPE_BY_HEADER = new Map(
  Object.entries(PROVIDER_SHAPE).map(([header, spec]) => [norm(header), spec]),
);

function setPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
) {
  const parts = path.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}

/**
 * One exported row as the provider would have sent it.
 *
 * A column this build does not recognise is kept under its own heading rather
 * than dropped: the column nobody mapped is exactly the one that answers next
 * month's question, and an export costs nothing to keep whole.
 */
export function shapeExportRow(row: ExportRow): Record<string, unknown> {
  const shaped: Record<string, unknown> = {};
  for (const [header, raw] of Object.entries(row)) {
    // A cell that is an object or an array is kept whole under its own heading
    // — it is already structured, and flattening it to "[object Object]" would
    // destroy it — but it cannot be parsed as an amount or a date.
    if (raw === null || raw === undefined) continue;
    if (
      typeof raw !== 'string' &&
      typeof raw !== 'number' &&
      typeof raw !== 'boolean'
    ) {
      shaped[header] = raw;
      continue;
    }
    const text = String(raw).trim();
    if (!text) continue;
    const spec = SHAPE_BY_HEADER.get(norm(header));
    if (!spec) {
      shaped[header] = raw;
      continue;
    }
    if (spec.kind === 'n') {
      setPath(shaped, spec.path, parseAmount(text));
    } else if (spec.kind === 'd') {
      // Left as written when it cannot be read, rather than dropped: an
      // unreadable date is still evidence of what the file said.
      setPath(shaped, spec.path, parseWhen(text)?.toISOString() ?? text);
    } else {
      setPath(shaped, spec.path, text);
    }
  }
  return shaped;
}

/**
 * Personal columns an export can carry, on top of the ones the API redacts.
 *
 * The API redaction list is written in the provider's camelCase field names,
 * and a spreadsheet's headers are words with spaces — "Cardholder Name" never
 * matched "cardholderName", so the same person's details would have been
 * redacted when polled and kept when imported. Both lists are compared
 * punctuation-insensitively here, and the export-only headers below cover what
 * the console can add to a worksheet that the API never returns.
 */
const EXPORT_REDACT = [
  ...DEFAULT_REDACT_KEYS,
  // The SAME things the API list strips, spelled the way a worksheet spells
  // them. Nothing more: this list started out wider — it also took the
  // customer's email, phone and billing address — and a wider list is not the
  // safer choice here, it is a different one. The poller keeps those, the
  // dashboard has columns for them, and the client drawer finds a person's
  // history by matching on their email when the reference is missing. Stripping
  // them from imported rows only would have made the same client whole when
  // polled and fragmented when imported, which is the exact bug that had "all
  // time deposits" reading $0 a fortnight ago.
  'Customer Name',
  'Customer First Name',
  'Customer Last Name',
  'Customer Date Of Birth',
  'Date of Birth',
  'Customer IP',
  'IP Address',
  'Card Number',
  'Card Mask',
  'Card Pan',
  'Masked Pan',
  'Card Expiry',
  'Card Expiry Date',
  'Recurring Token',
];

/**
 * The row as it gets stored alongside the payment.
 *
 * The whole row is kept because a column this build does not read today is
 * exactly what answers tomorrow's question — but a payments export is a
 * personal-data file, and none of the identifying columns are needed for any
 * figure this dashboard shows.
 *
 * Walks the whole object, because reshaping puts the personal fields where the
 * provider puts them — customer.email, cardData.cardholderName — and a
 * top-level pass would have left every one of them behind the moment the shape
 * gained a level.
 */
export function redactExportRow(row: ExportRow): ExportRow {
  if (process.env.PAYMAXIS_STORE_RAW === 'full') return row;
  const deny = new Set(
    [...EXPORT_REDACT, ...(process.env.PAYMAXIS_REDACT_KEYS ?? '').split(',')]
      .map((k) => norm(k.trim()))
      .filter(Boolean),
  );
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, val]) =>
          deny.has(norm(k)) ? [k, '«redacted»'] : [k, walk(val)],
        ),
      );
    }
    return v;
  };
  return walk(row) as ExportRow;
}

export type ImportSummary = {
  read: number;
  mapped: number;
  stored: number;
  /**
   * Held from an earlier import and rewritten from this file. How a re-export
   * with more columns, or a file loaded before a mapping was fixed, repairs
   * what is already stored. Never counts a webhook or a poll: an export must
   * not thin out a record the provider sent us in full.
   */
  refreshed: number;
  /** Rows that carried no id and no reference, so nothing could key them. */
  unusable: number;
  /** Already held — re-importing an overlapping period is meant to be safe. */
  duplicates: number;
  oldest: string | null;
  newest: string | null;
  /** Rows whose date could not be read; stored, but placed by arrival time. */
  undated: number;
  /**
   * Columns the file never filled in, named — because a worksheet exported
   * without "Amount in Shop Base Currency" imports perfectly and then reports
   * every total as zero, and that is worth knowing at import time rather than
   * a week later. Names only: the sentence around them belongs to whatever is
   * displaying the result.
   */
  warnings: string[];
};

/** Which mapped fields were empty on EVERY row — i.e. columns the file lacks. */
export function missingColumns(rows: MappedImport[]): string[] {
  if (!rows.length) return [];
  const checks: [string, (r: MappedImport) => boolean][] = [
    ['amount', (r) => r.amount !== 0],
    ['date', (r) => r.occurredAt !== null],
    ['state', (r) => r.state !== ''],
    ['customer reference', (r) => r.customer !== ''],
    ['shop', (r) => r.shop !== ''],
    ['terminal', (r) => r.terminal !== ''],
    ['currency', (r) => r.currency !== ''],
    ['type', (r) => r.type !== ''],
  ];
  return checks
    .filter(([, present]) => !rows.some(present))
    .map(([name]) => name);
}
