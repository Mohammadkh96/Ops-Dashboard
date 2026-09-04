// The balance, against a REAL PostgreSQL.
//
// check:balance runs the same service against an in-memory stand-in, and that
// is worth having: it is fast and it covers the arithmetic. But it cannot
// cover the database, and the database is where the last two bugs were.
//
// The one that made this file necessary: `beforeAnchor` was expressed as
// NOT(movedAfter). In SQL that is
//   NOT (settledAt > x OR (settledAt IS NULL AND occurredAt > x))
// and for a row with no settledAt it evaluates to NOT(NULL OR FALSE) = NULL,
// which is not TRUE, so the row is dropped. Every row has a null settledAt
// until somebody maps the field — so the count was zero for exactly the case
// it exists to explain. JavaScript's `!` is two-valued and the fake passed it
// without blinking.
//
// Anything involving NULL, ordering, or aggregation belongs here rather than
// there. Skips loudly where no postgres binary exists.
//
//   npm run check:sqlbalance

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const PG = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin']
  .find((d) => existsSync(join(d, 'initdb')));
if (!PG) {
  console.log('skip  no postgres binary here — nothing to check against.');
  process.exit(0);
}

let failures = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log(`ok    ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name} ${detail === undefined ? '' : JSON.stringify(detail)}`);
  }
};
const section = (t) => console.log(`\n── ${t} ──`);

const PORT = 55435;
const dir = mkdtempSync('/var/tmp/opsos-bal-');
const sh = (cmd, opts = {}) => execFileSync('bash', ['-lc', cmd], opts);
const asPg = (c) => `su postgres -s /bin/bash -c "export PATH=${PG}:\\$PATH; ${c}"`;

