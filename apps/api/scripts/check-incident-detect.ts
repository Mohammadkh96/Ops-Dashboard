// The detector decides what appears on an operations screen as an incident, so
// every rule is pinned here — including the cases where it must stay SILENT.
// A detector that cries wolf gets ignored, and then the real one is missed too.
//
//   npx tsx scripts/check-incident-detect.ts

import {
  detectIncidents,
  type DetectRow,
  type Detection,
} from '../src/modules/incident-detect';
import { isFailedState, isSettledState } from '../src/paymaxis/normalize';

const NOW = new Date('2026-08-21T12:00:00.000Z');
const MIN = 60_000;
const ago = (mins: number) => new Date(NOW.getTime() - mins * MIN);

let failures = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`ok    ${name.padEnd(58)}`);
  } else {
    failures++;
    console.log(`FAIL  ${name.padEnd(58)} ${JSON.stringify(detail)}`);
  }
}
function section(t: string) {
  console.log(`\n── ${t} ──`);
}

let seq = 0;
const row = (o: Partial<DetectRow> & { at: Date }): DetectRow => ({
  reference: `PM-${++seq}`,
  customer: `CU${1000 + (seq % 7)}`,
  psp: 'Paystrax',
  state: 'COMPLETED',
  type: 'DEPOSIT',
  amount: 100,
  currency: 'USD',
  ...o,
});

const run = (
  rows: DetectRow[],
  over: Partial<Parameters<typeof detectIncidents>[0]> = {},
) =>
  detectIncidents({
    rows,
    now: NOW,
    lastEventAt: rows.length ? rows[0].at : null,
    pollConfigured: true,
    settled: isSettledState,
    failed: isFailedState,
    ...over,
  });

const kinds = (d: Detection[]) => d.map((x) => x.kind);

// A provider working normally: 20 settled an hour, a couple of declines.
const healthy = (psp: string, hours = 25): DetectRow[] => {
  const out: DetectRow[] = [];
  for (let h = 0; h < hours; h++) {
    for (let i = 0; i < 8; i++) {
      out.push(row({ psp, at: ago(h * 60 + i * 5), state: 'COMPLETED' }));
    }
    out.push(row({ psp, at: ago(h * 60 + 50), state: 'DECLINED' }));
  }
  return out;
};

section('a healthy provider raises nothing');
{
  const found = run(healthy('Paystrax'));
  ok('no detections', found.length === 0, kinds(found));
}

section('a provider that stops settling');
{
  // Last hour: everything declined. Before that: the usual mix.
  const rows = healthy('Paystrax').filter((r) => r.at < ago(60));
  for (let i = 0; i < 9; i++) {
    rows.unshift(
      row({ psp: 'Paystrax', at: ago(i * 6), state: 'DECLINED', amount: 250 }),
    );
  }
  const found = run(rows);
  const d = found.find((x) => x.kind === 'psp-failing');
  ok('reported as failing', Boolean(d), kinds(found));
  ok('critical', d?.severity === 'critical', d?.severity);
  ok('names the provider', d?.psp === 'Paystrax', d?.psp);
  ok(
    'states the counts',
    Boolean(d?.evidence.some((e) => e.includes('0% success'))),
    d?.evidence,
  );
  ok(
    'quotes the baseline',
    Boolean(d?.evidence.some((e) => e.includes('24 hours'))),
    d?.evidence,
  );
  // A total outage must not ALSO be reported as a decline spike: one condition,
  // one incident, or the tiles double-count it.
  ok(
    'not double-reported as a spike',
    !kinds(found).includes('decline-spike'),
    kinds(found),
  );
}

section('a provider that has never settled here is not an outage');
{
  // 9 declines in the last hour and nothing before: a routing question, not a
  // provider that broke. Calling it critical would page someone over a
  // misconfigured terminal.
  const rows: DetectRow[] = [];
  for (let i = 0; i < 9; i++) {
    rows.push(row({ psp: 'NewPSP', at: ago(i * 6), state: 'DECLINED' }));
  }
  // Another provider keeps the feed alive so this is not "data stopped".
  rows.push(...healthy('Paystrax'));
  const found = run(rows);
  ok(
    'no failing-provider incident',
    !kinds(found).includes('psp-failing'),
    kinds(found),
  );
}

section('too few payments to judge');
{
  const rows = [
    ...healthy('Paystrax').filter((r) => r.at < ago(60)),
    ...Array.from({ length: 4 }, (_, i) =>
      row({ psp: 'Paystrax', at: ago(i * 6), state: 'DECLINED' }),
    ),
  ];
  const found = run(rows);
  ok(
    'stays quiet under the minimum',
    !kinds(found).includes('psp-failing'),
    kinds(found),
  );
}

