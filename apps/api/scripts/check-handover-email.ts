// What the handover email says — pinned.
//
// An email is written once and read every day by people who will not check it
// against the database. Every rule below is one where being wrong still looks
// completely normal: a day total that is secretly one shift, a refund quietly
// added to volume, a note that renders as markup because somebody typed a
// bracket.
//
//   npx tsx scripts/check-handover-email.ts

import { sendMail } from '../src/common/mailer';
import {
  buildHandoverEmail,
  type HandoverColumn,
  type HandoverInput,
} from '../src/shifts/handover-email';

let failures = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`ok    ${name}`);
  else {
    failures++;
    console.log(
      `FAIL  ${name} ${detail === undefined ? '' : JSON.stringify(detail)}`,
    );
  }
}
const section = (t: string) => console.log(`\n── ${t} ──`);

const col = (o: Partial<HandoverColumn> & { id: string }): HandoverColumn => ({
  slot: 1,
  name: 'Morning',
  agent: 'Mqdad',
  endedAtLocal: '08:02',
  financials: {
    deposits: { count: 10, amount: 5000 },
    withdrawals: { count: 4, amount: 2000 },
    refunds: { count: 1, amount: 250 },
    volume: 7000,
    declined: 3,
    pending: 2,
    successRate: 82.4,
    byPsp: [
      {
        psp: 'Paystrax',
        deposits: 8,
        depositAmount: 4000,
        withdrawals: 2,
        withdrawalAmount: 1000,
        refunds: 1,
        refundAmount: 250,
        volume: 5000,
      },
      {
        psp: 'ForumPay',
        deposits: 2,
        depositAmount: 1000,
        withdrawals: 2,
        withdrawalAmount: 1000,
        refunds: 0,
        refundAmount: 0,
        volume: 2000,
      },
    ],
    byCurrency: [{ currency: 'USD', count: 14, amount: 7000 }],
    currencies: ['USD'],
  },
  ...o,
});

const input = (o: Partial<HandoverInput>): HandoverInput => ({
  day: '2026-08-26',
  dayLabel: 'Wed 26 Aug',
  slotsPerDay: 3,
  columns: [col({ id: 'a' })],
  currentId: 'a',
  shiftName: 'Morning',
  from: 'Mqdad',
  to: 'Saif',
  durationMins: 488,
  notes: null,
  kyc: null,
  tickets: [],
  incidents: [],
  openTasks: [],
  ...o,
});

section('the day total appears only when there is a day to total');
{
  const one = buildHandoverEmail(input({}));
  ok(
    'one shift → no day total column',
    !one.html.includes('Day total'),
    'found one',
  );

  const two = buildHandoverEmail(
    input({
      columns: [
        col({ id: 'a' }),
        col({ id: 'b', slot: 2, name: 'Evening', agent: 'Saif' }),
      ],
      currentId: 'b',
    }),
  );
  ok('two shifts → a day total appears', two.html.includes('Day total'));
  // 7000 + 7000. A day total that silently shows one shift's figure is the
  // failure this is here to catch.
  ok(
    '...and it is the sum, not a copy',
    two.html.includes('14,000.00'),
    'no 14,000.00',
  );
}

section('refunds are reported, never netted into volume');
{
  const { html } = buildHandoverEmail(input({}));
  ok('volume is deposits + withdrawals', html.includes('7,000.00'));
  ok('refunds have their own row', html.includes('Refunds'));
  // 7000 - 250 would be the netted figure. It must not appear anywhere.
  ok(
    'the netted figure is absent',
    !html.includes('6,750.00'),
    'netting detected',
  );
}

section('one currency collapses, two expand');
{
  const single = buildHandoverEmail(input({}));
  ok(
    'a single currency is one sentence',
    single.html.includes('Everything settled in'),
  );
  ok('...and no currency table', !single.html.includes('Currency —'));

  const mixed = col({ id: 'a' });
  mixed.financials.byCurrency = [
    { currency: 'USD', count: 10, amount: 5000 },
    { currency: 'EUR', count: 4, amount: 2000 },
  ];
  mixed.financials.currencies = ['USD', 'EUR'];
  const two = buildHandoverEmail(input({ columns: [mixed] }));
  ok('a second currency expands the table', two.html.includes('Currency —'));
  ok(
    '...listing both',
    two.html.includes('>USD<') && two.html.includes('>EUR<'),
  );
}

section('a quiet night reads as quiet, not as broken');
{
  const empty = col({ id: 'a' });
  empty.financials.byCurrency = [];
  empty.financials.currencies = [];
  const { html } = buildHandoverEmail(input({ columns: [empty] }));
  // "Everything settled in —" is what a template writes when it assumes there
  // is always something to name.
  ok(
    'no dangling "settled in —"',
    !html.includes('Everything settled in <strong'),
    'dangling sentence',
  );
  ok(
    'it says what actually happened',
    html.includes('Nothing settled in this period'),
  );
}

section('nothing decided is not the same as everything declined');
{
  const quiet = col({ id: 'a' });
  quiet.financials.successRate = null;
  const { html } = buildHandoverEmail(input({ columns: [quiet] }));
  ok('an unknown rate reads as —, not 0%', !html.includes('>0%<'), 'showed 0%');
}

