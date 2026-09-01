// Paging a provider's ledger, against a stand-in that behaves like ForumPay.
//
// The stop conditions are the whole design here, and every one of them is a
// property that only shows up under a provider doing something unhelpful:
//
//   • a provider that IGNORES the offset parameter hands back page one for
//     ever, and a loop that cannot notice will re-store fifty rows until it
//     hits a page cap and call it a success
//   • a re-sync must UPDATE a row whose status moved from waiting to
//     confirmed, not add a second one
//   • an incremental run must stop as soon as it sees nothing new, or a
//     routine refresh costs fifty calls to somebody's payment API
//
// Runs against dist/ because tsx does not emit decorator metadata and Nest
// resolves every injected service as undefined without it.
//
// The store is an in-memory stand-in rather than Postgres, deliberately: what
// is under test is the LOOP, and the loop is the part that can hammer a
// payment provider until they block us. Keeping it database-free means it runs
// anywhere, including where there is no Postgres — and the queries it does not
// cover (list, summary) are ordinary Prisma reads whose failure mode is an
// empty table, not a thousand calls to somebody's API.
//
//   npm run check:sync

import 'dotenv/config';
import { createRequire } from 'node:module';
import { createServer } from 'node:https';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HTTPS, because the connector refuses http:// — plain http would put a live
// payment credential on the wire, and a check that exercised a path the real
// thing forbids would be checking something else.
const certDir = mkdtempSync(join(tmpdir(), 'psp-sync-'));
execSync(
  `openssl req -x509 -newkey rsa:2048 -nodes -keyout ${certDir}/k.pem ` +
    `-out ${certDir}/c.pem -days 1 -subj "/CN=127.0.0.1" ` +
    `-addext "subjectAltName=IP:127.0.0.1"`,
  { stdio: 'ignore' },
);
const TLS = {
  key: readFileSync(`${certDir}/k.pem`),
  cert: readFileSync(`${certDir}/c.pem`),
};
// Only for the self-signed stand-in in this process.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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

/** A ledger of `total` rows, newest first, served fifty at a time. */
function makeProvider({ total, honourOffset = true, cap = 50 }) {
  const rows = Array.from({ length: total }, (_, i) => ({
    payment_id: `pay-${String(total - i).padStart(5, '0')}`,
    invoice_amount: (100 + i).toFixed(2),
    invoice_currency: 'USD',
    state: i === 0 ? 'waiting' : 'confirmed',
    inserted: `2026-08-${String(28 - (i % 20)).padStart(2, '0')} 10:00:00`,
    pos_id: `POS${i % 3}`,
    payer_id: `CU${1000 + i}`,
    type: i % 2 ? 'Buy' : 'Sell',
  }));

  let calls = 0;
  const server = createServer(TLS, (req, res) => {
    calls++;
    const url = new URL(req.url, 'http://x');
    const limit = Math.min(Number(url.searchParams.get('limit') || 20), cap);
    // The unhelpful provider: accepts offset, ignores it.
    const offset = honourOffset ? Number(url.searchParams.get('offset') || 0) : 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ invoices: rows.slice(offset, offset + limit) }));
  });
  return { server, rows, calls: () => calls };
}

const listen = (server) =>
  new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

const ENDPOINT = (extra = {}) => ({
  path: '/GetTransactions/',
  recordsPath: 'invoices',
  fields: {
    id: 'payment_id',
    amount: 'invoice_amount',
    currency: 'invoice_currency',
    status: 'state',
    date: 'inserted',
    reference: 'pos_id',
    direction: 'type',
    customer: 'payer_id',
  },
  pagination: { limitParam: 'limit', offsetParam: 'offset', pageSize: 50 },
  ...extra,
});

process.env.CREDENTIALS_KEY = 'a-test-credentials-key-at-least-32-characters';

const { PspSyncService } = require('../dist/src/psps/psp-sync.service');
const { PspBalanceService } = require('../dist/src/psps/psp-balance.service');
const { seal } = require('../dist/src/common/secret-box');

/**
 * Just enough Prisma for the sync loop.
 *
 * Only the four calls it makes. A fuller fake would be a second
 * implementation of Postgres to get wrong.
 */
function makeStore() {
  const connections = new Map();
  const txns = new Map(); // `${connectionId}::${externalId}` -> row
  return {
    connections,
    txns,
    pspConnection: {
      findUnique: async ({ where }) => connections.get(where.id) ?? null,
      update: async ({ where, data }) => {
        const row = { ...connections.get(where.id), ...data };
        connections.set(where.id, row);
        return row;
      },
    },
    pspTransaction: {
      findUnique: async ({ where }) => {
        const k = where.connectionId_externalId;
        return txns.get(`${k.connectionId}::${k.externalId}`) ?? null;
      },
      create: async ({ data }) => {
        const row = { id: `t${txns.size + 1}`, ...data };
        txns.set(`${data.connectionId}::${data.externalId}`, row);
        return row;
      },
      update: async ({ where, data }) => {
        for (const [k, v] of txns) {
          if (v.id === where.id) {
            txns.set(k, { ...v, ...data });
            return txns.get(k);
          }
        }
        throw new Error('no such row');
      },
    },
  };
}

