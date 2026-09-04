// The estimated balance: an anchor somebody typed in, moved by transactions.
//
// This is arithmetic that ends up on a screen labelled "balance", which is
// exactly the kind of number people stop questioning. So the things checked
// here are the ways it could be quietly wrong rather than visibly broken:
//
//   • transactions BEFORE the anchor must not count — they are already inside
//     the figure the person read off the portal, and counting them again
//     doubles a day's deposits
//   • a direction the rules do not mention must be IGNORED AND COUNTED, never
//     silently treated as zero movement, because "no rule for REFUND" and
//     "no refunds happened" produce the same balance and mean opposite things
//   • a pending deposit is not money, so the status filter has to hold
//   • a EUR row under a USD anchor must be excluded rather than added as if a
//     euro were a dollar
//   • re-anchoring must record the DRIFT against the estimate it replaced,
//     because the drift is the only evidence of how wrong this method gets
//
// A database-free stand-in, like check:sync: what is under test is the
// arithmetic and the exclusion rules, not Postgres.
//
//   npm run check:balance

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let failures = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log(`ok    ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name} ${detail === undefined ? '' : JSON.stringify(detail)}`);
  }
};
const section = (t) => console.log(`\n── ${t} ──`);

const {
  PspBalanceService,
  readRules,
  pickReported,
  fitDrift,
} = require('../dist/src/psps/psp-balance.service');
const { numericTotals, asNumber } = require('../dist/src/psps/record-fields');

/**
 * Just enough Prisma: findUnique/findMany on two tables, and a groupBy that
 * sums and counts. Written out rather than mocked per-call so the service's
 * real queries run — a fake that returns a canned group would be checking the
 * fake's arithmetic.
 */
function makeStore() {
  const connections = [];
  const txns = [];
  const anchors = [];
  const events = [];

  /**
   * Just the where-clause shapes the service actually builds.
   *
   * Grown deliberately rather than made general: every clause understood here
   * is one the code under test writes, and a fake that quietly matched
   * something it did not understand would report a balance of zero as a pass.
   */
  const matches = (row, where = {}) =>
    Object.entries(where).every(([k, cond]) => {
      if (k === 'OR') return cond.some((c) => matches(row, c));
      if (k === 'AND') return cond.every((c) => matches(row, c));
      if (k === 'NOT') return !matches(row, cond);
      const v = row[k];
      if (cond === null) return v === null || v === undefined;
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        if ('gt' in cond) return v instanceof Date && v > cond.gt;
        if ('gte' in cond) return v instanceof Date && v >= cond.gte;
        if ('lt' in cond) return v instanceof Date && v < cond.lt;
        if ('lte' in cond) return v instanceof Date && v <= cond.lte;
        if ('not' in cond) {
          return cond.not === null
            ? v !== null && v !== undefined
            : v !== cond.not;
        }
        throw new Error(`the fake does not understand ${JSON.stringify(cond)}`);
      }
      return v === cond;
    });

  const grouper = (rows) => async ({ by, where, _sum }) => {
    const out = new Map();
    for (const r of rows.filter((r) => matches(r, where))) {
      const key = JSON.stringify(by.map((k) => r[k] ?? null));
      const g = out.get(key) ?? {
        ...Object.fromEntries(by.map((k) => [k, r[k] ?? null])),
        _sum: { amount: 0 },
        _count: { _all: 0 },
      };
      g._count._all++;
      if (_sum?.amount) g._sum.amount += Number(r.amount ?? 0);
      out.set(key, g);
    }
    return [...out.values()];
  };

  return {
    connections,
    txns,
    anchors,
    events,
    pspConnection: {
      findUnique: async ({ where }) =>
        connections.find((c) => c.id === where.id) ?? null,
      findMany: async () => connections,
    },
    pspBalanceAnchor: {
      findMany: async ({ where, take } = {}) => {
        const rows = anchors
          .filter((a) => !where?.connectionId || a.connectionId === where.connectionId)
          .sort((a, b) => b.takenAt - a.takenAt);
        return take ? rows.slice(0, take) : rows;
      },
      create: async ({ data }) => {
        const row = {
          id: `a${anchors.length + 1}`,
          enteredAt: new Date(),
          note: null,
          enteredBy: null,
          estimateWas: null,
          drift: null,
          ...data,
        };
        anchors.push(row);
        return row;
      },
    },
    pspTransaction: {
      groupBy: grouper(txns),
      count: async ({ where }) => txns.filter((r) => matches(r, where)).length,
    },
    paymentEvent: {
      groupBy: grouper(events),
      count: async ({ where }) => events.filter((r) => matches(r, where)).length,
      findMany: async ({ where }) => events.filter((r) => matches(r, where)),
    },
  };
}

const D = (s) => new Date(s);
const ANCHOR_AT = '2026-09-01T12:00:00Z';

/** A ForumPay-shaped connection with the rules the desk would configure. */
function seed(store, rules = {
  currency: 'USD',
  add: ['Sell'],
  subtract: ['Buy'],
  statuses: ['confirmed'],
}) {
  store.connections.push({
    id: 'c1',
    terminal: 'ForumPay_Tradin',
    ledgerSource: 'provider',
    movementRules: rules,
  });
}

const txn = (o) => ({
  connectionId: 'c1',
  currency: 'USD',
  status: 'confirmed',
  occurredAt: D('2026-09-01T13:00:00Z'),
  ...o,
});

