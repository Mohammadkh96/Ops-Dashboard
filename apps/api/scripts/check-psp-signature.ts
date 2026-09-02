// The `signature` auth mode: RFC 9421 request signing, as BEEM specifies it.
//
// This is checked differently from every other mode, because the failure it can
// have is different. A wrong header name gives a 401 that says "wrong key". A
// signature base that differs from the provider's by one byte gives the SAME
// 401. There is nothing in the response to read and nothing on screen to
// compare, so being close is worth nothing here — it either matches byte for
// byte or the connection never works, and no amount of live testing will say
// which byte.
//
// So two things are done that no other check does.
//
// BEEM's own reference signer is transcribed below, from the Node.js tab of
// their Authentication page, and our headers are asserted BYTE-IDENTICAL to
// what it produces for the same key, clientId, URL and second. Their signer is
// the definition; anything else is an opinion about it.
//
// And the signature is VERIFIED with the public key, the way BEEM will verify
// it — because a signature that is merely present and well-formed is exactly
// what a broken implementation produces.
//
//   npx tsx scripts/check-psp-signature.ts

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
} from 'node:crypto';
import { createServer } from 'node:http';

import {
  AUTH_MODES,
  callPsp,
  normalisePrivateKey,
  signatureBase,
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

/**
 * BEEM's reference signer, transcribed from their Authentication page.
 *
 * Deliberately NOT tidied, refactored or shared with the code under test. Its
 * whole value is being an independent statement of the same thing: if both are
 * written from one understanding, they agree about a mistake as readily as
 * about the truth.
 *
 * `created` is a parameter here where theirs reads the clock, which is the only
 * change — two implementations cannot be compared if each picks its own
 * timestamp.
 */
class BeemSigner {
  static SIGNATURE_ALGORITHM = 'rsa-v1_5-sha256';
  static DIGEST_ALGORITHM = 'sha-256';

  private readonly privateKey: ReturnType<typeof createPrivateKey>;

  constructor(
    rawKey: string,
    private readonly clientId: string,
  ) {
    let pem = rawKey;
    if (!pem.includes('-----BEGIN PRIVATE KEY-----')) {
      const clean = pem.replace(/\s+/g, '');
      const chunks = clean.match(/.{1,64}/g)!.join('\n');
      pem = `-----BEGIN PRIVATE KEY-----\n${chunks}\n-----END PRIVATE KEY-----\n`;
    }
    this.privateKey = createPrivateKey({ key: pem, format: 'pem' });
  }

  buildHeaders(
    url: string,
    payload: string | null,
    method: string,
    created: number,
  ): Record<string, string> {
    const headers: Record<string, string> = {};
    let contentDigest: string | null = null;
    if (payload) {
      contentDigest = this.createDigest(BeemSigner.DIGEST_ALGORITHM, payload);
      headers['Content-Digest'] = contentDigest;
    }
    const dateHeader = new Date(created * 1000).toUTCString();
    headers['Date'] = dateHeader;

    const signatureParameters = this.createSignatureParameters(
      contentDigest,
      created,
    );
    headers['Signature-Input'] = `sig=${signatureParameters}`;

    const parts = [
      `"@method": ${method.toUpperCase()}`,
      `"@target-uri": ${url}`,
    ];
    if (contentDigest !== null) {
      parts.push(`"content-digest": ${contentDigest}`);
    }
    parts.push(`"date": ${dateHeader}`);
    parts.push(`"@signature-params": ${signatureParameters}`);

    const base = parts.join('\n');
    headers['Signature'] = `sig=:${this.sign(base)}:`;
    return headers;
  }

  signatureBaseFor(url: string, method: string, created: number): string {
    const p = this.createSignatureParameters(null, created);
    return [
      `"@method": ${method.toUpperCase()}`,
      `"@target-uri": ${url}`,
      `"date": ${new Date(created * 1000).toUTCString()}`,
      `"@signature-params": ${p}`,
    ].join('\n');
  }

  private createSignatureParameters(
    contentDigest: string | null,
    createdTimestamp: number,
  ): string {
    let components = '("@method" "@target-uri"';
    if (contentDigest !== null) components += ' "content-digest"';
    components += ' "date"';
    return `${components});created=${createdTimestamp};keyid="${this.clientId}";alg="${BeemSigner.SIGNATURE_ALGORITHM}"`;
  }

  private sign(base: string): string {
    return createSign('RSA-SHA256')
      .update(base)
      .sign(this.privateKey, 'base64');
  }

  private createDigest(algorithm: string, data: string): string {
    return `${algorithm}=:${createHash('sha256').update(data).digest('base64')}:`;
  }
}

// A throwaway pair. Generated rather than committed: a private key in a
// repository is a private key in a repository, test or not.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const CLIENT_ID = '0193abc8-74c5-785f-ae34-11ab890b2681';

const CONN = {
  id: 'conn-beem',
  baseUrl: 'https://api.core.paybeem.com',
  authMode: 'signature',
  authName: '',
};
const CREDS = { key: CLIENT_ID, secret: privateKey };

type Seen = {
  url: string;
  method: string;
  headers: Record<string, string>;
};

async function recording(
  reply: (seen: Seen) => { status: number; body: unknown },
  fn: () => Promise<unknown>,
): Promise<{ seen: Seen[]; result: unknown }> {
  const seen: Seen[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const h: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      h[k] = v;
    });
    const record: Seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: h,
    };
    seen.push(record);
    const { status, body } = reply(record);
    return new Response(
      typeof body === 'string' ? body : JSON.stringify(body),
      { status, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    const result = await fn();
    return { seen, result };
  } finally {
    globalThis.fetch = real;
  }
}

