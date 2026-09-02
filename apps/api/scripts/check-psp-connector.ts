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
  sealedLength,
  SecretBoxError,
} from '../src/common/secret-box';
import {
  at,
  describeStatus,
  describeWebPage,
  looksLikeWebPage,
  providerError,
  suggestAuthMode,
  readBalances,
  readTransactions,
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

section('the length of a stored credential');
{
  const secret = 'a'.repeat(60);
  const sealed = withKey(KEY, () => seal(secret));

  ok('is reported exactly', sealedLength(sealed) === 60, sealedLength(sealed));
  // The whole point of reading it off the ciphertext: it must work when the
  // key is gone or has changed, which is when somebody most needs to see it.
  ok(
    'without the key being set',
    withKey(undefined, () => sealedLength(sealed)) === 60,
  );
  ok(
    'and under a different key',
    withKey(OTHER, () => sealedLength(sealed)) === 60,
  );
  ok(
    'a 30-character value reports 30',
    withKey(KEY, () => sealedLength(seal('b'.repeat(30)))) === 30,
  );
  ok('garbage reports nothing', sealedLength('nonsense') === null);
  ok('an empty value reports nothing', sealedLength('') === null);
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
  ok(
    'the string amount parses exactly',
    rows[0].amount === 0.21164052,
    rows[0],
  );
  ok('the currency comes through', rows[0].currency === 'BTC');
  ok('the wallet address is the account', rows[1].account === '0xab12');

  // ForumPay refuses inside a 200. Without this the call looks like a success
  // with no balances, and the screen blames the field paths.
  const refused = providerError({
    err: 'Permission denied!',
    err_code: 'actionNotAllowed',
  });
  ok('a refusal inside a 200 is found', refused !== null, refused);
  ok(
    'and carries the provider’s own words',
    /Permission denied/.test(refused ?? ''),
  );
  ok('and its code', /actionNotAllowed/.test(refused ?? ''));
}

section('a 401 that names the scheme it wants');
{
  // Five auth modes and no documentation is five saves, five calls and five
  // readings — unless the provider already answered, which on a 401 it usually
  // has.
  ok(
    'Basic is recognised',
    /basic/.test(
      suggestAuthMode({ 'www-authenticate': 'Basic realm="api"' }) ?? '',
    ),
  );
  ok(
    'Bearer is recognised',
    /bearer/.test(
      suggestAuthMode({ 'www-authenticate': 'Bearer realm="x"' }) ?? '',
    ),
  );
  // Saying "none of these can do it" is a finding, not a shrug: it stops
  // somebody working through the other four modes for nothing.
  const digest = suggestAuthMode({ 'www-authenticate': 'Digest realm="x"' });
  ok('an unsupported scheme is named', /digest/i.test(digest ?? ''), digest);
  ok(
    'and says none of the modes will do it',
    /none of the auth modes/i.test(digest ?? ''),
  );
  ok('no header, no guess', suggestAuthMode(undefined) === null);
  ok('an empty header, no guess', suggestAuthMode({}) === null);
}

section('reading a transaction list');
{
  // ForumPay's GetTransactions, from its API manual: a bare array, fiat amount
  // in invoice_amount, their own state vocabulary, a space-separated date.
  const endpoint: EndpointConfig = {
    path: '/GetTransactions/',
    fields: {
      id: 'payment_id',
      amount: 'invoice_amount',
      currency: 'invoice_currency',
      status: 'state',
      date: 'inserted',
      reference: 'pos_id',
      direction: 'type',
    },
  };
  const body = {
    // ForumPay's live API wraps the list, though its manual shows a bare
    // array. The wrapper is why an empty records path read the whole object as
    // one record and produced a single row of dashes.
    invoices: [
      {
        payment_id: '123e4567-e89b-12d3',
        type: 'Sell',
        invoice_amount: '48.25',
        invoice_currency: 'EUR',
        state: 'confirmed',
        inserted: '2021-08-06 08:23:24',
        pos_id: 'WEB1',
      },
      // A row we cannot price. Kept, not dropped — see readTransactions.
      {
        payment_id: 'x-2',
        state: 'cancelled',
        inserted: '2021-08-06 09:00:00',
      },
    ],
  };
  const rows = readTransactions(body, { ...endpoint, recordsPath: 'invoices' });
  ok('every row is read', rows.length === 2, rows);
  ok('the fiat amount comes through', rows[0].amount === 48.25);
  ok('and its currency', rows[0].currency === 'EUR');
  ok('and the provider id', rows[0].id === '123e4567-e89b-12d3');
  ok('and our reference on their side', rows[0].reference === 'WEB1');
  // Which way the money went. Without it a list is a pile of numbers: a total
  // means nothing, and a payout reconciles against a deposit of equal size.
  ok('and the direction', rows[0].direction === 'Sell', rows[0]);
  ok('absent where the provider sends none', rows[1].direction === null);

  // Untranslated. "confirmed" is ForumPay's word and Match2Pay says "DONE";
  // mapping them here would put a guess between the desk and the provider on
  // the one question a dispute turns on.
  ok('the status is theirs, verbatim', rows[0].status === 'confirmed');

  // A row with no readable amount is evidence, not noise: a list that silently
  // shortens itself hides the discrepancy somebody came to find.
  ok('an unpriceable row survives', rows[1].id === 'x-2');
  ok('with no amount invented', rows[1].amount === null, rows[1]);

  // Both forms of the date. Theirs is ambiguous — no timezone — so ours is a
  // reading, and theirs stays on screen to check it against.
  ok('their timestamp is kept verbatim', rows[0].at === '2021-08-06 08:23:24');
  ok(
    'and parsed where it can be',
    rows[0].atISO?.startsWith('2021-08-06T08:23:24') === true,
    rows[0].atISO,
  );
}

section('timestamps in the shapes providers actually send');
{
  const one = (date: unknown) =>
    readTransactions([{ date, amount: 1 }], { path: '/x' })[0];

  ok('a seconds epoch', one('1628238204').atISO !== null);
  ok('a milliseconds epoch', one('1628238204000').atISO !== null);
  ok('an ISO instant', one('2021-08-06T08:23:24Z').atISO !== null);
  // Nonsense must not become an invented date on a reconciliation screen.
  ok('unreadable stays unreadable', one('last Tuesday').atISO === null);
  ok('but is still shown as sent', one('last Tuesday').at === 'last Tuesday');
  ok('and nothing at all is null', one(undefined).at === null);
}

section('a field that lives in different places on different rows');
{
  // ForumPay, exactly: a Sell carries the reference in reference_no and leaves
  // pos_id as the literal "widget"; a Buy has no reference_no at all and puts
  // the reference in pos_id. Either name alone blanks out half the ledger.
  const endpoint: EndpointConfig = {
    path: '/x',
    fields: { id: 'payment_id', reference: 'reference_no|pos_id' },
  };
  const rows = readTransactions(
    [
      { payment_id: 'sell-1', pos_id: 'widget', reference_no: 'fe13fd54' },
      { payment_id: 'buy-1', pos_id: '33968e29' },
      // Present but empty is the same fact as absent, and providers send "".
      { payment_id: 'sell-2', pos_id: 'POS9', reference_no: '' },
      { payment_id: 'none-1' },
    ],
    endpoint,
  );
  ok(
    'the first choice wins where it has a value',
    rows[0].reference === 'fe13fd54',
  );
  ok(
    'the fallback covers the other kind of row',
    rows[1].reference === '33968e29',
  );
  ok('an empty string falls through', rows[2].reference === 'POS9', rows[2]);
  ok('and neither is null, not a guess', rows[3].reference === null);

  // A single name keeps working exactly as before.
  const plain = readTransactions([{ pos_id: 'A' }], {
    path: '/x',
    fields: { reference: 'pos_id' },
  });
  ok('one name still behaves', plain[0].reference === 'A');
  // Dotted paths must survive being split on the pipe.
  const nested = readTransactions([{ meta: { ref: 'deep' } }], {
    path: '/x',
    fields: { reference: 'missing.ref|meta.ref' },
  });
  ok(
    'and a dotted alternative resolves',
    nested[0].reference === 'deep',
    nested[0],
  );
}

section('an id the provider reuses across rows');
{
  // BEEM's wallet export, verbatim: a payment and its network fee share ONE
  // Transaction ID — 116 ids across 232 rows. Imported on that column alone,
  // every fee row dedupes into its payment, half the file never lands, and
  // the balance is wrong by the whole of the fees with nothing on screen to
  // say why. Joined to the type, the pair is unique for all 232.
  const rows = [
    {
      'Date Created': '2026-08-30 20:16:56.536852',
      'Transaction ID': '01a05450-fd19-7c6f-a9df-4542ea85b4de',
      'Transaction Type': 'NETWORK_FEE',
      Amount: '-3.9954',
    },
    {
      'Date Created': '2026-08-30 20:16:30.735124',
      'Transaction ID': '01a05450-fd19-7c6f-a9df-4542ea85b4de',
      'Transaction Type': 'PAYMENT_OUT',
      Amount: '-550.055005',
    },
  ];

  const collides = readTransactions(rows, {
    path: '',
    fields: { id: 'Transaction ID' },
  });
  ok(
    'on its own the id is the same for both rows',
    collides[0].id === collides[1].id,
    collides.map((r) => r.id),
  );

  const joined = readTransactions(rows, {
    path: '',
    fields: {
      id: 'Transaction ID+Transaction Type',
      amount: 'Amount',
      date: 'Date Created',
    },
  });
  ok('joined, they are distinct', joined[0].id !== joined[1].id, joined.map((r) => r.id));
  ok(
    'and the join is readable',
    joined[0].id === '01a05450-fd19-7c6f-a9df-4542ea85b4de:NETWORK_FEE',
    joined[0].id,
  );
  ok('a signed amount survives', joined[1].amount === -550.055005, joined[1]);
  ok(
    'and a microsecond timestamp is read',
    Boolean(joined[0].atISO?.startsWith('2026-08-30T20:16:56')),
    joined[0].atISO,
  );

  // Every part must be filled, or the join would produce ONE value for two
  // different rows — the exact failure it exists to prevent.
  const partial = readTransactions(
    [{ a: 'x' }, { a: 'x', b: 'y' }],
    { path: '', fields: { id: 'a+b|a' } },
  );
  ok('an incomplete join falls through', partial[0].id === 'x', partial[0]);
  ok('a complete one is used', partial[1].id === 'x:y', partial[1]);
}

section("ForumPay's settlement date, which its manual denies exists");
{
  // Their OpenAPI documents `confirmed` as a BOOLEAN — "Is transaction
  // successful and confirmed", example: false — and documents no settlement
  // timestamp at all. The live API sends a timestamp in that field, which is
  // the third thing their manual has been wrong about here, after the bare
  // array that is really {"invoices":[...]} and a payer_email that does not
  // exist.
  //
  // It matters because it is the only thing that places a payment correctly
  // against a balance anchor: raised the 31st, settled the 2nd, money moved on
  // the 2nd.
  const endpoint: EndpointConfig = {
    path: '',
    recordsPath: '',
    fields: { id: 'payment_id', date: 'inserted', settled: 'confirmed' },
  };
  const rows = readTransactions(
    [
      { payment_id: 'a', inserted: '2026-09-02 05:41:34', confirmed: '2026-09-02 05:41:35' },
      // Raised before an anchor, settled after it.
      { payment_id: 'e', inserted: '2026-08-31 14:00:00', confirmed: '2026-09-02 06:30:00' },
      // The shapes a row that has NOT settled arrives in. All three must give
      // null rather than a date, so the created date stands in — a pending
      // payment has no settlement time and must not be given one.
      { payment_id: 'b', inserted: '2026-08-31 14:00:00', confirmed: false },
      { payment_id: 'c', inserted: '2026-08-31 14:00:00', confirmed: '' },
      { payment_id: 'd', inserted: '2026-08-31 14:00:00' },
    ],
    endpoint,
  );

  ok('a settled row carries both dates',
     rows[0].atISO === '2026-09-02T05:41:34.000Z' &&
     rows[0].settledISO === '2026-09-02T05:41:35.000Z', rows[0]);
  ok('and they can be days apart',
     rows[1].atISO?.startsWith('2026-08-31') === true &&
     rows[1].settledISO?.startsWith('2026-09-02') === true, rows[1]);
  ok('the documented boolean is not a date', rows[2].settledISO === null, rows[2]);
  ok('nor is an empty string', rows[3].settledISO === null, rows[3]);
  ok('nor is an absent field', rows[4].settledISO === null, rows[4]);
  ok('and the created date always survives',
     rows.every((r) => r.atISO !== null), rows.map((r) => r.atISO));

  // Unconfigured, nothing is guessed: a field named `settled` would be wrong
  // here, and guessing one silently moves payments in time.
  const unmapped = readTransactions(
    [{ payment_id: 'a', inserted: '2026-09-02 05:41:34', confirmed: '2026-09-02 05:41:35' }],
    { path: '', recordsPath: '', fields: { id: 'payment_id', date: 'inserted' } },
  );
  ok('nothing is guessed when it is not configured',
     unmapped[0].settledISO === null, unmapped[0]);
}

section('a web page where an API should be');
{
  // The commonest configuration mistake: a provider's portal and its API are
  // different hosts, and the address a person knows is the one they log into.
  const page =
    '<!DOCTYPE html><html lang="en"><head><title>Match2Pay Wallet</title>' +
    '<style>@font-face{font-family:Roboto}</style></head><body></body></html>';

  ok('is recognised', looksLikeWebPage(page));
  ok('even with leading whitespace', looksLikeWebPage('\n  <html><body>'));
  ok(
    'and says it is the portal, not the API',
    /portal/i.test(describeWebPage(page)),
  );
  // The title is the one useful thing on the page — it names what was reached.
  ok(
    'naming the page',
    /Match2Pay Wallet/.test(describeWebPage(page)),
    describeWebPage(page),
  );

  // JSON that merely CONTAINS markup is not a web page.
  ok('a JSON body is not one', !looksLikeWebPage({ html: '<html>' }));
  ok('a JSON string is not one', !looksLikeWebPage('{"balance":1}'));
  ok('an XML body is not one', !looksLikeWebPage('<?xml version="1.0"?><a/>'));
  ok('nothing is not one', !looksLikeWebPage(undefined));
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