// ─────────────────────────────────────────────────────────────────────────
section('reading the rules');
{
  ok('nothing configured is null', readRules(null) === null);
  ok('an empty object is null', readRules({}) === null);
  ok('a string is null, not a crash', readRules('Sell') === null);
  ok('an array is null', readRules(['Sell']) === null);
  const r = readRules({ currency: ' usd ', add: ['Sell', '', ' Deposit '], subtract: 'Buy' });
  ok('the currency is trimmed and upper-cased', r.currency === 'USD', r);
  ok('blank words are dropped', r.add.length === 2, r);
  ok('words are trimmed', r.add[1] === 'Deposit', r);
  ok('a non-array is not a word list', r.subtract.length === 0, r);
}

section('no anchor yet');
{
  const store = makeStore();
  seed(store);
  store.txns.push(txn({ externalId: 't1', direction: 'Sell', amount: 500 }));
  const b = await new PspBalanceService(store).balance('c1');
  ok('there is no estimate', b.estimate === null, b);
  ok('and no movement is claimed', b.movement.net === 0, b.movement);
  ok('but the rules are reported as configured', b.configured === true, b);
}

section('an anchor, moved by what came after it');
{
  const store = makeStore();
  seed(store);
  store.anchors.push({
    id: 'a0',
    connectionId: 'c1',
    amount: 61512.27,
    currency: 'USD',
    takenAt: D(ANCHOR_AT),
    enteredAt: D(ANCHOR_AT),
    enteredBy: 'ops@tradin.com',
    note: null,
    estimateWas: null,
    drift: null,
  });
  store.txns.push(
    // After the anchor: these move it.
    txn({ externalId: 't1', direction: 'Sell', amount: 1000 }),
    txn({ externalId: 't2', direction: 'Sell', amount: 500.5 }),
    txn({ externalId: 't3', direction: 'Buy', amount: 200 }),
    // Before it: already inside the figure the portal showed.
    txn({ externalId: 't4', direction: 'Sell', amount: 9999, occurredAt: D('2026-08-31T09:00:00Z') }),
    // Exactly at the anchor: also already inside it.
    txn({ externalId: 't5', direction: 'Sell', amount: 4444, occurredAt: D(ANCHOR_AT) }),
    // Not money yet.
    txn({ externalId: 't6', direction: 'Sell', amount: 777, status: 'waiting' }),
    // A word no rule mentions.
    txn({ externalId: 't7', direction: 'Refund', amount: 50 }),
    // Another currency, not converted.
    txn({ externalId: 't8', direction: 'Sell', amount: 300, currency: 'EUR' }),
    // No timestamp at all, so it cannot be placed against the anchor.
    txn({ externalId: 't9', direction: 'Sell', amount: 88, occurredAt: null }),
  );

  const b = await new PspBalanceService(store).balance('c1');
  ok('added is only the confirmed USD sells after the anchor', b.movement.added === 1500.5, b.movement);
  ok('subtracted is the buy', b.movement.subtracted === 200, b.movement);
  ok('the net is the difference', b.movement.net === 1300.5, b.movement);
  ok('the estimate is anchor plus net', b.estimate === 62812.77, b);
  // `counted` is how many are COUNTING NOW, not how many moved since. With a
  // baseline there is no such number: a payment can enter and leave the
  // counting set without any date changing. The movement figure is the one
  // that answers "what happened", and it is asserted above.
  ok('the counting set is reported', b.movement.counted === 6, b.movement);

  // Each exclusion for exactly one reason, and every one of them visible.
  ok('the pending row is excluded as a status', b.movement.ignoredStatus === 1, b.movement);
  ok('the unknown direction is excluded and counted', b.movement.ignoredDirection === 1, b.movement);
  ok('the EUR row is excluded as a currency', b.movement.ignoredCurrency === 1, b.movement);
  ok('the undated row is reported', b.movement.undated === 1, b.movement);
  ok('the anchor is returned with the estimate', b.anchor?.amount === 61512.27, b.anchor);
  ok('and who entered it', b.anchor?.enteredBy === 'ops@tradin.com', b.anchor);
  ok('the age is reported in hours', typeof b.ageHours === 'number' && b.ageHours > 0, b);
}

section('a payment raised before the anchor and settled after it');
{
  // The ForumPay SL case, exactly. A payment is raised on the 31st and sits
  // pending. Somebody anchors the balance on the 2nd at 05:50 — the portal
  // does NOT include that payment, because it has not settled. It confirms at
  // 06:30. The money moved after the anchor, so it must count.
  //
  // Placed by its creation date it looks like it predates the anchor, so it
  // was treated as already inside the portal figure and never counted by
  // anything. Invisible rather than wrong, which is worse.
  const store = makeStore();
  seed(store);
  store.anchors.push({
    id: 'a0', connectionId: 'c1', amount: 172383.5, currency: 'USD',
    takenAt: D('2026-09-02T05:50:00Z'), enteredAt: D('2026-09-02T05:50:00Z'),
    enteredBy: null, note: null, estimateWas: null, drift: null,
  });
  store.txns.push(
    // Raised the 31st, settled after the anchor. This is the one that went missing.
    txn({ externalId: 'late', direction: 'Sell', amount: 500,
          occurredAt: D('2026-08-31T14:00:00Z'), settledAt: D('2026-09-02T06:30:00Z') }),
    // Raised AND settled before the anchor: genuinely inside the portal figure.
    txn({ externalId: 'old', direction: 'Sell', amount: 9999,
          occurredAt: D('2026-08-31T09:00:00Z'), settledAt: D('2026-08-31T09:05:00Z') }),
    // A provider that reports no settlement date at all still works off the
    // created date, which is all there is.
    txn({ externalId: 'plain', direction: 'Sell', amount: 25,
          occurredAt: D('2026-09-02T07:00:00Z'), settledAt: null }),
  );

  const b = await new PspBalanceService(store).balance('c1');
  ok('the late settlement counts', b.movement.added === 525, b.movement);
  ok('the counting set is reported', b.movement.counted === 3, b.movement);
  ok('the genuinely old one does not', b.movement.beforeAnchor === 1, b.movement);
  ok('the estimate moves by both', b.estimate === 172908.5, b);

  // Without a settled date the old behaviour returns, and the payment is lost.
  store.txns[0].settledAt = null;
  const without = await new PspBalanceService(store).balance('c1');
  ok('unmapped, the same payment goes missing', without.movement.added === 25, without.movement);
  ok('and is at least reported as before the anchor',
     without.movement.beforeAnchor === 2, without.movement);
}