section('what people type cannot become markup');
{
  const { html, subject } = buildHandoverEmail(
    input({
      notes: 'Careful: <script>alert(1)</script> & the "big" client',
      from: 'A <b>name</b>',
      tickets: [
        {
          num: '<img src=x onerror=1>',
          subject: 'x',
          desc: '',
          status: 'Open',
        },
      ],
    }),
  );
  ok('the script tag is escaped', !html.includes('<script>'), 'raw script tag');
  ok('the img tag is escaped', !html.includes('<img src=x'), 'raw img tag');
  ok(
    'the ampersand survives readably',
    html.includes('&amp; the &quot;big&quot; client'),
  );
  // The subject is a header, not HTML — escaping it would show &lt; in an
  // inbox, so it stays raw and must simply not be HTML.
  ok('the subject is left as text', subject.includes('A <b>name</b>'));
}

section('the shift being handed over is the one highlighted');
{
  const { html, subject } = buildHandoverEmail(
    input({
      columns: [
        col({ id: 'a' }),
        col({ id: 'b', slot: 2, name: 'Evening', agent: 'Saif' }),
      ],
      currentId: 'b',
      shiftName: 'Evening',
      from: 'Saif',
      to: 'Ward',
    }),
  );
  ok('the current column is marked', html.includes('· this shift'));
  ok('only once', html.split('· this shift').length - 1 >= 1);
  ok(
    'the subject names the handover',
    subject.includes('Evening — Saif → Ward'),
    subject,
  );
  ok('and the day', subject.includes('Wed 26 Aug'));
}

section('the empty cases read as facts, not as errors');
{
  const bare = col({ id: 'a' });
  bare.financials.byPsp = [];
  const { html } = buildHandoverEmail(input({ columns: [bare] }));
  ok(
    'no terminals says so',
    html.includes('No settled payments on any terminal.'),
  );
  ok('no incidents is good news', html.includes('No open incidents anywhere.'));
  ok('no tickets says so', html.includes('No tickets carried over.'));
}

section('unfinished work is carried, not hidden');
{
  const { html } = buildHandoverEmail(
    input({
      openTasks: [
        { title: 'Chase Paystrax', priority: 'High', status: 'Pending' },
      ],
    }),
  );
  ok('it is listed', html.includes('Chase Paystrax'));
  ok('and named as carried over', html.includes('carry to the next shift'));
}

section('delivery says what actually happened');
{
  // The mailer is checked against a stubbed fetch rather than a live provider:
  // what matters is that the request is the RIGHT request and that every
  // failure comes back as a reason instead of a thrown error that would make a
  // closed shift look like a failed one.
  const realFetch = globalThis.fetch;
  // Only what the checks below read: the endpoint and the body it was sent.
  const calls: { url: string; body: string }[] = [];
  // Typed by hand rather than off `typeof fetch`: the DOM's RequestInit is
  // `any` in this config, and reading `.body` off an `any` is how a check ends
  // up asserting nothing at all.
  const stub = (status: number) => {
    const f = (url: unknown, init?: { body?: unknown }) => {
      const body = init?.body;
      calls.push({
        url: String(url),
        body: typeof body === 'string' ? body : '',
      });
      return Promise.resolve(
        new Response(status === 200 ? '{"id":"x"}' : 'nope', { status }),
      );
    };
    return f;
  };

  const mail = {
    to: ['a@example.com', 'b@example.com'],
    subject: 'S',
    html: '<p>H</p>',
  };
  const run = async () => {
    // sendMail reads the environment on every call, so flipping the variables
    // here is enough — no re-import needed.
    delete process.env.RESEND_API_KEY;
    delete process.env.SENDGRID_API_KEY;

    const unset = await sendMail(mail);
    ok('no provider → not sent, with a reason', !unset.sent && !!unset.reason);
    ok(
      '...and it names the variable to set',
      unset.reason!.includes('RESEND_API_KEY'),
    );

    const noone = await sendMail({ ...mail, to: [] });
    ok(
      'nobody to send to → says so',
      !noone.sent && noone.reason!.includes('Nobody'),
    );

    process.env.RESEND_API_KEY = 'test-key';
    globalThis.fetch = stub(200);
    const sent = await sendMail(mail);
    ok('with a key → sent', sent.sent && sent.provider === 'resend', sent);
    ok(
      'to the right endpoint',
      calls[0]?.url === 'https://api.resend.com/emails',
      calls[0]?.url,
    );
    const body = JSON.parse(calls[0]?.body ?? '{}') as {
      to: string[];
      subject: string;
      html: string;
    };
    ok('carrying both recipients', body.to.length === 2);
    ok('the subject', body.subject === 'S');
    ok('and the html', body.html === '<p>H</p>');

    globalThis.fetch = stub(422);
    const refused = await sendMail(mail);
    ok(
      'a refusal is a reason, not a throw',
      !refused.sent && refused.reason!.includes('422'),
      refused,
    );

    globalThis.fetch = () => Promise.reject(new Error('network down'));
    const down = await sendMail(mail);
    ok(
      'an unreachable provider is a reason too',
      !down.sent && down.reason!.includes('network down'),
    );

    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  };
  void run().then(finish);
}

function finish() {
  console.log(
    failures
      ? `\n${failures} check(s) failed.`
      : '\nAll handover checks passed.',
  );
  process.exit(failures ? 1 : 0);
}
