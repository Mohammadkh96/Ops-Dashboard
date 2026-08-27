// Where payments stop, and what that says about whose problem it is.
//
// The funnel exists to split one number — "82% approval" — into three failures
// with three different owners: the customer left, the issuer said no, or the
// provider never answered. Getting that split wrong sends somebody to argue
// with the wrong party, so every rule is pinned here.
//
//   npx tsx scripts/check-payment-journey.ts

import {
  buildFunnel,
  buildJourneys,
  stageOf,
  type JourneyRow,
} from '../src/modules/payment-journey';

const NOW = new Date('2026-08-21T12:00:00.000Z');
const ago = (mins: number) => new Date(NOW.getTime() - mins * 60_000);

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

const row = (
  o: Partial<JourneyRow> & { key: string; at: Date },
): JourneyRow => ({
  state: 'COMPLETED',
  type: 'DEPOSIT',
  psp: 'Paystrax',
  terminal: 'Paystrax_Tradin SL',
  customer: 'CU1',
  amount: 100,
  currency: 'USD',
  ...o,
});

section('provider vocabulary reduces to what a funnel needs');
{
  ok('COMPLETED', stageOf('COMPLETED') === 'completed');
  ok('SETTLED too', stageOf('SETTLED') === 'completed');
  ok('DECLINED', stageOf('DECLINED') === 'declined');
  ok('CHARGEBACK is a decline', stageOf('CHARGEBACK') === 'declined');
  ok('CANCELLED is the customer leaving', stageOf('CANCELLED') === 'abandoned');
  ok('EXPIRED too', stageOf('EXPIRED') === 'abandoned');
  ok('CHECKOUT', stageOf('CHECKOUT') === 'checkout');
  // Three different waits, one answer to "did this finish".
  ok('PENDING waits', stageOf('PENDING') === 'waiting');
  ok('AWAITING_WEBHOOK waits', stageOf('AWAITING_WEBHOOK') === 'waiting');
  ok('RECONCILIATION waits', stageOf('RECONCILIATION') === 'waiting');
  ok('nothing is unknown, not completed', stageOf(null) === 'unknown');
}

section('a payment keeps the order it moved in');
{
  const [j] = buildJourneys(
    [
      row({ key: 'p1', at: ago(30), state: 'CHECKOUT' }),
      row({ key: 'p1', at: ago(28), state: 'PENDING' }),
      row({ key: 'p1', at: ago(27), state: 'COMPLETED' }),
    ],
    NOW,
  );
  ok(
    'the path is in order',
    j.path.join('→') === 'checkout→waiting→completed',
    j.path,
  );
  ok('the outcome is where it ended', j.outcome === 'completed');
  ok('duration is first to last', j.durationMins === 3, j.durationMins);
}

section('rows arrive in any order and repeat');
{
  const [j] = buildJourneys(
    [
      // Deliberately out of order, and PENDING read three times.
      row({ key: 'p2', at: ago(20), state: 'PENDING' }),
      row({ key: 'p2', at: ago(30), state: 'CHECKOUT' }),
      row({ key: 'p2', at: ago(25), state: 'PENDING' }),
      row({ key: 'p2', at: ago(28), state: 'PENDING' }),
      row({ key: 'p2', at: ago(10), state: 'DECLINED' }),
    ],
    NOW,
  );
  ok('sorted by time', j.startedAt.getTime() === ago(30).getTime());
  // Re-reading a pending payment is one wait, not three.
  ok(
    'repeats collapse',
    j.path.join('→') === 'checkout→waiting→declined',
    j.path,
  );
}

