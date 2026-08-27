// What happens after a decline — pinned.
//
// This number decides whether somebody chases a customer and whether the desk
// pays a retry fee, so the ways it can be wrong all cost money: counting a
// second genuine purchase as a recovery flatters it, and reporting 0% where
// nobody actually tried sends a recoverable code to the bottom of the queue.
//
//   npx tsx scripts/check-retry-recovery.ts

import { buildRecovery, type AttemptRow } from '../src/modules/retry-recovery';

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

let seq = 0;
const row = (o: Partial<AttemptRow> & { at: Date }): AttemptRow => ({
  key: `pm-${++seq}`,
  customer: 'CU1',
  psp: 'Paystrax',
  amount: 100,
  currency: 'EUR',
  state: 'COMPLETED',
  errorCode: null,
  errorMessage: null,
  ...o,
});

section('a decline followed by a success is a recovery');
{
  const r = buildRecovery([
    row({ at: ago(120), state: 'DECLINED', errorCode: '05' }),
    row({ at: ago(110), state: 'COMPLETED' }),
  ]);
  ok('one decline', r.declines === 1);
  ok('one retry', r.retried === 1);
  ok('one recovery', r.recovered === 1);
  ok('the money is counted', r.recoveredAmount === 100, r.recoveredAmount);
  ok('rate is of those who tried', r.recoveryRate === 100, r.recoveryRate);
  const code = r.codes[0];
  ok('grouped by the code', code.code === '05', code.code);
  ok('and how long it took', code.medianMins === 10, code.medianMins);
}

section('a decline nobody retried is not a failed retry');
{
  const r = buildRecovery([
    row({ at: ago(120), state: 'DECLINED', errorCode: '51' }),
  ]);
  ok('counted as a decline', r.declines === 1);
  ok('but not as a retry', r.retried === 0);
  // The distinction the whole panel rests on: "nobody tried" and "the retries
  // all failed" look identical in a naive percentage and mean opposite things.
  ok(
    'the rate is unknown, not zero',
    r.codes[0].recoveryRate === null,
    r.codes[0].recoveryRate,
  );
  ok('it lands in the never-retried pile', r.codes[0].neverRetried === 1);
  ok('with its value', r.codes[0].neverRetriedAmount === 100);
}

section('the things that are not retries');
{
  const has = (rows: AttemptRow[]) => buildRecovery(rows).retried;

  // A different customer's payment is not this customer's retry.
  ok(
    'another customer',
    has([
      row({ at: ago(120), state: 'DECLINED', errorCode: '05' }),
      row({ at: ago(110), customer: 'CU2' }),
    ]) === 0,
  );
  // A different amount is a different purchase. This is the rule that keeps
  // the estimate conservative — it misses a customer who retried with a
  // different card for a different amount, and that is the right way to be
  // wrong.
  ok(
    'a different amount',
    has([
      row({ at: ago(120), state: 'DECLINED', errorCode: '05' }),
      row({ at: ago(110), amount: 250 }),
    ]) === 0,
  );
  // A different currency is not the same money.
  ok(
    'a different currency',
    has([
      row({ at: ago(120), state: 'DECLINED', errorCode: '05' }),
      row({ at: ago(110), currency: 'USD' }),
    ]) === 0,
  );
  // Tomorrow's deposit is not today's recovery.
  ok(
    'seven hours later',
    has([
      row({ at: ago(600), state: 'DECLINED', errorCode: '05' }),
      row({ at: ago(180) }),
    ]) === 0,
  );
  // A payment BEFORE the decline cannot be its retry.
  ok(
    'an earlier payment',
    has([
      row({ at: ago(110), state: 'DECLINED', errorCode: '05' }),
      row({ at: ago(120) }),
    ]) === 0,
  );
}

section('a retry that fails again is still a retry');
{
  const r = buildRecovery([
    row({ at: ago(120), state: 'DECLINED', errorCode: '51' }),
    row({ at: ago(110), state: 'DECLINED', errorCode: '51' }),
  ]);
  // Two declines; the first was retried, the second was not.
  ok('both are declines', r.declines === 2, r.declines);
  ok('one was retried', r.retried === 1, r.retried);
  ok('nothing recovered', r.recovered === 0);
  // 0% here is REAL — somebody tried and it did not work. Different from null.
  ok(
    'the rate is a measured zero',
    r.codes[0].recoveryRate === 0,
    r.codes[0].recoveryRate,
  );
}

