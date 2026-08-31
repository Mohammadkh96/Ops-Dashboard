// Provider credentials at rest, and what the connector will and will not do.
//
// These are live payment-provider keys. Two properties have to hold, and both
// are the kind that look fine until the day they don't:
//
//   • A stolen copy of the database is ciphertext, not keys.
//   • Nothing here can move money, whatever is typed into the form.
//
//   npx tsx scripts/check-psp-connector.ts

import {
  credentialsKeyConfigured,
  hint,
  open,
  sameSecret,
  seal,
  SecretBoxError,
} from '../src/common/secret-box';
import {
  at,
  describeStatus,
  providerError,
  readBalances,
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

const KEY = 'a-test-credentials-key-at-least-32-characters-long';
const OTHER = 'a-DIFFERENT-credentials-key-also-32-characters-long';

function withKey<T>(value: string | undefined, fn: () => T): T {
  const before = process.env.CREDENTIALS_KEY;
  if (value === undefined) delete process.env.CREDENTIALS_KEY;
  else process.env.CREDENTIALS_KEY = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.CREDENTIALS_KEY;
    else process.env.CREDENTIALS_KEY = before;
  }
}

const throws = (fn: () => unknown): Error | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e as Error;
  }
};

section('credentials at rest');
{
  const secret = 'PDDnvdCpneODtE3z8HBzqaBcUTvdrzjt';

  withKey(KEY, () => {
    const sealed = seal(secret);
    ok('a sealed value round-trips', open(sealed) === secret);
    // The whole point. Anybody reading a backup, a replica or a screenshot of
    // this column has ciphertext.
    ok(
      'and does not contain the plaintext',
      !sealed.includes(secret),
      sealed.slice(0, 24),
    );
    ok('it is tagged with a version', sealed.startsWith('v1.'));

    // Reusing an IV under one key in GCM is not a weakness, it is a break: two
    // ciphertexts under one IV leak the XOR of the plaintexts.
    const a = seal(secret);
    const b = seal(secret);
    ok('the same value seals differently every time', a !== b);
    ok('and both still open', open(a) === secret && open(b) === secret);
  });
}

section('a tampered or mismatched value fails loudly');
{
  const sealed = withKey(KEY, () => seal('the-key'));

  // Authenticated encryption: a flipped byte must fail, not decrypt to
  // plausible rubbish that gets sent to a payment provider as a credential.
  const parts = sealed.split('.');
  const flipped = [
    parts[0],
    parts[1],
    parts[2],
    parts[3].slice(0, -2) + (parts[3].endsWith('AA') ? 'BB' : 'AA'),
  ].join('.');
  ok(
    'a modified ciphertext is refused',
    withKey(KEY, () => throws(() => open(flipped))) !== null,
  );

  // The likeliest real incident by far, and the one whose native error message
  // ("unable to authenticate data") sends people looking in the wrong place.
  const wrongKey = withKey(OTHER, () => throws(() => open(sealed)));
  ok('a changed CREDENTIALS_KEY is refused', wrongKey !== null);
  ok(
    'and the message names the cause',
    /CREDENTIALS_KEY/.test(wrongKey?.message ?? ''),
    wrongKey?.message,
  );

  ok(
    'garbage is refused',
    withKey(KEY, () => throws(() => open('nonsense'))) !== null,
  );
  ok(
    'so is an unknown version',
    withKey(KEY, () => throws(() => open('v9.a.b.c'))) !== null,
  );
}

section('a missing or weak key');
{
  ok(
    'no key at all is refused',
    withKey(undefined, () => throws(() => seal('x'))) !== null,
  );
  // A short "key" is somebody typing a word rather than generating a secret.
  ok(
    'a short key is refused',
    withKey('too-short', () => throws(() => seal('x'))) !== null,
  );
  const e = withKey(undefined, () => throws(() => seal('x')));
  // A runnable command, not a description of one. The command has to work on
  // the machine the person is actually sitting at, which is often Windows —
  // where `openssl` does not exist and the error would send them in a circle.
  ok(
    'and the message says how to make one',
    /randomBytes\(48\)/.test(e?.message ?? ''),
    e?.message,
  );
  ok(
    'the status helper agrees',
    withKey(undefined, credentialsKeyConfigured) === false,
  );
  ok('and when set', withKey(KEY, credentialsKeyConfigured) === true);
  ok('a SecretBoxError is what is thrown', e instanceof SecretBoxError);
}

section('the hint shown after pasting a key');
{
  // Four characters of a 32-character key, for confirming the right one landed.
  ok(
    'shows the last four',
    hint('PDDnvdCpneODtE3z8HBzqaBcUTvdrzjt').endsWith('rzjt'),
  );
  ok(
    'and nothing else',
    !hint('PDDnvdCpneODtE3z8HBzqaBcUTvdrzjt').includes('PDDnv'),
  );
  // A short value has no safe last-four to show.
  ok('a tiny value is fully hidden', hint('abcd') === '••••');
}

section('comparing secrets');
{
  ok('equal values match', sameSecret('abc123', 'abc123'));
  ok('different values do not', !sameSecret('abc123', 'abc124'));
  // timingSafeEqual throws on a length mismatch; that throw would itself be the
  // timing signal it exists to remove.
  ok('different lengths do not throw', sameSecret('abc', 'abcdef') === false);
}

