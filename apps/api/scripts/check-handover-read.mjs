// The handover read receipt, against the real application.
//
// The point of showing the previous handover at Start shift is that afterwards
// somebody can ask "was the night shift told about the PSP outage?" and get an
// answer. That only holds if the receipt cannot be claimed without reading —
// so most of what is pinned here is the server refusing claims, not accepting
// them.
//
//   npm run build && node scripts/check-handover-read.mjs
//
// Against the BUILT app: Nest resolves constructor dependencies from the type
// metadata TypeScript emits, and esbuild — which tsx uses — does not emit it.
//
// In a THROWAWAY database, created and dropped by the script. It has to open
// and close shifts to test that opening and closing are recorded, and doing
// that in the development database would rewrite the desk's own history in
// order to check that history is kept correctly. An empty world also lets it
// assert things like "there is no previous shift", which is otherwise only
// true on a machine nobody has used.

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

process.env.JWT_SECRET ??= 'handover-read-check';
process.env.PAYMAXIS_POLL_ENABLED = '0';

const EMAIL = 'handover-read-check@opsos.test';

async function run() {
  // Before the app is imported: Prisma reads DATABASE_URL when the client is
  // constructed, and the client is constructed as the module loads.
  const drop = await useScratchDb('opsos_handover_check');
  const require_ = createRequire(import.meta.url);
  const { createApp } = require_('../dist/src/bootstrap');
  const { PrismaService } = require_('../dist/src/prisma/prisma.service');

  const app = await createApp();
  await app.init();
  const http = app.getHttpServer();
  const prisma = app.get(PrismaService);
  const jwt = app.get(require_('@nestjs/jwt').JwtService);

  // A desk of one. The whole database goes at the end, so nothing else to
  // tidy up.
  const user = await prisma.user.create({
    data: {
      email: EMAIL,
      firstName: 'Read',
      lastName: 'Check',
      passwordHash: 'none',
      role: 'OPERATIONS_MANAGER',
    },
  });
  const auth = `Bearer ${jwt.sign({ sub: user.id, email: user.email, role: user.role })}`;

  const api = (method, path) =>
    request(http)[method](`/api/shifts${path}`).set('Authorization', auth);

  const mine = [];

  const startShift = async (body) => {
    const res = await api('post', '/start').send(body);
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`start failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    mine.push(res.body.shift.id);
    return res.body.shift;
  };
  const endShift = (body = {}) => api('post', '/end').send(body);

  try {
    section('the first shift of all');
    {
      const prev = await api('get', '/previous');
      ok('there is nothing to read', prev.body.shift === null, prev.body);

      const shift = await startShift({ name: 'Morning' });
      // Not a failure and not a warning: somebody has to open the first shift.
      ok('starting is not blocked', Boolean(shift.id));
      ok('and nothing is recorded as read', shift.readHandoverOf === null);

      await endShift({ handoverTo: 'Nobody', notes: 'Watch the EUR terminal.' });
    }

    section('the next shift is offered the one that just closed');
    {
      const prev = await api('get', '/previous');
      ok('it is the shift this script just ended', prev.body.shift?.id === mine[0], prev.body.shift);
      ok('with who closed it', Boolean(prev.body.shift?.endedBy), prev.body.shift);
      // Said before the document loads, so the reader knows what they are
      // walking into before they start reading.
      ok('and that there are notes to read', prev.body.shift?.hasNotes === true);
    }

    section('a read that happened');
    {
      const prev = await api('get', '/previous');
      const shift = await startShift({
        name: 'Evening',
        readHandoverOf: prev.body.shift.id,
      });
      ok('is recorded', shift.readHandoverOf === prev.body.shift.id, shift.readHandoverOf);
      ok('with a time', Boolean(shift.handoverReadAt), shift.handoverReadAt);
      await endShift({ notes: 'Quiet.' });
    }

    section('a read that did not');
    {
      // The whole value of this receipt is that it cannot be claimed. A stale
      // tab, a replayed request or a hand-written one all land here.
      const shift = await startShift({
        name: 'Night',
        readHandoverOf: 'some-other-shift-id',
      });
      ok('a claim about the wrong shift is dropped', shift.readHandoverOf === null, shift.readHandoverOf);
      ok('and no time is invented', shift.handoverReadAt === null);
      await endShift();
    }

    section('claiming to have read a shift that is not the last one');
    {
      // mine[0] is a real shift this script closed — just not the most recent
      // one. A receipt against it would read as "handover was read" while the
      // handover that mattered went unread, which is worse than no receipt.
      const shift = await startShift({ name: 'Morning', readHandoverOf: mine[0] });
      ok('is dropped', shift.readHandoverOf === null, shift.readHandoverOf);
      await endShift();
    }

    section('declining to read it');
    {
      const prev = await api('get', '/previous');
      ok('there is something to read', Boolean(prev.body.shift));
      const shift = await startShift({ name: 'Evening' });
      // Somebody has to be able to take the desk when the document will not
      // build. What must never happen is a read being recorded anyway.
      ok('the desk can still be taken', Boolean(shift.id));
      ok('and it is recorded as not read', shift.readHandoverOf === null);
      await endShift();
    }

    section('the document itself is the same one the email carries');
    {
      const prev = await api('get', '/previous');
      const doc = await api('get', `/${prev.body.shift.id}/handover`);
      ok('it builds', doc.status === 200, doc.status);
      ok('with a subject', typeof doc.body.subject === 'string' && doc.body.subject.length > 0);
      // Returned as a JSON string rather than served as text/html: it is built
      // from notes people typed, and handing the browser a page to render at
      // the API origin is how a note becomes script.
      ok(
        'as JSON, not as a page',
        (doc.headers['content-type'] ?? '').includes('application/json'),
        doc.headers['content-type'],
      );
      ok('and HTML inside it', typeof doc.body.html === 'string' && doc.body.html.includes('<'));
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
      n ? `\n${n} check(s) failed.` : '\nAll handover-read checks passed.',
    );
    process.exit(n ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
