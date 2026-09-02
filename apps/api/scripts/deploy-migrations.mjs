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
        '[migrations] lock cannot be held across a connection pooler.\n',
    );
    process.exit(typeof e?.status === 'number' ? e.status : 1);
  }
}
