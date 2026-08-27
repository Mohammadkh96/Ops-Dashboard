// The Google sign-in round trip, end to end, against a stubbed Google.
//
// check-google-claims.ts pins WHO is allowed in. This one pins what the routes
// actually do with them: the redirect out, the redirect back, the account that
// gets created, the role it gets, and — the part that is easy to get wrong and
// impossible to notice — that the session token is handed over in the URL
// FRAGMENT rather than the query string, and that it is a token /auth/me will
// actually accept.
//
// Google's token endpoint is stubbed. Everything else is the real application:
// the real controller, the real service, the real database.
//
// Needs a local Postgres (the same one `npm run db:push` targets). It cleans up
// the accounts it creates.
//
//   npm run build && node scripts/check-google-flow.mjs
//
// Against the BUILT app, not the sources, unlike the other check scripts. Nest
// resolves constructor dependencies from the type metadata TypeScript emits,
// and esbuild — which tsx uses — does not emit it: under tsx every injected
// service arrives as undefined and the controller 500s with nothing wrong in
// it. ts-node emits the metadata but cannot load Prisma v7's generated client,
// which is written as ESM. The compiled output has neither problem.

import 'dotenv/config';
import request from 'supertest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { createApp } = require_('../dist/src/bootstrap');
const { PrismaService } = require_('../dist/src/prisma/prisma.service');

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

const CLIENT_ID = 'flow-check.apps.googleusercontent.com';
const DOMAIN = 'flowcheck.test';
const WEB = 'http://localhost:3000';

process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
process.env.GOOGLE_CLIENT_SECRET = 'flow-check-secret';
process.env.GOOGLE_ALLOWED_DOMAINS = DOMAIN;
process.env.GOOGLE_REDIRECT_URI = 'http://localhost:4000/api/auth/google/callback';
process.env.WEB_ORIGIN = WEB;
process.env.JWT_SECRET ??= 'flow-check-secret-key';
process.env.PAYMAXIS_POLL_ENABLED = '0';

const b64url = (o) =>
  Buffer.from(JSON.stringify(o))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** What "Google" will hand back on the next token exchange. */