section('the provider is not consistent about case');
{
  const store = makeStore();
  seed(store, { currency: 'USD', add: ['sell'], subtract: ['BUY'], statuses: ['Confirmed'] });
  store.anchors.push({
    id: 'a0', connectionId: 'c1', amount: 100, currency: 'USD',
    takenAt: D(ANCHOR_AT), enteredAt: D(ANCHOR_AT),
    enteredBy: null, note: null, estimateWas: null, drift: null,
  });
  store.txns.push(
    txn({ externalId: 't1', direction: 'Sell', amount: 10, status: 'confirmed' }),
    txn({ externalId: 't2', direction: 'Buy', amount: 4, status: 'CONFIRMED' }),
  );
  const b = await new PspBalanceService(store).balance('c1');
  ok('"sell" matches "Sell"', b.movement.added === 10, b.movement);
  ok('"Confirmed" matches "CONFIRMED"', b.movement.subtracted === 4, b.movement);
  ok('the estimate holds', b.estimate === 106, b);
}

section('no rules configured');
{
  const store = makeStore();
  seed(store, null);
  store.anchors.push({
    id: 'a0', connectionId: 'c1', amount: 100, currency: 'USD',
    takenAt: D(ANCHOR_AT), enteredAt: D(ANCHOR_AT),
    enteredBy: null, note: null, estimateWas: null, drift: null,
  });
  store.txns.push(txn({ externalId: 't1', direction: 'Sell', amount: 10 }));
  const b = await new PspBalanceService(store).balance('c1');
  // The estimate equals the anchor, which LOOKS like a balance that has not
  // moved. `configured: false` is what lets the screen say the difference.
  ok('the estimate is just the anchor', b.estimate === 100, b);
  ok('and it says it cannot classify anything', b.configured === false, b);
  ok('the unclassified row is counted, not hidden', b.movement.ignoredDirection === 1, b.movement);
}

section('re-anchoring records the drift');
{
  const store = makeStore();
  seed(store);
  const svc = new PspBalanceService(store);

  await svc.setAnchor('c1', { amount: 1000, currency: 'usd', takenAt: ANCHOR_AT }, 'ops@tradin.com');
  ok('the first anchor has no drift to report', store.anchors[0].drift === null, store.anchors[0]);
  ok('the currency is normalised', store.anchors[0].currency === 'USD', store.anchors[0]);

  store.txns.push(txn({ externalId: 't1', direction: 'Sell', amount: 300 }));
  const mid = await svc.balance('c1');
  ok('the estimate has moved', mid.estimate === 1300, mid);

  // The portal actually says 1290 — ten dollars of fees we never saw.
  const after = await svc.setAnchor(
    'c1',
    { amount: 1290, currency: 'USD', takenAt: '2026-09-02T12:00:00Z' },
    'ops@tradin.com',
  );
  ok('the new anchor keeps the estimate it replaced', after.anchor.estimateWas === 1300, after.anchor);
  ok('and the gap, signed', after.anchor.drift === 10, after.anchor);
  ok('the estimate now starts from the true figure', after.balance.estimate === 1290, after.balance);
  // Re-anchoring re-measures the baseline, so everything already counting is
  // inside it and the movement restarts at zero.
  ok('the older transaction no longer moves it', after.balance.movement.net === 0, after.balance.movement);

  const history = await svc.history('c1');
  ok('both anchors are kept', history.length === 2, history);
  ok('newest first', history[0].amount === 1290, history);
}

section('a terminal whose ledger comes from Paymaxis');
{
  const store = makeStore();
  store.connections.push({
    id: 'c1',
    terminal: 'MT_Tradin',
    ledgerSource: 'paymaxis',
    movementRules: {
      currency: 'USD',
      add: ['DEPOSIT'],
      subtract: ['WITHDRAWAL'],
      statuses: ['COMPLETED'],
    },
  });
  store.anchors.push({
    id: 'a0', connectionId: 'c1', amount: 130000, currency: 'USD',
    takenAt: D(ANCHOR_AT), enteredAt: D(ANCHOR_AT),
    enteredBy: null, note: null, estimateWas: null, drift: null,
  });
  // Real rows: PaymentEvent always carries an id and a receivedAt, and each of
  // these is a DIFFERENT payment — the pending one is not a second event about
  // one of the others.
  let n = 0;
  const ev = (o) => ({
    id: `e${++n}`,
    paymentId: `pay-${n}`,
    externalId: null,
    terminal: 'MT_Tradin',
    currency: 'USD',
    state: 'COMPLETED',
    occurredAt: D('2026-09-01T15:00:00Z'),
    receivedAt: D('2026-09-01T15:00:01Z'),
    ...o,
  });
  store.events.push(
    ev({ type: 'DEPOSIT', amount: 2500 }),
    ev({ type: 'WITHDRAWAL', amount: 400 }),
    ev({ type: 'DEPOSIT', amount: 100, state: 'PENDING' }),
  );

  const b = await new PspBalanceService(store).balance('c1');
  ok('Paymaxis rows move the balance too', b.movement.net === 2100, b.movement);
  ok('the estimate is right', b.estimate === 132100, b);
  ok('a pending deposit is not money', b.movement.ignoredStatus === 1, b.movement);
}

