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
    // The same identity the poller writes, so an imported payment and a polled
    // one are one record rather than two.
    dedupeKey: `paymaxis:${paymentId || reference}:${state}:${occurredAt?.toISOString() ?? ''}`,
    occurredAt,
  };
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
  'Customer Name',
  'Customer Email',
  'Customer Phone',
  'Customer Date Of Birth',
  'Card Number',
  'Card Mask',
  'Card Pan',
  'Masked Pan',
  'Bank Account',
  'Bank Account Number',
  'IBAN',
  'Billing Address',
  'Address',
  'City',
  'Postal Code',
  'Zip',
  'Customer IP',
];

/**
 * The row as it gets stored alongside the payment.
 *
 * The whole row is kept because a column this build does not read today is
 * exactly what answers tomorrow's question — but a payments export is a
 * personal-data file, and none of the identifying columns are needed for any
 * figure this dashboard shows.
 */
export function redactExportRow(row: ExportRow): ExportRow {
  if (process.env.PAYMAXIS_STORE_RAW === 'full') return row;
  const deny = new Set(
    [...EXPORT_REDACT, ...(process.env.PAYMAXIS_REDACT_KEYS ?? '').split(',')]
      .map((k) => norm(k.trim()))
      .filter(Boolean),
  );
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      deny.has(norm(k)) ? '«redacted»' : v,
    ]),
  );
}

export type ImportSummary = {
  read: number;
  mapped: number;
  stored: number;
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
