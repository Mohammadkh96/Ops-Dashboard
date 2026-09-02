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
  const { PspBalanceService } = require('../dist/src/psps/psp-balance.service');
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
    const { balance: b } = await svc.setAnchor(beem.id, {
      amount: '25160.845871',
      currency: 'USDC',
      takenAt: new Date().toISOString(),
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

    const dir = await new PspSyncService(prisma, svc).directory();
    const card = dir.find((d) => d.id === beem.id);
    ok('its card opens even with no endpoint configured',
       card?.hasTransactions === true, card);
    ok('and reports what it holds', card?.stored === 5, card?.stored);
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