{
  const store = makeStore();
  const sync = new PspSyncService(store, new PspBalanceService(store));
  let seq = 0;

  function connectionFor(port) {
    const id = `c${++seq}`;
    store.connections.set(id, {
      id,
      terminal: `T-${port}`,
      label: `T-${port}`,
      // http:// is refused by the connector on purpose, so the stand-in speaks
      // https and the check exercises the path the real thing takes.
      baseUrl: `https://127.0.0.1:${port}`,
      authMode: 'basic',
      apiKeyEnc: seal('user'),
      apiSecretEnc: seal('secret'),
      endpoints: { transactions: ENDPOINT() },
    });
    return { id };
  }
  const storedFor = (id) =>
    [...store.txns.values()].filter((t) => t.connectionId === id);

  section('a full read of a ledger longer than one page');
  {
    const { server } = makeProvider({ total: 120 });
    const port = await listen(server);
    const conn = await connectionFor(port);

    const r = await sync.sync(conn.id, { full: true });
    ok('it succeeds', r.ok, r);
    ok('every row is read', r.fetched === 120, r);
    ok('over three pages', r.pages === 3, r);
    ok('and all are new', r.created === 120, r);

    const stored = storedFor(conn.id).length;
    ok('and all are stored', stored === 120, stored);

    const one = store.txns.get(`${conn.id}::pay-00120`);
    ok('the fiat amount is kept exactly', Number(one.amount) === 100, one?.amount);
    ok('the direction is theirs', one.direction === 'Sell', one?.direction);
    ok('the client id is carried', one.customer === 'CU1000', one?.customer);
    ok('their timestamp is kept as sent', one.rawAt === '2026-08-28 10:00:00');
    ok('and read as an instant', one.occurredAt instanceof Date);
    // The field nobody mapped today is the one a dispute needs next month.
    ok('the whole record is kept', !!one.raw?.payment_id, Object.keys(one.raw ?? {}));

    server.close();
  }

  section('running it again does not duplicate');
  {
    const { server } = makeProvider({ total: 60 });
    const port = await listen(server);
    const conn = await connectionFor(port);

    await sync.sync(conn.id, { full: true });
    const r2 = await sync.sync(conn.id, { full: true });

    ok('the count is unchanged', storedFor(conn.id).length === 60);
    ok('nothing was created', r2.created === 0, r2);
    // A status moving waiting → confirmed has to land on the existing row.
    ok('rows were updated instead', r2.updated === 60, r2);

    server.close();
  }

  section('an incremental run stops as soon as it sees nothing new');
  {
    const { server, calls } = makeProvider({ total: 300 });
    const port = await listen(server);
    const conn = await connectionFor(port);

    await sync.sync(conn.id, { full: true });
    const before = calls();
    const r = await sync.sync(conn.id);

    ok('it reads one page, not six', r.pages === 1, r);
    ok('and says why it stopped', /up to date/i.test(r.stopped), r.stopped);
    ok('one extra call to the provider', calls() - before === 1, calls() - before);

    server.close();
  }

  section('a provider that ignores the offset parameter');
  {
    // The failure this exists for: without detection the loop runs to the
    // 200-page cap, re-storing the same fifty rows, and reports success.
    const { server, calls } = makeProvider({ total: 500, honourOffset: false });
    const port = await listen(server);
    const conn = await connectionFor(port);

    const r = await sync.sync(conn.id, { full: true });
    ok('it stops quickly', r.pages <= 3, r);
    ok('it does not claim 500 rows', r.created === 50, r);
    ok('and names the parameter', /offset/.test(r.stopped), r.stopped);
    ok('rather than looping to the cap', calls() < 10, calls());

    server.close();
  }

  section('an empty ledger');
  {
    const { server } = makeProvider({ total: 0 });
    const port = await listen(server);
    const conn = await connectionFor(port);

    const r = await sync.sync(conn.id, { full: true });
    ok('is not an error', r.ok, r);
    ok('and stores nothing', r.created === 0, r);

    server.close();
  }

  // list() and summary() are ordinary Prisma reads — groupBy, contains, a
  // date range — and stand-ins for those would be a second implementation of
  // Postgres to get wrong. They are exercised against a real database by
  // `npm run check:sync:db`, which needs one running.
}

console.log(
  failures ? `\n${failures} check(s) failed.` : '\nAll PSP sync checks passed.',
);
process.exit(failures ? 1 : 0);
