// What a request pays for when nothing has been running.
//
// This API is a serverless function in front of a database that suspends when
// idle. Both wake quickly on their own; the complaint from the desk was that
// they woke ONE AFTER THE OTHER, and the bill for both landed on whoever
// pressed a button first — usually the sign-in after a quiet hour, which came
// back as "Failed to fetch" rather than as anything explicable.
//
// So the boot path is now something worth guarding. What this pins:
//
//   • boot does not WAIT for the database. It already did not — $connect() with
//     a driver adapter opens no socket — but that is an easy property to lose to
//     a later "let's verify the connection at startup", and losing it costs
//     every cold start the whole database wake-up before a single route answers.
//     The proof is a boot against a database that will never reply.
//   • the OpenAPI document is built on demand rather than on the way up — but
//     /api/docs still has to work, or this traded a real feature for a fast
//     start. That one IS a change; before it, every cold start assembled the
//     whole document through reflection before serving anything.
//   • /api/health is reachable with no token and still says whether Postgres is
//     up, because it is what the browser now pings to do the waking.
//
//   npm run build && node scripts/check-coldstart.mjs
//
// In a throwaway database.

import 'dotenv/config';
import request from 'supertest';
import { createRequire } from 'node:module';

import { useScratchDb } from './scratch-db.mjs';

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log(`ok    ${name}`);
  else {
    failures++;
    console.log(
      `FAIL  ${name} ${detail === undefined ? '' : JSON.stringify(detail)}`,
    );
  }
}
const section = (t) => console.log(`\n── ${t} ──`);

process.env.JWT_SECRET ??= 'coldstart-check';
process.env.PAYMAXIS_POLL_ENABLED = '0';

/**
 * How long a boot may take when the database is unreachable.
 *
 * Generous on purpose — this is not a benchmark, and a loaded machine must not
 * fail it. A correct boot takes about 200ms here. The budget is only ever
 * exceeded by a boot that WAITS on the network, which is the thing being ruled
 * out: a TCP connect to a black-holed address takes tens of seconds to give up,
 * so anything that opens one at startup blows past this by a wide margin.
 */
const BOOT_BUDGET_MS = 8_000;

async function run() {
  const drop = await useScratchDb('opsos_coldstart_check');
  const require_ = createRequire(import.meta.url);
  const { createApp } = require_('../dist/src/bootstrap');

  section('a boot that does not wait for Postgres');
  {
    // An address that accepts nothing. Not a wrong password (which is refused
    // immediately) and not a closed port on localhost (ditto) — a host that
    // never answers, which is what a suspended or unreachable database looks
    // like from the outside.
    const real = process.env.DATABASE_URL;
    process.env.DATABASE_URL =
      'postgresql://nobody:nobody@192.0.2.1:5432/nothing?connect_timeout=30';

    const started = Date.now();
    let app;
    let booted = true;
    try {
      app = await createApp();
      await app.init();
    } catch {
      booted = false;
    }
    const took = Date.now() - started;
    process.env.DATABASE_URL = real;

    ok('the app comes up at all', booted);
    ok(
      `and does not block on the connection (${took}ms < ${BOOT_BUDGET_MS}ms)`,
      booted && took < BOOT_BUDGET_MS,
      took,
    );

    if (app) {
      // It has to be HONEST about it, not merely fast: an API that boots
      // quickly and then reports itself healthy with no database is worse than
      // one that is slow.
      const h = await request(app.getHttpServer()).get('/api/health');
      ok('health answers without a database', h.status === 200, h.status);
      ok('and says the database is down', h.body?.database === 'down', h.body);
      ok('and calls itself degraded', h.body?.status === 'degraded', h.body);
      await app.close();
    }
  }

  const app = await createApp();
  await app.init();
  const http = app.getHttpServer();

  try {
    section('what the browser pings to do the waking');
    {
      const h = await request(http).get('/api/health');
      ok('health needs no token', h.status === 200, h.status);
      ok('and reaches the database', h.body?.database === 'up', h.body);
      // The ping is only worth making because it runs a query. One that never
      // touched Postgres would wake the function and leave the database asleep,
      // which is most of the wait it was added to remove.
      ok(
        'and reports which build answered',
        Object.prototype.hasOwnProperty.call(h.body ?? {}, 'build'),
        h.body,
      );
    }

    section('documentation built on demand still exists');
    {
      // The whole point of the lazy factory is that nothing here changes.
      const json = await request(http).get('/api/docs-json');
      ok('the OpenAPI document is served', json.status === 200, json.status);
      ok(
        'and describes this API',
        json.body?.info?.title === 'OpsOS API',
        json.body?.info,
      );
      ok(
        'and contains the routes',
        Object.keys(json.body?.paths ?? {}).length > 10,
        Object.keys(json.body?.paths ?? {}).length,
      );

      // Built twice, because a factory that memoises wrongly, or one that
      // mutates the app while building, fails only on the second reader.
      const again = await request(http).get('/api/docs-json');
      ok('and again for the next reader', again.status === 200, again.status);
      ok(
        'identically',
        JSON.stringify(again.body?.paths) === JSON.stringify(json.body?.paths),
      );
    }
  } finally {
    await app.close();
    await drop();
  }

  return failures;
}

void run()
  .then((n) => {
    console.log(n ? `\n${n} check(s) failed.` : '\nAll cold-start checks passed.');
    process.exit(n ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