section('the three ways a payment fails are told apart');
{
  const journeys = buildJourneys(
    [
      // Left at the checkout — ours.
      row({ key: 'a', at: ago(200), state: 'CHECKOUT' }),
      row({ key: 'a', at: ago(199), state: 'EXPIRED' }),
      // The issuer said no — routing/risk.
      row({ key: 'b', at: ago(200), state: 'PENDING' }),
      row({ key: 'b', at: ago(199), state: 'DECLINED' }),
      // Nobody ever answered — the provider's.
      row({ key: 'c', at: ago(200), state: 'AWAITING_WEBHOOK' }),
      // Still waiting, but only ten minutes: normal.
      row({ key: 'd', at: ago(10), state: 'PENDING' }),
      // Worked.
      row({ key: 'e', at: ago(30), state: 'COMPLETED' }),
    ],
    NOW,
  );
  const by = (k: string) => journeys.find((j) => j.key === k)?.outcome;
  ok('abandoned', by('a') === 'abandoned', by('a'));
  ok('declined', by('b') === 'declined', by('b'));
  ok('stalled', by('c') === 'stalled', by('c'));
  ok('in flight, not stalled', by('d') === 'in-flight', by('d'));
  ok('completed', by('e') === 'completed', by('e'));

  const [f] = buildFunnel(journeys);
  ok('five payments', f.total === 5, f.total);
  // 1 completed of 2 decided. The three that were never decided are NOT in the
  // denominator — that is the whole point of the split.
  ok('approval is settled ÷ decided', f.approvalRate === 50, f.approvalRate);
  ok(
    'and the rest is attributed',
    JSON.stringify(f.lostTo) ===
      JSON.stringify({ abandoned: 1, declined: 1, stalled: 1 }),
    f.lostTo,
  );
}

section('nothing decided is not nought per cent');
{
  const journeys = buildJourneys(
    [row({ key: 'x', at: ago(10), state: 'PENDING' })],
    NOW,
  );
  const [f] = buildFunnel(journeys);
  ok('approval is unknown', f.approvalRate === null, f.approvalRate);
}

section('a payment is attributed to whoever actually handled it');
{
  const journeys = buildJourneys(
    [
      // Abandoned before it ever reached a terminal.
      row({
        key: 'n1',
        at: ago(200),
        state: 'CHECKOUT',
        psp: null,
        terminal: null,
      }),
      row({
        key: 'n1',
        at: ago(199),
        state: 'CANCELLED',
        psp: null,
        terminal: null,
      }),
      // Routed later: the terminal appears on the second row only.
      row({
        key: 'n2',
        at: ago(50),
        state: 'CHECKOUT',
        psp: null,
        terminal: null,
      }),
      row({ key: 'n2', at: ago(49), state: 'COMPLETED', psp: 'ForumPay' }),
    ],
    NOW,
  );
  const psps = journeys.map((j) => j.psp).sort();
  ok('unrouted stays unassigned', psps.includes('Unassigned'), psps);
  ok('routed is attributed', psps.includes('ForumPay'), psps);
  // Attributing an abandoned checkout to whichever provider appears later
  // would blame a provider for a payment it never saw.
  ok('two providers, not one', new Set(psps).size === 2, psps);
}

section('the commonest routes through are reported');
{
  const rows: JourneyRow[] = [];
  // 6 straight through, 3 declined after waiting, 1 abandoned.
  for (let i = 0; i < 6; i++) {
    rows.push(row({ key: `s${i}`, at: ago(60), state: 'PENDING' }));
    rows.push(row({ key: `s${i}`, at: ago(59), state: 'COMPLETED' }));
  }
  for (let i = 0; i < 3; i++) {
    rows.push(row({ key: `d${i}`, at: ago(60), state: 'PENDING' }));
    rows.push(row({ key: `d${i}`, at: ago(59), state: 'DECLINED' }));
  }
  rows.push(row({ key: 'a1', at: ago(60), state: 'CHECKOUT' }));
  rows.push(row({ key: 'a1', at: ago(59), state: 'CANCELLED' }));

  const [f] = buildFunnel(buildJourneys(rows, NOW));
  ok(
    'commonest path first',
    f.paths[0].path === 'waiting → completed',
    f.paths[0],
  );
  ok('with its count', f.paths[0].count === 6, f.paths[0]);
  ok('and its share', f.paths[0].share === 60, f.paths[0]);
  ok(
    'the declined route is listed',
    f.paths.some((p) => p.path === 'waiting → declined' && p.count === 3),
    f.paths,
  );
  ok(
    'so is the abandoned one',
    f.paths.some((p) => p.path === 'checkout → abandoned'),
    f.paths,
  );
  ok('paths are capped', f.paths.length <= 8, f.paths.length);
}