section('a decline rate well above the provider’s own normal');
{
  // Baseline ~11% declines; last hour 60%.
  const rows = healthy('Paystrax').filter((r) => r.at < ago(60));
  for (let i = 0; i < 6; i++)
    rows.unshift(row({ psp: 'Paystrax', at: ago(i * 5), state: 'DECLINED' }));
  for (let i = 0; i < 4; i++)
    rows.unshift(row({ psp: 'Paystrax', at: ago(i * 7), state: 'COMPLETED' }));
  const found = run(rows);
  const d = found.find((x) => x.kind === 'decline-spike');
  ok('reported as a spike', Boolean(d), kinds(found));
  ok(
    'compares against itself',
    Boolean(d?.evidence.some((e) => e.includes('Previous 24 hours'))),
    d?.evidence,
  );
  ok(
    'states the gap in points',
    Boolean(d?.evidence.some((e) => e.includes('percentage points'))),
    d?.evidence,
  );
}

section('a small rise is not an incident');
{
  const rows = healthy('Paystrax').filter((r) => r.at < ago(60));
  for (let i = 0; i < 2; i++)
    rows.unshift(row({ psp: 'Paystrax', at: ago(i * 5), state: 'DECLINED' }));
  for (let i = 0; i < 8; i++)
    rows.unshift(row({ psp: 'Paystrax', at: ago(i * 6), state: 'COMPLETED' }));
  const found = run(rows);
  ok('no spike raised', !kinds(found).includes('decline-spike'), kinds(found));
}

section('payments with no final state');
{
  const rows = [
    ...healthy('Paystrax'),
    ...Array.from({ length: 4 }, (_, i) =>
      row({
        psp: 'ForumPay',
        at: ago(150 + i * 10),
        state: 'AWAITING_WEBHOOK',
        amount: 500,
      }),
    ),
  ];
  const found = run(rows);
  const d = found.find((x) => x.kind === 'stuck-in-flight');
  ok('reported', Boolean(d), kinds(found));
  ok('counts them', Boolean(d?.title.startsWith('4 payments stuck')), d?.title);
  ok(
    'names the states',
    Boolean(d?.evidence.some((e) => e.includes('AWAITING_WEBHOOK'))),
    d?.evidence,
  );
  ok(
    'totals the value',
    Boolean(d?.evidence.some((e) => e.includes('2,000'))),
    d?.evidence,
  );
}

section('recent in-flight payments are just in flight');
{
  const rows = [
    ...healthy('Paystrax'),
    ...Array.from({ length: 5 }, (_, i) =>
      row({ psp: 'ForumPay', at: ago(i * 5), state: 'PENDING' }),
    ),
  ];
  const found = run(rows);
  ok(
    'not reported as stuck',
    !kinds(found).includes('stuck-in-flight'),
    kinds(found),
  );
}

section('the feed going quiet');
{
  const rows = healthy('Paystrax').filter((r) => r.at < ago(180));
  const found = run(rows, { lastEventAt: ago(190) });
  ok('reported', kinds(found).includes('data-stopped'), kinds(found));
  // Everything else is suspended: with no data arriving, every provider looks
  // dead, and reporting five outages would point at the wrong problem.
  ok('suppresses provider rules', found.length === 1, kinds(found));
  ok(
    'says how stale',
    Boolean(found[0].evidence.some((e) => e.includes('Last payment received'))),
    found[0].evidence,
  );
}

section('silence with no credentials configured is not a fault');
{
  const found = run([], { lastEventAt: null, pollConfigured: false });
  ok('stays quiet', found.length === 0, kinds(found));
}

section('every detection names the payments behind it');
{
  const rows = [
    ...healthy('Paystrax'),
    ...Array.from({ length: 30 }, (_, i) =>
      row({
        psp: 'ForumPay',
        at: ago(150 + i * 5),
        state: 'AWAITING_WEBHOOK',
        amount: 100,
      }),
    ),
  ];
  const d = run(rows).find((x) => x.kind === 'stuck-in-flight');
  ok('carries samples', (d?.samples.length ?? 0) > 0, d?.samples.length);
  ok('capped, not a wall', (d?.samples.length ?? 0) <= 25, d?.samples.length);
  ok('reports the true total', d?.sampleTotal === 30, d?.sampleTotal);
  ok(
    'oldest first',
    Boolean(d && d.samples[0].ageMins >= d.samples[1].ageMins),
    d?.samples.slice(0, 2),
  );
  ok('quotable reference', Boolean(d?.samples[0].reference), d?.samples[0]);
  ok('names the customer', Boolean(d?.samples[0].customer), d?.samples[0]);
}