let started = false;
let prisma;
try {
  sh(`chown postgres:postgres ${dir} && chmod 700 ${dir}`);
  sh(asPg(`initdb -D ${dir} -U app --auth=trust`), { stdio: 'ignore' });
  sh(asPg(`pg_ctl -D ${dir} -o '-p ${PORT} -c listen_addresses=127.0.0.1' -l ${dir}/log start`), {
    stdio: 'ignore',
  });
  started = true;
  const url = `postgresql://app@127.0.0.1:${PORT}/opsos?sslmode=disable`;
  sh(`${PG}/psql -h 127.0.0.1 -p ${PORT} -U app -d postgres -c 'CREATE DATABASE opsos'`, {
    stdio: 'ignore',
  });
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: url },
  });

  const { PrismaClient } = require('../dist/generated/prisma/client');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { PspBalanceService, readRules } = require('../dist/src/psps/psp-balance.service');
  const { PspSyncService } = require('../dist/src/psps/psp-sync.service');
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  const svc = new PspBalanceService(prisma);
  const anchorFor = (connId, amount) =>
    svc.setAnchor(connId, { amount, currency: 'USD', takenAt: new Date().toISOString() });

  // ══ ForumPay: its own API, one row per payment ═════════════════════════
  const fp = await prisma.pspConnection.create({
    data: {
      terminal: 'ForumPay_Tradin SL',
      provider: 'forumpay',
      label: 'ForumPay Saint Lucia',
      ledgerSource: 'provider',
      movementRules: {
        currency: 'USD',
        add: ['Sell'],
        subtract: ['Buy'],
        statuses: ['confirmed'],
      },
    },
  });
  const fpRow = (o) =>
    prisma.pspTransaction.create({
      data: {
        connectionId: fp.id,
        terminal: fp.terminal,
        currency: 'USD',
        direction: 'Sell',
        raw: {},
        ...o,
      },
    });

  section('ForumPay: a payment still pending when the balance is entered');
  {
    // History, all settled long ago.
    for (let i = 0; i < 3; i++) {
      await fpRow({
        externalId: `hist-${i}`, amount: '1000.00', status: 'confirmed',
        occurredAt: new Date('2026-08-20T10:00:00Z'),
        settledAt: new Date('2026-08-20T10:01:00Z'),
      });
    }
    // Raised on the 31st and NOT yet confirmed. It is not in the portal figure
    // and must not be in the baseline.
    await fpRow({
      externalId: 'pending', amount: '500.00', status: 'waiting',
      occurredAt: new Date('2026-08-31T14:00:00Z'),
    });

    const { balance: b } = await anchorFor(fp.id, '172383.50');
    ok('the baseline is the settled history', b.movement.net === 0, b.movement);
    ok('and it is a baseline, not a date window', b.basis === 'baseline', b.basis);
    ok('the estimate starts at the figure entered',
       Math.abs(b.estimate - 172383.5) < 0.005, b.estimate);

    // Now it confirms. Its occurredAt is STILL 31 August — before the anchor.
    await prisma.pspTransaction.update({
      where: { connectionId_externalId: { connectionId: fp.id, externalId: 'pending' } },
      data: { status: 'confirmed', settledAt: new Date() },
    });
    const after = await svc.balance(fp.id);
    ok('confirming it moves the balance', after.movement.net === 500, after.movement);
    ok('by exactly its amount',
       Math.abs(after.estimate - 172883.5) < 0.005, after.estimate);
  }

  section('ForumPay: a confirmed payment that is later cancelled');
  {
    // The date window could not express this at all: the payment stops being
    // money, and the balance has to go DOWN.
    const before = await svc.balance(fp.id);
    await prisma.pspTransaction.update({
      where: { connectionId_externalId: { connectionId: fp.id, externalId: 'hist-0' } },
      data: { status: 'cancelled' },
    });
    const after = await svc.balance(fp.id);
    ok('the estimate falls', after.estimate < before.estimate, {
      before: before.estimate, after: after.estimate,
    });
    ok('by the payment that stopped being money',
       Math.abs(before.estimate - after.estimate - 1000) < 0.005,
       { before: before.estimate, after: after.estimate });
  }

  section('ForumPay: nothing is double counted by a re-sync');
  {
    const before = await svc.balance(fp.id);
    // A sync rewrites every row it saw, unchanged.
    const rows = await prisma.pspTransaction.findMany({ where: { connectionId: fp.id } });
    for (const r of rows) {
      await prisma.pspTransaction.update({ where: { id: r.id }, data: { status: r.status } });
    }
    const after = await svc.balance(fp.id);
    ok('the estimate is unchanged', after.estimate === before.estimate, {
      before: before.estimate, after: after.estimate,
    });
  }

  section("ForumPay: the provider's cut, which is not inside the amount");
  {
    // The reported gap: the estimate ran about 0.2% high against the portal,
    // always in the same direction, which is the shape of a percentage nobody
    // is subtracting. ForumPay charges a fee on every transaction and reports
    // it separately from invoice_amount, so a payout of 1,570.45 takes MORE
    // than 1,570.45 out of the balance.
    const fees = await prisma.pspConnection.create({
      data: {
        terminal: 'ForumPay_Fees',
        provider: 'forumpay',
        label: 'ForumPay with fees',
        ledgerSource: 'provider',
        movementRules: {
          currency: 'USD',
          add: ['Sell'],
          subtract: ['Buy'],
          statuses: ['confirmed'],
        },
      },
    });
    const row = (o) =>
      prisma.pspTransaction.create({
        data: {
          connectionId: fees.id,
          terminal: fees.terminal,
          currency: 'USD',
          status: 'confirmed',
          raw: {},
          occurredAt: new Date(),
          ...o,
        },
      });

    const { balance: start } = await svc.setAnchor(fees.id, {
      amount: '64741.31',
      currency: 'USD',
      takenAt: new Date().toISOString(),
    });
    ok('nothing moves before anything happens', start.movement.net === 0, start.movement);

    // A payout of 1,570.45 that also cost 3.14 in fees.
    await row({ externalId: 'payout', direction: 'Buy', amount: '1570.45', fee: '3.14' });
    const b = await svc.balance(fees.id);
    ok('the fee leaves the balance as well as the payout',
       Math.abs(b.movement.subtracted - 1573.59) < 0.005, b.movement);
    ok('and is reported separately', Math.abs(b.movement.fees - 3.14) < 0.005, b.movement);
    ok('so the estimate matches the portal',
       Math.abs(b.estimate - 63167.72) < 0.005, b.estimate);

    // A fee on a DEPOSIT is also a deduction: the provider charges for taking
    // money in, and netting it against the deposit would understate both.
    await row({ externalId: 'deposit', direction: 'Sell', amount: '1000.00', fee: '2.00' });
    const c = await svc.balance(fees.id);
    ok('a deposit still brings in its full amount',
       Math.abs(c.movement.added - 1000) < 0.005, c.movement);
    ok('and its fee is an outflow, not a smaller deposit',
       Math.abs(c.movement.fees - 5.14) < 0.005, c.movement);
    ok('the estimate accounts for both',
       Math.abs(c.estimate - 64165.72) < 0.005, c.estimate);

    // A provider that reports no fee must be unaffected. (The sign a provider
    // writes its fee with is normalised where it is parsed, not here — see
    // check:psp. Normalising in two places invites the two to disagree.)
    await row({ externalId: 'nofee', direction: 'Sell', amount: '50.00' });
    const e = await svc.balance(fees.id);
    ok('a row with no fee changes nothing',
       Math.abs(e.movement.fees - 5.14) < 0.005, e.movement);
    ok('and still brings in its amount',
       Math.abs(e.movement.added - 1050) < 0.005, e.movement);
  }

  // ══ MT: through Paymaxis, one row per STATE CHANGE ════════════════════
  const mt = await prisma.pspConnection.create({
    data: {
      terminal: 'MT_Tradin',
      provider: 'match2pay',
      label: 'Match2Pay',
      ledgerSource: 'paymaxis',
      movementRules: {
        currency: 'USD',
        add: ['DEPOSIT'],
        subtract: ['WITHDRAWAL'],
        statuses: ['COMPLETED'],
      },
    },
  });
  let evN = 0;
  const ev = (o) =>
    prisma.paymentEvent.create({
      data: {
        provider: 'paymaxis',
        terminal: 'MT_Tradin',
        currency: 'USD',
        headers: {},
        payload: {},
        dedupeKey: `k${++evN}`,
        ...o,
      },
    });

  section('mapping a fee AFTER a balance was entered');
  {
    // The trap this exists to close, and it sat directly in the path of the
    // advice being given: "map the fee field and the estimate stops drifting".
    //
    // The movement's fee is now.fees MINUS the anchor's baselineFees. Map a fee
    // on a terminal whose anchor was taken when no fee was mapped and the
    // baseline holds ZERO while "now" holds every fee in the stored history. A
    // month of them then comes off a twenty-hour movement — about a thousand
    // dollars, in the direction that looks like the correction somebody was
    // hoping for, with nothing on screen to say so: the like-for-like check
    // compares add/subtract/status words, and a fee mapping is none of those.
    const late = await prisma.pspConnection.create({
      data: {
        terminal: 'ForumPay_LateFee',
        provider: 'forumpay',
        label: 'ForumPay, fee mapped later',
        ledgerSource: 'provider',
        movementRules: {
          currency: 'USD',
          add: ['Sell'],
          subtract: ['Buy'],
          statuses: ['confirmed'],
        },
        // No fee mapped yet — the state every terminal is in today.
        endpoints: { transactions: { path: '/GetTransactions/', fields: { amount: 'invoice_amount' } } },
      },
    });
    const lateRow = (o) =>
      prisma.pspTransaction.create({
        data: {
          connectionId: late.id,
          terminal: late.terminal,
          currency: 'USD',
          status: 'confirmed',
          raw: {},
          occurredAt: new Date(),
          ...o,
        },
      });

    // A month of history already stored, each row carrying a fee in the raw
    // record that nothing is reading yet.
    for (let i = 0; i < 30; i++) {
      await lateRow({ externalId: `hist-${i}`, direction: 'Sell', amount: '1000.00' });
    }

    const { anchor: taken } = await svc.setAnchor(late.id, {
      amount: '100000.00',
      currency: 'USD',
      takenAt: new Date().toISOString(),
    });
    ok('the anchor records that no fee was mapped', taken.baselineFeePath === null, taken.baselineFeePath);

    // One day passes: one more deposit.
    await lateRow({ externalId: 'today', direction: 'Sell', amount: '500.00' });
    const before = await svc.balance(late.id);
    ok('a day of movement is just the deposit', Math.abs(before.movement.net - 500) < 0.005, before.movement);

    // Now the operator does exactly what they were told: maps the fee field and
    // re-syncs, which writes a fee onto every stored row including the month of
    // history that is already inside the anchored figure.
    await prisma.pspConnection.update({
      where: { id: late.id },
      data: {
        endpoints: {
          transactions: {
            path: '/GetTransactions/',
            fields: { amount: 'invoice_amount', fee: 'processing_fee' },
          },
        },
      },
    });
    await prisma.pspTransaction.updateMany({
      where: { connectionId: late.id },
      data: { fee: '2.00' },
    });

    const after = await svc.balance(late.id);
    // 31 rows x 2.00 = 62.00 of fees exist. Only the ONE row after the anchor
    // is movement; the other 30 are inside the figure that was read off the
    // portal. Subtracting all 62 would be the bug.
    ok('the whole history of fees is NOT subtracted from one day of movement',
       Math.abs(after.movement.net - 500) < 0.005, after.movement);
    ok('the estimate does not drop by a month of fees',
       Math.abs(after.estimate - before.estimate) < 0.005,
       { before: before.estimate, after: after.estimate });
    ok('and the screen says the mapping moved', after.feeMappingChanged === true, after);
    // Held out entirely rather than half-applied: a fee measured under one
    // mapping minus one measured under another is not a fee.
    ok('no fee is claimed while the two sides disagree', after.movement.fees === 0, after.movement);

    // Re-entering the balance measures both sides the same way again, and from
    // then on the fee counts properly.
    const { balance: reset } = await svc.setAnchor(late.id, {
      amount: '100500.00',
      currency: 'USD',
      takenAt: new Date().toISOString(),
    });
    ok('re-anchoring clears the warning', reset.feeMappingChanged === false, reset);

    await lateRow({ externalId: 'tomorrow', direction: 'Buy', amount: '200.00', fee: '2.00' });
    const good = await svc.balance(late.id);
    ok('and the fee then counts, once, on the new movement',
       Math.abs(good.movement.fees - 2) < 0.005, good.movement);
    ok('the payout and its fee both leave',
       Math.abs(good.movement.subtracted - 202) < 0.005, good.movement);
  }

  section('a transaction that arrives AFTER the anchor but happened BEFORE it');
  {
    // The hole in a stored baseline, and the one that can move a balance by
    // tens of thousands rather than tens.
    //
    // baselineIn/baselineOut are a snapshot of what was STORED when the balance
    // was entered. A row that reaches us later but whose money moved earlier is
    // absent from that snapshot and present in "now" — so it reads as movement
    // since the anchor, when in truth it is already inside the figure somebody
    // copied off the portal. A full sync, a CSV import, or a provider that
    // simply reported a payout late all produce exactly this.
    //
    // It has to be told apart from the case the baseline exists FOR: a payment
    // pending at the anchor and confirmed afterwards, which IS movement. The
    // discriminator is not the date alone — it is whether we already held the
    // row. firstSeenAt says that.
    const late = await prisma.pspConnection.create({
      data: {
        terminal: 'ForumPay_LateArrival',
        provider: 'forumpay',
        label: 'ForumPay, a row that arrives late',
        ledgerSource: 'provider',
        movementRules: {
          currency: 'USD',
          add: ['Sell'],
          subtract: ['Buy'],
          statuses: ['confirmed'],
        },
      },
    });
    const at = (iso, o) =>
      prisma.pspTransaction.create({
        data: {
          connectionId: late.id,
          terminal: late.terminal,
          currency: 'USD',
          status: 'confirmed',
          raw: {},
          occurredAt: new Date(iso),
          settledAt: new Date(iso),
          ...o,
        },
      });

    const day = (n) => `2026-09-0${n}T09:00:00.000Z`;
    await at(day(1), { externalId: 'old-1', direction: 'Sell', amount: '1000.00' });

    // The balance is read off the portal on the 2nd. It already contains
    // everything that had moved by then, including a payout on the 1st that we
    // had not yet been told about.
    await svc.setAnchor(late.id, {
      amount: '100000.00',
      currency: 'USD',
      takenAt: '2026-09-02T09:42:00.000Z',
    });

    // A day later a sync brings in that payout, dated the 1st.
    await at(day(1), { externalId: 'late-payout', direction: 'Buy', amount: '30000.00' });

    const b = await svc.balance(late.id);
    ok('a payout that happened before the anchor is not movement',
       Math.abs(b.movement.subtracted) < 0.005, b.movement);
    ok('so the estimate does not fall by it',
       Math.abs(b.estimate - 100000) < 0.005, b.estimate);

    // And the case this must not break: a payment we ALREADY held, pending at
    // the anchor, that settles afterwards. Same dates, different history.
    const pending = await prisma.pspTransaction.create({
      data: {
        connectionId: late.id,
        terminal: late.terminal,
        currency: 'USD',
        status: 'waiting',
        raw: {},
        externalId: 'pending-at-anchor',
        direction: 'Sell',
        amount: '500.00',
        occurredAt: new Date(day(2)),
      },
    });
    await svc.setAnchor(late.id, {
      amount: '100000.00',
      currency: 'USD',
      takenAt: '2026-09-03T09:00:00.000Z',
    });
    await prisma.pspTransaction.update({
      where: { id: pending.id },
      // Confirms later, but ForumPay stamps it settled at the ORIGINAL time —
      // before the anchor. By date alone this looks retroactive; it is not.
      data: { status: 'confirmed', settledAt: new Date(day(2)) },
    });

    const c = await svc.balance(late.id);
    ok('but a payment we already held, settling later, still counts',
       Math.abs(c.movement.added - 500) < 0.005, c.movement);
  }

  section("ForumPay: the cut it takes and never reports");
  {
    // The real numbers, and the whole reason this exists. ForumPay reports no
    // fiat fee per payment and publishes no balance, so for a month the
    // estimate simply ran high. Two corrections against their portal, over
    // windows whose inflow share differed by nearly a factor of two, solve it:
    //
    //   0.70% x 10,177.71 in + 0.20% x  9,081.86 out =  89.41  (portal: 89.40)
    //   0.70% x 15,623.18 in + 0.20% x 39,372.14 out = 188.11  (portal: 188.08)
    //
    // Corroborated by a number that was NOT used to derive it: ForumPay was
    // separately seen charging 3.14 on a 1,570.45 payout, which is 0.1999%.
    const rated = await prisma.pspConnection.create({
      data: {
        terminal: 'ForumPay_Rates',
        provider: 'forumpay',
        label: 'ForumPay with modelled rates',
        ledgerSource: 'provider',
        movementRules: {
          currency: 'USD',
          add: ['Sell'],
          subtract: ['Buy'],
          statuses: ['confirmed'],
          feeRateIn: 0.7,
          feeRateOut: 0.2,
        },
      },
    });
    const put = (o) =>
      prisma.pspTransaction.create({
        data: {
          connectionId: rated.id,
          terminal: rated.terminal,
          currency: 'USD',
          status: 'confirmed',
          raw: {},
          occurredAt: new Date(),
          settledAt: new Date(),
          ...o,
        },
      });

    await svc.setAnchor(rated.id, {
      amount: '221977.91',
      currency: 'USD',
      takenAt: new Date(Date.now() - 60_000).toISOString(),
    });

    // The second window as it actually stood on the dashboard.
    await put({ externalId: 'in', direction: 'Sell', amount: '15623.18' });
    await put({ externalId: 'out', direction: 'Buy', amount: '39372.14' });

    const b = await svc.balance(rated.id);
    ok('the deposit rate is charged on deposits',
       Math.abs(b.movement.fees - (0.007 * 15623.18 + 0.002 * 39372.14)) < 0.005,
       b.movement);
    // The number on the operator's screen, against the number on ForumPay's.
    ok('and the estimate lands on the portal figure',
       Math.abs(b.estimate - 198040.87) < 0.05, b.estimate);
    ok('the fee is an outflow, not a smaller deposit',
       Math.abs(b.movement.added - 15623.18) < 0.005, b.movement);

    // Configuring percentages says "this provider does not report its cut". A
    // stray reported fee must NOT then be added on top, or the same payment is
    // charged twice — once by the provider and once by us.
    await put({ externalId: 'reported', direction: 'Buy', amount: '1000.00', fee: '5.00' });
    const c = await svc.balance(rated.id);
    ok('a stray reported fee is not charged on top of the model',
       Math.abs(c.movement.fees - (b.movement.fees + 0.002 * 1000)) < 0.005,
       { before: b.movement.fees, after: c.movement.fees });

    // Changing a rate is the same trap as mapping a fee field late: the stored
    // baseline holds fees measured at the OLD rate.
    await prisma.pspConnection.update({
      where: { id: rated.id },
      data: {
        movementRules: {
          currency: 'USD',
          add: ['Sell'],
          subtract: ['Buy'],
          statuses: ['confirmed'],
          feeRateIn: 0.9,
          feeRateOut: 0.2,
        },
      },
    });
    const d = await svc.balance(rated.id);
    ok('changing a rate is caught like changing the mapping',
       d.feeMappingChanged === true, d.feeMappingChanged);
    ok('and no fee is claimed until the balance is entered again',
       d.movement.fees === 0, d.movement);
  }

  section('a fee rate that is not a rate');
  {
    const bad = (v) => readRules({ add: ['Sell'], feeRateIn: v })?.feeRateIn;
    ok('a percentage is read as one', bad(0.7) === 0.7);
    ok('zero is not a rate', bad(0) === undefined);
    ok('a negative is not a rate', bad(-1) === undefined);
    // 0.7 typed as a fraction and then read as a percent is 0.007% - harmless.
    // The dangerous typo is the other way: a decimal point misplaced, or a
    // fraction multiplied, which would take the whole balance out.
    ok('over 100% is a typo, not a fee', bad(700) === undefined);
    ok('a word is not a rate', bad('lots') === undefined);
    ok('nothing is not a rate', bad(undefined) === undefined);
  }

  section('"to 4 September" includes the 4th');
  {
    // A date input labelled "to" and set to the 4th means through the 4th.
    // Read literally it is midnight at the START of the 4th, so `lte` that
    // dropped the whole day — silently, which is the part that matters.
    //
    // It cost a real conclusion. A ledger exported "to 4 September" to
    // reconcile against Match2Pay's own file came out with nothing from the
    // 4th in it while theirs had a full day, and ten completed withdrawals
    // looked missing that were never missing.
    const dated = await prisma.pspConnection.create({
      data: {
        terminal: 'ForumPay_Dates',
        provider: 'forumpay',
        label: 'ForumPay, date filtering',
        ledgerSource: 'provider',
      },
    });
    const on = (iso, id) =>
      prisma.pspTransaction.create({
        data: {
          connectionId: dated.id,
          terminal: dated.terminal,
          externalId: id,
          currency: 'USD',
          status: 'confirmed',
          direction: 'Buy',
          amount: '10.00',
          raw: {},
          occurredAt: new Date(iso),
        },
      });
    await on('2026-09-03T12:00:00Z', 'third');
    await on('2026-09-04T00:00:00Z', 'fourth-midnight');
    await on('2026-09-04T05:57:00Z', 'fourth-morning');
    await on('2026-09-04T23:59:59Z', 'fourth-last-second');
    await on('2026-09-05T00:00:01Z', 'fifth');

    const sync = new PspSyncService(prisma, svc);
    const got = await sync.list(dated.id, { from: '2026-09-03', to: '2026-09-04' });
    const ids = got.rows.map((r) => r.externalId).sort();
    ok('the whole of the named day is included',
       ids.join(',') === 'fourth-last-second,fourth-midnight,fourth-morning,third',
       ids);
    ok('and the next day is not', !ids.includes('fifth'), ids);

    // An explicit instant is still honoured exactly — somebody who typed a
    // time meant that time.
    const precise = await sync.list(dated.id, { to: '2026-09-04T01:00:00Z' });
    ok('a time given explicitly is not widened to a day',
       precise.rows.every((r) => r.externalId !== 'fourth-morning'),
       precise.rows.map((r) => r.externalId));
  }

  section('Match2Pay: a charge per payment, not per dollar');
  {
    // Why every percentage failed here. A blockchain charges the same gas to
    // move 20 dollars as 2,000, so the cost tracks the COUNT. Against an
    // average 46-dollar withdrawal a flat 2.14 looks like 4.6%, and like 9% on
    // a quiet weekend of smaller ones — which is the unstable "rate" that kept
    // appearing and kept fitting nothing.
    //
    // The real window, both terminals: 4 deposits + 9 withdrawals on Saint
    // Lucia drifted 23.35, and 77 + 91 on Mauritius drifted 273.40.
    const mk = async (terminal, flatIn, flatOut) =>
      prisma.pspConnection.create({
        data: {
          terminal,
          provider: 'match2pay',
          label: terminal,
          ledgerSource: 'provider',
          movementRules: {
            currency: 'USD',
            add: ['DEPOSIT'],
            subtract: ['WITHDRAWAL'],
            statuses: ['Completed'],
            feeFlatIn: flatIn,
            feeFlatOut: flatOut,
          },
        },
      });

    const run = async (terminal, deposits, withdrawals, expected) => {
      const c = await mk(terminal, 1.0202, 2.141);
      await svc.setAnchor(c.id, {
        amount: '100000.00',
        currency: 'USD',
        takenAt: new Date(Date.now() - 60_000).toISOString(),
      });
      const put = (i, dir, amt) =>
        prisma.pspTransaction.create({
          data: {
            connectionId: c.id,
            terminal: c.terminal,
            externalId: `${dir}-${i}`,
            direction: dir,
            status: 'Completed',
            currency: 'USD',
            amount: amt,
            raw: {},
            occurredAt: new Date(),
            settledAt: new Date(),
          },
        });
      // Amounts deliberately varied: a per-payment charge must not care.
      for (let i = 0; i < deposits; i++) await put(i, 'DEPOSIT', String(10 + i * 7));
      for (let i = 0; i < withdrawals; i++) await put(i, 'WITHDRAWAL', String(15 + i * 3));
      const b = await svc.balance(c.id);
      ok(`${terminal}: the charge follows the payment count`,
         Math.abs(b.movement.fees - expected) < 0.01,
         { fees: b.movement.fees, expected });
      return b;
    };

    // 4 x 1.0202 + 9 x 2.141 = 23.35, which is what Saint Lucia actually drifted.
    await run('MT_SaintLucia_flat', 4, 9, 4 * 1.0202 + 9 * 2.141);
    // 77 x 1.0202 + 91 x 2.141 = 273.40, which is what Mauritius actually drifted.
    await run('MT_Mauritius_flat', 77, 91, 77 * 1.0202 + 91 * 2.141);

    // THE property a percentage does not have: the same payments at ten times
    // the value cost the same to move.
    const big = await mk('MT_BigTickets_flat', 1.0202, 2.141);
    await svc.setAnchor(big.id, {
      amount: '100000.00',
      currency: 'USD',
      takenAt: new Date(Date.now() - 60_000).toISOString(),
    });
    for (let i = 0; i < 9; i++) {
      await prisma.pspTransaction.create({
        data: {
          connectionId: big.id, terminal: big.terminal,
          externalId: `w-${i}`, direction: 'WITHDRAWAL', status: 'Completed',
          currency: 'USD', amount: String(5000 + i * 100), raw: {},
          occurredAt: new Date(), settledAt: new Date(),
        },
      });
    }
    const b = await svc.balance(big.id);
    ok('nine large withdrawals cost the same as nine small ones',
       Math.abs(b.movement.fees - 9 * 2.141) < 0.01, b.movement.fees);
  }

  section('a fee held out must come out of the baseline too');
  {
    // Straight off the screen. ForumPay SL, anchored an hour earlier, showed
    //     in 400.02   out -3,807.23   movement +4,207.25
    // A NEGATIVE outflow: an hour of payouts adding money to the balance.
    //
    // applyRules puts the fee inside `out` (t.out += fee), so a stored
    // baselineOut is payments-out PLUS every fee counted at the anchor. Holding
    // the fee out of `now` while leaving it inside the baseline makes the
    // subtraction short by the whole history of them.
    const fp = await prisma.pspConnection.create({
      data: {
        terminal: 'ForumPay_FeeHeldOut',
        provider: 'forumpay',
        label: 'ForumPay, fee mapping changed after anchoring',
        ledgerSource: 'provider',
        movementRules: {
          currency: 'USD',
          add: ['Sell'],
          subtract: ['Buy'],
          statuses: ['confirmed'],
        },
        endpoints: {
          transactions: {
            path: '/GetTransactions/',
            fields: { amount: 'invoice_amount', fee: 'processing_fee' },
          },
        },
      },
    });
    const put = (id, dir, amt, fee) =>
      prisma.pspTransaction.create({
        data: {
          connectionId: fp.id,
          terminal: fp.terminal,
          externalId: id,
          direction: dir,
          status: 'confirmed',
          currency: 'USD',
          amount: amt,
          fee,
          raw: {},
          occurredAt: new Date(),
          settledAt: new Date(),
        },
      });

    // A month of history, each payout carrying a fee. Deliberately MORE fee
    // history than the hour's payouts — which is the real proportion: ForumPay
    // had about 5,865 of fees behind it against 2,057 of payouts in the hour,
    // and that is what turned the outflow negative rather than merely short.
    for (let i = 0; i < 200; i++) await put(`hist-${i}`, 'Buy', '100.00', '30.00');

    const { anchor: a } = await svc.setAnchor(fp.id, {
      amount: '198040.87',
      currency: 'USD',
      takenAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    ok('the baseline carries the fees inside its outflow',
       Math.abs((a.baselineOut ?? 0) - (200 * 100 + 200 * 30)) < 0.005, a.baselineOut);
    ok('and records them separately too', Math.abs((a.baselineFees ?? 0) - 6000) < 0.005, a.baselineFees);

    // An hour of real payouts: 2,057.38 out, 400.02 in.
    await put('out-1', 'Buy', '807.38', '4.65');
    await put('out-2', 'Buy', '700.00', '0.11');
    await put('out-3', 'Buy', '200.00', '4.64');
    await put('out-4', 'Buy', '350.00', '4.65');
    await put('in-1', 'Sell', '150.00', '2.68');
    await put('in-2', 'Sell', '250.02', '2.68');

    // Now the fee mapping is changed, which is what the operator had just done.
    await prisma.pspConnection.update({
      where: { id: fp.id },
      data: {
        endpoints: {
          transactions: {
            path: '/GetTransactions/',
            fields: { amount: 'invoice_amount', fee: 'fee' },
          },
        },
      },
    });

    const b = await svc.balance(fp.id);
    ok('the fee mapping change is noticed', b.feeMappingChanged === true, b.feeMappingChanged);
    // THE assertion. Four payouts leave money; they cannot add it.
    ok('an hour of payouts is an OUTflow', b.movement.subtracted > 0, b.movement);
    ok('of exactly what was paid out, fees held aside',
       Math.abs(b.movement.subtracted - 2057.38) < 0.005, b.movement);
    ok('and the deposits are unaffected',
       Math.abs(b.movement.added - 400.02) < 0.005, b.movement);
    ok('so the balance FALLS over an hour of net payouts',
       b.estimate < 198040.87, b.estimate);
    ok('by the net of the two',
       Math.abs(b.estimate - (198040.87 + 400.02 - 2057.38)) < 0.005, b.estimate);
  }

  section('MT: both states of a payment carry the SAME occurredAt');
  {
    // Verbatim from the ledger screen: one second, two states. This is why no
    // date could ever place it — there is no settlement timestamp to find.
    const at = new Date('2026-09-02T05:43:15Z');
    await ev({ paymentId: 'p-old', type: 'DEPOSIT', state: 'COMPLETED',
               amount: 2000, occurredAt: new Date('2026-08-15T10:00:00Z'),
               receivedAt: new Date('2026-08-15T10:00:01Z') });
    await ev({ paymentId: 'p-late', type: 'DEPOSIT', state: 'PENDING',
               amount: 30, occurredAt: at, receivedAt: new Date('2026-09-02T05:43:16Z') });

    const { balance: b } = await anchorFor(mt.id, '130000.00');
    ok('the pending payment is not in the baseline', b.movement.net === 0, b.movement);
    ok('and MT uses a baseline too', b.basis === 'baseline', b.basis);

    // It completes — same occurredAt, settled amount net of the fee.
    await ev({ paymentId: 'p-late', type: 'DEPOSIT', state: 'COMPLETED',
               amount: 29.93, occurredAt: at,
               receivedAt: new Date('2026-09-02T05:43:59Z') });
    const after = await svc.balance(mt.id);
    ok('completing it moves the balance', Math.abs(after.movement.net - 29.93) < 0.005,
       after.movement);
    ok('at the settled amount, not the requested one',
       Math.abs(after.estimate - 130029.93) < 0.005, after.estimate);
    ok('and the payment counts once, not twice',
       after.movement.counted === 2, after.movement);
  }

  section('changing the rules is not silently reported as movement');
  {
    await prisma.pspConnection.update({
      where: { id: mt.id },
      data: {
        movementRules: {
          currency: 'USD',
          add: ['DEPOSIT'],
          subtract: ['WITHDRAWAL'],
          // Counting pending payments too is a different question.
          statuses: ['COMPLETED', 'PENDING'],
        },
      },
    });
    const b = await svc.balance(mt.id);
    ok('the screen is told the rules changed', b.rulesChanged === true, b);

    // Re-entering the balance re-measures the baseline under the new rules.
    const { balance: fresh } = await anchorFor(mt.id, '130029.93');
    ok('re-entering it clears that', fresh.rulesChanged === false, fresh);
    ok('and movement starts from zero again', fresh.movement.net === 0, fresh.movement);
  }

  section('a word only reordered is the same rules');
  {
    await prisma.pspConnection.update({
      where: { id: mt.id },
      data: {
        movementRules: {
          currency: 'usd',
          add: ['deposit'],
          subtract: ['WITHDRAWAL'],
          statuses: ['PENDING', 'COMPLETED'],
        },
      },
    });
    const b = await svc.balance(mt.id);
    ok('case and order are not a change', b.rulesChanged === false, b.rules);
  }

  section('BEEM: a ledger that arrives only as a file');
  {
    // No endpoint, ever: BEEM publishes create-type endpoints only, so its
    // ledger comes from the CSV its portal exports. Its amounts already carry
    // their sign and its Transaction ID repeats across a payment and its fee.
    const beem = await prisma.pspConnection.create({
      data: {
        terminal: 'BEEM_Tradin',
        provider: 'beem',
        label: 'BEEM',
        ledgerSource: 'provider',
        // Field mapping only — no path. Nothing to call.
        endpoints: {
          transactions: {
            path: '',
            fields: {
              id: 'Transaction ID+Transaction Type',
              amount: 'Amount',
              currency: 'Wallet Currency',
              status: 'Payment Status',
              date: 'Date Created',
              direction: 'Transaction Type',
            },
          },
        },
        movementRules: {
          currency: 'USDC',
          add: ['PAYMENT_IN'],
          subtract: ['PAYMENT_OUT', 'NETWORK_FEE', 'PROCESSING_FEE'],
          statuses: ['COMPLETE'],
          signed: true,
        },
      },
    });

    // Their real June-August totals, as four signed rows.
    const beemRow = (direction, amount) =>
      prisma.pspTransaction.create({
        data: {
          connectionId: beem.id,
          terminal: beem.terminal,
          externalId: `${direction}-1`,
          direction,
          status: 'COMPLETE',
          currency: 'USDC',
          amount,
          occurredAt: new Date('2026-08-30T20:16:56Z'),
          raw: {},
        },
      });
    await beemRow('PAYMENT_IN', '35939.594759');
    await beemRow('PAYMENT_OUT', '-11609.154551');
    await beemRow('NETWORK_FEE', '-284.488500');
    await beemRow('PROCESSING_FEE', '-71.879190');

    // Imported FIRST, then anchored — which is the order that matters. The
    // baseline is what is already counting, so anchoring first would leave it
    // at nothing and the whole import would land as movement.
    //
    // And anchored AS OF THE EXPORT'S CUTOFF, not as of the moment it was
    // typed. That distinction used to be invisible and is now load-bearing: a
    // balance is true at the instant the figure was true, and BEEM's running
    // balance comes out of an export that ends when the export ends. Date it
    // "now" and every payment between the cutoff and now is treated as already
    // inside it — which is exactly right for a figure read at "now", and
    // exactly wrong for one read off a two-day-old file.
    const { balance: b } = await svc.setAnchor(beem.id, {
      amount: '25160.845871',
      currency: 'USDC',
      takenAt: '2026-08-30T20:16:57.000Z',
    });
    ok('anchoring after the import starts movement at zero',
       b.movement.net === 0, b.movement);
    ok('at their own running balance',
       Math.abs(b.estimate - 25160.85) < 0.005, b.estimate);

    // A later export brings one new payment and repeats everything else.
    await beemRow('PAYMENT_IN', '500.000000').catch(() => {});
    await prisma.pspTransaction.create({
      data: {
        connectionId: beem.id, terminal: beem.terminal,
        externalId: 'PAYMENT_IN-2', direction: 'PAYMENT_IN', status: 'COMPLETE',
        currency: 'USDC', amount: '500.00',
        occurredAt: new Date('2026-09-02T10:00:00Z'), raw: {},
      },
    });
    const after = await svc.balance(beem.id);
    ok('only the new row moves it', Math.abs(after.movement.net - 500) < 0.005,
       after.movement);
    // Signed amounts: the outflows must not be double-negated into gains.
    ok('money out is reported as out, not as in',
       after.movement.subtracted === 0 && after.movement.added === 500,
       after.movement);

    // The other half of the same rule, and the failure it prevents: a row that
    // arrives later but whose money moved BEFORE the figure was true is already
    // inside that figure. Counting it again is how one late payout moves a
    // balance by tens of thousands.
    await prisma.pspTransaction.create({
      data: {
        connectionId: beem.id, terminal: beem.terminal,
        externalId: 'PAYMENT_OUT-late', direction: 'PAYMENT_OUT',
        status: 'COMPLETE', currency: 'USDC', amount: '-9000.00',
        occurredAt: new Date('2026-08-29T10:00:00Z'), raw: {},
      },
    });
    const late = await svc.balance(beem.id);
    ok('a payout dated before the anchor does not move it',
       Math.abs(late.movement.net - 500) < 0.005, late.movement);

    const dir = await new PspSyncService(prisma, svc).directory();
    const card = dir.find((d) => d.id === beem.id);
    ok('its card opens even with no endpoint configured',
       card?.hasTransactions === true, card);
    ok('and reports what it holds', card?.stored === 6, card?.stored);
  }

  console.log(failures ? `\n${failures} failed` : '\nall good');
} finally {
  await prisma?.$disconnect?.();
  if (started) {
    try {
      sh(asPg(`pg_ctl -D ${dir} stop -m immediate`), { stdio: 'ignore' });
    } catch { /* already gone */ }
  }
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