section('a payment Paymaxis reported more than once');
{
  // The MT bug, exactly as it appeared: PaymentEvent holds one row per state
  // change, so a deposit that went PENDING then COMPLETED is two rows — with
  // the SAME occurredAt, and often two different amounts because a fee is
  // taken between them. Summed as transactions, every deposit counted twice.
  const store = makeStore();
  store.connections.push({
    id: 'c1', terminal: 'MT_Tradin', ledgerSource: 'paymaxis',
    movementRules: {
      currency: 'USD', add: ['DEPOSIT'], subtract: ['WITHDRAWAL'],
      // Left EMPTY on purpose. A status filter hides this bug whenever one is
      // configured, which is exactly why it survived: it is only visible when
      // nothing is filtering the pending rows out.
      statuses: [],
    },
  });
  store.anchors.push({
    id: 'a0', connectionId: 'c1', amount: 100000, currency: 'USD',
    takenAt: D('2026-09-01T00:00:00Z'), enteredAt: D('2026-09-01T00:00:00Z'),
    enteredBy: null, note: null, estimateWas: null, drift: null,
  });

  const pair = (paymentId, type, pending, completed, at, recv) => [
    { id: `${paymentId}-p`, paymentId, externalId: null, terminal: 'MT_Tradin',
      type, state: 'PENDING', currency: 'USD', amount: pending,
      occurredAt: D(at), receivedAt: D(recv) },
    { id: `${paymentId}-c`, paymentId, externalId: null, terminal: 'MT_Tradin',
      type, state: 'COMPLETED', currency: 'USD', amount: completed,
      occurredAt: D(at), receivedAt: D(recv.replace('Z', '').slice(0, -2) + '59Z') },
  ];
  store.events.push(
    ...pair('eb55d5a22dc9', 'DEPOSIT', 30.0, 29.93, '2026-09-02T05:43:15Z', '2026-09-02T05:43:16Z'),
    ...pair('820e9aaf39ce', 'DEPOSIT', 100.0, 100.0, '2026-09-02T06:31:58Z', '2026-09-02T06:31:59Z'),
    ...pair('b129bddf964d', 'WITHDRAWAL', 11.06, 11.06, '2026-09-02T06:32:24Z', '2026-09-02T06:32:25Z'),
    // One that only ever had a single event.
    { id: 'fa1c757ca99e-c', paymentId: 'fa1c757ca99e', externalId: null,
      terminal: 'MT_Tradin', type: 'DEPOSIT', state: 'COMPLETED', currency: 'USD',
      amount: 19.93, occurredAt: D('2026-09-02T06:24:51Z'),
      receivedAt: D('2026-09-02T06:24:52Z') },
  );

  const b = await new PspBalanceService(store).balance('c1');
  // Four payments, not seven events.
  ok('each payment counts once', b.movement.counted === 4, b.movement);
  // 29.93 + 100 + 19.93 in, 11.06 out. Summed as events it would have been
  // 279.86 in and 22.12 out.
  ok('deposits are the settled amounts', Math.abs(b.movement.added - 149.86) < 0.005, b.movement);
  ok('the withdrawal counts once', Math.abs(b.movement.subtracted - 11.06) < 0.005, b.movement);
  ok('the estimate is right', Math.abs(b.estimate - 100138.8) < 0.005, b);
}

section('a provider that already puts the sign in the amount');
{
  // BEEM's wallet export, with its real totals for June-August 2026. Every
  // amount is signed: PAYMENT_IN positive, PAYMENT_OUT and both fee types
  // negative, and the signed total reconciles to their own Running Balance
  // column exactly. Configured the ordinary way this moves the balance by
  // twice the outflows, in the wrong direction, and looks reasonable doing it.
  const store = makeStore();
  store.connections.push({
    id: 'c1', terminal: 'BEEM_Tradin', ledgerSource: 'provider',
    movementRules: {
      currency: 'USDC',
      add: ['PAYMENT_IN'],
      subtract: ['PAYMENT_OUT', 'NETWORK_FEE', 'PROCESSING_FEE'],
      statuses: ['COMPLETE'],
      signed: true,
    },
  });
  store.anchors.push({
    id: 'a0', connectionId: 'c1', amount: 1186.773353, currency: 'USDC',
    takenAt: D('2026-06-03T12:00:00Z'), enteredAt: D('2026-06-03T12:00:00Z'),
    enteredBy: null, note: null, estimateWas: null, drift: null,
  });
  const beem = (direction, amount) => ({
    connectionId: 'c1', externalId: `${direction}-${amount}`, direction,
    status: 'COMPLETE', currency: 'USDC', amount,
    occurredAt: D('2026-07-01T00:00:00Z'),
  });
  store.txns.push(
    beem('PAYMENT_IN', 35939.594759),
    beem('PAYMENT_OUT', -11609.154551),
    beem('NETWORK_FEE', -284.4885),
    beem('PROCESSING_FEE', -71.87919),
  );

  const b = await new PspBalanceService(store).balance('c1');
  // Their own Running Balance column, to the cent.
  ok('the estimate matches the provider running balance',
     Math.abs(b.estimate - 25160.85) < 0.01, b);
  ok('money in is the positive rows', Math.abs(b.movement.added - 35939.59) < 0.01, b.movement);
  ok('money out is the negative ones, as a magnitude',
     Math.abs(b.movement.subtracted - 11965.52) < 0.01, b.movement);
  ok('all four types counted', b.movement.counted === 4, b.movement);

  // The same rows WITHOUT the flag: the failure this exists to prevent.
  store.connections[0].movementRules = {
    ...store.connections[0].movementRules, signed: false,
  };
  const wrong = await new PspBalanceService(store).balance('c1');
  ok('unflagged, the same ledger comes out badly wrong',
     Math.abs(wrong.estimate - 25160.85) > 20000, wrong);
}

