// Who Google sign-in lets in, and who it refuses — pinned.
//
// This is the whole security boundary of signing in with a company Google
// account. The ID token is not signature-verified (it comes straight from
// Google's token endpoint over TLS, with nobody in between to forge it), so
// every control that matters lives in checkGoogleClaims. Forgery is not the
// threat model; a REAL Google token belonging to somebody else's application or
// somebody else's company is.
//
// Each case below is a token Google really would issue.
//
//   npx tsx scripts/check-google-claims.ts

import {
  checkGoogleClaims,
  decodeIdToken,
  type GoogleClaims,
} from '../src/auth/google.service';

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

const CLIENT_ID = '1234567890-abc.apps.googleusercontent.com';
const NOW = 1_800_000_000;

/** A token for a real member of staff, in good standing. */
const good = (over: Partial<GoogleClaims> = {}): GoogleClaims => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub: '110000000000000000001',
  exp: NOW + 3600,
  email: 'ops@tradin.com',
  email_verified: true,
  hd: 'tradin.com',
  name: 'Ops Desk',
  ...over,
});

/** Runs the check and reports whether it refused, and with what. */
function refusal(
  claims: GoogleClaims,
  cfg: { domains?: string[]; clientId?: string } = {},
): { refused: boolean; message: string } {
  // Spread rather than a default parameter: `clientId: undefined` IS the case
  // under test (an unconfigured deployment), and a default would quietly
  // replace it with the configured one and pass a check that never ran.
  const clientId = 'clientId' in cfg ? cfg.clientId : CLIENT_ID;
  const domains = cfg.domains ?? ['tradin.com'];
  try {
    checkGoogleClaims(claims, { clientId, domains, now: NOW });
    return { refused: false, message: '' };
  } catch (e) {
    const body = (e as { getResponse?: () => unknown }).getResponse?.();
    const message =
      (body as { message?: string })?.message ?? (e as Error).message;
    return { refused: true, message: String(message) };
  }
}

section('the ordinary case');
{
  ok('a verified tradin.com account is let in', !refusal(good()).refused);
  ok(
    'the bare issuer form Google also uses is accepted',
    !refusal(good({ iss: 'accounts.google.com' })).refused,
  );
  ok(
    'a second allowed domain works',
    !refusal(good({ email: 'a@global.tradin.com', hd: 'global.tradin.com' }), {
      domains: ['tradin.com', 'global.tradin.com'],
    }).refused,
  );
  ok(
    'domains are compared case-insensitively',
    !refusal(good({ email: 'Ops@Tradin.COM', hd: 'Tradin.com' })).refused,
  );
}

section('a genuine token for the wrong application');
{
  // The one that matters most. Anyone can stand up a Google app, sign in to it,
  // and hold a real, correctly-signed, unexpired Google token. Without the aud
  // check that token opens this dashboard.
  const r = refusal(
    good({ aud: 'someone-elses-app.apps.googleusercontent.com' }),
  );
  ok('is refused', r.refused);
  ok('and says so', /another application/i.test(r.message), r.message);
}

section('a personal account');
{
  // A gmail.com account has no hd claim at all. That absence is the refusal.
  const r = refusal(good({ email: 'someone@gmail.com', hd: undefined }));
  ok('is refused', r.refused);
  ok('and names the company', /tradin\.com/.test(r.message), r.message);
}

section('a Workspace account at the wrong company');
{
  const r = refusal(good({ email: 'x@othercorp.com', hd: 'othercorp.com' }));
  ok('is refused', r.refused);
}

section('an address whose domain the Workspace does not own');
{
  // Both halves are checked. A Workspace can carry addresses at a domain it
  // does not own, so hd alone is not enough — and neither is the address.
  ok(
    'right hd, wrong address is refused',
    refusal(good({ email: 'x@othercorp.com', hd: 'tradin.com' })).refused,
  );
  ok(
    'right address, wrong hd is refused',
    refusal(good({ email: 'ops@tradin.com', hd: 'othercorp.com' })).refused,
  );
}

section('half-configured deployments refuse everybody');
{
  // The failure mode to avoid: an empty allow-list reading as "no restriction".
  const r = refusal(good(), { domains: [] });
  ok('no allowed domains refuses even a good token', r.refused);
  ok(
    'and says which setting is missing',
    /GOOGLE_ALLOWED_DOMAINS/.test(r.message),
    r.message,
  );
  ok(
    'no client id refuses too',
    refusal(good(), { clientId: undefined }).refused,
  );
  ok(
    'an empty client id cannot match an absent aud',
    refusal(good({ aud: undefined }), { clientId: '' }).refused,
  );
}

section('the rest of the claims');
{
  ok('an expired token is refused', refusal(good({ exp: NOW - 1 })).refused);
  ok(
    'a token with no exp is refused',
    refusal(good({ exp: undefined })).refused,
  );
  ok(
    'an unexpected issuer is refused',
    refusal(good({ iss: 'https://accounts.example.com' })).refused,
  );
  ok(
    'an unverified address is refused',
    refusal(good({ email_verified: false })).refused,
  );
  ok(
    'a missing address is refused',
    refusal(good({ email: undefined })).refused,
  );
  // Google omits email_verified on some tokens rather than sending false; only
  // an explicit false is a refusal, or nobody could sign in at all.
  ok(
    'an absent email_verified is not treated as false',
    !refusal(good({ email_verified: undefined })).refused,
  );
}

section('reading the token');
{
  const claims = { sub: 'x', email: 'ops@tradin.com', hd: 'tradin.com' };
  const b64url = (o: unknown) =>
    Buffer.from(JSON.stringify(o))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  const token = `${b64url({ alg: 'RS256' })}.${b64url(claims)}.signature`;
  ok(
    'claims are read out of the payload',
    decodeIdToken(token).email === 'ops@tradin.com',
  );
  // base64url, not base64: a real token's payload routinely contains bytes that
  // differ between the two alphabets, and getting this wrong fails only
  // sometimes — the worst kind of sometimes.
  const withSlash = { ...claims, name: 'ÿÿÿ?>?>' };
  ok(
    'base64url payloads decode',
    decodeIdToken(`h.${b64url(withSlash)}.s`).name === 'ÿÿÿ?>?>',
  );
  let threw = false;
  try {
    decodeIdToken('not-a-token');
  } catch {
    threw = true;
  }
  ok('a malformed token is refused, not guessed at', threw);
}

console.log(
  failures
    ? `\n${failures} check(s) failed.`
    : '\nAll Google sign-in checks passed.',
);
process.exit(failures ? 1 : 0);
