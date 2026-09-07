// The provider's own statement, checked against ours payment by payment.
//
// Every fixture here is a real event from one month of two live Match2Pay
// terminals, because the failures this has to survive are not the ones anybody
// invents. In order of how much they cost:
//
//   • a deposit recorded at 299.70 that the provider settled at 3,999.40. The
//     client had paid twice into an address whose invoice was already closed;
//     the wallet got everything, the CRM got the first transfer. The balance was
//     RIGHT throughout — no total could ever have found this.
//   • fourteen deposits the provider had completed and we still held under
//     "Awaiting Webhook", "Pending" and "Declined".
//   • "WITHDRAW" against "WITHDRAWAL": comparing the two words for equality
//     turned 1,348 reconciled payouts into 1,348 discrepancies.
//   • ten withdrawals that looked missing and were not — the statement ran a
//     day past our own ledger, and a window compared against a shorter window
//     reports the difference as missing money.
//
//   npm run build && node scripts/check-reconcile.mjs
//
// In a throwaway database.

import 'dotenv/config';
import { createRequire } from 'node:module';

import { useScratchDb } from './scratch-db.mjs';

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log(`ok    ${name}`);
  else {
    failures++;
    console.log(
      `FAIL  ${name} ${detail === undefined ? '' : JSON.stringify(detail)}`,
    );
  }
}
const section = (t) => console.log(`\n── ${t} ──`);

process.env.JWT_SECRET ??= 'reconcile-check';
process.env.PAYMAXIS_POLL_ENABLED = '0';

const TERMINAL = 'MT-SL-CHECK';
// The rules these terminals actually run: only "Completed" counts.
const RULES = {
  add: ['DEPOSIT'],
  subtract: ['WITHDRAWAL'],
  statuses: ['COMPLETED'],
  currency: 'USD',
};

/** A CRM reference carries the millisecond the address was asked for. */
const ref = (client, at) => `${client}_${Date.parse(at)}`;