section('the vocabulary a provider actually uses');
{
  const store = makeStore();
  seed(store);
  store.txns.push(
    txn({ externalId: 't1', direction: 'Sell', status: 'confirmed', amount: 1 }),
    txn({ externalId: 't2', direction: 'Sell', status: 'confirmed', amount: 1 }),
    txn({ externalId: 't3', direction: 'Buy', status: 'waiting', amount: 1 }),
    txn({ externalId: 't4', direction: null, status: 'confirmed', amount: 1 }),
  );
  const v = await new PspBalanceService(store).vocabulary('c1');
  ok('the commonest direction is first', v.directions[0].value === 'Sell', v.directions);
  ok('with its count', v.directions[0].count === 2, v.directions);
  ok('nulls are not offered as a word', v.directions.length === 2, v.directions);
  ok('statuses come back too', v.statuses.some((s) => s.value === 'waiting'), v.statuses);
  ok('and currencies', v.currencies[0].value === 'USD', v.currencies);
}

section('entering a figure that is not one');
{
  const store = makeStore();
  seed(store);
  const svc = new PspBalanceService(store);
  const rejects = async (body, why) => {
    try {
      await svc.setAnchor('c1', body);
      ok(why, false, 'it was accepted');
    } catch {
      ok(why, true);
    }
  };
  await rejects({ currency: 'USD' }, 'no amount is refused');
  await rejects({ amount: 'lots', currency: 'USD' }, 'a word is refused');
  await rejects({ amount: 100 }, 'no currency is refused');
  await rejects({ amount: 100, currency: 'USD', takenAt: 'tuesday' }, 'an unreadable date is refused');
  ok('and nothing was written', store.anchors.length === 0, store.anchors);
}


section('what the provider itself says');
{
  // The reading stored by the last successful balance test, as psps.service
  // writes it: { at, rows: [{ account, currency, amount }] }.
  const at = '2026-09-03T06:00:00.000Z';

  ok(
    'a single matching row is the balance',
    pickReported({ at, rows: [{ currency: 'USD', amount: 222984.36, account: null }] }, 'USD')
      ?.amount === 222984.36,
  );

  // Picked by CURRENCY, not by position. A provider with several wallets
  // returns several rows and the first is not necessarily the right one —
  // ForumPay returns a row per crypto, all near zero, and taking row zero
  // would put 0.0001 on a screen captioned "the provider says".
  const many = {
    at,
    rows: [
      { currency: 'BTC', amount: 0.00012, account: 'btc' },
      { currency: 'USD', amount: 222984.36, account: 'usd' },
      { currency: 'EUR', amount: 500, account: 'eur' },
    ],
  };
  ok('the right currency is chosen out of several', pickReported(many, 'USD')?.amount === 222984.36);
  ok('and its account comes with it', pickReported(many, 'USD')?.account === 'usd');
  ok('case does not matter', pickReported(many, 'usd')?.amount === 222984.36);

  // Two wallets in one currency is a total, not a choice.
  ok(
    'several rows in the balance currency are summed',
    pickReported(
      { at, rows: [{ currency: 'USD', amount: 100.5 }, { currency: 'USD', amount: 200.25 }] },
      'USD',
    )?.amount === 300.75,
  );
  ok(
    'and no single account is claimed for a sum',
    pickReported(
      { at, rows: [{ currency: 'USD', amount: 1, account: 'a' }, { currency: 'USD', amount: 2, account: 'b' }] },
      'USD',
    )?.account === null,
  );

  // NOTHING is worse than the wrong thing here. A figure under the heading
  // "the provider says" is the one number on the screen nobody will question.
  ok('no row in the balance currency yields nothing', pickReported(many, 'GBP') === null);
  ok('an unreadable amount is not a zero balance', pickReported({ at, rows: [{ currency: 'USD', amount: 'lots' }] }, 'USD') === null);
  ok('an empty reading is nothing', pickReported({ at, rows: [] }, 'USD') === null);
  ok('a reading with no timestamp is nothing', pickReported({ rows: [{ currency: 'USD', amount: 1 }] }, 'USD') === null);
  ok('never read is nothing', pickReported(null, 'USD') === null);
  ok('junk is nothing', pickReported('222984.36', 'USD') === null);
  ok('an array is nothing', pickReported([{ currency: 'USD', amount: 1 }], 'USD') === null);

  // A zero IS a balance. Dropping it would show an estimate beside a provider
  // that has actually been emptied, which is the moment it matters most.
  ok('zero is a balance', pickReported({ at, rows: [{ currency: 'USD', amount: 0 }] }, 'USD')?.amount === 0);

  // With no currency configured there is nothing to match on, so everything is
  // in scope — right for a provider that reports one wallet and no currency.
  ok(
    'with no currency asked for, one row still answers',
    pickReported({ at, rows: [{ currency: null, amount: 42 }] }, null)?.amount === 42,
  );
}