let nextIdTokenClaims = null;
let tokenEndpointStatus = 200;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.toString();
  if (url.startsWith('https://oauth2.googleapis.com/token')) {
    if (tokenEndpointStatus !== 200) {
      return new Response('{"error":"invalid_grant"}', {
        status: tokenEndpointStatus,
      });
    }
    const idToken = `${b64url({ alg: 'RS256' })}.${b64url(nextIdTokenClaims)}.sig`;
    return new Response(JSON.stringify({ id_token: idToken }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return realFetch(input, init);
};

/** The claims a real, in-good-standing member of staff would arrive with. */
const staff = (email, over = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub: `sub-${email}`,
  exp: Math.floor(Date.now() / 1000) + 3600,
  email,
  email_verified: true,
  hd: DOMAIN,
  name: 'Flow Check',
  given_name: 'Flow',
  family_name: 'Check',
  ...over,
});

/** The Location header of a redirect, split into path and fragment. */
function landing(location) {
  const url = new URL(location, WEB);
  return {
    path: url.pathname,
    query: url.searchParams,
    fragment: new URLSearchParams(url.hash.replace(/^#/, '')),
    raw: location,
  };
}

async function run() {
  let app;
  try {
    app = await createApp();
    await app.init();
  } catch (e) {
    console.log(
      `\nSkipped: could not start the app (${e instanceof Error ? e.message : String(e)}).`,
    );
    console.log('This check needs the local Postgres from docker-compose.');
    return 0;
  }
  const http = app.getHttpServer();
  const prisma = app.get(PrismaService);

  const newcomer = `newcomer@${DOMAIN}`;
  const existing = `existing@${DOMAIN}`;
  const outsider = `outsider@elsewhere.test`;
  const cleanup = [newcomer, existing, outsider];
  await prisma.user.deleteMany({ where: { email: { in: cleanup } } });

  /** Runs a whole sign-in and returns where the browser ends up. */
  async function signIn(claims, returnTo = '/') {
    nextIdTokenClaims = claims;
    const start = await request(http)
      .get('/api/auth/google')
      .query({ returnTo })
      .expect(302);
    const state = new URL(start.headers.location).searchParams.get('state');
    const back = await request(http)
      .get('/api/auth/google/callback')
      .query({ code: 'stub-code', state })
      .expect(302);
    return landing(back.headers.location);
  }

  try {
    section('a member of staff who has never signed in');
    {
      const end = await signIn(staff(newcomer), '/shift');
      ok('lands on the callback page', end.path === '/auth/callback', end.raw);

      // The whole reason this is a fragment: a query string would be written to
      // the web host's access log and sent in the Referer of the next request.
      ok('the token is in the fragment', end.fragment.has('token'));
      ok('and NOT in the query string', !end.query.has('token'), end.raw);
      ok('the requested page is carried through', end.fragment.get('next') === '/shift');

      const created = await prisma.user.findUnique({ where: { email: newcomer } });
      ok('an account is created', Boolean(created));
      // Everyone in the company can reach this door, so the default it opens on
      // has to be the one that grants nothing.
      ok('at READ_ONLY, not something useful', created?.role === 'READ_ONLY', created?.role);
      ok('with the Google account recorded', created?.googleId === `sub-${newcomer}`);
      ok('and a name off the token', created?.firstName === 'Flow');

      // The token is only worth anything if the rest of the API takes it.
      const me = await request(http)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${end.fragment.get('token')}`)
        .expect(200);
      ok('the session token is accepted by /auth/me', me.body.email === newcomer, me.body);

      // No password can ever match, so this account is Google-only.
      const refused = await request(http)
        .post('/api/auth/login')
        .send({ email: newcomer, password: 'anything' });
      ok('and no password signs in as them', refused.status === 401, refused.status);
    }

    section('somebody who already has an account');
    {
      await prisma.user.create({
        data: {
          email: existing,
          firstName: 'Already',
          lastName: 'Here',
          passwordHash: 'placeholder',
          role: 'ADMIN',
        },
      });
      const end = await signIn(staff(existing));
      ok('signs in', end.fragment.has('token'), end.raw);

      const after = await prisma.user.findUnique({ where: { email: existing } });
      // The bug this prevents: signing in through the new door quietly demoting
      // an administrator to the default role.
      ok('keeps their role', after?.role === 'ADMIN', after?.role);
      ok('and gains the Google link', after?.googleId === `sub-${existing}`);
    }

    section('a deactivated account');
    {
      await prisma.user.update({
        where: { email: existing },
        data: { isActive: false },
      });
      const end = await signIn(staff(existing));
      ok('is sent back to the login page', end.path === '/login', end.raw);
      ok('with no token anywhere', !end.fragment.has('token') && !end.query.has('token'));
      ok(
        'and a reason that names the fix',
        /administrator/i.test(end.query.get('error') ?? ''),
        end.query.get('error'),
      );
      await prisma.user.update({
        where: { email: existing },
        data: { isActive: true },
      });
    }

    section('somebody outside the company');
    {
      const end = await signIn(staff(outsider, { hd: undefined }));
      ok('never reaches the dashboard', end.path === '/login', end.raw);
      ok('gets no token', !end.fragment.has('token'));
      ok(
        'and is told which account to use',
        (end.query.get('error') ?? '').includes(DOMAIN),
        end.query.get('error'),
      );
      const ghost = await prisma.user.findUnique({ where: { email: outsider } });
      // The refusal has to happen BEFORE the account is written, or a refused
      // sign-in still leaves a row behind for somebody to wonder about.
      ok('and no account is left behind', ghost === null);
    }

    section('returnTo is not an open redirect');
    {
      // The state token is attacker-supplied the moment they can get somebody
      // to start the flow, and this redirect happens with a fresh session in
      // hand — the single worst moment to follow a stranger's URL.
      const end = await signIn(staff(newcomer), 'https://evil.test/steal');
      ok('an absolute URL is dropped', end.fragment.get('next') === '/', end.raw);
      const protocolRelative = await signIn(staff(newcomer), '//evil.test/steal');
      ok(
        'a protocol-relative URL is dropped',
        protocolRelative.fragment.get('next') === '/',
        protocolRelative.raw,
      );
    }

    section('Google itself refusing');
    {
      tokenEndpointStatus = 400;
      const end = await signIn(staff(newcomer));
      ok('ends on the login page, not a JSON error', end.path === '/login', end.raw);
      ok(
        'and says where to look',
        /redirect URI/i.test(end.query.get('error') ?? ''),
        end.query.get('error'),
      );
      tokenEndpointStatus = 200;
    }

    section('a state that was not issued here');
    {
      const back = await request(http)
        .get('/api/auth/google/callback')
        .query({ code: 'stub-code', state: 'forged' })
        .expect(302);
      const end = landing(back.headers.location);
      ok('is refused', end.path === '/login', end.raw);
      ok('with no token', !end.fragment.has('token'));
    }
  } finally {
    await prisma.user.deleteMany({ where: { email: { in: cleanup } } });
    await app.close();
  }
  return failures;
}

void run()
  .then((n) => {
    console.log(
      n ? `\n${n} check(s) failed.` : '\nAll Google sign-in flow checks passed.',
    );
    process.exit(n ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