section('reading a provider response');
{
  const endpoint: EndpointConfig = {
    path: '/v1/balances',
    recordsPath: 'data.balances',
    fields: { amount: 'available', currency: 'ccy', account: 'wallet' },
  };
  const body = {
    data: {
      balances: [
        { wallet: 'main', ccy: 'EUR', available: 12045.5 },
        { wallet: 'crypto', ccy: 'USDT', available: '8,300.25' },
      ],
    },
  };
  const rows = readBalances(body, endpoint);
  ok('both balances are read', rows.length === 2, rows);
  ok('numbers come through', rows[0].amount === 12045.5);
  // Providers send "1,234.56". A wrong reading here is a balance out by a
  // factor of a thousand on the screen the desk trusts.
  ok('a thousands separator is handled', rows[1].amount === 8300.25, rows[1]);
  ok('the currency is kept', rows[1].currency === 'USDT');
  ok('and the account', rows[0].account === 'main');
}

section('a mapping that does not fit');
{
  const endpoint: EndpointConfig = {
    path: '/x',
    recordsPath: 'wrong.path',
    fields: { amount: 'available' },
  };
  const rows = readBalances(
    { data: { balances: [{ available: 5 }] } },
    endpoint,
  );
  // "No balances found" sends somebody to check the path. A row of 0.00 sends
  // them to ask the provider where the money went.
  ok('yields nothing rather than zeros', rows.length === 0, rows);

  const unreadable = readBalances(
    { rows: [{ label: 'main' }, { label: 'x', amount: 12 }] },
    { path: '/x', recordsPath: 'rows' },
  );
  ok(
    'rows with no readable amount are dropped',
    unreadable.length === 1,
    unreadable,
  );
  ok('and the readable one survives', unreadable[0]?.amount === 12);
}

section('a single object rather than a list');
{
  const rows = readBalances(
    { balance: { amount: 900, currency: 'GBP' } },
    { path: '/x', recordsPath: 'balance' },
  );
  ok(
    'is read as one balance',
    rows.length === 1 && rows[0].amount === 900,
    rows,
  );
}

section('walking into a response');
{
  ok('a dotted path resolves', at({ a: { b: { c: 7 } } }, 'a.b.c') === 7);
  ok('an array index resolves', at({ a: [{ b: 1 }, { b: 2 }] }, 'a.1.b') === 2);
  ok(
    'a missing path is undefined, not a throw',
    at({ a: 1 }, 'x.y.z') === undefined,
  );
  ok(
    'an empty path returns the whole body',
    at({ a: 1 }, undefined) !== undefined,
  );
}

section('errors a person can act on');
{
  // "Request failed with status code 401" tells somebody nothing they had not
  // already seen on the screen.
  ok('401 points at the credential', /credential/i.test(describeStatus(401)));
  ok(
    '403 distinguishes permission from identity',
    /permission|allow-list/i.test(describeStatus(403)),
  );
  ok('404 points at the URL', /base URL|path/i.test(describeStatus(404)));
  ok('429 says rate limited', /rate limit/i.test(describeStatus(429)));
  ok('5xx says it is probably theirs', /theirs/i.test(describeStatus(502)));
}

section('ForumPay, against its published API manual');
{
  // GET /GetBalance/ — HTTP Basic, and the response IS the array, with no
  // wrapper object. Taken from the OpenAPI document, not guessed.
  const endpoint: EndpointConfig = {
    path: '/GetBalance/',
    recordsPath: '',
    fields: { amount: 'balance', currency: 'currency', account: 'address' },
  };
  const body = [
    {
      address: '38wGZr2xLgbHWsYrsNCER1C9mZkNHwyd69',
      currency: 'BTC',
      balance: '0.21164052',
    },
    { address: '0xab12', currency: 'USDT', balance: '15320.44' },
  ];
  const rows = readBalances(body, endpoint);
  ok('a bare array needs no records path', rows.length === 2, rows);
  // Amounts arrive as strings, and BTC has eight decimal places — a reading
  // that rounds is a reading that is wrong.
  ok('the string amount parses exactly', rows[0].amount === 0.21164052, rows[0]);
  ok('the currency comes through', rows[0].currency === 'BTC');
  ok('the wallet address is the account', rows[1].account === '0xab12');

  // ForumPay refuses inside a 200. Without this the call looks like a success
  // with no balances, and the screen blames the field paths.
  const refused = providerError({
    err: 'Permission denied!',
    err_code: 'actionNotAllowed',
  });
  ok('a refusal inside a 200 is found', refused !== null, refused);
  ok('and carries the provider’s own words', /Permission denied/.test(refused ?? ''));
  ok('and its code', /actionNotAllowed/.test(refused ?? ''));
}

section('what is not a provider error');
{
  ok('a successful array is not', providerError([{ balance: '1' }]) === null);
  ok('a plain object is not', providerError({ balances: [] }) === null);
  // A row with an `error` COLUMN must not take a whole reading down.
  ok('an empty string is not', providerError({ err: '   ' }) === null);
  ok('a non-string is not', providerError({ error: 0 }) === null);
  ok('nothing at all is not', providerError(null) === null);
}

console.log(
  failures
    ? `\n${failures} check(s) failed.`
    : '\nAll PSP connector checks passed.',
);
process.exit(failures ? 1 : 0);