section('fitting how wrong this method has been');
{
  // An anchor as fitDrift reads one: what it corrected by, and the cumulative
  // in/out totals at the moment it was taken.
  const rules = { add: ['sell'], subtract: ['buy'], statuses: ['confirmed'] };
  // Newest first, a day apart. The span matters now: an interval with no
  // readable time between its two anchors cannot be measured per hour, so it
  // is skipped — and a fixture with no dates would silently measure nothing.
  let clock = Date.parse('2026-09-04T00:00:00Z');
  const at = (n) => ({
    drift: n.drift,
    baselineIn: n.in,
    baselineOut: n.out,
    baselineRules: rules,
    takenAt: new Date((clock -= 86_400_000) + 86_400_000).toISOString(),
  });

  // Newest first, as the service passes them. Two anchors, one interval:
  // 20,000 in and 10,000 out flowed between them, and the estimate finished
  // 150 high.
  const one = [at({ drift: 150, in: 30000, out: 15000 }), at({ drift: null, in: 10000, out: 5000 })];
  const fit = fitDrift(one);
  ok('one interval is one sample', fit?.samples === 1, fit);
  ok('the volume is the difference of the totals', fit?.volume === 30000, fit);
  ok('and the rate is drift over volume', Math.abs(fit.rate - 150 / 30000) < 1e-12, fit);

  // POOLED, not averaged. A big interval has to outweigh a small one, or a
  // quiet afternoon with a rounding error outvotes a fortnight of trading.
  // Totals are CUMULATIVE, so an interval's volume is the step between two
  // rows — not the row itself. Getting that backwards is how the first draft of
  // this check built a "tiny" interval a hundred thousand wide.
  const pooled = fitDrift([
    at({ drift: 10, in: 50050, out: 49950 }),   // step of 100 — the outlier, 10%
    at({ drift: 900, in: 50000, out: 49900 }),  // step of 99,900 — about 0.9%
    at({ drift: null, in: 0, out: 0 }),
  ]);
  const mean = (10 / 100 + 900 / 99900) / 2;
  ok('two intervals', pooled?.samples === 2, pooled);
  ok('over the volume of both', pooled?.volume === 100000, pooled);
  ok(
    'the rate is total drift over total volume, not the mean of the rates',
    Math.abs(pooled.rate - 910 / 100000) < 1e-9 && Math.abs(pooled.rate - mean) > 0.04,
    { pooled, mean },
  );

  // The estimate can also run UNDER — nothing here assumes a direction.
  const under = fitDrift([at({ drift: -60, in: 20000, out: 10000 }), at({ drift: null, in: 0, out: 0 })]);
  ok('a negative drift gives a negative rate', under.rate < 0, under);

  section('what the fit refuses to count');
  {
    // Fewer than two anchors is no interval at all: an anchor has to be
    // CORRECTED before there is any error to measure.
    ok('one anchor is not a measurement', fitDrift([at({ drift: 150, in: 1, out: 1 })]) === null);
    ok('no anchors is not a measurement', fitDrift([]) === null);

    // A baseline-less anchor predates baselines and has no volume to attribute
    // its drift to. Counting it would divide a real drift by somebody else's volume.
    ok(
      'an anchor with no baseline is skipped',
      fitDrift([
        { drift: 150, baselineIn: null, baselineOut: null, baselineRules: rules },
        at({ drift: null, in: 0, out: 0 }),
      ]) === null,
    );

    // Rules changed mid-interval: the two totals count different things, so
    // their difference is not a volume. This is the one that would silently
    // produce a large wrong rate rather than no rate.
    ok(
      'an interval spanning a rules change is skipped',
      fitDrift([
        { drift: 150, baselineIn: 30000, baselineOut: 15000, baselineRules: rules },
        { drift: null, baselineIn: 10000, baselineOut: 5000, baselineRules: { add: ['deposit'], subtract: ['payout'] } },
      ]) === null,
    );

    // No volume, no rate — dividing a drift by zero volume is an infinity that
    // would land on a screen as a balance.
    ok(
      'a zero-volume interval is skipped',
      fitDrift([at({ drift: 150, in: 100, out: 100 }), at({ drift: null, in: 100, out: 100 })]) === null,
    );
    ok(
      'and so is a negative one',
      fitDrift([at({ drift: 150, in: 10, out: 10 }), at({ drift: null, in: 100, out: 100 })]) === null,
    );

    // An anchor with no recorded drift is the FIRST one ever entered: there was
    // no estimate for it to be wrong against.
    ok(
      'an anchor with no drift is skipped',
      fitDrift([at({ drift: null, in: 30000, out: 15000 }), at({ drift: null, in: 0, out: 0 })]) === null,
    );

    // A baseline-less anchor kills BOTH intervals touching it, not one: a
    // volume needs a total at each end. So the good pair has to sit clear of it.
    const mixed = fitDrift([
      at({ drift: 150, in: 30000, out: 15000 }),
      at({ drift: 20, in: 10000, out: 5000 }),
      { drift: null, baselineIn: null, baselineOut: null, baselineRules: rules },
    ]);
    ok('one good interval past a bad one still counts', mixed?.samples === 1, mixed);
    ok('and measures only that interval', mixed?.volume === 30000, mixed);
  }

  section('the numbers actually on the screen');
  {
    // ForumPay SL as reported: 10,177.71 in and 9,081.86 out since the anchor,
    // and the portal 89.40 below the estimate. If that gap had been fitted from
    // a previous interval of the same shape, the correction should reproduce it.
    const volumeSince = 10177.71 + 9081.86;
    const fitted = fitDrift([
      at({ drift: 89.4, in: volumeSince, out: 0 }),
      at({ drift: null, in: 0, out: 0 }),
    ]);
    const expected = fitted.rate * volumeSince;
    ok(
      'a correction fitted on one period reproduces it on an identical one',
      Math.abs(expected - 89.4) < 0.01,
      { rate: fitted.rate, expected },
    );
    // And the size of it: a fraction of a percent of what moved, which is what
    // a fee looks like and is the sanity check on the whole idea.
    ok('and the rate is fee-sized', fitted.rate > 0 && fitted.rate < 0.01, fitted.rate);
  }
}


