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

const row = (o: Partial<DetectRow> & { at: Date }): DetectRow => ({
  psp: 'Paystrax',
  state: 'COMPLETED',
  type: 'DEPOSIT',
  amount: 100,
  currency: 'USD',
  ...o,
});

const run = (rows: DetectRow[], over: Partial<Parameters<typeof detectIncidents>[0]> = {}) =>
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
    rows.unshift(row({ psp: 'Paystrax', at: ago(i * 6), state: 'DECLINED', amount: 250 }));
  }
  const found = run(rows);
  const d = found.find((x) => x.kind === 'psp-failing');
  ok('reported as failing', Boolean(d), kinds(found));
  ok('critical', d?.severity === 'critical', d?.severity);
  ok('names the provider', d?.psp === 'Paystrax', d?.psp);
  ok('states the counts', Boolean(d?.evidence.some((e) => e.includes('0% success'))), d?.evidence);
  ok('quotes the baseline', Boolean(d?.evidence.some((e) => e.includes('24 hours'))), d?.evidence);
  // A total outage must not ALSO be reported as a decline spike: one condition,
  // one incident, or the tiles double-count it.
  ok('not double-reported as a spike', !kinds(found).includes('decline-spike'), kinds(found));
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
  ok('no failing-provider incident', !kinds(found).includes('psp-failing'), kinds(found));
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
  ok('stays quiet under the minimum', !kinds(found).includes('psp-failing'), kinds(found));
}

section('a decline rate well above the provider’s own normal');
{
  // Baseline ~11% declines; last hour 60%.
  const rows = healthy('Paystrax').filter((r) => r.at < ago(60));
  for (let i = 0; i < 6; i++) rows.unshift(row({ psp: 'Paystrax', at: ago(i * 5), state: 'DECLINED' }));
  for (let i = 0; i < 4; i++) rows.unshift(row({ psp: 'Paystrax', at: ago(i * 7), state: 'COMPLETED' }));
  const found = run(rows);
  const d = found.find((x) => x.kind === 'decline-spike');
  ok('reported as a spike', Boolean(d), kinds(found));
  ok('compares against itself', Boolean(d?.evidence.some((e) => e.includes('Previous 24 hours'))), d?.evidence);
  ok('states the gap in points', Boolean(d?.evidence.some((e) => e.includes('percentage points'))), d?.evidence);
}

section('a small rise is not an incident');
{
  const rows = healthy('Paystrax').filter((r) => r.at < ago(60));
  for (let i = 0; i < 2; i++) rows.unshift(row({ psp: 'Paystrax', at: ago(i * 5), state: 'DECLINED' }));
  for (let i = 0; i < 8; i++) rows.unshift(row({ psp: 'Paystrax', at: ago(i * 6), state: 'COMPLETED' }));
  const found = run(rows);
  ok('no spike raised', !kinds(found).includes('decline-spike'), kinds(found));
}

section('payments with no final state');
{
  const rows = [
    ...healthy('Paystrax'),
    ...Array.from({ length: 4 }, (_, i) =>
      row({ psp: 'ForumPay', at: ago(150 + i * 10), state: 'AWAITING_WEBHOOK', amount: 500 }),
    ),
  ];
  const found = run(rows);
  const d = found.find((x) => x.kind === 'stuck-in-flight');
  ok('reported', Boolean(d), kinds(found));
  ok('counts them', Boolean(d?.title.startsWith('4 payments stuck')), d?.title);
  ok('names the states', Boolean(d?.evidence.some((e) => e.includes('AWAITING_WEBHOOK'))), d?.evidence);
  ok('totals the value', Boolean(d?.evidence.some((e) => e.includes('2,000'))), d?.evidence);
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
  ok('not reported as stuck', !kinds(found).includes('stuck-in-flight'), kinds(found));
}

section('the feed going quiet');
{
  const rows = healthy('Paystrax').filter((r) => r.at < ago(180));
  const found = run(rows, { lastEventAt: ago(190) });
  ok('reported', kinds(found).includes('data-stopped'), kinds(found));
  // Everything else is suspended: with no data arriving, every provider looks
  // dead, and reporting five outages would point at the wrong problem.
  ok('suppresses provider rules', found.length === 1, kinds(found));
  ok('says how stale', Boolean(found[0].evidence.some((e) => e.includes('Last payment received'))), found[0].evidence);
}

section('silence with no credentials configured is not a fault');
{
  const found = run([], { lastEventAt: null, pollConfigured: false });
  ok('stays quiet', found.length === 0, kinds(found));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