section('the same customer charged twice for the same thing');
{
  // Two identical settled deposits, two minutes apart. The customer pressed
  // pay again because the first looked stuck.
  const rows = [
    ...healthy('Paystrax'),
    row({ customer: 'CU9001', amount: 250, at: ago(20), psp: 'ForumPay' }),
    row({ customer: 'CU9001', amount: 250, at: ago(18), psp: 'ForumPay' }),
  ];
  const d = run(rows).find((x) => x.kind === 'double-charge');
  ok('detected', Boolean(d), kinds(run(rows)));
  ok(
    'one pair',
    Boolean(d?.title.includes('1 possible double charge')),
    d?.title,
  );
  ok('one customer', Boolean(d?.title.includes('1 customer')), d?.title);
  ok('both charges are shown', d?.sampleTotal === 2, d?.sampleTotal);
  // Only the second charge is money owed back; counting both would report
  // double the amount that was doubled.
  ok(
    'the value is the second charge alone',
    Boolean(d?.evidence.some((e) => e.includes('250'))) &&
      !d?.evidence.some((e) => e.includes('500')),
    d?.evidence,
  );
  ok(
    'newest first — that one can still be refunded quietly',
    Boolean(d && d.samples[0].ageMins <= d.samples[1].ageMins),
    d?.samples.map((s) => s.ageMins),
  );
}

section('the things that look like double charges and are not');
{
  const base = healthy('Paystrax');
  const twice = (o: Partial<DetectRow>, gapMins: number) => [
    row({
      customer: 'CU9002',
      amount: 250,
      at: ago(30),
      psp: 'ForumPay',
      ...o,
    }),
    row({
      customer: 'CU9002',
      amount: 250,
      at: ago(30 - gapMins),
      psp: 'ForumPay',
      ...o,
    }),
  ];
  const has = (rows: DetectRow[]) =>
    Boolean(run(rows).find((x) => x.kind === 'double-charge'));

  // A customer topping up twice in an evening is ordinary.
  ok('an hour apart is not a double charge', !has([...base, ...twice({}, 60)]));
  // Different amounts is somebody adding funds, not one charge landing twice.
  ok(
    'different amounts are not',
    !has([
      ...base,
      row({ customer: 'CU9003', amount: 250, at: ago(30), psp: 'ForumPay' }),
      row({ customer: 'CU9003', amount: 300, at: ago(28), psp: 'ForumPay' }),
    ]),
  );
  // Same amount at two providers within minutes is a customer whose first
  // attempt was declined and who was routed elsewhere — the retry SUCCEEDING
  // is the system working.
  ok(
    'the same amount at a different terminal is not',
    !has([
      ...base,
      row({ customer: 'CU9004', amount: 250, at: ago(30), psp: 'ForumPay' }),
      row({ customer: 'CU9004', amount: 250, at: ago(29), psp: 'Paystrax' }),
    ]),
  );
  // Two people paying the same amount at the same second is a coincidence,
  // not a double charge. Keying on the customer is what makes this safe.
  ok(
    'two different customers are not',
    !has([
      ...base,
      row({ customer: 'CU9005', amount: 250, at: ago(30), psp: 'ForumPay' }),
      row({ customer: 'CU9006', amount: 250, at: ago(30), psp: 'ForumPay' }),
    ]),
  );
  // A withdrawal repeating is a payout schedule.
  ok(
    'repeated withdrawals are not',
    !has([...base, ...twice({ type: 'WITHDRAWAL' }, 2)]),
  );
  // A declined attempt followed by a successful one is the normal shape of a
  // retry, and reporting it would fire on half the payments on the desk.
  ok(
    'a decline then a success is not',
    !has([
      ...base,
      row({
        customer: 'CU9007',
        amount: 250,
        at: ago(30),
        psp: 'ForumPay',
        state: 'DECLINED',
      }),
      row({ customer: 'CU9007', amount: 250, at: ago(29), psp: 'ForumPay' }),
    ]),
  );
  // Anonymous rows cannot be attributed to one person at all.
  ok(
    'payments with no customer are not',
    !has([
      ...base,
      row({ customer: null, amount: 250, at: ago(30), psp: 'ForumPay' }),
      row({ customer: null, amount: 250, at: ago(29), psp: 'ForumPay' }),
    ]),
  );
}

section('three charges in a row are two pairs, not three');
{
  const rows = [
    ...healthy('Paystrax'),
    row({ customer: 'CU9008', amount: 99, at: ago(20), psp: 'ForumPay' }),
    row({ customer: 'CU9008', amount: 99, at: ago(19), psp: 'ForumPay' }),
    row({ customer: 'CU9008', amount: 99, at: ago(18), psp: 'ForumPay' }),
  ];
  const d = run(rows).find((x) => x.kind === 'double-charge');
  ok(
    'two pairs',
    Boolean(d?.title.includes('2 possible double charges')),
    d?.title,
  );
  ok('three payments listed', d?.sampleTotal === 3, d?.sampleTotal);
  // 99 owed back twice, not three times: the first charge is the one the
  // customer meant to make.
  ok(
    '198 owed back',
    Boolean(d?.evidence.some((e) => e.includes('198'))),
    d?.evidence,
  );
  ok('escalated by volume', d?.severity === 'medium', d?.severity);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
