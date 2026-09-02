// Applies pending migrations as part of the build.
//
// Nothing on the deploy path used to do this, so every schema change needed a
// person to remember a separate command against production. When they did not,
// the API shipped ahead of its database and the failure surfaced as a 500 on
// whatever button happened to touch the new column — three migrations went
// unapplied that way. The build is the one step that always runs, so it is
// where this belongs.
//
// `migrate deploy` is the deployment-safe command: it applies committed
// migrations in order, never generates or edits one, never resets, and takes an
// advisory lock so two concurrent builds cannot both apply the same migration.
// Running it twice is a no-op.
//
//   node scripts/deploy-migrations.mjs

import { execFileSync } from 'node:child_process';

import { migrationUrl } from './direct-url.mjs';
import { findHolders, clearIdleHolders } from './migration-lock.mjs';

// The DIRECT connection, not the pooled one the API runs on. See direct-url.mjs
// — an advisory lock taken through a connection pooler is taken on one backend
// and looked for on another, which is the P1002 this deploy died on.
const { url, host, why } = migrationUrl();

if (!url) {
  // A build with no database configured is a legitimate case — a preview of the
  // web app, a CI type-check — and failing it would block work that never
  // touches the schema. Loud, so it cannot be mistaken for success.
  console.warn(
    '\n[migrations] DATABASE_URL is not set for this build, so no migrations were applied.\n' +
      '[migrations] If this is the API deployment, set it — the API will otherwise\n' +
      '[migrations] start against a database that is behind this build.\n',
  );
  process.exit(0);
}

// Never print the URL: it carries the password. The HOST is printed, because
// "which database did it migrate" is the first question when this goes wrong,
// and the -pooler suffix in that name was the whole bug.
console.log(`[migrations] Applying pending migrations to ${host} (${why})…`);

/**
 * Retried, because the commonest failure here is not a broken migration.
 *
 * Neon suspends an idle database and takes several seconds to wake, and the
 * advisory-lock timeout is ten. A cold start alone can lose that race — and so
 * can a second deploy that is legitimately holding the lock while it applies
 * the same migrations, which is exactly the case the lock exists for and which
 * resolves itself in seconds.
 *
 * `migrate deploy` is idempotent: it applies what is pending, in order, and a
 * second run after a partial one continues rather than repeating.
 */
/**
 * Who holds the lock, in words, or null if we cannot say.
 *
 * Never allowed to fail the build on its own: this is a diagnostic printed
 * beside a failure that has already happened, and a diagnostic that throws
 * would replace a useful error with a useless one.
 */
async function describeLock() {
  let client;
  try {
    const { Client } = (await import('pg')).default;
    client = new Client({ connectionString: url });
    await client.connect();

    // Offered deliberately as an opt-in. Terminating a backend during a build
    // nobody is watching is not something to do by default — but a project
    // that deploys often enough to keep hitting this can ask for it.
    if (process.env.MIGRATE_FORCE_UNLOCK === '1') {
      const { killed, busy } = await clearIdleHolders(client);
      return (
        `[migrations] MIGRATE_FORCE_UNLOCK is set. ` +
        (killed.length
          ? `Terminated idle session(s) holding the lock: ${killed.join(', ')}.`
          : 'No idle holder to terminate.') +
        (busy.length
          ? ` Left ${busy.length} active session(s) alone — those are doing something.`
          : '')
      );
    }

    const holders = await findHolders(client);
    if (!holders.length) {
      return (
        '[migrations] Nothing is holding the migration lock right now, so this\n' +
        '[migrations] is a slow or sleeping database rather than a stuck lock.'
      );
    }
    return [
      `[migrations] ${holders.length} session(s) on the migration lock:`,
      ...holders.map(
        (h) =>
          `[migrations]   pid ${h.pid} — ${h.granted ? 'HOLDS it' : 'waiting'}, ` +
          `state ${h.state ?? 'unknown'}` +
          (h.granted && h.state === 'idle'
            ? '  <- abandoned; clear with: npm run migrate:lock -- --clear'
            : ''),
      ),
    ].join('\n');
  } catch {
    return null;
  } finally {
    try {
      await client?.end();
    } catch {
      /* nothing to do about a connection that will not close */
    }
  }
}

const ATTEMPTS = 4;
const WAIT_MS = [3000, 6000, 12000];

for (let attempt = 1; ; attempt++) {
  try {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      stdio: 'inherit',
      // Overridden for this child only. The API's own runtime still reads the
      // pooled DATABASE_URL, which is what a serverless function needs.
      env: { ...process.env, DATABASE_URL: url },
    });
    console.log('[migrations] Done.');
    break;
  } catch (e) {
    // Before waiting again, find out WHO holds the lock. P1002 says the
    // database "timed out" and names nobody, and the three causes need
    // opposite responses: a sleeping database wants another moment, a sibling
    // deploy mid-migration wants to be left alone, and a killed build's
    // abandoned session wants terminating. Retrying is only right for one of
    // them, and the message cannot tell them apart.
    const holders = await describeLock();
    if (holders) console.warn(holders);

    if (attempt < ATTEMPTS) {
      const wait = WAIT_MS[attempt - 1];
      console.warn(
        `[migrations] Attempt ${attempt} of ${ATTEMPTS} failed. ` +
          `Waiting ${wait / 1000}s — a suspended database or a concurrent ` +
          `deploy both clear on their own.`,
      );
      // Synchronous on purpose: this is a build step, there is nothing else to
      // do while waiting, and setTimeout would let the script exit first.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
      continue;
    }
    console.error(
      '\n[migrations] FAILED — the deployment is stopping here on purpose.\n' +
        '[migrations] Shipping the API against a database that is behind it would\n' +
        '[migrations] turn every write to a new column into a 500 at runtime, which\n' +
        '[migrations] is far harder to diagnose than this message.\n' +
        `[migrations] Database: ${host}\n` +
        `[migrations] Tried ${ATTEMPTS} times.\n` +
        '[migrations] If this says P1002 and the host above ends in -pooler, set\n' +
        '[migrations] DIRECT_URL to the unpooled connection string: an advisory\n' +
        '[migrations] lock cannot be held across a connection pooler.\n' +
        '[migrations] If it says P1002 and an IDLE session is reported above, a\n' +
        '[migrations] killed build left the lock held. Clear it with:\n' +
        '[migrations]     npm run migrate:lock -- --clear\n',
    );
    process.exit(typeof e?.status === 'number' ? e.status : 1);
  }
}