section('when the correction stops being founded on anything');
{
  const rules = { add: ['sell'], subtract: ['buy'], statuses: ['confirmed'] };
  // Newest first, a day apart. The span matters now: an interval with no
  // readable time between its two anchors cannot be measured per hour, so it
  // is skipped — and a fixture with no dates would silently measure nothing.
  let clock = Date.parse('2026-09-04T00:00:00Z');
  const at = (n) => ({
    drift: n.drift,
    baselineIn: n.in,
    baselineOut: n.out,
    baselineRules: rules,
    takenAt: new Date((clock -= 86_400_000) + 86_400_000).toISOString(),
  });

  // The edge of experience: the biggest gap ever actually corrected. Past it,
  // the rate is being extrapolated beyond everything it was fitted on, and the
  // corrected figure is no better founded than the raw one.
  const fit = fitDrift([
    at({ drift: 352.2, in: 40000, out: 30000 }),
    at({ drift: 89.4, in: 12000, out: 8000 }),
    at({ drift: null, in: 0, out: 0 }),
  ]);
  ok('two corrections', fit?.samples === 2, fit);
  ok('the largest is the largest, not the latest', fit?.largest === 352.2, fit);

  // Magnitude, not signed — an estimate that once ran 500 UNDER is still
  // evidence about how far this method strays.
  const mixedSign = fitDrift([
    at({ drift: -500, in: 40000, out: 30000 }),
    at({ drift: 10, in: 12000, out: 8000 }),
    at({ drift: null, in: 0, out: 0 }),
  ]);
  ok('a large negative correction still counts as experience', mixedSign?.largest === 500, mixedSign);

  // And the threshold the screen uses, both ways round. Inside experience the
  // corrected figure stands; outside it the screen has to send somebody to the
  // portal instead of quietly extrapolating.
  const projected = (volume) => Math.abs(fit.rate * volume);
  ok(
    'a normal day is within what has been measured',
    projected(19259.57) < fit.largest,
    { projected: projected(19259.57), largest: fit.largest },
  );
  ok(
    'a fortnight of the same is not',
    projected(19259.57 * 14) > fit.largest,
    { projected: projected(19259.57 * 14), largest: fit.largest },
  );
}


section('finding which field the gap is made of');
{
  // The premise: a provider that deducts a fee REPORTS it on the record of the
  // payment it came out of, and we keep every record whole. So the missing
  // money is already stored under a field nobody mapped.
  //
  // A ForumPay-shaped record. Two fee fields, one denominated in the fiat and
  // one in the crypto — which is the trap, because both are called a fee and
  // only one can be subtracted from a USD balance.
  const rows = [
    { payment_id: 'a', invoice_amount: '1000.00', processing_fee: '2.00', network_processing_fee: '0.00042', rate: '68.799' },
    { payment_id: 'b', invoice_amount: '500.00', processing_fee: '1.00', network_processing_fee: '0.00031', rate: '68.801' },
    { payment_id: 'c', invoice_amount: '250.00', processing_fee: '0.50', network_processing_fee: '0.00019', rate: '68.802' },
  ];
  const totals = numericTotals(rows);
  const by = (path) => totals.find((t) => t.path === path);

  ok('the fiat fee sums', by('processing_fee')?.total === 3.5, by('processing_fee'));
  ok('and every row had one', by('processing_fee')?.nonZero === 3, by('processing_fee'));
  // Both are summed and offered; which one is right is decided by which MATCHES
  // the measured gap, not by which sounds like a fee. That is the whole point:
  // "network_processing_fee" is the more fee-sounding name and it is the wrong one.
  ok('so does the crypto one, separately', Math.abs(by('network_processing_fee').total - 0.00092) < 1e-9);
  ok('and it is nowhere near the fiat gap of 3.50', Math.abs(by('network_processing_fee').total - 3.5) > 3);

  // Ranking is what makes the answer readable: the field whose sum lands on the
  // measured drift, out of everything the provider sends.
  const target = 3.5;
  const ranked = totals
    .filter((t) => t.nonZero > 0)
    .map((t) => ({ path: t.path, missBy: Math.min(Math.abs(t.total - target), Math.abs(-t.total - target)) }))
    .sort((a, b) => a.missBy - b.missBy);
  ok('the fiat fee ranks first', ranked[0].path === 'processing_fee', ranked.slice(0, 3));
  ok('and lands exactly on the gap', ranked[0].missBy < 0.005, ranked[0]);

  // A provider can report a deduction as a negative. Same finding, different
  // mapping — so both signs have to be searched or half of them are missed.
  const negative = numericTotals([{ fee: '-2.00' }, { fee: '-1.50' }]);
  const missSigned = Math.min(
    Math.abs(negative[0].total - 3.5),
    Math.abs(-negative[0].total - 3.5),
  );
  ok('a fee reported negative still matches', missSigned < 0.005, negative[0]);
}

