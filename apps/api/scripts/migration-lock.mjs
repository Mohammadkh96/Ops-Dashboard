/**
 * Who is holding the migration lock, and clearing it when nobody should be.
 *
 * `prisma migrate deploy` takes pg_advisory_lock(72707369) so two builds cannot
 * apply the same migration at once, and gives up after ten seconds with P1002 —
 * a message that says the database "timed out" and names no culprit. That is
 * the same message whether the database is asleep, a sibling deploy is
 * legitimately mid-migration, or a build was killed and left a session holding
 * the lock for ever. Those need opposite responses and the error cannot tell
 * them apart.
 *
 * So: ask. An advisory lock and its holder are both visible in the catalog.
 *
 *   npm run migrate:lock          — report who holds it
 *   npm run migrate:lock -- --clear
 *                                 — terminate IDLE holders and release it
 *
 * --clear terminates a backend, so it is never automatic and never the default.
 * It refuses to touch a session that is actually running something, because
 * that session is the concurrent migration the lock exists to protect.
 */

import pg from 'pg';

import { migrationUrl } from './direct-url.mjs';

/** The key Prisma uses. Visible in the P1002 message itself. */
export const PRISMA_MIGRATE_LOCK_ID = 72707369;

const HOLDERS = `
  SELECT l.pid,
         l.granted,
         a.state,
         a.application_name,
         a.backend_start,
         a.state_change,
         a.query
    FROM pg_locks l
    LEFT JOIN pg_stat_activity a ON a.pid = l.pid
   WHERE l.locktype = 'advisory'
     AND l.objid = $1
     AND l.pid <> pg_backend_pid()
   ORDER BY l.granted DESC, a.backend_start ASC
`;

/** @param {import('pg').Client} client */
export async function findHolders(client, lockId = PRISMA_MIGRATE_LOCK_ID) {
  const { rows } = await client.query(HOLDERS, [lockId]);
  return rows;
}

/**
 * Terminates the sessions holding the lock that are not doing anything.
 *
 * "Not doing anything" is the whole safety rule. A session whose state is
 * `idle` finished its last statement and is sitting on the lock — that is the
 * killed build. A session that is `active` is mid-query, and terminating it
 * during a migration is how a database ends up half-migrated.
 */
export async function clearIdleHolders(client, lockId = PRISMA_MIGRATE_LOCK_ID) {
  const holders = await findHolders(client, lockId);
  const idle = holders.filter((h) => h.granted && h.state === 'idle');
  const busy = holders.filter((h) => h.granted && h.state !== 'idle');

  const killed = [];
  for (const h of idle) {
    const { rows } = await client.query(
      'SELECT pg_terminate_backend($1) AS ok',
      [h.pid],
    );
    if (rows[0]?.ok) killed.push(h.pid);
  }
  return { killed, busy, holders };
}

function describe(h) {
  const age = h.backend_start
    ? `${Math.round((Date.now() - new Date(h.backend_start).getTime()) / 1000)}s old`
    : 'age unknown';
  const q = (h.query ?? '').replace(/\s+/g, ' ').slice(0, 80);
  return (
    `  pid ${h.pid} · ${h.granted ? 'HOLDS the lock' : 'waiting for it'} · ` +
    `${h.state ?? 'state unknown'} · ${age}\n` +
    `    last statement: ${q || '(none)'}`
  );
}

async function main() {
  const clear = process.argv.includes('--clear');
  const { url, host, why } = migrationUrl();
  if (!url) {
    console.error('No DATABASE_URL or DIRECT_URL is set — nothing to inspect.');
    process.exit(1);
  }

  console.log(`Migration lock on ${host} (${why})\n`);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const holders = await findHolders(client);
    if (!holders.length) {
      console.log(
        'Nothing holds the lock. If a deploy is still failing with P1002 the\n' +
          'cause is not a stuck lock — check that the database is awake and\n' +
          'that the build is not racing another deploy of the same project.',
      );
      return;
    }

    console.log(`${holders.length} session(s) on lock ${PRISMA_MIGRATE_LOCK_ID}:`);
    for (const h of holders) console.log(describe(h));

    if (!clear) {
      console.log(
        '\nRe-run with --clear to terminate the IDLE holders. A session that is\n' +
          'still active is left alone: it is very likely the concurrent migration\n' +
          'this lock exists to protect, and killing it mid-flight is how a\n' +
          'database ends up half-migrated.',
      );
      return;
    }

    const { killed, busy } = await clearIdleHolders(client);
    console.log(
      killed.length
        ? `\nTerminated ${killed.length} idle session(s): ${killed.join(', ')}.`
        : '\nNo idle holder to terminate.',
    );
    if (busy.length) {
      console.log(
        `Left ${busy.length} active session(s) alone: ${busy.map((b) => b.pid).join(', ')}.\n` +
          'Wait for those to finish rather than killing them.',
      );
    }
  } finally {
    await client.end();
  }
}

// Only when run directly, so the exports stay importable by the deploy script.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
