// The oauth2 auth mode: minting a token, re-using it, and saying so when it
// cannot be minted.
//
// This mode exists because BEEM does not accept a static key at all. It answers
// one with `WWW-Authenticate: Bearer error="invalid_token",
// error_description="Invalid JWT serialization: Missing dot delimiter(s)"` —
// which our own 401 advice read as "the scheme is Bearer" and turned into "set
// the auth mode to bearer", sending somebody to re-send the same rejected key
// under a different header name. Half of what is checked here is that the
// advice now says the true thing.
//
// The other half is the exchange, and it is checked against a stubbed fetch
// rather than a live provider for a reason that is not convenience: the things
// that go wrong are the SHAPE of the request (a provider that wants the
// credentials in the body and gets them in a header refuses, and vice versa)
// and the NUMBER of requests (one login per page of a sync is how a client gets
// locked out). Neither is visible in a response body, so neither can be
// asserted by calling the real thing.
//
//   npx tsx scripts/check-psp-oauth.ts

import {
  AUTH_MODES,
  callPsp,
  clearTokenCache,
  discoverTokenEndpoint,
  suggestAuthMode,
  type EndpointConfig,
} from '../src/psps/psp-connector';

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

/** What BEEM actually answered a static key with. */
const BEEM_401 =
  'Bearer error="invalid_token", error_description="Invalid JWT serialization: Missing dot delimiter(s)", error_uri="https://tools.ietf.org/html/rfc6750#section-3.1"';

const CONN = {
  id: 'conn-beem',
  baseUrl: 'https://api.core.paybeem.com',
  authMode: 'oauth2',
  authName: '/oauth/token',
};
const LEDGER: EndpointConfig = { path: '/api/v1/pay/summary' };
const CREDS = { key: 'client-id-uuid', secret: 'api-client-key' };

/** Every request the code under test made, in order. */
type Seen = {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  body: string | null;
};

/**
 * Runs `fn` with fetch replaced, and hands back what was requested.
 *
 * `reply` is asked for a response per request, so a stub can answer the token
 * endpoint one way and the ledger another — and can answer the SAME endpoint
 * differently the second time, which is what the expiry and revocation cases
 * need.
 */
