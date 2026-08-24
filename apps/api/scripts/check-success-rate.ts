// The overview's arithmetic, pinned. These four numbers get read aloud in
// meetings, so every definition in them is a decision worth defending:
// what counts as success, what counts as money, and which way it flowed.
//
//   npx tsx scripts/check-success-rate.ts

import {
  buildSuccessRate,
  directionOf,
  stateBucket,
  type SuccessRow,
} from '../src/modules/success-rate';
import { isSettledState } from '../src/paymaxis/normalize';

let failures = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`ok    ${name.padEnd(56)}`);
  else {
    failures++;
    console.log(`FAIL  ${name.padEnd(56)} ${JSON.stringify(detail)}`);
  }
}
const section = (t: string) => console.log(`\n── ${t} ──`);

const row = (o: Partial<SuccessRow>): SuccessRow => ({
  type: 'DEPOSIT',
  state: 'COMPLETED',
  amount: 100,
  currency: 'USD',
  ...o,
});
const build = (rows: SuccessRow[]) => buildSuccessRate(rows, { settled: isSettledState });
const group = (rows: SuccessRow[], key: string) =>
  build(rows).groups.find((g) => g.key === key)!;

section('states land in the right bucket');
{
  ok('COMPLETED → completed', stateBucket('COMPLETED', isSettledState) === 'completed');
  ok('DECLINED → declined', stateBucket('DECLINED', isSettledState) === 'declined');
  // Separated on purpose: an abandoned checkout and a refused card are
  // different problems with different owners.
  ok('CANCELLED → cancelled', stateBucket('CANCELLED', isSettledState) === 'cancelled');
  ok('EXPIRED → cancelled', stateBucket('EXPIRED', isSettledState) === 'cancelled');
  ok('PENDING → pending', stateBucket('PENDING', isSettledState) === 'pending');
  ok('AWAITING_WEBHOOK → pending', stateBucket('AWAITING_WEBHOOK', isSettledState) === 'pending');
  ok('CHECKOUT → pending', stateBucket('CHECKOUT', isSettledState) === 'pending');
}

section('direction');
{
  ok('DEPOSIT', directionOf('DEPOSIT') === 'deposits');
  ok('WITHDRAWAL', directionOf('WITHDRAWAL') === 'withdrawals');
  ok('PAYOUT is a withdrawal', directionOf('PAYOUT') === 'withdrawals');
  ok('REFUND', directionOf('REFUND') === 'refunds');
  ok('unknown counts as a deposit', directionOf(null) === 'deposits');
}

section('the rate measures the rail, not the customer');
{
  const rows = [
    ...Array.from({ length: 76 }, () => row({ state: 'COMPLETED' })),
    ...Array.from({ length: 24 }, () => row({ state: 'DECLINED' })),
    ...Array.from({ length: 18 }, () => row({ state: 'CANCELLED' })),
    ...Array.from({ length: 51 }, () => row({ state: 'PENDING' })),
  ];
  const d = group(rows, 'deposits');
  ok('76 of 100 decided = 76%', d.successRate === 76, d.successRate);
  // The point of the definition: 169 payments, 76 good — but the rail refused
  // 24, and that is the number the rate is about.
  ok('abandoned and in-flight are excluded', d.decided === 100, d.decided);
  ok('but they are still counted', d.count === 169, d.count);
  ok('and still shown', d.slices.every((s) => s.count > 0), d.slices);
}

section('a rate over nothing is unknown, not zero');
{
  const d = group([row({ state: 'PENDING' }), row({ state: 'CANCELLED' })], 'deposits');
  // 0% reads as a total outage. Nothing has been decided, so there is no rate.
  ok('null, not 0', d.successRate === null, d.successRate);
  ok('empty period too', group([], 'total').successRate === null);
}

section('money is signed by direction');
{
  const rows = [
    row({ type: 'DEPOSIT', amount: 46367.26 }),
    row({ type: 'WITHDRAWAL', amount: 11530.58 }),
    row({ type: 'REFUND', amount: 2588.67 }),
  ];
  const b = build(rows);
  const g = (k: string) => b.groups.find((x) => x.key === k)!;
  ok('deposits are positive', g('deposits').amount === 46367.26, g('deposits').amount);
  ok('withdrawals are negative', g('withdrawals').amount === -11530.58, g('withdrawals').amount);
  ok('refunds are negative', g('refunds').amount === -2588.67, g('refunds').amount);
  // Net flow: what actually stayed. A gross total would rise when a customer
  // takes their money out, which is the opposite of what happened.
  ok('total is net flow', g('total').amount === 32248.01, g('total').amount);
  ok('a withdrawal already stored negative is not flipped twice',
    build([row({ type: 'WITHDRAWAL', amount: -500 })]).groups.find((x) => x.key === 'withdrawals')!
      .amount === -500);
}

section('only settled money reaches the headline');
{
  const rows = [
    row({ state: 'COMPLETED', amount: 1000 }),
    row({ state: 'DECLINED', amount: 9000 }),
    row({ state: 'PENDING', amount: 9000 }),
  ];
  const d = group(rows, 'deposits');
  ok('declined and pending are not revenue', d.amount === 1000, d.amount);
  // They are still visible in their own slice, so nothing is hidden.
  ok('the attempt is still reported', d.slices.find((s) => s.key === 'declined')!.amount === 9000);
}

section('the bar is share of count, not value');
{
  const rows = [
    ...Array.from({ length: 40 }, () => row({ state: 'COMPLETED', amount: 10 })),
    row({ type: 'WITHDRAWAL', state: 'COMPLETED', amount: 50000 }),
    ...Array.from({ length: 10 }, () => row({ state: 'DECLINED', amount: 10 })),
  ];
  const t = group(rows, 'total');
  const completed = t.slices.find((s) => s.key === 'completed')!;
  // 41 of 51 payments completed. By value the one big withdrawal would paint
  // the whole bar, and the operational picture is 51 payments.
  ok('41 of 51 = 80%', completed.share === 80, completed.share);
  ok('shares add to 100', t.slices.reduce((a, s) => a + s.share, 0) === 100, t.slices.map((s) => s.share));
}

section('groups partition the payments');
{
  const rows = [
    row({ type: 'DEPOSIT' }), row({ type: 'DEPOSIT' }),
    row({ type: 'WITHDRAWAL' }), row({ type: 'REFUND' }),
  ];
  const b = build(rows);
  const g = (k: string) => b.groups.find((x) => x.key === k)!;
  ok('total counts every payment once',
    g('total').count === g('deposits').count + g('withdrawals').count + g('refunds').count,
    [g('total').count, g('deposits').count, g('withdrawals').count, g('refunds').count]);
  ok('and reports the population', b.payments === 4, b.payments);
}

section('mixed currencies are declared, not hidden');
{
  const b = build([row({ currency: 'USD' }), row({ currency: 'EUR' }), row({ currency: 'USD' })]);
  ok('every currency seen is listed', JSON.stringify(b.currencies) === '["EUR","USD"]', b.currencies);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