async function main() {
  section('the mode exists');
  {
    ok('signature is an auth mode', AUTH_MODES.includes('signature'));
  }

  section('agreeing with BEEM’s own signer, byte for byte');
  {
    // Their signer and ours, same key, same clientId, same URL, same second.
    const url =
      'https://api.core.paybeem.com/api/v1/pay/summary?merchantId=abc&max=100&offset=0';
    const created = 1716792114;
    const theirs = new BeemSigner(privateKey, CLIENT_ID);

    ok(
      'the signature base matches theirs exactly',
      signatureBase(url, 'GET', CLIENT_ID, created) ===
        theirs.signatureBaseFor(url, 'GET', created),
      {
        ours: signatureBase(url, 'GET', CLIENT_ID, created),
        theirs: theirs.signatureBaseFor(url, 'GET', created),
      },
    );

    // And spelled out, so a change to either implementation has to be
    // deliberate rather than merely self-consistent.
    //
    // The date here is what created=1716792114 actually is. BEEM's published
    // example pairs that timestamp with "Tue, 27 May 2025 10:21:54 GMT", which
    // is a year and four hours away from it — their example was written by
    // hand, not produced by their signer. Both values come from one clock in
    // real code, so it does not matter there; it matters here, where copying
    // their example would have asserted a lie about our own output.
    const expected = [
      '"@method": GET',
      `"@target-uri": ${url}`,
      '"date": Mon, 27 May 2024 06:41:54 GMT',
      '"@signature-params": ("@method" "@target-uri" "date");created=1716792114;keyid="0193abc8-74c5-785f-ae34-11ab890b2681";alg="rsa-v1_5-sha256"',
    ].join('\n');
    ok(
      'and matches the documented shape literally',
      signatureBase(url, 'GET', CLIENT_ID, created) === expected,
      signatureBase(url, 'GET', CLIENT_ID, created),
    );

    // No content-digest, and three components not four: every call here is a
    // GET with no body. Signing a digest of nothing signs something the
    // provider is not verifying.
    ok(
      'no content-digest is signed',
      !signatureBase(url, 'GET', CLIENT_ID, created).includes('content-digest'),
    );
  }

  section('what actually goes on the wire');
  {
    const { seen, result } = await recording(
      () => ({ status: 200, body: [{ id: 'p1' }] }),
      () =>
        callPsp(
          CONN,
          {
            path: '/api/v1/pay/summary',
            query: { merchantId: 'abc' },
          } as EndpointConfig,
          CREDS,
        ),
    );

    ok('the call succeeded', (result as { ok: boolean }).ok, result);
    ok('one request', seen.length === 1);
    const h = seen[0].headers;

    ok('a Date header is set', !!h.date, h);
    ok('a Signature-Input header is set', !!h['signature-input'], h);
    ok('a Signature header is set', !!h.signature, h);
    ok(
      'the client id travels as keyid',
      (h['signature-input'] ?? '').includes(`keyid="${CLIENT_ID}"`),
      h['signature-input'],
    );
    ok(
      'the algorithm is named',
      (h['signature-input'] ?? '').includes('alg="rsa-v1_5-sha256"'),
      h['signature-input'],
    );
    ok(
      'the signature is wrapped as a byte sequence',
      /^sig=:[A-Za-z0-9+/]+=*:$/.test(h.signature ?? ''),
      h.signature,
    );

    // No Authorization header at all. There is no shared secret in this scheme,
    // and a stray bearer of the private key would be handing it over.
    ok('no authorization header', h.authorization === undefined, h);
    ok(
      'the private key is nowhere in the request',
      !JSON.stringify(seen[0]).includes(
        privateKey.replace(/\s+/g, '').slice(40, 120),
      ),
    );

    // THE check. Anything can produce a well-formed signature header; only a
    // correct one verifies.
    const sigInput = h['signature-input'].replace(/^sig=/, '');
    const created = Number(/created=(\d+)/.exec(sigInput)?.[1]);
    const base = signatureBase(seen[0].url, 'GET', CLIENT_ID, created);
    const raw = (h.signature ?? '').replace(/^sig=:/, '').replace(/:$/, '');
    ok(
      'and it verifies with the public key, as BEEM will verify it',
      createVerify('RSA-SHA256')
        .update(base)
        .verify(createPublicKey(publicKey), raw, 'base64'),
      { base, raw: raw.slice(0, 24) },
    );

    // And the whole header set, against theirs, byte for byte.
    //
    // Possible because rsa-v1_5-sha256 is deterministic: the same key over the
    // same base gives the same bytes every time, unlike a PSS or ECDSA
    // signature which is randomised. So "verifies" is not the strongest thing
    // available here — "identical to what their signer emits" is, and it is the
    // one that catches a difference their verifier would tolerate today and
    // reject after a change on their side.
    const theirs = new BeemSigner(privateKey, CLIENT_ID).buildHeaders(
      seen[0].url,
      null,
      'GET',
      created,
    );
    ok('the Date header is theirs', h.date === theirs['Date'], {
      ours: h.date,
      theirs: theirs['Date'],
    });
    ok(
      'the Signature-Input header is theirs',
      h['signature-input'] === theirs['Signature-Input'],
      { ours: h['signature-input'], theirs: theirs['Signature-Input'] },
    );
    ok('the Signature header is theirs', h.signature === theirs['Signature'], {
      ours: h.signature,
      theirs: theirs['Signature'],
    });
    ok(
      'and theirs carries no Content-Digest for a GET either',
      theirs['Content-Digest'] === undefined,
      theirs,
    );

    // The URL signed must be the URL sent, query string included — this is the
    // failure that a sync introduces and a single test never shows: page one
    // works, page two adds offset=50 and stops verifying.
    ok(
      'the signed target is the full URL with its query',
      base.includes(`"@target-uri": ${seen[0].url}`) &&
        seen[0].url.includes('merchantId=abc'),
      seen[0].url,
    );
  }

  section('paging, where the URL changes under the signature');
  {
    const { seen } = await recording(
      () => ({ status: 200, body: [] }),
      async () => {
        for (const offset of ['0', '100', '200']) {
          await callPsp(
            CONN,
            {
              path: '/api/v1/pay/summary',
              query: { merchantId: 'abc', max: '100', offset },
            } as EndpointConfig,
            CREDS,
          );
        }
      },
    );

    ok('three pages were fetched', seen.length === 3);
    for (const s of seen) {
      const sigInput = s.headers['signature-input'].replace(/^sig=/, '');
      const created = Number(/created=(\d+)/.exec(sigInput)?.[1]);
      const base = signatureBase(s.url, 'GET', CLIENT_ID, created);
      const raw = s.headers.signature.replace(/^sig=:/, '').replace(/:$/, '');
      ok(
        `page at offset ${new URL(s.url).searchParams.get('offset')} verifies`,
        createVerify('RSA-SHA256')
          .update(base)
          .verify(createPublicKey(publicKey), raw, 'base64'),
        s.url,
      );
    }
    // Same key, different requests: the signatures must differ, or something is
    // signing a constant.
    ok(
      'each page is signed separately',
      new Set(seen.map((s) => s.headers.signature)).size === 3,
    );
  }

  section('the Date header survives fetch');
  {
    // Not paranoia. `Date` is on the browser's forbidden-header list, and if the
    // HTTP client silently dropped it, every signature would verify locally and
    // fail at the provider — a signed component that never arrived. Checked
    // against a real socket because a stubbed fetch cannot answer it.
    const srv = createServer((req, res) => {
      res.end(
        JSON.stringify({
          date: req.headers.date ?? null,
          sigInput: req.headers['signature-input'] ?? null,
          sig: req.headers.signature ?? null,
        }),
      );
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      const got = await fetch(`http://127.0.0.1:${port}/x`, {
        headers: {
          date: 'Tue, 27 May 2025 10:21:54 GMT',
          'signature-input': 'sig=("@method" "@target-uri" "date");created=1',
          signature: 'sig=:AAAA:',
        },
      });
      const seen = (await got.json()) as Record<string, string | null>;
      ok(
        'Date arrives at the server',
        seen.date === 'Tue, 27 May 2025 10:21:54 GMT',
        seen,
      );
      ok('Signature-Input arrives', !!seen.sigInput, seen);
      ok('Signature arrives', !!seen.sig, seen);
    } finally {
      srv.close();
    }
  }

  section('the clock, which is half of replay protection');
  {
    const before = Math.floor(Date.now() / 1000);
    const { seen } = await recording(
      () => ({ status: 200, body: [] }),
      () => callPsp(CONN, { path: '/x' } as EndpointConfig, CREDS),
    );
    const after = Math.floor(Date.now() / 1000);
    const created = Number(
      /created=(\d+)/.exec(seen[0].headers['signature-input'])?.[1],
    );
    // BEEM rejects a Date more than a few minutes out. A stale or fabricated
    // timestamp here is a connection that fails intermittently and blames the key.
    ok('created is now', created >= before && created <= after, {
      created,
      before,
      after,
    });
    ok(
      'and the Date header is the same instant',
      seen[0].headers.date === new Date(created * 1000).toUTCString(),
      { date: seen[0].headers.date, created },
    );
  }

  section('a private key pasted into a single-line box');
  {
    // What the HTML spec does to a PEM pasted into a text input: the newlines
    // are stripped out. Rejecting that is rejecting the correct key.
    const flattened = privateKey.replace(/\n/g, '');
    ok(
      'newlines stripped is still readable',
      normalisePrivateKey(flattened) === privateKey,
      normalisePrivateKey(flattened)?.slice(0, 40),
    );
    ok(
      'as is the untouched PEM',
      normalisePrivateKey(privateKey) === privateKey,
    );
    ok(
      'and one with \\n written out',
      normalisePrivateKey(privateKey.replace(/\n/g, '\\n')) === privateKey,
    );
    ok(
      'and a bare base64 blob, assumed PKCS#8 as BEEM assumes',
      normalisePrivateKey(
        privateKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
      ) === privateKey,
    );

    // And it must still WORK after being rebuilt, not merely look right.
    const rebuilt = normalisePrivateKey(flattened)!;
    const { seen } = await recording(
      () => ({ status: 200, body: [] }),
      () =>
        callPsp(CONN, { path: '/x' } as EndpointConfig, {
          key: CLIENT_ID,
          secret: rebuilt,
        }),
    );
    const created = Number(
      /created=(\d+)/.exec(seen[0].headers['signature-input'])?.[1],
    );
    ok(
      'a rebuilt key produces a signature that verifies',
      createVerify('RSA-SHA256')
        .update(signatureBase(seen[0].url, 'GET', CLIENT_ID, created))
        .verify(
          createPublicKey(publicKey),
          seen[0].headers.signature.replace(/^sig=:/, '').replace(/:$/, ''),
          'base64',
        ),
    );
  }

  section('a PKCS#1 key keeps its own label');
  {
    // PKCS#1 and PKCS#8 are different encodings. Relabelling one as the other
    // produces a key that parses as nothing — so the label found is the label
    // written back.
    const pkcs1 = createPrivateKey(privateKey).export({
      type: 'pkcs1',
      format: 'pem',
    }) as string;
    const normalised = normalisePrivateKey(pkcs1.replace(/\n/g, ''));
    ok(
      'it is not relabelled as PKCS#8',
      (normalised ?? '').includes('BEGIN RSA PRIVATE KEY'),
      normalised?.slice(0, 40),
    );
    ok('and it still loads', normalised === pkcs1);
  }

  section('what it refuses, and says why');
  {
    const cases: [string, { key?: string; secret?: string }, RegExp][] = [
      ['no client id', { secret: privateKey }, /client id/i],
      ['no key at all', { key: CLIENT_ID }, /private key/i],
      [
        // The commonest mistake in this scheme by a distance: the two halves
        // look alike and only one of them goes here.
        'the PUBLIC half pasted by mistake',
        { key: CLIENT_ID, secret: publicKey },
        /private key/i,
      ],
      [
        'something that is not a key',
        { key: CLIENT_ID, secret: 'hunter2' },
        /private key/i,
      ],
      [
        'a client id with a line break in it',
        { key: `${CLIENT_ID}\nx-injected: 1`, secret: privateKey },
        /line break|quote/i,
      ],
    ];

    for (const [name, creds, expect] of cases) {
      const { seen, result } = await recording(
        () => ({ status: 200, body: [] }),
        () => callPsp(CONN, { path: '/x' } as EndpointConfig, creds),
      );
      const r = result as { ok: boolean; error: string };
      ok(`${name}: no request is made`, seen.length === 0, seen);
      ok(`${name}: and the error says why`, !r.ok && expect.test(r.error), r);
    }

    // An encrypted key needs a passphrase and there is nowhere to put one.
    ok(
      'an encrypted key is rejected rather than half-tried',
      normalisePrivateKey(
        '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIE\n-----END ENCRYPTED PRIVATE KEY-----',
      ) === null,
    );
    ok('and empty is empty', normalisePrivateKey('') === null);
    ok('and whitespace is empty', normalisePrivateKey('   \n  ') === null);
  }

  section('an EC key, which is the right shape but the wrong algorithm');
  {
    const ec = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const { seen, result } = await recording(
      () => ({ status: 200, body: [] }),
      () =>
        callPsp(CONN, { path: '/x' } as EndpointConfig, {
          key: CLIENT_ID,
          secret: ec.privateKey,
        }),
    );
    const r = result as { ok: boolean; error: string };
    // It parses as a private key, so only an explicit type check catches it.
    // Otherwise the signature is made with the wrong algorithm and rejected as
    // "wrong key" at the provider.
    ok('no request is made', seen.length === 0);
    ok('and RSA is named as what is needed', /RSA/.test(r.error), r.error);
  }

  section('the 401 advice, which has now been wrong twice');
  {
    const said = suggestAuthMode(
      {
        'www-authenticate':
          'Bearer error="invalid_token", error_description="Invalid JWT serialization: Missing dot delimiter(s)"',
      },
      'basic',
    );
    // BEEM's gateway complains about a JWT while its documentation says every
    // request is signed. The advice must not pick one and assert it.
    ok('it names the signature mode too', /signature/i.test(said ?? ''), said);
    ok('and still names oauth2', /oauth2/i.test(said ?? ''), said);
    ok(
      'and says which document settles it',
      /authentication/i.test(said ?? ''),
      said,
    );
    ok(
      'while being certain about what is ruled out',
      /static key/i.test(said ?? ''),
      said,
    );
  }

  section('the other modes are untouched');
  {
    const { seen } = await recording(
      () => ({ status: 200, body: [] }),
      () =>
        callPsp(
          { ...CONN, authMode: 'bearer' },
          { path: '/x' } as EndpointConfig,
          { key: 'plain-key' },
        ),
    );
    ok(
      'bearer still bears',
      seen[0].headers.authorization === 'Bearer plain-key',
    );
    ok('and signs nothing', seen[0].headers.signature === undefined);
  }

  console.log(
    failures
      ? `\n${failures} check(s) failed.`
      : '\nAll signature checks passed.',
  );
  process.exit(failures ? 1 : 0);
}

void main();
