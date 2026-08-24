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

const url = process.env.DATABASE_URL;

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

// Never print the URL: it carries the password.
const host = (() => {
  try {
    return new URL(url).host;
  } catch {
    return 'the configured database';
  }
})();

console.log(`[migrations] Applying pending migrations to ${host}…`);

try {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: process.env,
  });
  console.log('[migrations] Done.');
} catch (e) {
  console.error(
    '\n[migrations] FAILED — the deployment is stopping here on purpose.\n' +
      '[migrations] Shipping the API against a database that is behind it would\n' +
      '[migrations] turn every write to a new column into a 500 at runtime, which\n' +
      '[migrations] is far harder to diagnose than this message.\n' +
      `[migrations] Database: ${host}\n`,
  );
  process.exit(typeof e?.status === 'number' ? e.status : 1);
}
