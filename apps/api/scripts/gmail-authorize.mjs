// One-time: let the dashboard send from a company Gmail mailbox.
//
// Run this once, on any machine, signed in as the mailbox the handover should
// come FROM (ops@yourcompany.com, or whatever you use). It prints a
// GMAIL_REFRESH_TOKEN to paste into the API's environment. Nothing else is
// needed — no Workspace administrator, no domain-wide delegation.
//
//   node scripts/gmail-authorize.mjs
//
// It reuses GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET — the same OAuth client
// as sign-in — so there is one thing registered with Google rather than two.
// You must add http://localhost:8910/callback to that client's authorised
// redirect URIs first; it can be removed again afterwards.
//
// The refresh token is a long-lived credential for sending mail as that
// mailbox. It goes in the API environment and nowhere else — not in the repo,
// not in a chat message.

import 'dotenv/config';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const PORT = 8910;
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPE = 'https://www.googleapis.com/auth/gmail.send';

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set (apps/api/.env).\n' +
      'They are the same values Google sign-in uses.',
  );
  process.exit(1);
}

const state = randomBytes(16).toString('hex');

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', clientId);
authUrl.searchParams.set('redirect_uri', REDIRECT);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPE);
authUrl.searchParams.set('state', state);
// offline + consent together, deliberately. Without access_type=offline there
// is no refresh token at all; without prompt=consent Google silently omits it
// on every grant after the first, so re-running this after a mistake returns a
// response that looks fine and is missing the only field that matters.
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');

console.log('\nOpen this in a browser, signed in as the SENDING mailbox:\n');
console.log(authUrl.toString());
console.log(`\nWaiting on ${REDIRECT} …\n`);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end('Not here.');
    return;
  }

  const finish = (status, message) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(message);
    setTimeout(() => server.close(), 100);
  };

  if (url.searchParams.get('state') !== state) {
    finish(400, 'That response did not come from the link this script printed.');
    console.error('\nState mismatch — start again.');
    process.exitCode = 1;
    return;
  }

  const error = url.searchParams.get('error');
  if (error) {
    finish(400, `Google reported: ${error}`);
    console.error(`\nGoogle reported: ${error}`);
    process.exitCode = 1;
    return;
  }

  const code = url.searchParams.get('code');
  if (!code) {
    finish(400, 'No code came back.');
    process.exitCode = 1;
    return;
  }

  void exchange(code, finish);
});

async function exchange(code, finish) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    finish(400, 'Google refused the exchange. See the terminal.');
    console.error(`\nGoogle refused the exchange: HTTP ${res.status}\n${body}`);
    if (body.includes('redirect_uri_mismatch')) {
      console.error(
        `\nAdd exactly this to the OAuth client's authorised redirect URIs:\n  ${REDIRECT}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  const tokens = await res.json();
  if (!tokens.refresh_token) {
    finish(400, 'No refresh token came back. See the terminal.');
    console.error(
      '\nGoogle returned an access token but no refresh token. That happens when\n' +
        'this mailbox has already granted this client before: revoke it at\n' +
        'https://myaccount.google.com/permissions and run this again.',
    );
    process.exitCode = 1;
    return;
  }

  // Confirm rather than assume. A token that cannot read its own profile will
  // not send mail either, and finding that out now is much cheaper than finding
  // it out when a shift closes.
  let mailbox = '(unknown)';
  try {
    const who = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      { headers: { authorization: `Bearer ${tokens.access_token}` } },
    );
    if (who.ok) mailbox = (await who.json()).emailAddress ?? mailbox;
  } catch {
    /* the refresh token is still the thing we came for */
  }

  finish(200, `Done. You can close this tab.\n\nMailbox: ${mailbox}`);

  console.log(`\nAuthorised as: ${mailbox}\n`);
  console.log('Put these in the API environment (Vercel → Settings → Environment Variables):\n');
  console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log(`GMAIL_SENDER=${mailbox}`);
  console.log(`MAIL_FROM=OpsOS <${mailbox}>`);
  console.log(
    '\nGOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are already there if sign-in works.',
  );
  console.log(
    '\nTreat the refresh token as a password: it sends mail as this mailbox until revoked.',
  );
}

server.listen(PORT);
