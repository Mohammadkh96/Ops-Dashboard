// How an exported file is read, pinned.
//
// Every one of these is a decision that fails SILENTLY when it is wrong: a
// misread decimal separator turns €1,500 into €1.50 and the totals still add
// up; a misread date files a year of payments in the wrong month and the
// dashboard still draws a chart. Nothing about the import looks broken
// afterwards, which is exactly why the rules are checked here rather than by
// looking at the result.
//
//   npx tsx scripts/check-import-export.ts

import {
  mapExportRow,
  missingColumns,
  parseAmount,
  parseWhen,
  redactExportRow,
  shapeExportRow,
  type MappedImport,
} from '../src/paymaxis/import-export';
import { normalizePayment } from '../src/paymaxis/normalize';

let failures = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`ok    ${name}`);
  else {
    failures++;
    console.log(
      `FAIL  ${name} ${detail === undefined ? '' : JSON.stringify(detail)}`,
    );
  }
}
const section = (t: string) => console.log(`\n── ${t} ──`);

section('amounts, whichever locale wrote them');
{
  ok('plain', parseAmount('1500') === 1500);
  ok('anglo thousands + decimals', parseAmount('1,500.00') === 1500);
  ok('euro thousands + decimals', parseAmount('1.500,00') === 1500);
  // The one that costs money if it is wrong.
  ok(
    'euro thousands, no decimals',
    parseAmount('1.500') === 1500,
    parseAmount('1.500'),
  );
  ok(
    'anglo thousands, no decimals',
    parseAmount('1,500') === 1500,
    parseAmount('1,500'),
  );
  ok('decimal comma', parseAmount('12,50') === 12.5);
  ok('decimal dot', parseAmount('12.50') === 12.5);
  ok('millions', parseAmount('1,234,567.89') === 1234567.89);
  ok('currency symbol and spaces', parseAmount(' $ 1,234.50 ') === 1234.5);
  ok('negative', parseAmount('-250.00') === -250);
  ok('blank is zero, not NaN', parseAmount('') === 0);
  ok('junk is zero, not NaN', parseAmount('n/a') === 0);
}

section('dates, always UTC');
{
  const iso = parseWhen('2026-03-04T09:15:30Z');
  ok(
    'ISO',
    iso?.toISOString() === '2026-03-04T09:15:30.000Z',
    iso?.toISOString(),
  );
  const spaced = parseWhen('2026-03-04 09:15:30');
  ok(
    'space-separated is read as UTC, not local',
    spaced?.toISOString() === '2026-03-04T09:15:30.000Z',
    spaced?.toISOString(),
  );
  ok(
    'date only',
    parseWhen('2026-03-04')?.toISOString() === '2026-03-04T00:00:00.000Z',
  );

  // Day-first: the convention this provider and this merchant both write.
  const amb = parseWhen('04/03/2026 09:15');
  ok(
    '04/03/2026 is 4 March, not 3 April',
    amb?.toISOString() === '2026-03-04T09:15:00.000Z',
    amb?.toISOString(),
  );
  // >12 settles it whichever way the file was written.
  ok(
    '13/03/2026 is 13 March',
    parseWhen('13/03/2026')?.toISOString() === '2026-03-13T00:00:00.000Z',
  );
  ok(
    '03/13/2026 is also 13 March',
    parseWhen('03/13/2026')?.toISOString() === '2026-03-13T00:00:00.000Z',
  );
  ok(
    'dotted European date',
    parseWhen('04.03.2026')?.toISOString() === '2026-03-04T00:00:00.000Z',
  );

  ok('blank is null', parseWhen('') === null);
  ok('junk is null', parseWhen('not a date') === null);
  // A spreadsheet serial read as a date lands in 1899; refusing it keeps a
  // payment out of the wrong century rather than quietly redating it.
  ok(
    'two-digit year is refused',
    parseWhen('04/03/26') === null,
    parseWhen('04/03/26'),
  );
}

