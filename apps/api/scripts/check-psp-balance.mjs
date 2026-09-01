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
} = require('../dist/src/psps/psp-balance.service');

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

  const matches = (row, where = {}) =>
    Object.entries(where).every(([k, cond]) => {
      const v = row[k];
      if (cond === null) return v === null || v === undefined;
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        if ('gt' in cond) return v instanceof Date && v > cond.gt;
        return false;
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
  ok('three rows counted', b.movement.counted === 3, b.movement);

  // Each exclusion for exactly one reason, and every one of them visible.
  ok('the pending row is excluded as a status', b.movement.ignoredStatus === 1, b.movement);
  ok('the unknown direction is excluded and counted', b.movement.ignoredDirection === 1, b.movement);
  ok('the EUR row is excluded as a currency', b.movement.ignoredCurrency === 1, b.movement);
  ok('the undated row is reported', b.movement.undated === 1, b.movement);
  ok('the anchor is returned with the estimate', b.anchor?.amount === 61512.27, b.anchor);
  ok('and who entered it', b.anchor?.enteredBy === 'ops@tradin.com', b.anchor);
  ok('the age is reported in hours', typeof b.ageHours === 'number' && b.ageHours > 0, b);
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
  ok('the older transaction no longer moves it', after.balance.movement.counted === 0, after.balance.movement);

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
  const ev = (o) => ({
    terminal: 'MT_Tradin',
    currency: 'USD',
    state: 'COMPLETED',
    occurredAt: D('2026-09-01T15:00:00Z'),
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

console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);