section('providers are compared side by side');
{
  const rows: JourneyRow[] = [];
  // Paystrax: 8 of 10 approved.
  for (let i = 0; i < 10; i++) {
    rows.push(
      row({
        key: `p${i}`,
        at: ago(40),
        state: i < 8 ? 'COMPLETED' : 'DECLINED',
      }),
    );
  }
  // ForumPay: 2 of 10 approved, and 5 nobody ever answered.
  for (let i = 0; i < 10; i++) {
    rows.push(
      row({
        key: `f${i}`,
        at: ago(300),
        psp: 'ForumPay',
        state: i < 2 ? 'COMPLETED' : i < 5 ? 'DECLINED' : 'AWAITING_WEBHOOK',
      }),
    );
  }
  const f = buildFunnel(buildJourneys(rows, NOW));
  const paystrax = f.find((x) => x.psp === 'Paystrax')!;
  const forum = f.find((x) => x.psp === 'ForumPay')!;
  ok('busiest first', f[0].total >= f[1].total);
  ok(
    'Paystrax approves 80%',
    paystrax.approvalRate === 80,
    paystrax.approvalRate,
  );
  ok(
    'ForumPay approves 40% of what it decided',
    forum.approvalRate === 40,
    forum.approvalRate,
  );
  // The number the approval rate hides: half of ForumPay's payments were never
  // answered at all, which no success rate would show.
  ok('...while never answering 5', forum.lostTo.stalled === 5, forum.lostTo);
}

section('how long a payment takes to settle');
{
  const rows: JourneyRow[] = [];
  [2, 4, 6, 8, 100].forEach((mins, i) => {
    rows.push(row({ key: `t${i}`, at: ago(200), state: 'PENDING' }));
    rows.push(row({ key: `t${i}`, at: ago(200 - mins), state: 'COMPLETED' }));
  });
  const [f] = buildFunnel(buildJourneys(rows, NOW));
  // Median, not mean: one payment that took 100 minutes must not move the
  // number that describes the other four.
  ok('median, not mean', f.medianMins === 6, f.medianMins);
}

section('a payment we only ever saw once was not instant');
{
  // Everything that arrives by import looks like this: one stored state, the
  // final one. Counting those as taking zero minutes reported "median 0m to
  // settle" across a year of imported history — which reads as the fastest
  // provider alive and means nothing was measured.
  const imported = Array.from({ length: 5 }, (_, i) =>
    row({ key: `imp${i}`, at: ago(100), state: 'COMPLETED' }),
  );
  const [f] = buildFunnel(buildJourneys(imported, NOW));
  ok('no duration is claimed', f.medianMins === null, f.medianMins);
  ok('and they are counted as unobserved', f.singleState === 5, f.singleState);
  // They still count as completed — we know the outcome, just not the path.
  ok('the outcome still counts', f.approvalRate === 100, f.approvalRate);

  // Mixed: only the watched ones inform the median.
  const mixed = [
    ...imported,
    row({ key: 'watched', at: ago(100), state: 'PENDING' }),
    row({ key: 'watched', at: ago(93), state: 'COMPLETED' }),
  ];
  const [g] = buildFunnel(buildJourneys(mixed, NOW));
  ok('the watched one sets it', g.medianMins === 7, g.medianMins);
  ok('the unwatched are still counted', g.singleState === 5, g.singleState);
}

console.log(
  failures ? `\n${failures} check(s) failed.` : '\nAll journey checks passed.',
);
process.exit(failures ? 1 : 0);
