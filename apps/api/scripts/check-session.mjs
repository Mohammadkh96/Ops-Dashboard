// Staying signed in, and the ways a sliding session goes wrong.
//
// The desk's complaint was ordinary: leave the dashboard idle, come back, and
// it has to be reloaded before it works. A token that expires on a wall clock
// signs out the person USING it, which is the wrong thing to measure — so the
// browser now renews while a tab is open and the session rolls forward.
//
// That is a security change dressed as a convenience one, and the checks here
// are almost all about what it must still refuse. A renewal endpoint that is
// slightly too generous is an authentication system with no expiry at all:
//
//   • an EXPIRED token that can renew itself is a permanent session, and the
//     expiry becomes decoration
//   • a renewal that re-signs the OLD claims carries a role that was revoked an
//     hour ago forward for another whole day
//   • a deactivated account whose tab is still open keeps working
//
//   npm run build && node scripts/check-session.mjs
//
// In a throwaway database — it changes roles and deactivates accounts.

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

process.env.JWT_SECRET ??= 'session-check';
process.env.PAYMAXIS_POLL_ENABLED = '0';

async function run() {
  const drop = await useScratchDb('opsos_session_check');
  const require_ = createRequire(import.meta.url);
  const { createApp } = require_('../dist/src/bootstrap');
  const { PrismaService } = require_('../dist/src/prisma/prisma.service');

  const app = await createApp();
  await app.init();
  const http = app.getHttpServer();
  const prisma = app.get(PrismaService);
  const jwt = app.get(require_('@nestjs/jwt').JwtService);

  const user = await prisma.user.create({
    data: {
      email: 'desk@session.test',
      firstName: 'Desk',
      lastName: 'Check',
      passwordHash: 'none',
      role: 'OPERATIONS',
    },
  });

  const tokenFor = (u, opts) =>
    jwt.sign({ sub: u.id, email: u.email, role: u.role }, opts);
  const refresh = (token) =>
    request(http)
      .post('/api/auth/refresh')
      .set('Authorization', `Bearer ${token}`)
      .send();

  try {
    section('a session that is still in use');
    {
      const first = tokenFor(user);
      const r = await refresh(first);
      ok('a live token renews', r.status === 201 || r.status === 200, r.status);
      ok('and comes back with a new one', typeof r.body?.accessToken === 'string');

      // The renewed token has to actually work, not merely be a string.
      const me = await request(http)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${r.body.accessToken}`);
      ok('the new token is accepted', me.status === 200, me.status);
      ok('and is the same person', me.body?.email === 'desk@session.test', me.body);

      // Rolling forward means the clock restarts, or nothing has been gained.
      const before = jwt.decode(first);
      const after = jwt.decode(r.body.accessToken);
      ok('the expiry moved forward', after.exp >= before.exp, { before: before.exp, after: after.exp });
    }

    section('what renewal must refuse');
    {
      // THE one. If an expired token can renew itself there is no expiry.
      const dead = tokenFor(user, { expiresIn: '-1s' });
      const r = await refresh(dead);
      ok('an EXPIRED token cannot renew itself', r.status === 401, r.status);

      const none = await request(http).post('/api/auth/refresh').send();
      ok('and neither can no token at all', none.status === 401, none.status);

      const forged = await refresh(
        require_('@nestjs/jwt').JwtService
          ? jwt.sign({ sub: user.id }, { secret: 'not-the-real-secret' })
          : '',
      );
      ok('nor one signed with the wrong secret', forged.status === 401, forged.status);
    }

    section('a session that should have ended');
    {
      // A tab left open by somebody who has since been deactivated. The token
      // is still within its lifetime, so only re-reading the account catches it.
      const gone = await prisma.user.create({
        data: {
          email: 'gone@session.test',
          firstName: 'Gone',
          lastName: 'Check',
          passwordHash: 'none',
          role: 'OPERATIONS',
        },
      });
      const theirs = tokenFor(gone);
      ok('their token works while the account is active',
         (await refresh(theirs)).status < 400);

      await prisma.user.update({ where: { id: gone.id }, data: { isActive: false } });
      const after = await refresh(theirs);
      ok('a deactivated account cannot renew', after.status === 401, after.status);
    }

    section('a role that changed under an open tab');
    {
      // The subtle one. Re-signing the OLD claims would carry a role that was
      // revoked an hour ago forward for another whole day — turning a sliding
      // session into permissions that outlive their removal.
      const promoted = await prisma.user.create({
        data: {
          email: 'promoted@session.test',
          firstName: 'Promoted',
          lastName: 'Check',
          passwordHash: 'none',
          role: 'ADMIN',
        },
      });
      const asAdmin = tokenFor(promoted);
      ok('the token says ADMIN', jwt.decode(asAdmin).role === 'ADMIN');

      await prisma.user.update({
        where: { id: promoted.id },
        data: { role: 'READ_ONLY' },
      });
      const r = await refresh(asAdmin);
      ok('renewal succeeds', r.status < 400, r.status);
      ok('but the new token carries the CURRENT role',
         jwt.decode(r.body.accessToken).role === 'READ_ONLY',
         jwt.decode(r.body.accessToken)?.role);
    }
  } finally {
    await app.close();
    await drop();
  }

  return failures;
}

void run()
  .then((n) => {
    console.log(n ? `\n${n} check(s) failed.` : '\nAll session checks passed.');
    process.exit(n ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