section('did switching provider help');
{
  const r = buildRecovery([
    row({ at: ago(200), state: 'DECLINED', errorCode: '05', psp: 'Paystrax' }),
    row({ at: ago(190), psp: 'ForumPay' }),
    row({
      at: ago(120),
      state: 'DECLINED',
      errorCode: '05',
      psp: 'Paystrax',
      customer: 'CU2',
    }),
    row({ at: ago(110), psp: 'Paystrax', customer: 'CU2' }),
  ]);
  const code = r.codes.find((c) => c.code === '05')!;
  ok('both recovered', code.recovered === 2, code.recovered);
  // The actionable half: one of them worked by going elsewhere.
  ok(
    'one switched provider',
    code.switchedProvider.retried === 1,
    code.switchedProvider,
  );
  ok(
    'and it worked',
    code.switchedProvider.recovered === 1,
    code.switchedProvider,
  );
}

section('the queue only offers codes that have ever come back');
{
  const rows: AttemptRow[] = [];
  // Code 05: retried twice, recovered once, and 3 nobody touched — worth
  // chasing at 500 in value.
  rows.push(
    row({ at: ago(300), state: 'DECLINED', errorCode: '05', customer: 'CU1' }),
  );
  rows.push(row({ at: ago(290), customer: 'CU1' }));
  rows.push(
    row({ at: ago(300), state: 'DECLINED', errorCode: '05', customer: 'CU2' }),
  );
  rows.push(
    row({ at: ago(290), state: 'DECLINED', errorCode: '05', customer: 'CU2' }),
  );
  for (let i = 0; i < 3; i++) {
    rows.push(
      row({
        at: ago(200),
        state: 'DECLINED',
        errorCode: '05',
        customer: `CUx${i}`,
        amount: 500,
      }),
    );
  }
  // Code 43 (stolen card): 4 declines, one retried and it failed. Never
  // recovers — and must NOT be offered as work.
  rows.push(
    row({
      at: ago(300),
      state: 'DECLINED',
      errorCode: '43',
      customer: 'CUs1',
      amount: 900,
    }),
  );
  rows.push(
    row({
      at: ago(295),
      state: 'DECLINED',
      errorCode: '43',
      customer: 'CUs1',
      amount: 900,
    }),
  );
  for (let i = 0; i < 3; i++) {
    rows.push(
      row({
        at: ago(200),
        state: 'DECLINED',
        errorCode: '43',
        customer: `CUy${i}`,
        amount: 900,
      }),
    );
  }

  const r = buildRecovery(rows);
  const chase = r.worthChasing.map((c) => c.code);
  ok('a recoverable code is offered', chase.includes('05'), chase);
  // 43 has more money sitting in it and a proven 0% recovery. Putting it at
  // the top by value is how a work queue gets abandoned by the people meant
  // to work it.
  ok('a code that never recovers is not', !chase.includes('43'), chase);
  const five = r.worthChasing.find((c) => c.code === '05')!;
  // Four, not three: CU2's SECOND decline was never itself retried, so it is
  // in the pile too. That is right — a customer who tried twice and stopped
  // has a live unrecovered decline exactly like one who never tried at all.
  ok(
    'with the count nobody touched',
    five.neverRetried === 4,
    five.neverRetried,
  );
  ok('and the money in them', five.amount === 1600, five.amount);
  ok('and its observed rate', five.recoveryRate === 50, five.recoveryRate);
}

section('a decline with no code still groups');
{
  const r = buildRecovery([
    row({
      at: ago(120),
      state: 'DECLINED',
      errorMessage: 'Declined by issuer',
    }),
    row({ at: ago(110) }),
  ]);
  ok(
    'grouped by its message',
    r.codes[0].code === 'Declined by issuer',
    r.codes[0].code,
  );

  const bare = buildRecovery([row({ at: ago(120), state: 'DECLINED' })]);
  ok(
    'or says there was none',
    bare.codes[0].code === 'No code given',
    bare.codes[0].code,
  );
}

section('nothing declined at all');
{
  const r = buildRecovery([row({ at: ago(10) })]);
  ok('no declines', r.declines === 0);
  ok('the rate is unknown, not zero', r.recoveryRate === null, r.recoveryRate);
  ok('nothing to chase', r.worthChasing.length === 0);
}

console.log(
  failures ? `\n${failures} check(s) failed.` : '\nAll recovery checks passed.',
);
process.exit(failures ? 1 : 0);
