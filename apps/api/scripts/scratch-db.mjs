// A throwaway database for checks that need real tables.
//
// Some things can only be pinned against the real application — a controller,
// a service and Postgres together. Those checks have to create and destroy
// shifts, and running them against the development database would rewrite the
// desk's own history to test that history is recorded correctly.
//
// So: a separate database, created empty, migrated, and dropped afterwards.
// The check becomes safe to run anywhere, and its assertions can be about an
// empty world ("there is no previous shift") rather than about whatever
// happened to be in the table.

import { execFileSync } from 'node:child_process';
import { Client } from 'pg';

/**
 * Creates the scratch database and points DATABASE_URL at it.
 *
 * Returns a function that drops it again. Call it in a finally, and pass
 * `{ keep: true }` while debugging a failure you want to look at.
 */
export async function useScratchDb(name = 'opsos_scratch') {
  const source = process.env.DATABASE_URL;
  if (!source) throw new Error('DATABASE_URL is not set.');

  const url = new URL(source);
  // The database name is interpolated into SQL below, so it may not come from
  // anywhere a caller could get creative with. A fixed alphabet, not escaping.
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`Unusable scratch database name: ${name}`);
  }

  const adminUrl = new URL(source);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  // Dropped first, not just created: a check that crashed last time leaves its
  // rows behind, and a "clean" database with yesterday's shifts in it fails in
  // a way that looks like the code is wrong.
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  url.pathname = `/${name}`;
  const scratch = url.toString();
  process.env.DATABASE_URL = scratch;

  // migrate deploy, not db push: this is the same path production takes, so a
  // migration that is broken fails here rather than on the next deployment.
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: scratch },
  });

  return async ({ keep = false } = {}) => {
    process.env.DATABASE_URL = source;
    if (keep) {
      console.log(`\nScratch database kept: ${name}`);
      return;
    }
    const cleanup = new Client({ connectionString: adminUrl.toString() });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await cleanup.end();
  };
}