section('what is not a number, however much it looks like one');
{
  // The search tries EVERY field, so a lenient parser is a liability here in a
  // way it is not once somebody has said "this field is the amount". A loose
  // one turns an invoice reference into a candidate fee column.
  ok('a plain number is', asNumber(3.14) === 3.14);
  ok('a numeric string is', asNumber('3.14') === 3.14);
  ok('a negative is', asNumber('-3.14') === -3.14);
  ok('zero is', asNumber('0') === 0);
  ok('a reference is not', asNumber('USD-2024-11') === null);
  ok('a date is not', asNumber('2026-09-03') === null);
  ok('a thousands separator is not, here', asNumber('1,234.56') === null);
  ok('an address is not', asNumber('TSRFEggH3AZRWZFBxxSCXXCrfQ') === null);
  ok('empty is not', asNumber('') === null);
  ok('whitespace is not', asNumber('   ') === null);
  ok('a boolean is not', asNumber(true) === null);
  ok('null is not', asNumber(null) === null);
  ok('an object is not', asNumber({ amount: 1 }) === null);
  ok('infinity is not', asNumber(Infinity) === null);
}

section('records that do not all look alike');
{
  // A field present on some rows and absent on others is the normal case: a fee
  // only exists on the payments that were charged one. It must sum over the
  // rows that have it rather than being dropped for the rows that do not.
  const mixed = numericTotals([
    { fee: '2.00', kind: 'Sell' },
    { kind: 'Buy' },
    { fee: '1.50', kind: 'Sell' },
  ]);
  const fee = mixed.find((t) => t.path === 'fee');
  ok('a field missing from some rows still sums', fee?.total === 3.5, fee);
  ok('and reports how many rows had it', fee?.rows === 2, fee);

  // Zeros count as present but not as evidence — a column of zeros explains no
  // gap, and offering it as a candidate is noise.
  const zeros = numericTotals([{ fee: '0' }, { fee: '0.00' }]);
  const z = zeros.find((t) => t.path === 'fee');
  ok('a field of zeros is present', z?.rows === 2, z);
  ok('but nothing in it is non-zero', z?.nonZero === 0, z);

  // Nested, because some providers wrap the money in an object.
  const nested = numericTotals([
    { fees: { processing: '2.00' } },
    { fees: { processing: '1.50' } },
  ]);
  const n = nested.find((t) => t.path === 'fees.processing');
  ok('a nested field is found by its dotted path', n?.total === 3.5, nested);

  ok('no records is no candidates', numericTotals([]).length === 0);
  ok('records with no numbers are no candidates', numericTotals([{ a: 'x' }]).length === 0);
}


section('a balance that moves on its own, not on its throughput');
{
  const rules = { add: ['DEPOSIT'], subtract: ['WITHDRAWAL'], statuses: ['Completed'] };
  const at = (n) => ({
    drift: n.drift,
    baselineIn: n.in,
    baselineOut: n.out,
    baselineRules: rules,
    takenAt: n.takenAt,
  });

  // Match2Pay as observed. Its USD figure is a valuation of crypto holdings,
  // so it drifts with the market and barely notices the payments: 23.35 of
  // drift against 426.66 of volume over 44 hours, and 2.50 the window before.
  const mt = fitDrift([
    at({ drift: 23.35, in: 168.19, out: 258.47, takenAt: '2026-09-04T05:42:00.000Z' }),
    at({ drift: 2.50, in: 0, out: 0, takenAt: '2026-09-02T09:42:00.000Z' }),
    at({ drift: null, in: 0, out: 0, takenAt: '2026-08-31T09:42:00.000Z' }),
  ]);
  ok('it spans the hours between the anchors', Math.abs((mt?.hours ?? 0) - 44) < 0.01, mt?.hours);
  ok('and 5.5% of volume is not a fee', Math.abs(mt.rate) > 0.02, mt.rate);
  ok('per hour is the readable unit', Math.abs(mt.perHour - 23.35 / 44) < 0.001, mt.perHour);

  // ForumPay, for contrast: the same fit, a rate a provider could charge.
  const fp = fitDrift([
    at({ drift: 188.08, in: 15623.18, out: 39372.14, takenAt: '2026-09-04T05:42:00.000Z' }),
    at({ drift: null, in: 0, out: 0, takenAt: '2026-09-02T09:42:00.000Z' }),
  ]);
  ok('ForumPay fits inside the fee ceiling', Math.abs(fp.rate) <= 0.02, fp.rate);

  // The failure the two bases exist to prevent, stated in money. A volume rate
  // fitted on a busy window predicts almost nothing on a quiet one — which is
  // precisely when a valuation-driven balance has drifted most.
  const quietVolume = 50;
  ok(
    'a volume rate would predict almost nothing on a quiet day',
    mt.rate * quietVolume < 3,
    mt.rate * quietVolume,
  );
  ok(
    'while the time basis still expects a day of movement',
    Math.abs(mt.perHour * 24 - 12.7) < 0.2,
    mt.perHour * 24,
  );
}

console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);
