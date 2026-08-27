// What the Gmail provider actually puts on the wire.
//
// Every failure this pins is one that looks fine locally and is wrong only in
// the received copy — a mangled subject, a table broken by a line-length limit,
// a From header Gmail refuses. None of them show up in a preview, and all of
// them show up in front of the whole desk at handover time.
//
//   npx tsx scripts/check-gmail.ts

import * as gmail from '../src/common/gmail';

const { mimeMessage, encodeHeader, gmailFrom } = gmail.__internals;

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

/** Reads an env var, runs a function, puts the environment back. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const before = { ...process.env };
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
}

function run(): number {
  section('which way in is configured');
  {
    const clean = {
      GMAIL_REFRESH_TOKEN: undefined,
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      GOOGLE_SERVICE_ACCOUNT_JSON: undefined,
      GMAIL_SERVICE_ACCOUNT_EMAIL: undefined,
      GMAIL_PRIVATE_KEY: undefined,
      GMAIL_SENDER: undefined,
    };
    ok(
      'nothing set means not configured',
      withEnv(clean, () => gmail.gmailMode()) === null,
    );
    ok(
      'a refresh token needs the OAuth client too',
      withEnv({ ...clean, GMAIL_REFRESH_TOKEN: 'r' }, () =>
        gmail.gmailMode(),
      ) === null,
    );
    ok(
      'refresh token + client is the refresh-token path',
      withEnv(
        {
          ...clean,
          GMAIL_REFRESH_TOKEN: 'r',
          GOOGLE_CLIENT_ID: 'c',
          GOOGLE_CLIENT_SECRET: 's',
        },
        () => gmail.gmailMode(),
      ) === 'refresh-token',
    );
    // A service account with no mailbox to impersonate cannot send: the token
    // would belong to the service account itself, which has no Gmail at all.
    ok(
      'a service account without a sender is not configured',
      withEnv(
        {
          ...clean,
          GMAIL_SERVICE_ACCOUNT_EMAIL: 'sa@p.iam.gserviceaccount.com',
          GMAIL_PRIVATE_KEY: 'k',
        },
        () => gmail.gmailMode(),
      ) === null,
    );
    ok(
      'with one, it is the service-account path',
      withEnv(
        {
          ...clean,
          GMAIL_SERVICE_ACCOUNT_EMAIL: 'sa@p.iam.gserviceaccount.com',
          GMAIL_PRIVATE_KEY: 'k',
          GMAIL_SENDER: 'ops@co.com',
        },
        () => gmail.gmailMode(),
      ) === 'service-account',
    );
    // The refresh-token path is tried first: it is the one that does not need a
    // Workspace administrator, so it is the one most people will have.
    ok(
      'the refresh token wins when both are set',
      withEnv(
        {
          ...clean,
          GMAIL_REFRESH_TOKEN: 'r',
          GOOGLE_CLIENT_ID: 'c',
          GOOGLE_CLIENT_SECRET: 's',
          GMAIL_SERVICE_ACCOUNT_EMAIL: 'sa@p.iam.gserviceaccount.com',
          GMAIL_PRIVATE_KEY: 'k',
          GMAIL_SENDER: 'ops@co.com',
        },
        () => gmail.gmailMode(),
      ) === 'refresh-token',
    );
  }

  section('the From address');
  {
    ok(
      'a matching MAIL_FROM is kept as written',
      withEnv(
        { GMAIL_SENDER: 'ops@co.com', MAIL_FROM: 'OpsOS <ops@co.com>' },
        gmailFrom,
      ) === 'OpsOS <ops@co.com>',
    );
    // Gmail refuses a From the authenticated mailbox does not own, rather than
    // rewriting it — so a stale MAIL_FROM would break every send with a message
    // about headers that reads like a bug in the dashboard.
    ok(
      'a disagreeing address is corrected to the mailbox',
      withEnv(
        { GMAIL_SENDER: 'ops@co.com', MAIL_FROM: 'OpsOS <old@vendor.dev>' },
        gmailFrom,
      ) === 'OpsOS <ops@co.com>',
    );
    ok(
      'and the display name survives that',
      withEnv(
        {
          GMAIL_SENDER: 'ops@co.com',
          MAIL_FROM: 'Night Desk <old@vendor.dev>',
        },
        gmailFrom,
      ) === 'Night Desk <ops@co.com>',
    );
    ok(
      'a bare address works',
      withEnv(
        { GMAIL_SENDER: 'ops@co.com', MAIL_FROM: 'ops@co.com' },
        gmailFrom,
      ) === 'ops@co.com',
    );
    ok(
      'no MAIL_FROM falls back to the mailbox',
      withEnv(
        { GMAIL_SENDER: 'ops@co.com', MAIL_FROM: undefined },
        gmailFrom,
      ) === 'ops@co.com',
    );
    ok(
      'case differences are not treated as a mismatch',
      withEnv(
        { GMAIL_SENDER: 'Ops@Co.com', MAIL_FROM: 'OpsOS <ops@co.com>' },
        gmailFrom,
      ) === 'OpsOS <ops@co.com>',
    );
  }

  section('the subject line');
  {
    ok(
      'plain ASCII is left alone',
      encodeHeader('Handover 3') === 'Handover 3',
    );
    // The real one: "[Handover] Night — Sara → next · Wed 26 Aug". A raw
    // non-ASCII header is not legal mail and arrives as mojibake.
    const real = '[Handover] Night — Sara → next · Wed 26 Aug';
    const encoded = encodeHeader(real);
    ok('an em dash forces encoding', encoded.startsWith('=?UTF-8?B?'), encoded);
    ok(
      'and round-trips exactly',
      Buffer.from(
        encoded.replace(/^=\?UTF-8\?B\?|\?=$/g, ''),
        'base64',
      ).toString('utf8') === real,
    );
  }

  section('the message body');
  {
    // The handover HTML is generated as a few very long lines. Mail lines may
    // not exceed 998 characters; sent raw, the table is silently mangled on the
    // way and looks perfect in every local preview.
    const html = `<table>${'<td style="padding:8px">cell</td>'.repeat(200)}</table>`;
    ok('the sample is long enough to matter', html.length > 998);

    const msg = mimeMessage({
      from: 'OpsOS <ops@co.com>',
      to: ['a@co.com', 'b@co.com'],
      subject: '[Handover] Night — 3',
      html,
    });
    const [headers, body] = msg.split('\r\n\r\n');

    ok('headers use CRLF', msg.includes('\r\n'));
    ok(
      'several recipients are comma-separated',
      headers.includes('To: a@co.com, b@co.com'),
    );
    ok('the charset is declared', headers.includes('charset="UTF-8"'));
    ok(
      'the body is declared base64',
      headers.includes('Content-Transfer-Encoding: base64'),
    );
    ok(
      'the subject is encoded in the header',
      /Subject: =\?UTF-8\?B\?/.test(headers),
    );

    const longest = Math.max(...msg.split('\r\n').map((l) => l.length));
    ok('no line exceeds the 998-character limit', longest <= 998, longest);
    ok(
      'the body decodes back to the original HTML',
      Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8') ===
        html,
    );
  }

  section('non-ASCII in the body survives');
  {
    const html = '<p>Refunds — €1,240 · Ahmad’s note</p>';
    const msg = mimeMessage({
      from: 'ops@co.com',
      to: ['a@co.com'],
      subject: 'x',
      html,
    });
    const body = msg.split('\r\n\r\n')[1];
    ok(
      'multi-byte characters come back intact',
      Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8') ===
        html,
    );
  }

  return failures;
}

const n = run();
console.log(n ? `\n${n} check(s) failed.` : '\nAll Gmail checks passed.');
process.exit(n ? 1 : 0);
