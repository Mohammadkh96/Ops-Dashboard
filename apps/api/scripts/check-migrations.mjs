// Do the migrations actually build the schema the code expects?
//
// Nothing else answers this. `prisma generate` reads schema.prisma and never
// looks at the migrations; the checks read the generated client and never touch
// a database. So a migration whose SQL says something slightly different from
// the model it is supposed to create passes everything and is found in
// production — 0021 declared its index DESC in SQL and ascending in the schema,
// which is a difference `migrate diff` reports for ever and the next
// `migrate dev` offers to "fix" on a database that is not broken.
//
// Against a REAL PostgreSQL, thrown away afterwards. A fake cannot answer this:
// the question IS what Postgres makes of the SQL.
//
// Skipped, loudly, where no postgres binary exists — this must not be the check
// that makes the suite unrunnable on a machine without one.
//
//   npm run check:migrations

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PG = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin']
  .find((d) => existsSync(join(d, 'initdb')));

if (!PG) {
  console.log('skip  no postgres binary here — nothing to check against.');
  process.exit(0);
}

const PORT = 55433;
// Somewhere the postgres system user can traverse: initdb refuses to run as
// root, and it cannot reach a directory whose parents are 0700.
const dir = mkdtempSync(join('/var/tmp', 'opsos-migrate-'));
const run = (cmd, opts = {}) =>
  execFileSync('bash', ['-lc', cmd], { encoding: 'utf8', ...opts });

let started = false;
try {
  const asPg = (c) =>
    `su postgres -s /bin/bash -c "export PATH=${PG}:\\$PATH; ${c}"`;
  run(`chown postgres:postgres ${dir} && chmod 700 ${dir}`);
  run(asPg(`initdb -D ${dir} -U app --auth=trust`), { stdio: 'ignore' });
  run(
    asPg(
      `pg_ctl -D ${dir} -o '-p ${PORT} -c listen_addresses=127.0.0.1' -l ${dir}/log start`,
    ),
    { stdio: 'ignore' },
  );
  started = true;

  const url = `postgresql://app@127.0.0.1:${PORT}/opsos?sslmode=disable`;
  run(`${PG}/psql -h 127.0.0.1 -p ${PORT} -U app -d postgres -c 'CREATE DATABASE opsos'`, {
    stdio: 'ignore',
  });

  console.log('── applying every migration to an empty database ──');
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
  console.log('ok    they all apply');

  // Twice, because a deploy that retries must not be a deploy that breaks.
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: url },
  });
  console.log('ok    and applying them again changes nothing');

  console.log('\n── the result matches schema.prisma ──');
  const diff = spawnSync(
    'npx',
    [
      'prisma',
      'migrate',
      'diff',
      '--from-config-datasource',
      'prisma.config.ts',
      '--to-schema',
      'prisma/schema.prisma',
      '--exit-code',
    ],
    { encoding: 'utf8', env: { ...process.env, DATABASE_URL: url } },
  );

  if (diff.status === 0) {
    console.log('ok    no drift between the migrations and the model');
    console.log('\nall good');
  } else {
    console.log('FAIL  the migrations do not build what schema.prisma declares');
    console.log(diff.stdout || diff.stderr);
    console.log(
      '\nFix the SCHEMA to describe what the SQL does where the migration has\n' +
        'already shipped, and the SQL where it has not. Do not edit a migration\n' +
        'that has been applied anywhere — Prisma checksums them.',
    );
    process.exitCode = 1;
  }
} finally {
  if (started) {
    try {
      run(
        `su postgres -s /bin/bash -c "export PATH=${PG}:\\$PATH; pg_ctl -D ${dir} stop -m immediate"`,
        { stdio: 'ignore' },
      );
    } catch {
      /* stopping a server that already died is not a failure */
    }
  }
  rmSync(dir, { recursive: true, force: true });
}
