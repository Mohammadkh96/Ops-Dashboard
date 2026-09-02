// Reading an event log as a ledger.
//
// PaymentEvent holds one row per STATE CHANGE — that is deliberate, and the
// live feed depends on it: a payment moving to COMPLETED is news, re-reading it
// unchanged is not. But a LEDGER is not an event log, and reading those rows
// straight out put the same payment on screen twice, once PENDING and once
// COMPLETED, at the same second and sometimes at two different amounts because
// a fee was taken between them. Every count built on that — the stored count,
// the status breakdown, the balance — was really counting callbacks.
//
// The rows here are Match2Pay's, taken off the screen that showed the problem.
//
//   npm run check:events

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { latestPerPayment } = require('../dist/src/psps/payment-events');

let failures = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log(`ok    ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name} ${detail === undefined ? '' : JSON.stringify(detail)}`);
  }
};
const section = (t) => console.log(`\n── ${t} ──`);

const D = (s) => new Date(s);
/** received is what separates two states of one payment; occurred is identical. */
const ev = (id, paymentId, state, occurred, received, extra = {}) => ({
  id, paymentId, externalId: null, state,
  occurredAt: occurred === null ? null : D(occurred),
  receivedAt: D(received),
  ...extra,
});

section('one payment reported twice');
{
  // Verbatim from the MT ledger: same payment id, same second, two states,
  // and 30.00 pending settling as 29.93.
  const rows = [
    ev('e1', 'eb55d5a22dc9', 'PENDING',   '2026-09-02T05:43:15Z', '2026-09-02T05:43:16Z', { amount: 30.0 }),
    ev('e2', 'eb55d5a22dc9', 'COMPLETED', '2026-09-02T05:43:15Z', '2026-09-02T05:43:59Z', { amount: 29.93 }),
  ];
  const out = latestPerPayment(rows);
  ok('it collapses to one row', out.length === 1, out);
  ok('and the row kept is the latest state', out[0].id === 'e2', out[0]);
  ok('with the settled amount, not the requested one', out[0].amount === 29.93, out[0]);

  // Order in must not decide the answer.
  ok('whichever order they arrive in', latestPerPayment([rows[1], rows[0]])[0].id === 'e2');
}

section('the tiebreaker is not decoration');
{
  // Both states carry the IDENTICAL occurredAt on every MT pair seen. Without
  // receivedAt the winner would be whichever the database happened to return
  // first, and the ledger would flicker between PENDING and COMPLETED.
  const same = '2026-09-02T06:32:24Z';
  const rows = [
    ev('a', 'b129bddf964d', 'COMPLETED', same, '2026-09-02T06:33:00Z'),
    ev('b', 'b129bddf964d', 'PENDING',   same, '2026-09-02T06:32:25Z'),
  ];
  ok('the later arrival wins', latestPerPayment(rows)[0].id === 'a');
  ok('and it is stable', latestPerPayment([rows[1], rows[0]])[0].id === 'a');
}

section('a payment that keeps moving');
{
  const rows = [
    ev('p1', 'x', 'PENDING',    '2026-09-01T10:00:00Z', '2026-09-01T10:00:01Z'),
    ev('p2', 'x', 'PROCESSING', '2026-09-01T10:05:00Z', '2026-09-01T10:05:01Z'),
    ev('p3', 'x', 'COMPLETED',  '2026-09-01T10:09:00Z', '2026-09-01T10:09:01Z'),
    ev('p4', 'x', 'REFUNDED',   '2026-09-03T09:00:00Z', '2026-09-03T09:00:01Z'),
  ];
  const out = latestPerPayment(rows);
  ok('four events are one payment', out.length === 1, out);
  ok('at the state it actually ended in', out[0].state === 'REFUNDED', out[0]);
}

section('telling payments apart');
{
  const rows = [
    ev('e1', 'p-1', 'COMPLETED', '2026-09-01T10:00:00Z', '2026-09-01T10:00:01Z'),
    ev('e2', 'p-2', 'COMPLETED', '2026-09-01T11:00:00Z', '2026-09-01T11:00:01Z'),
    // No paymentId: falls back to externalId.
    { id: 'e3', paymentId: null, externalId: 'ext-9', state: 'COMPLETED',
      occurredAt: D('2026-09-01T12:00:00Z'), receivedAt: D('2026-09-01T12:00:01Z') },
    { id: 'e4', paymentId: null, externalId: 'ext-9', state: 'PENDING',
      occurredAt: D('2026-09-01T11:59:00Z'), receivedAt: D('2026-09-01T11:59:01Z') },
    // Neither: its own id, so it stands alone rather than collapsing into
    // every other anonymous row.
    { id: 'e5', paymentId: null, externalId: null, state: 'COMPLETED',
      occurredAt: D('2026-09-01T13:00:00Z'), receivedAt: D('2026-09-01T13:00:01Z') },
    { id: 'e6', paymentId: null, externalId: null, state: 'COMPLETED',
      occurredAt: D('2026-09-01T14:00:00Z'), receivedAt: D('2026-09-01T14:00:01Z') },
  ];
  const out = latestPerPayment(rows);
  ok('distinct payments stay distinct', out.length === 5, out.map((r) => r.id));
  ok('externalId collapses its pair', out.some((r) => r.id === 'e3') && !out.some((r) => r.id === 'e4'));
  ok('two null-keyed rows are two payments',
     out.some((r) => r.id === 'e5') && out.some((r) => r.id === 'e6'));
}

section('the order it comes back in');
{
  const rows = [
    ev('old', 'a', 'COMPLETED', '2026-08-01T10:00:00Z', '2026-08-01T10:00:01Z'),
    ev('new', 'b', 'COMPLETED', '2026-09-01T10:00:00Z', '2026-09-01T10:00:01Z'),
    // No timestamp at all: it exists, but it is not today's news.
    ev('undated', 'c', 'COMPLETED', null, '2026-09-05T10:00:00Z'),
  ];
  const out = latestPerPayment(rows);
  ok('newest first', out[0].id === 'new', out.map((r) => r.id));
  ok('then older', out[1].id === 'old', out.map((r) => r.id));
  ok('undated last, not first', out[2].id === 'undated', out.map((r) => r.id));
}

section('nothing to collapse');
{
  ok('an empty log is empty', latestPerPayment([]).length === 0);
  const one = [ev('e1', 'p', 'COMPLETED', '2026-09-01T10:00:00Z', '2026-09-01T10:00:01Z')];
  ok('a single event is itself', latestPerPayment(one).length === 1);
}

console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);