section('a row becomes a payment');
{
  const row = {
    ID: 'pm-900',
    'Reference ID': 'REF-900',
    'External Id': 'PSX-77',
    State: 'COMPLETED',
    Type: 'DEPOSIT',
    'Amount in Shop Base Currency': '1.500,00',
    Amount: '1.400,00',
    Currency: 'EUR',
    Shop: '6321',
    Terminal: 'Paystrax_Tradin SL',
    'Customer Reference ID': 'CU60573',
    Updated: '2026-03-04 09:15:30',
    'Error Code': '',
  };
  const m = mapExportRow(row)!;
  ok('mapped', !!m);
  ok('id', m.paymentId === 'pm-900');
  // Shop-base is the addable figure; the other column is the customer's own
  // currency and would silently mix units into every total.
  ok('prefers the shop-base amount', m.amount === 1500, m.amount);
  ok('entity derived from shop', m.entity === 'Saint Lucia', m.entity);
  ok('psp derived from terminal', /paystrax/i.test(m.psp), m.psp);
  ok('customer', m.customer === 'CU60573');
  ok('date', m.occurredAt?.toISOString() === '2026-03-04T09:15:30.000Z');

  ok(
    'a row with no id and no reference is refused',
    mapExportRow({ State: 'COMPLETED' }) === null,
  );
  const refOnly = mapExportRow({ 'Reference ID': 'REF-1', State: 'COMPLETED' });
  ok('a reference alone is enough to key on', refOnly?.reference === 'REF-1');
}

section('an imported payment and a polled one are ONE record');
{
  // An operator must be able to import a period that overlaps what polling
  // already collected without doubling it.
  //
  // The two sources DESCRIBE THE SAME PAYMENT DIFFERENTLY, and that is the
  // whole test. An earlier version of this check wrote both timestamps to the
  // same second and both states in the same case, so it passed while the real
  // thing stored every overlapping payment twice — a live import of 70,023 rows
  // over a polled period reported "0 already held". So each pair below differs
  // exactly the way the real sources differ.
  const polled = normalizePayment({
    id: 'pm-900',
    referenceId: 'REF-900',
    state: 'COMPLETED', // the API SHOUTS
    type: 'DEPOSIT',
    amount: 1500,
    currency: 'EUR',
    shopName: '6321',
    customerReferenceId: 'CU60573',
    updatedAt: '2026-03-04T09:15:30.412Z', // ...to the millisecond, in UTC
  });
  const imported = mapExportRow({
    ID: 'pm-900',
    'Reference ID': 'REF-900',
    State: 'Completed', // the export is written for people
    'Amount in Shop Base Currency': '1.500,00',
    Updated: '04/03/2026 09:15:30', // ...to the second, day-first
  })!;
  ok(
    'same identity despite both differences',
    polled.dedupeKey === imported.dedupeKey,
    {
      polled: polled.dedupeKey,
      imported: imported.dedupeKey,
    },
  );

  // A state the provider spells with a space or a hyphen is the same state.
  ok(
    'AWAITING_WEBHOOK == "Awaiting webhook"',
    mapExportRow({ ID: 'pm-901', State: 'Awaiting webhook' })!.dedupeKey ===
      normalizePayment({ id: 'pm-901', state: 'AWAITING_WEBHOOK' }).dedupeKey,
  );

  // ...and a state CHANGE is still news, whichever source notices it.
  const later = mapExportRow({
    ID: 'pm-900',
    State: 'REFUNDED',
    Updated: '05/03/2026 10:00:00',
  })!;
  ok(
    'a later state is a different record',
    later.dedupeKey !== imported.dedupeKey,
  );

  // Re-reading the same payment an hour later must NOT be a new record: the
  // time we looked is not part of what a payment is.
  ok(
    'the same state read again is the same record',
    normalizePayment({
      id: 'pm-900',
      state: 'COMPLETED',
      updatedAt: '2026-03-04T11:00:00.000Z',
    }).dedupeKey === polled.dedupeKey,
  );
}