async function recording(
  reply: (seen: Seen, n: number) => { status: number; body: unknown },
  fn: () => Promise<unknown>,
): Promise<{ seen: Seen[]; result: unknown }> {
  const seen: Seen[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const record: Seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      contentType: headers.get('content-type'),
      body:
        init?.body === undefined || init?.body === null
          ? null
          : String(init.body),
    };
    seen.push(record);
    const { status, body } = reply(record, seen.length);
    return new Response(
      typeof body === 'string' ? body : JSON.stringify(body),
      {
        status,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof fetch;
  try {
    const result = await fn();
    return { seen, result };
  } finally {
    globalThis.fetch = real;
  }
}

const isToken = (s: Seen) => s.url.includes('/oauth/token');

// Async, so wrapped: these scripts are transformed to CommonJS, where a
// top-level await is not available.
async function main() {
  section('the mode is offered at all');
  {
    ok('oauth2 is an auth mode', AUTH_MODES.includes('oauth2'));
  }

  section('reading what BEEM said');
  {
    const said = suggestAuthMode({ 'www-authenticate': BEEM_401 }, 'basic');
    // The old advice. Following it produces the identical 401, because the
    // problem was never which header the key travelled in.
    ok(
      'it no longer says "set the auth mode to bearer"',
      !/set the auth mode to .bearer/i.test(said ?? ''),
      said,
    );
    ok('it names oauth2 instead', /oauth2/.test(said ?? ''), said);
    ok(
      'it quotes the provider’s own reason',
      /Invalid JWT serialization/.test(said ?? ''),
      said,
    );
    // It used to go on to say "put the client id in the key box and the client
    // key in the secret box", which read as settled fact. It was not: BEEM's
    // documentation turned out to specify RSA request signing, and a gateway
    // that parses a JWT does not tell you which of the two schemes a client is
    // meant to use. So the message now offers both and names the document that
    // decides — see check-psp-signature.ts, which asserts that in full.
    ok(
      'it does not assert oauth2 as the answer',
      /signature/i.test(said ?? '') && /authentication/i.test(said ?? ''),
      said,
    );

    // A Bearer challenge with no JWT complaint is still just "send a token" —
    // this must not turn every 401 into an oauth2 recommendation.
    const plain = suggestAuthMode({ 'www-authenticate': 'Bearer realm="x"' });
    ok(
      'a plain Bearer challenge still suggests bearer',
      /bearer/i.test(plain ?? ''),
      plain,
    );
    ok('and does not mention oauth2', !/oauth2/.test(plain ?? ''), plain);

    // The dead end that wasted the most time: advice to switch to the mode that
    // is already selected.
    const already = suggestAuthMode(
      { 'www-authenticate': 'Bearer realm="x"' },
      'bearer',
    );
    ok(
      'it never advises the mode that just failed',
      /already/i.test(already ?? ''),
      already,
    );
    const asBasic = suggestAuthMode(
      { 'www-authenticate': 'Basic realm="api"' },
      'basic',
    );
    ok(
      'same for basic — it points at the credential, not the mode',
      /already/i.test(asBasic ?? ''),
      asBasic,
    );
  }

  section('minting a token');
  {
    clearTokenCache();
    const { seen, result } = await recording(
      (s) =>
        isToken(s)
          ? {
              status: 200,
              body: { access_token: 'jwt.aaa.bbb', expires_in: 3600 },
            }
          : { status: 200, body: [{ id: 'p1' }] },
      () => callPsp(CONN, LEDGER, CREDS),
    );

    ok('the call succeeded', (result as { ok: boolean }).ok, result);
    ok(
      'two requests were made',
      seen.length === 2,
      seen.map((s) => s.url),
    );

    const token = seen[0];
    ok('the token endpoint was called first', isToken(token), token.url);
    ok(
      'it was joined onto the base URL',
      token.url === 'https://api.core.paybeem.com/oauth/token',
      token.url,
    );
    ok('with POST', token.method === 'POST');
    ok('as a form', token.contentType === 'application/x-www-form-urlencoded');
    ok(
      'asking for client_credentials',
      token.body === 'grant_type=client_credentials',
      token.body,
    );
    // RFC 6749 says a server MUST support this one, so it is the one to try first.
    ok(
      'presenting the credentials as Basic',
      token.authorization ===
        `Basic ${Buffer.from('client-id-uuid:api-client-key').toString('base64')}`,
      token.authorization,
    );
    // The whole reason the exchange exists: the secret must not be in the body of
    // the first attempt, and must never be in the ledger request at all.
    ok(
      'the secret is not in the token body',
      !(token.body ?? '').includes('api-client-key'),
    );

    const ledger = seen[1];
    ok(
      'then the ledger',
      ledger.url.includes('/api/v1/pay/summary'),
      ledger.url,
    );
    ok('with GET', ledger.method === 'GET');
    ok(
      'bearing the minted token',
      ledger.authorization === 'Bearer jwt.aaa.bbb',
      ledger.authorization,
    );
    ok(
      'and not the client key',
      !(ledger.authorization ?? '').includes('api-client-key'),
    );
  }

  section('providers that want the credentials in the body');
  {
    clearTokenCache();
    const { seen, result } = await recording(
      (s) => {
        if (!isToken(s)) return { status: 200, body: [] };
        // The other half of the split: refuse Basic, accept the form fields.
        return s.authorization
          ? { status: 401, body: { error: 'invalid_client' } }
          : { status: 200, body: { access_token: 'jwt.x.y', expires_in: 600 } };
      },
      () => callPsp(CONN, LEDGER, CREDS),
    );

    ok('it fell back and succeeded', (result as { ok: boolean }).ok, result);
    ok(
      'after exactly two attempts at the token',
      seen.filter(isToken).length === 2,
    );
    const second = seen.filter(isToken)[1];
    ok(
      'the second carried client_id and client_secret',
      (second.body ?? '').includes('client_id=client-id-uuid') &&
        (second.body ?? '').includes('client_secret=api-client-key'),
      second.body,
    );
    ok('and no Basic header', second.authorization === null);
  }

  section('a token endpoint that is simply wrong');
  {
    clearTokenCache();
    // A 404 says nothing about how the credentials should be presented, so trying
    // the other way is a second bad request for no information.
    const { seen, result } = await recording(
      () => ({ status: 404, body: { error: 'Not Found' } }),
      () => callPsp(CONN, LEDGER, CREDS),
    );
    ok('it gave up after one attempt', seen.length === 1, seen.length);
    const r = result as { ok: boolean; error: string; status: number | null };
    ok('it failed', !r.ok);
    ok('naming the token endpoint', /token endpoint/i.test(r.error), r.error);
    ok('and the status', r.status === 404, r.status);
    // The provider's own sentence, not our guess at what a 404 means.
    ok('and what the provider said', /Not Found/.test(r.error), r.error);
  }

  section('re-use, which is the difference between a sync and a lockout');
  {
    clearTokenCache();
    const { seen } = await recording(
      (s) =>
        isToken(s)
          ? {
              status: 200,
              body: { access_token: 'jwt.reused', expires_in: 3600 },
            }
          : { status: 200, body: [] },
      async () => {
        // A sync is dozens of these. One login for the run, not one per page.
        for (let i = 0; i < 5; i++) await callPsp(CONN, LEDGER, CREDS);
      },
    );
    ok(
      'one token for five pages',
      seen.filter(isToken).length === 1,
      seen.filter(isToken).length,
    );
    ok(
      'all five pages were fetched',
      seen.filter((s) => !isToken(s)).length === 5,
    );
  }

  section('a rotated secret does not wait for the old token to expire');
  {
    clearTokenCache();
    const { seen } = await recording(
      (s) =>
        isToken(s)
          ? { status: 200, body: { access_token: 'jwt.a', expires_in: 3600 } }
          : { status: 200, body: [] },
      async () => {
        await callPsp(CONN, LEDGER, CREDS);
        // What happens the moment somebody pastes a replacement key. The old
        // token is still valid for an hour; using it would make the new
        // credential look like it had not taken effect.
        await callPsp(CONN, LEDGER, { key: CREDS.key, secret: 'rotated-key' });
      },
    );
    ok('the new secret minted a new token', seen.filter(isToken).length === 2);
  }

  section('a token revoked mid-sync');
  {
    clearTokenCache();
    let minted = 0;
    const { seen, result } = await recording(
      (s) => {
        if (isToken(s)) {
          minted++;
          return {
            status: 200,
            body: { access_token: `jwt.${minted}`, expires_in: 3600 },
          };
        }
        // The first token is refused — revoked, rotated their side, or simply
        // shorter-lived than it claimed. The second must be tried.
        return s.authorization === 'Bearer jwt.1'
          ? { status: 401, body: { error: 'invalid_token' } }
          : { status: 200, body: [{ id: 'p1' }] };
      },
      () => callPsp(CONN, LEDGER, CREDS),
    );

    ok('the call recovered', (result as { ok: boolean }).ok, result);
    ok('by minting once more', minted === 2, minted);
    ok(
      'and re-requesting the page',
      seen.filter((s) => !isToken(s)).length === 2,
    );
  }

  section('a 401 that a fresh token will not fix');
  {
    clearTokenCache();
    let n = 0;
    const { seen, result } = await recording(
      (s) => {
        if (isToken(s))
          return {
            status: 200,
            body: { access_token: `jwt.${++n}`, expires_in: 3600 },
          };
        return { status: 401, body: { error: 'invalid_token' } };
      },
      () => callPsp(CONN, LEDGER, CREDS),
    );
    // One retry, not a loop. A key that is simply not entitled to this endpoint
    // would otherwise mint tokens until something gave out.
    ok('it retried exactly once', seen.filter((s) => !isToken(s)).length === 2);
    ok('then reported the 401', !(result as { ok: boolean }).ok);
  }

  section('what it refuses to do');
  {
    clearTokenCache();
    const { seen, result } = await recording(
      () => ({ status: 200, body: {} }),
      () => callPsp({ ...CONN, authName: '' }, LEDGER, CREDS),
    );
    const r = result as { ok: boolean; error: string };
    ok('no token endpoint means no request at all', seen.length === 0);
    ok(
      'and an error that says what to do',
      /token endpoint/i.test(r.error),
      r.error,
    );

    const insecure = await recording(
      () => ({ status: 200, body: {} }),
      () =>
        callPsp(
          { ...CONN, authName: 'http://auth.example.com/token' },
          LEDGER,
          CREDS,
        ),
    );
    // Stricter than the base URL check has to be: every other call carries the
    // key, this one carries the key AND the secret, in a request body.
    ok('an http token endpoint is refused', insecure.seen.length === 0);
    ok(
      'because the secret would be in the clear',
      /https/.test((insecure.result as { error: string }).error),
      insecure.result,
    );

    // An authorisation server on another host is normal, and must work.
    clearTokenCache();
    const elsewhere = await recording(
      (s) =>
        s.url.includes('login.example.com')
          ? { status: 200, body: { access_token: 'jwt.other', expires_in: 60 } }
          : { status: 200, body: [] },
      () =>
        callPsp(
          { ...CONN, authName: 'https://login.example.com/oauth2/token' },
          LEDGER,
          CREDS,
        ),
    );
    ok(
      'an absolute token URL is used as given',
      (elsewhere.result as { ok: boolean }).ok,
    );
    ok(
      'on its own host',
      elsewhere.seen[0].url === 'https://login.example.com/oauth2/token',
      elsewhere.seen[0].url,
    );
  }

  section('a token endpoint that answers 200 with nothing usable');
  {
    clearTokenCache();
    const { seen, result } = await recording(
      (s) =>
        isToken(s)
          ? { status: 200, body: { token: 'wrong-field' } }
          : { status: 200, body: [] },
      () => callPsp(CONN, LEDGER, CREDS),
    );
    const r = result as { ok: boolean; error: string };
    // Without this the ledger is called with `Bearer undefined`, and the 401 that
    // comes back sends somebody to check a credential that was fine.
    ok(
      'the ledger is not called with no token',
      seen.filter((s) => !isToken(s)).length === 0,
    );
    ok('and the reply is the finding', /access_token/.test(r.error), r.error);
  }

  section('an HTML login page instead of a token');
  {
    clearTokenCache();
    const { result } = await recording(
      () => ({ status: 200, body: '<!doctype html><title>Sign in</title>' }),
      () => callPsp(CONN, LEDGER, CREDS),
    );
    ok('it does not crash on non-JSON', !(result as { ok: boolean }).ok);
    ok(
      'and keeps the body for the Test panel',
      typeof (result as { body?: unknown }).body === 'string',
      (result as { body?: unknown }).body,
    );
  }

  section('asking a provider where it mints tokens');
  {
    // The one field of an oauth2 connection that cannot be guessed, and the
    // standardised way to stop guessing: RFC 8414 / OIDC discovery.
    const { seen, result } = await recording(
      (s) =>
        s.url.endsWith('/.well-known/openid-configuration')
          ? {
              status: 200,
              body: {
                issuer: 'https://api.core.paybeem.com',
                token_endpoint: 'https://api.core.paybeem.com/oauth2/token',
                grant_types_supported: ['client_credentials', 'refresh_token'],
              },
            }
          : { status: 404, body: { error: 'Not Found' } },
      () => discoverTokenEndpoint('https://api.core.paybeem.com'),
    );

    const r = result as {
      ok: boolean;
      found?: { tokenEndpoint: string; from: string; grants?: string[] }[];
    };
    ok('it found one', r.ok && r.found?.length === 1, result);
    ok(
      'and it is the token endpoint the document named',
      r.found?.[0].tokenEndpoint ===
        'https://api.core.paybeem.com/oauth2/token',
      r.found,
    );
    ok(
      'reporting where it was published, so a person can judge it',
      (r.found?.[0].from ?? '').endsWith('/.well-known/openid-configuration'),
      r.found,
    );
    ok(
      'and which grants it says it supports',
      r.found?.[0].grants?.includes('client_credentials') === true,
      r.found,
    );
    // No credential goes anywhere near this.
    ok(
      'every request was a GET',
      seen.every((s) => s.method === 'GET'),
    );
    ok(
      'and carried no authorization header',
      seen.every((s) => s.authorization === null),
    );
  }

  section('a provider that publishes nothing');
  {
    const { result } = await recording(
      () => ({ status: 404, body: { error: 'Not Found' } }),
      () => discoverTokenEndpoint('https://api.core.paybeem.com'),
    );
    const r = result as { ok: boolean; found?: unknown[] };
    // Not an error — most providers do not publish metadata, and the screen has
    // to tell somebody to go and ask rather than showing them a failure.
    ok('is not a failure', r.ok === true, result);
    ok('it just found nothing', r.found?.length === 0, result);
  }

  section('what discovery will not accept');
  {
    // A token endpoint is where a client SECRET gets posted. An http one, or a
    // relative one, is not something to offer somebody as an answer.
    const insecure = await recording(
      (s) =>
        s.url.includes('.well-known')
          ? {
              status: 200,
              body: { token_endpoint: 'http://auth.example.com/t' },
            }
          : { status: 404, body: {} },
      () => discoverTokenEndpoint('https://api.core.paybeem.com'),
    );
    ok(
      'an http token endpoint is not offered',
      (insecure.result as { found?: unknown[] }).found?.length === 0,
      insecure.result,
    );

    const relative = await recording(
      (s) =>
        s.url.includes('.well-known')
          ? { status: 200, body: { token_endpoint: '/oauth/token' } }
          : { status: 404, body: {} },
      () => discoverTokenEndpoint('https://api.core.paybeem.com'),
    );
    ok(
      'nor a relative one',
      (relative.result as { found?: unknown[] }).found?.length === 0,
      relative.result,
    );

    const junk = await recording(
      () => ({ status: 200, body: '<!doctype html><title>Hi</title>' }),
      () => discoverTokenEndpoint('https://api.core.paybeem.com'),
    );
    ok(
      'and a web page is not metadata',
      (junk.result as { found?: unknown[] }).found?.length === 0,
      junk.result,
    );

    const http = await discoverTokenEndpoint('http://api.core.paybeem.com');
    ok(
      'an http base URL is refused outright',
      !(http as { ok: boolean }).ok,
      http,
    );
  }

  section('the same endpoint via two well-known paths');
  {
    const { result } = await recording(
      () => ({
        status: 200,
        body: { token_endpoint: 'https://api.core.paybeem.com/oauth2/token' },
      }),
      () => discoverTokenEndpoint('https://api.core.paybeem.com/api'),
    );
    // Both spellings and both placements are asked, and for most providers
    // several answer. One endpoint is one finding, not four.
    ok(
      'is reported once',
      (result as { found?: unknown[] }).found?.length === 1,
      result,
    );
  }

  section('the other modes are untouched');
  {
    clearTokenCache();
    const { seen } = await recording(
      () => ({ status: 200, body: [] }),
      () =>
        callPsp(
          { ...CONN, authMode: 'basic', authName: '/oauth/token' },
          LEDGER,
          CREDS,
        ),
    );
    // A stale token path left in the box from an earlier attempt must not cause a
    // login on a mode that does not use one.
    ok('basic makes one request', seen.length === 1);
    ok(
      'straight to the ledger',
      seen[0].url.includes('/api/v1/pay/summary'),
      seen[0].url,
    );
    ok(
      'with a Basic header',
      (seen[0].authorization ?? '').startsWith('Basic '),
      seen[0].authorization,
    );
  }

  console.log(
    failures ? `\n${failures} check(s) failed.` : '\nAll oauth2 checks passed.',
  );
  process.exit(failures ? 1 : 0);
}

void main();