async function run() {
  const drop = await useScratchDb('opsos_reconcile_check');
  const require_ = createRequire(import.meta.url);
  const { createApp } = require_('../dist/src/bootstrap');
  const { PrismaService } = require_('../dist/src/prisma/prisma.service');
  const {
    PspReconcileService,
    readStatement,
    raisedAt,
  } = require_('../dist/src/psps/psp-reconcile.service');

  const app = await createApp();
  await app.init();
  const prisma = app.get(PrismaService);
  const service = app.get(PspReconcileService);

  try {
    section('reading a statement whose columns are the provider\'s, not ours');
    {
      const { rows, columns, unreadable } = readStatement([
        {
          Created: '2026-09-01T10:41:49.619214Z',
          Status: 'DONE',
          Type: 'DEPOSIT',
          'Final amount': 3999.4,
          'Transaction amount': 3999.4,
          'Processing fee': 0,
        },
        {
          Created: '2026-09-01T11:38:56.000Z',
          Status: 'DONE',
          Type: 'WITHDRAW',
          'Final amount': 10,
        },
      ]);
      ok('both rows read', rows.length === 2, { rows, unreadable });
      ok('the settled amount wins over the requested one',
         columns.amount === 'Final amount', columns);
      // The one that cost 1,348 false discrepancies.
      ok('"WITHDRAW" is a withdrawal', rows[1].direction === 'out', rows[1]);
      ok('"DEPOSIT" is a deposit', rows[0].direction === 'in', rows[0]);

      const bad = readStatement([{ Created: 'not a date', Type: 'DEPOSIT', Amount: '1' }]);
      ok('a row that cannot be read is counted, not guessed at',
         bad.rows.length === 0 && bad.unreadable === 1, bad);
      // A figure with a thousands separator is a figure; a reference is not.
      ok('1,234.56 is a number', readStatement([
        { Created: '2026-09-01T00:00:00Z', Type: 'DEPOSIT', Amount: '1,234.56' },
      ]).rows[0]?.amount === 1234.56);
      ok('and CU13228_1788259307681 is not', readStatement([
        { Created: '2026-09-01T00:00:00Z', Type: 'DEPOSIT', Amount: 'CU13228_1788259307681' },
      ]).unreadable === 1);
    }

    section('the join two systems that share no id still have');
    {
      const r = raisedAt('CU13228_1788259307681', null);
      ok('the reference carries the instant the address was asked for',
         r?.toISOString() === '2026-09-01T10:41:47.681Z', r?.toISOString());
      ok('and a reference without one falls back to the timestamp we hold',
         raisedAt('no-epoch-here', new Date('2026-09-01T00:00:00Z'))?.toISOString()
           === '2026-09-01T00:00:00.000Z');
      ok('as does no reference at all',
         raisedAt(null, new Date('2026-09-01T00:00:00Z'))?.toISOString()
           === '2026-09-01T00:00:00.000Z');
    }

    const conn = await prisma.pspConnection.create({
      data: {
        label: 'Match2Pay SL (check)',
        terminal: TERMINAL,
        provider: 'match2pay',
        ledgerSource: 'paymaxis',
        movementRules: RULES,
      },
    });

    // Our ledger, as Paymaxis delivered it. Note the PENDING event alongside the
    // COMPLETED one for the same payment: reconciling per EVENT rather than per
    // PAYMENT would double every deposit here.
    const event = (n) =>
      prisma.paymentEvent.create({
        data: {
          provider: 'paymaxis',
          terminal: TERMINAL,
          paymentId: n.paymentId,
          reference: n.reference,
          customer: n.customer ?? null,
          type: n.type,
          state: n.state,
          amount: n.amount,
          currency: 'USD',
          occurredAt: new Date(n.at),
          headers: {},
          payload: {},
        },
      });

    // THE ONE. Invoiced 299.70, paid twice into the same address, 3,999.40 landed.
    await event({ paymentId: 'p-cu13228', reference: ref('CU13228', '2026-09-01T10:41:47.681Z'),
                  customer: 'CU13228', type: 'DEPOSIT', state: 'PENDING', amount: 299.7,
                  at: '2026-09-01T10:41:47.000Z' });
    await event({ paymentId: 'p-cu13228', reference: ref('CU13228', '2026-09-01T10:41:47.681Z'),
                  customer: 'CU13228', type: 'DEPOSIT', state: 'COMPLETED', amount: 299.7,
                  at: '2026-09-01T10:41:48.000Z' });
    // An ordinary deposit and an ordinary withdrawal, both right.
    await event({ paymentId: 'p-ok-in', reference: ref('CU999', '2026-09-02T09:00:00.000Z'),
                  customer: 'CU999', type: 'DEPOSIT', state: 'COMPLETED', amount: 100,
                  at: '2026-09-02T09:00:00.000Z' });
    await event({ paymentId: 'p-ok-out', reference: ref('CU999', '2026-09-02T10:00:00.000Z'),
                  customer: 'CU999', type: 'WITHDRAWAL', state: 'COMPLETED', amount: 50,
                  at: '2026-09-02T10:00:00.000Z' });
    // Settled by the provider; still Awaiting Webhook here.
    await event({ paymentId: 'p-stuck', reference: ref('CU57183', '2026-09-02T11:00:00.000Z'),
                  customer: 'CU57183', type: 'DEPOSIT', state: 'AWAITING WEBHOOK', amount: 40,
                  at: '2026-09-02T11:00:00.000Z' });
    // An address nobody ever paid into. The provider's statement has no row for
    // it, and it must NOT be reported as anything at all.
    await event({ paymentId: 'p-never', reference: ref('CU4242', '2026-09-02T15:00:00.000Z'),
                  customer: 'CU4242', type: 'DEPOSIT', state: 'AWAITING WEBHOOK', amount: 75,
                  at: '2026-09-02T15:00:00.000Z' });

    const at = (iso, s) => ({ Created: iso, Status: 'DONE', ...s });
    const statement = [
      at('2026-09-01T10:41:49.619Z', { Type: 'DEPOSIT', 'Final amount': 3999.4 }),
      at('2026-09-02T09:00:01.000Z', { Type: 'DEPOSIT', 'Final amount': 100 }),
      at('2026-09-02T10:00:02.000Z', { Type: 'WITHDRAW', 'Final amount': 50 }),
      at('2026-09-02T11:00:01.000Z', { Type: 'DEPOSIT', 'Final amount': 82.7 }),
      // Never reached us at all.
      at('2026-09-02T13:00:00.000Z', { Type: 'WITHDRAW', 'Final amount': 30 }),
      // Not settled — must be ignored rather than treated as movement.
      { Created: '2026-09-02T14:00:00.000Z', Status: 'EXPIRED', Type: 'DEPOSIT', 'Final amount': 500 },
    ];

    section('one month, one terminal');
    {
      const r = await service.reconcile(conn.id, statement);

      ok('the settled rows are separated from the rest',
         r.statement.settled === 5 && r.statement.ignored === 1, r.statement);
      ok('and every settled one found its payment',
         r.matched === 4 && r.missing.length === 1, { matched: r.matched, missing: r.missing });
      ok('an address nobody paid into is not reported',
         !r.uncounted.some((u) => u.value === 75) &&
           !r.missing.some((m) => m.amount === 75), r.uncounted);

      // THE FINDING.
      const cu = r.amountErrors[0];
      ok('the deposit paid twice is found', r.amountErrors.length === 1, r.amountErrors);
      ok('  ours 299.70', cu?.ours === 299.7, cu);
      ok('  theirs 3,999.40', cu?.theirs === 3999.4, cu);
      ok('  short by 3,699.70', cu?.difference === 3699.7, cu);
      ok('  and it names the client', cu?.customer === 'CU13228', cu);
      // Counted once, not once per event.
      ok('a payment with two events is one payment',
         r.counted.payments === 3, r.counted);

      // A status with a SPACE in it — the reason the internal key is not
      // separated by one. "AWAITING WEBHOOK" must survive whole.
      const stuck = r.uncounted.find((u) => u.status === 'AWAITING WEBHOOK');
      ok('the settled deposit we still hold as awaiting is named',
         stuck?.payments === 1 && stuck?.value === 82.7, r.uncounted);

      const gone = r.missing[0];
      ok('a payout we hold no record of is named',
         gone?.amount === 30 && gone?.direction === 'out', r.missing);

      // The whole point, in money: what this does to the estimate.
      //   -3,699.70  deposit recorded short
      //     -82.70   deposit settled and not counted
      //     +30.00   payout that left and we never recorded
      ok('the drift is itemised, not fitted',
         r.net === Math.round((-3699.7 - 82.7 + 30) * 100) / 100, r.net);
    }

    section('the phantom that a longer window invents');
    {
      // Ten Mauritius withdrawals "went missing" this way while this was being
      // written. Nothing was missing: the statement was pulled the next morning
      // and our export stopped the night before.
      const withOverhang = [
        ...statement,
        at('2026-09-04T04:04:45.000Z', { Type: 'WITHDRAW', 'Final amount': 30 }),
        at('2026-09-04T05:46:47.000Z', { Type: 'WITHDRAW', 'Final amount': 100 }),
      ];
      const r = await service.reconcile(conn.id, withOverhang);
      ok('payments past our last record are named as overhang',
         r.boundary !== null && r.boundary.includes('2'), r.boundary);
      ok('and are NOT reported as missing money',
         !r.missing.some((m) => m.amount === 100), r.missing);
      ok('so the drift is unchanged by them',
         r.net === Math.round((-3699.7 - 82.7 + 30) * 100) / 100, r.net);
    }

    section('what it refuses to do');
    {
      let msg = '';
      try {
        await service.reconcile(conn.id, []);
      } catch (e) { msg = e.message; }
      ok('an empty file is refused with something to do about it',
         /export the provider statement again/i.test(msg), msg);

      msg = '';
      try {
        await service.reconcile(conn.id, [{ nothing: 'useful', here: 1 }]);
      } catch (e) { msg = e.message; }
      ok('and so is a file whose columns mean nothing —', /could be read as payments/i.test(msg), msg);
      ok('  naming the columns it did find', /nothing, here/.test(msg), msg);

      // It reads. It must never write.
      const before = await prisma.paymentEvent.count({ where: { terminal: TERMINAL } });
      await service.reconcile(conn.id, statement);
      const after = await prisma.paymentEvent.count({ where: { terminal: TERMINAL } });
      ok('reconciling changes nothing in the ledger', before === after, { before, after });
    }
  } finally {
    await app.close();
    await drop();
  }

  return failures;
}

void run()
  .then((n) => {
    console.log(n ? `\n${n} check(s) failed.` : '\nAll reconciliation checks passed.');
    process.exit(n ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
