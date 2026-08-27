/**
 * Sending mail through the company's own Gmail.
 *
 * The handover goes out from ops@yourcompany.com because that is the address
 * the desk already recognises — not from a transactional-mail vendor's domain,
 * which lands in spam on a first send and looks like phishing when it doesn't.
 * The sent copy also lands in the Gmail account's Sent folder, so there is a
 * record where people already look for one.
 *
 * TWO WAYS IN, because which one is available depends on whether you administer
 * the Workspace:
 *
 *   • A REFRESH TOKEN for one mailbox. The owner of that mailbox grants consent
 *     once (scripts/gmail-authorize.mjs walks it), and nothing else is needed.
 *     No administrator, no domain-wide delegation. This is the one most people
 *     can actually do, so it is tried first.
 *
 *   • A SERVICE ACCOUNT with domain-wide delegation, impersonating a mailbox.
 *     Nothing to re-consent and no per-mailbox setup, but it takes a Workspace
 *     super-admin to authorise the client ID, and it hands that key the ability
 *     to send as anybody in the domain.
 *
 * Everything here is plain HTTPS and node:crypto. The googleapis package is
 * ~50MB of generated clients for the sake of one POST, and this runs in a
 * serverless function where the bundle is the cold start.
 */

import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const SCOPE = 'https://www.googleapis.com/auth/gmail.send';

export type GmailMode = 'refresh-token' | 'service-account' | null;

/** Which of the two is set up, if either. */
export function gmailMode(): GmailMode {
  if (
    process.env.GMAIL_REFRESH_TOKEN &&
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET
  ) {
    return 'refresh-token';
  }
  if (serviceAccount() && process.env.GMAIL_SENDER) return 'service-account';
  return null;
}

/**
 * The address the mail is from.
 *
 * Gmail will only accept a From that the authenticated mailbox owns or has as a
 * verified alias; anything else is rejected outright rather than rewritten, so
 * MAIL_FROM has to agree with GMAIL_SENDER. The display name is free.
 */
export function gmailFrom(): string {
  const sender = process.env.GMAIL_SENDER ?? '';
  const configured = process.env.MAIL_FROM ?? '';
  if (!configured) return sender;
  // MAIL_FROM may be "Name <addr>" or a bare address. If its address half
  // disagrees with the mailbox we are authenticated as, the mailbox wins —
  // the alternative is Gmail refusing every send with a message about the
  // From header that reads like a bug in the dashboard.
  const addr = configured.replace(/^[^<]*<|>\s*$/g, '').trim();
  if (!sender || addr.toLowerCase() === sender.toLowerCase()) return configured;
  const name = configured.includes('<')
    ? configured.slice(0, configured.indexOf('<')).trim()
    : '';
  return name ? `${name} <${sender}>` : sender;
}

type ServiceAccount = { client_email: string; private_key: string };

/**
 * The service-account key, from either shape it tends to arrive in.
 *
 * A private key has newlines in it, which most environment-variable editors
 * cannot hold — so a pasted key arrives with literal backslash-n. Both are
 * accepted, because the failure otherwise is an opaque "error:0909006C" from
 * OpenSSL that says nothing about what to fix.
 */
function serviceAccount(): ServiceAccount | null {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (json) {
    try {
      const parsed = JSON.parse(json) as Partial<ServiceAccount>;
      if (parsed.client_email && parsed.private_key) {
        return {
          client_email: parsed.client_email,
          private_key: parsed.private_key.replace(/\\n/g, '\n'),
        };
      }
    } catch {
      return null;
    }
  }
  const email = process.env.GMAIL_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GMAIL_PRIVATE_KEY;
  if (email && key) {
    return { client_email: email, private_key: key.replace(/\\n/g, '\n') };
  }
  return null;
}

const b64url = (b: Buffer | string) =>
  (Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/**
 * A cached access token.
 *
 * Serverless instances are reused between requests, so this saves a round trip
 * on most sends. Expired a minute early, because a token that expires while in
 * flight fails the send rather than being retried.
 */
let cached: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const mode = gmailMode();
  const body =
    mode === 'refresh-token'
      ? new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: process.env.GMAIL_REFRESH_TOKEN as string,
          client_id: process.env.GOOGLE_CLIENT_ID as string,
          client_secret: process.env.GOOGLE_CLIENT_SECRET as string,
        })
      : new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: signedAssertion(),
        });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text();
    // The two that actually happen, named, because Google's own wording for
    // both is "invalid_grant" and that sends people to the wrong place.
    const hint =
      mode === 'refresh-token'
        ? ' The refresh token may have been revoked, or the Google client it was issued for changed — re-run scripts/gmail-authorize.mjs.'
        : " Check that the service account's client ID is authorised for the gmail.send scope in Workspace admin, and that GMAIL_SENDER is a real mailbox in the domain.";
    throw new Error(
      `Google refused the token request: HTTP ${res.status} ${text.slice(0, 200)}.${hint}`,
    );
  }

  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) throw new Error('Google returned no access token.');
  cached = {
    token: json.access_token,
    expiresAt: Date.now() + ((json.expires_in ?? 3600) - 60) * 1000,
  };
  return cached.token;
}

/** The signed JWT that stands in for a password on the service-account path. */
function signedAssertion(): string {
  const sa = serviceAccount();
  if (!sa) throw new Error('No service account configured.');
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      // Domain-wide delegation: the mailbox to act as. Without this the token
      // belongs to the service account itself, which has no Gmail mailbox, and
      // the send fails with a 400 that says nothing about delegation.
      sub: process.env.GMAIL_SENDER,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(sa.private_key);
  return `${header}.${claims}.${b64url(signature)}`;
}

/**
 * A subject line that survives the trip.
 *
 * The handover subject contains an em dash and a middle dot. A raw non-ASCII
 * header is not legal mail and arrives as mojibake in most clients, so it is
 * encoded per RFC 2047 — but only when it needs to be, since an encoded ASCII
 * subject is harder to read in a log for no gain.
 */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/**
 * The message itself, as RFC 2822 text.
 *
 * The body is base64 with Content-Transfer-Encoding: base64, not raw HTML.
 * Mail lines may not exceed 998 characters, and the handover's HTML is
 * generated as a handful of very long lines — sent raw it is silently mangled
 * by whatever normalises it on the way, and the table falls apart in the
 * received copy while looking perfect in every local preview.
 */
function mimeMessage(mail: {
  from: string;
  to: string[];
  subject: string;
  html: string;
}): string {
  const body = Buffer.from(mail.html, 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');
  return [
    `From: ${mail.from}`,
    `To: ${mail.to.join(', ')}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

/** Sends, or says why it could not. */
export async function sendViaGmail(mail: {
  to: string[];
  subject: string;
  html: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const token = await accessToken();
    const raw = b64url(
      Buffer.from(mimeMessage({ ...mail, from: gmailFrom() }), 'utf8'),
    );
    const res = await fetch(SEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text();
      // A token can be revoked between two sends, and the cached one would then
      // fail every send until the instance recycled.
      if (res.status === 401) cached = null;
      return {
        ok: false,
        reason: `Gmail refused it: HTTP ${res.status} ${text.slice(0, 200)}`,
      };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Exposed for the check script; not part of the sending path. */
export const __internals = { mimeMessage, encodeHeader, gmailFrom, b64url };
