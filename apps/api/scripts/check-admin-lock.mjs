// The second password in front of the Admin tab.
//
// Everything here is about what the lock REFUSES. A lock that opens for the
// right passphrase is easy; the ways this kind of thing turns out to be
// decorative are all refusals that were never written: the session token
// accepted as an unlock, the routes still answering without one, a demoted
// administrator's token still working, unlimited guesses.
//
//   npm run build && node scripts/check-admin-lock.mjs
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

process.env.JWT_SECRET ??= 'admin-lock-check';
process.env.PAYMAXIS_POLL_ENABLED = '0';

const PASS = 'desk-vault-2026';

async function run() {
  const drop = await useScratchDb('opsos_admin_lock_check');
  const require_ = createRequire(import.meta.url);
  const { createApp } = require_('../dist/src/bootstrap');
  const { PrismaService } = require_('../dist/src/prisma/prisma.service');

  const app = await createApp();
  await app.init();
  const http = app.getHttpServer();
  const prisma = app.get(PrismaService);
  const jwt = app.get(require_('@nestjs/jwt').JwtService);

  const make = async (email, role) =>
    prisma.user.create({
      data: {
        email,
        firstName: role,
        lastName: 'Check',
        passwordHash: 'none',
        role,
      },
    });
  const session = (u) =>
    `Bearer ${jwt.sign({ sub: u.id, email: u.email, role: u.role })}`;

  const admin = await make('admin@lock.test', 'ADMIN');
  const other = await make('other@lock.test', 'ADMIN');
  const agent = await make('agent@lock.test', 'OPERATIONS');

  const adminAuth = session(admin);
  const agentAuth = session(agent);

  const post = (path, auth, body) =>
    request(http).post(`/api${path}`).set('Authorization', auth).send(body);
  const get = (path, auth, adminToken) => {
    const r = request(http).get(`/api${path}`);
    if (auth) r.set('Authorization', auth);
    if (adminToken) r.set('X-Admin-Token', adminToken);
    return r;
  };

  try {
    section('the routes it guards');
    {
      // These two answered to ANYBODY before this existed: a plain GET returned
      // every account's name, email and role, and the whole audit trail.
      ok('users is not public', (await get('/admin/users')).status === 401);
      ok('the audit log is not public', (await get('/admin/audit-logs')).status === 401);
      ok(
        'and being signed in is not enough',
        (await get('/admin/users', adminAuth)).status === 403,
      );
    }

    section('who may have a lock at all');
    {
      const r = await get('/auth/admin/lock', agentAuth);
      ok('a non-administrator is refused', r.status === 403, r.body);
      ok(
        'and cannot set a passphrase to become one',
        (await post('/auth/admin/lock', agentAuth, { next: PASS })).status === 403,
      );
    }

    section('setting the passphrase');
    {
      const before = await get('/auth/admin/lock', adminAuth);
      ok('starts unset', before.body.configured === false, before.body);

      const short = await post('/auth/admin/lock', adminAuth, { next: 'short' });
      ok('a short one is refused', short.status === 400, short.body);

      const set = await post('/auth/admin/lock', adminAuth, { next: PASS });
      ok('a real one is accepted', set.status === 201 || set.status === 200, set.body);

      const after = await get('/auth/admin/lock', adminAuth);
      ok('and is then configured', after.body.configured === true);
      ok('with a time', Boolean(after.body.setAt));
    }

    section('unlocking');
    {
      const wrong = await post('/auth/admin/unlock', adminAuth, {
        passphrase: 'not-the-passphrase',
      });
      ok('the wrong one is refused', wrong.status === 401, wrong.status);
      // Said out loud, because somebody typing a near-miss needs to know they
      // are burning attempts before the lockout arrives with no warning.
      ok('and says how many attempts are left', /attempt/i.test(wrong.body.message ?? ''), wrong.body);

      const good = await post('/auth/admin/unlock', adminAuth, { passphrase: PASS });
      ok('the right one opens it', good.status === 201 || good.status === 200, good.body);
      ok('and returns a token', typeof good.body.adminToken === 'string');
      ok('with an expiry', Boolean(good.body.expiresAt));

      const token = good.body.adminToken;
      ok(
        'which opens the guarded routes',
        (await get('/admin/users', adminAuth, token)).status === 200,
      );
      ok(
        'and the audit log',
        (await get('/admin/audit-logs', adminAuth, token)).status === 200,
      );

      // Both halves are required. The session says who you are; the unlock says
      // you took the extra step just now. Neither alone is enough.
      ok(
        'the unlock alone is not a session',
        (await get('/admin/users', null, token)).status === 401,
      );

      section('tokens that must not be mistaken for an unlock');
      {
        // The failure that would make all of this decorative: a session token
        // carries no scope, so it must never satisfy the guard.
        const r = await get('/admin/users', adminAuth, adminAuth.replace('Bearer ', ''));
        ok('a session token is refused as an unlock', r.status === 403, r.body);

        // Signed by us, correct shape, wrong scope — a forged elevation.
        const forged = jwt.sign({ sub: admin.id, email: admin.email, scope: 'user' });
        ok(
          'a token with the wrong scope is refused',
          (await get('/admin/users', adminAuth, forged)).status === 403,
        );

        const expired = jwt.sign(
          { sub: admin.id, email: admin.email, scope: 'admin' },
          { expiresIn: '-1s' },
        );
        ok(
          'an expired unlock is refused',
          (await get('/admin/users', adminAuth, expired)).status === 403,
        );

        // One administrator's unlock, pasted into another person's session.
        // The two halves have to be the same person.
        ok(
          "somebody else's unlock does not raise my session",
          (await get('/admin/users', session(other), token)).status === 403,
        );
      }

      section('an unlock outlives the thing it was granted for');
      {
        // A token is good for fifteen minutes. An administrator demoted or
        // deactivated two minutes in still holds a perfectly valid one, so the
        // account is re-read on every request rather than trusted from the
        // claims.
        await prisma.user.update({
          where: { id: admin.id },
          data: { role: 'OPERATIONS' },
        });
        ok(
          'a demoted administrator is refused',
          (await get('/admin/users', adminAuth, token)).status === 403,
        );
        await prisma.user.update({
          where: { id: admin.id },
          data: { role: 'ADMIN', isActive: false },
        });
        ok(
          'a deactivated one is refused',
          (await get('/admin/users', adminAuth, token)).status === 403,
        );
        await prisma.user.update({
          where: { id: admin.id },
          data: { isActive: true },
        });
        ok(
          'and it works again once they are back',
          (await get('/admin/users', adminAuth, token)).status === 200,
        );
      }
    }

    section('guessing');
    {
      // A second password is worth nothing if somebody who already has the
      // session can try it a thousand times a minute.
      const target = await make('guessed@lock.test', 'ADMIN');
      const auth = session(target);
      await post('/auth/admin/lock', auth, { next: PASS });

      let lastStatus = 0;
      for (let i = 0; i < 5; i++) {
        lastStatus = (
          await post('/auth/admin/unlock', auth, { passphrase: `wrong-${i}` })
        ).status;
      }
      ok('five wrong attempts are all refused', lastStatus === 401);

      const after = await post('/auth/admin/unlock', auth, { passphrase: PASS });
      ok('and the RIGHT one is then refused too', after.status === 403, after.body);
      ok(
        'with how long to wait',
        /minute/i.test(after.body.message ?? ''),
        after.body,
      );

      const status = await get('/auth/admin/lock', auth);
      ok('the status says it is locked out', status.body.lockedForSeconds > 0, status.body);

      // The owner setting a new passphrase proves who they are, so leaving them
      // shut out of what they just set would be nonsense.
      await prisma.user.update({
        where: { id: target.id },
        data: { adminLockedUntil: null, adminFails: 0 },
      });
      ok(
        'clearing the lockout lets the right one through',
        (await post('/auth/admin/unlock', auth, { passphrase: PASS })).status <= 201,
      );
    }

    section('changing it');
    {
      const noCurrent = await post('/auth/admin/lock', adminAuth, {
        next: 'a-different-one-entirely',
      });
      // Without this, a session somebody walked away from could REPLACE the
      // passphrase — turning the second password into a formality and locking
      // the owner out at the same time.
      ok('changing needs the current one', noCurrent.status === 401, noCurrent.body);

      const changed = await post('/auth/admin/lock', adminAuth, {
        current: PASS,
        next: 'a-different-one-entirely',
      });
      ok('with it, the change lands', changed.status <= 201, changed.body);
      ok(
        'the old one no longer opens it',
        (await post('/auth/admin/unlock', adminAuth, { passphrase: PASS })).status === 401,
      );
      ok(
        'the new one does',
        (await post('/auth/admin/unlock', adminAuth, {
          passphrase: 'a-different-one-entirely',
        })).status <= 201,
      );
    }

    section('the audit trail');
    {
      const rows = await prisma.auditLog.findMany({
        where: { entityType: 'AdminLock' },
        select: { action: true },
      });
      const actions = new Set(rows.map((r) => r.action));
      ok('unlocks are recorded', actions.has('admin.unlock'));
      // The one that is easy to leave out, and the one somebody actually needs
      // afterwards: a run of failures against the admin lock is invisible if
      // only successes are written down.
      ok('and so are failed attempts', actions.has('admin.unlock.failed'));
      ok('and passphrase changes', actions.has('admin.passphrase.set'));
    }
  } finally {
    await app.close();
    await drop();
  }
  return failures;
}

void run()
  .then((n) => {
    console.log(
      n ? `\n${n} check(s) failed.` : '\nAll admin-lock checks passed.',
    );
    process.exit(n ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
