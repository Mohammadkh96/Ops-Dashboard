// Administering accounts from the Admin tab.
//
// The interesting cases are all the ones where an administrator is stopped from
// doing something to themselves. Every one of them is a single click that is
// irreversible from where the person is standing — the screen they would undo
// it on is the one they just shut.
//
//   npm run build && node scripts/check-admin-users.mjs
//
// In a throwaway database: it creates accounts, changes roles and deactivates
// people.

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

process.env.JWT_SECRET ??= 'admin-users-check';
process.env.PAYMAXIS_POLL_ENABLED = '0';

const PASS = 'desk-vault-2026';

async function run() {
  const drop = await useScratchDb('opsos_admin_users_check');
  const require_ = createRequire(import.meta.url);
  const { createApp } = require_('../dist/src/bootstrap');
  const { PrismaService } = require_('../dist/src/prisma/prisma.service');

  const app = await createApp();
  await app.init();
  const http = app.getHttpServer();
  const prisma = app.get(PrismaService);
  const jwt = app.get(require_('@nestjs/jwt').JwtService);

  const admin = await prisma.user.create({
    data: {
      email: 'boss@lock.test',
      firstName: 'The',
      lastName: 'Boss',
      passwordHash: 'none',
      role: 'ADMIN',
    },
  });
  const auth = `Bearer ${jwt.sign({ sub: admin.id, email: admin.email, role: admin.role })}`;
  const call = (m, p) =>
    request(http)[m](`/api${p}`).set('Authorization', auth);

  // Open the lock, since every route here is behind it.
  await call('post', '/auth/admin/lock').send({ next: PASS });
  const unlocked = await call('post', '/auth/admin/unlock').send({
    passphrase: PASS,
  });
  const ADM = unlocked.body.adminToken;
  const api = (m, p) => call(m, p).set('X-Admin-Token', ADM);

  try {
    section('the lock is in front of all of it');
    {
      // The front end hiding a button is not a control. These are.
      ok(
        'listing needs the unlock',
        (await call('get', '/admin/accounts')).status === 403,
      );
      ok(
        'creating needs the unlock',
        (await call('post', '/admin/accounts').send({ email: 'x@y.test' }))
          .status === 403,
      );
      ok(
        'and so does changing a role',
        (await call('patch', `/admin/accounts/${admin.id}`).send({
          role: 'READ_ONLY',
        })).status === 403,
      );
    }

    section('adding somebody');
    {
      const made = await api('post', '/admin/accounts').send({
        email: 'Sara@Tradin.com',
        firstName: 'Sara',
        lastName: 'Ahmed',
        role: 'OPERATIONS',
      });
      ok('an account is created', made.status <= 201, made.body);
      // Lower-cased on the way in, because Google returns a verified address in
      // whatever case the directory holds and sign-in matches on it exactly.
      ok('the address is normalised', made.body.email === 'sara@tradin.com', made.body.email);

      const list = await api('get', '/admin/accounts');
      const sara = list.body.find((u) => u.email === 'sara@tradin.com');
      ok('and appears in the list', Boolean(sara));
      ok('with the role that was asked for', sara?.role === 'OPERATIONS');
      // The whole point of adding without a password: they press "Continue with
      // Google" and land in it. Nothing to send, nothing to leak.
      ok('and no usable password', sara?.hasPassword === false, sara);
      ok('having never used Google yet', sara?.google === false);

      const again = await api('post', '/admin/accounts').send({
        email: 'sara@tradin.com',
      });
      ok('adding them twice is refused', again.status === 409, again.status);

      const bad = await api('post', '/admin/accounts').send({
        email: 'not-an-address',
      });
      ok('a malformed address is refused', bad.status === 400);

      const wrongRole = await api('post', '/admin/accounts').send({
        email: 'wizard@lock.test',
        role: 'Wizard',
      });
      ok('an unknown role is refused', wrongRole.status === 400);
      ok(
        'and the message lists the real ones',
        /READ_ONLY/.test(wrongRole.body.message ?? ''),
        wrongRole.body.message,
      );

      const shortPw = await api('post', '/admin/accounts').send({
        email: 'short@lock.test',
        password: 'abc',
      });
      ok('a short temporary password is refused', shortPw.status === 400);
    }

    section('a deactivated account is not a free email address');
    {
      const list = await api('get', '/admin/accounts');
      const sara = list.body.find((u) => u.email === 'sara@tradin.com');
      await api('patch', `/admin/accounts/${sara.id}`).send({ isActive: false });

      const again = await api('post', '/admin/accounts').send({
        email: 'sara@tradin.com',
      });
      ok('making a second one is refused', again.status === 409);
      // The common case, and the one a bare "already exists" sends somebody
      // hunting for a duplicate that is not there.
      ok(
        'and it says the account is deactivated',
        /deactivated/i.test(again.body.message ?? ''),
        again.body.message,
      );
      await api('patch', `/admin/accounts/${sara.id}`).send({ isActive: true });
    }

    section('what an administrator may not do to themselves');
    {
      const mine = await api('patch', `/admin/accounts/${admin.id}`).send({
        role: 'READ_ONLY',
      });
      ok('change their own role', mine.status === 400, mine.body);
      const off = await api('patch', `/admin/accounts/${admin.id}`).send({
        isActive: false,
      });
      ok('deactivate themselves', off.status === 400, off.body);
      // Not a blanket ban on touching your own row — renaming yourself is fine.
      const rename = await api('patch', `/admin/accounts/${admin.id}`).send({
        firstName: 'Renamed',
      });
      ok('but renaming themselves is allowed', rename.status <= 201, rename.body);
    }

    section('the last administrator');
    {
      const list = await api('get', '/admin/accounts');
      const sara = list.body.find((u) => u.email === 'sara@tradin.com');

      await api('patch', `/admin/accounts/${sara.id}`).send({ role: 'ADMIN' });
      const demote = await api('patch', `/admin/accounts/${sara.id}`).send({
        role: 'OPERATIONS',
      });
      ok(
        'can be demoted while another one exists',
        demote.status <= 201,
        demote.body,
      );

      // Now the boss is the only active administrator. Somebody else demoting
      // them reaches the same dead end as doing it to yourself, politely.
      const other = await prisma.user.create({
        data: {
          email: 'second@lock.test',
          firstName: 'Second',
          lastName: 'Admin',
          passwordHash: 'none',
          role: 'ADMIN',
        },
      });
      const otherAuth = `Bearer ${jwt.sign({ sub: other.id, email: other.email, role: 'ADMIN' })}`;
      await request(http)
        .post('/api/auth/admin/lock')
        .set('Authorization', otherAuth)
        .send({ next: PASS });
      const otherUnlock = await request(http)
        .post('/api/auth/admin/unlock')
        .set('Authorization', otherAuth)
        .send({ passphrase: PASS });
      const otherAdm = otherUnlock.body.adminToken;

      // Demote the second one first, leaving exactly one.
      await api('patch', `/admin/accounts/${other.id}`).send({
        role: 'OPERATIONS',
      });
      const lastOne = await request(http)
        .patch(`/api/admin/accounts/${admin.id}`)
        .set('Authorization', otherAuth)
        .set('X-Admin-Token', otherAdm)
        .send({ role: 'OPERATIONS' });
      // otherAuth is no longer an admin, so the guard refuses before the rule
      // is even reached — which is itself the right answer.
      ok(
        'a demoted administrator cannot demote the last one',
        lastOne.status === 403,
        lastOne.status,
      );
    }

    section('passwords');
    {
      const list = await api('get', '/admin/accounts');
      const sara = list.body.find((u) => u.email === 'sara@tradin.com');

      const set = await api(
        'post',
        `/admin/accounts/${sara.id}/password`,
      ).send({ password: 'temporary-one-2026' });
      ok('one can be set', set.status <= 201, set.body);

      const login = await request(http).post('/api/auth/login').send({
        email: 'sara@tradin.com',
        password: 'temporary-one-2026',
      });
      ok('and it actually signs them in', login.status <= 201, login.status);

      const after = (await api('get', '/admin/accounts')).body.find(
        (u) => u.email === 'sara@tradin.com',
      );
      ok('the list now says they have one', after.hasPassword === true);

      const cleared = await api(
        'post',
        `/admin/accounts/${sara.id}/password/clear`,
      );
      ok('and it can be taken away again', cleared.status <= 201);
      const refused = await request(http).post('/api/auth/login').send({
        email: 'sara@tradin.com',
        password: 'temporary-one-2026',
      });
      // The marker written in its place cannot match any input, so the account
      // is Google-only rather than open.
      ok('after which it no longer works', refused.status === 401, refused.status);
    }

    section('the audit trail');
    {
      const rows = await prisma.auditLog.findMany({
        where: { entityType: 'User' },
        select: { action: true },
      });
      const actions = new Set(rows.map((r) => r.action));
      ok('creating is recorded', actions.has('user.created'));
      ok('role and status changes are recorded', actions.has('user.updated'));
      ok('so is setting a password', actions.has('user.password.set'));
      ok('and clearing one', actions.has('user.password.cleared'));
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
      n ? `\n${n} check(s) failed.` : '\nAll admin-user checks passed.',
    );
    process.exit(n ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
