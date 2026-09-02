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
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  const ANCHOR_AT = new Date('2026-09-02T05:50:00Z');
  const conn = await prisma.pspConnection.create({
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
  await prisma.pspBalanceAnchor.create({
    data: {
      connectionId: conn.id,
      amount: '172383.50',
      currency: 'USD',
      takenAt: ANCHOR_AT,
    },
  });

  const row = (o) =>
    prisma.pspTransaction.create({
      data: {
        connectionId: conn.id,
        terminal: conn.terminal,
        currency: 'USD',
        status: 'confirmed',
        direction: 'Sell',
        raw: {},
        ...o,
      },
    });

  // The shape of a real ForumPay ledger the day after an anchor: mostly old
  // rows, none of which carry a settled date until the field is mapped.
  for (let i = 0; i < 5; i++) {
    await row({
      externalId: `old-${i}`,
      amount: '100.00',
      occurredAt: new Date('2026-08-20T10:00:00Z'),
    });
  }
  await row({
    externalId: 'after',
    amount: '124.00',
    occurredAt: new Date('2026-09-02T07:00:00Z'),
  });
  await row({
    externalId: 'undated',
    amount: '9.00',
    occurredAt: null,
  });

  const svc = new PspBalanceService(prisma);

  section('with no settled date mapped, as every provider starts');
  {
    const b = await svc.balance(conn.id);
    ok('the new transaction counts', b.movement.added === 124, b.movement);
    // The bug: NOT(...) over a null column returned zero here.
    ok('and the five older ones are REPORTED, not silently dropped',
       b.movement.beforeAnchor === 5, b.movement);
    ok('the undated one is counted separately', b.movement.undated === 1, b.movement);
    ok('the estimate is anchor plus movement',
       Math.abs(b.estimate - 172507.5) < 0.005, b.estimate);
  }

  section('a payment raised before the anchor and settled after it');
  {
    // The reported case: raised 31 Aug, still pending at the anchor, confirmed
    // afterwards. It moved money after the anchor, so it has to count.
    await row({
      externalId: 'late',
      amount: '500.00',
      occurredAt: new Date('2026-08-31T14:00:00Z'),
      settledAt: new Date('2026-09-02T06:30:00Z'),
    });
    const b = await svc.balance(conn.id);
    ok('it counts', b.movement.added === 624, b.movement);
    ok('and is not also counted as before the anchor',
       b.movement.beforeAnchor === 5, b.movement);
  }

  section('a payment raised and settled before the anchor');
  {
    await row({
      externalId: 'settled-early',
      amount: '77.00',
      occurredAt: new Date('2026-08-31T14:00:00Z'),
      settledAt: new Date('2026-08-31T14:05:00Z'),
    });
    const b = await svc.balance(conn.id);
    ok('it does not move the balance', b.movement.added === 624, b.movement);
    ok('and is reported as already inside the anchor',
       b.movement.beforeAnchor === 6, b.movement);
  }

  section('every row is accounted for somewhere');
  {
    const b = await svc.balance(conn.id);
    const total = await prisma.pspTransaction.count({ where: { connectionId: conn.id } });
    const seen =
      b.movement.counted +
      b.movement.ignoredDirection +
      b.movement.ignoredStatus +
      b.movement.ignoredCurrency +
      b.movement.beforeAnchor +
      b.movement.undated;
    // The property that matters: a payment can be counted, excluded for a
    // stated reason, or before the anchor — never simply missing.
    ok(`all ${total} rows are in exactly one bucket`, seen === total, {
      total, seen, movement: b.movement,
    });
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