section('a row is stored in the shape the provider uses');
{
  // The columns the dashboard shows are read out of the payload by the
  // PROVIDER's field names. Stored under the export's headings instead, they
  // are present, findable by eye, and invisible to every lookup — which is how
  // 70,023 imported payments showed "—" down most of the table.
  const shaped = shapeExportRow({
    ID: 'pm-900',
    'Amount in Shop Base Currency': '1.500,00',
    'Shop Base Currency': 'EUR',
    'Customer Amount': '1.750,25',
    'Customer Currency': 'GBP',
    Commission: '12,50',
    'Refunded Amount': '0,00',
    'External Result Code': '00|Approved',
    'Parent Reference ID': 'REF-100',
    'Return URL': 'https://example.com/done',
    'Customer Reference ID': 'CU60573',
    'Customer Account Number': '778812',
    'Billing City': 'Port Louis',
    'Card Brand': 'VISA',
    Shop: '6321',
    Terminal: 'Paystrax_Tradin SL',
    Created: '04/03/2026 09:15:30',
    'Some Column Nobody Mapped': 'keep me',
  });
  const at = (path: string): unknown =>
    path
      .split('.')
      .reduce<unknown>((n, k) => (n as Record<string, unknown>)?.[k], shaped);

  ok(
    'money lands under the provider key',
    at('amountInShopBaseCurrency') === 1500,
  );
  ok(
    '...as a NUMBER, not "1.500,00"',
    typeof at('amountInShopBaseCurrency') === 'number',
  );
  ok('shop base currency', at('shopBaseCurrency') === 'EUR');
  ok('customer amount', at('customerAmount') === 1750.25);
  ok('commission', at('commission') === 12.5);
  ok('external result code', at('externalResultCode') === '00|Approved');
  ok('return url', at('returnUrl') === 'https://example.com/done');
  // Nested exactly where the live payload nests them, or the drawer's
  // customer/billing/card sections read empty.
  ok('customer reference nests', at('customer.referenceId') === 'CU60573');
  ok('account number nests', at('customer.accountNumber') === '778812');
  ok('billing nests', at('customer.billingAddress.city') === 'Port Louis');
  ok('card nests', at('cardData.brand') === 'VISA');
  ok('shop is shopName', at('shopName') === '6321');
  ok('terminal is terminalName', at('terminalName') === 'Paystrax_Tradin SL');
  ok('a date becomes ISO', at('createdAt') === '2026-03-04T09:15:30.000Z');
  // Nothing is thrown away: the column nobody mapped is the one that answers
  // next month's question.
  ok(
    'an unmapped column is kept',
    at('Some Column Nobody Mapped') === 'keep me',
  );
}

section('an import keeps and strips exactly what a poll does');
{
  // Redaction has to be SYMMETRIC. Stripping a field from imported rows that
  // polled rows keep does not make anything safer — it makes the same client
  // whole through one door and fragmented through the other.
  const stored = redactExportRow(
    shapeExportRow({
      ID: 'pm-1',
      'Cardholder Name': 'A Person',
      'Customer Email': 'a@example.com',
      'Customer Account Number': '778812',
      'Billing City': 'Port Louis',
      'Card Number': '411111******1111',
      'Customer IP': '10.0.0.1',
      'Date of Birth': '1980-01-01',
      State: 'COMPLETED',
    }),
  );
  const at = (path: string): unknown =>
    path
      .split('.')
      .reduce<unknown>((n, k) => (n as Record<string, unknown>)?.[k], stored);

  // Stripped, exactly as the API path strips them...
  ok('cardholder name', at('cardData.cardholderName') === '«redacted»');
  ok('card number', at('Card Number') === '«redacted»');
  ok('ip', at('customer.ip') === '«redacted»');
  ok('date of birth', at('customer.dateOfBirth') === '«redacted»');

  // ...and KEPT, exactly as the API path keeps them. Email is how the client
  // drawer finds a person whose payments carry no reference; the dashboard has
  // columns for the account number and the billing address.
  ok(
    'email survives — identity matching needs it',
    at('customer.email') === 'a@example.com',
  );
  ok('account number survives', at('customer.accountNumber') === '778812');
  ok('billing survives', at('customer.billingAddress.city') === 'Port Louis');
  ok(
    'the payment itself is kept',
    at('state') === 'COMPLETED' && at('id') === 'pm-1',
  );
}

section('a file missing a column says so');
{
  const rows: MappedImport[] = [
    mapExportRow({ ID: 'pm-1', State: 'COMPLETED', Updated: '2026-03-04' })!,
    mapExportRow({ ID: 'pm-2', State: 'DECLINED', Updated: '2026-03-05' })!,
  ];
  const warnings = missingColumns(rows);
  ok('no amount column is reported', warnings.includes('amount'), warnings);
  ok(
    'no customer column is reported',
    warnings.includes('customer reference'),
    warnings,
  );
  ok(
    'the columns that ARE there are not reported',
    !warnings.includes('state'),
    warnings,
  );
  ok(
    'a complete file warns about nothing',
    missingColumns([
      mapExportRow({
        ID: 'pm-1',
        State: 'COMPLETED',
        Type: 'DEPOSIT',
        Updated: '2026-03-04',
        'Amount in Shop Base Currency': '100',
        Currency: 'USD',
        'Customer Reference ID': 'CU1',
        Shop: '6321',
        Terminal: 'Paystrax_Tradin SL',
      })!,
    ]).length === 0,
  );
}

console.log(
  failures ? `\n${failures} check(s) failed.` : '\nAll import checks passed.',
);
process.exit(failures ? 1 : 0);
