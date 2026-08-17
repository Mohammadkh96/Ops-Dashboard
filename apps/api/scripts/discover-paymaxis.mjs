#!/usr/bin/env node
/**
 * Paymaxis read-API discovery — read-only.
 *
 * The API keys alone are not enough to connect: we also need the host, the path,
 * the auth header name and the pagination parameters, and those differ from the
 * documentation often enough that guessing is a waste of time. This asks the
 * real API and prints the exact settings to use.
 *
 * Run it from a machine that can reach the internet — a laptop is fine. It is
 * not run by the server.
 *
 * Safety:
 *   • GET requests only. It cannot create, modify or capture a payment, even
 *     though the keys carry write permission.
 *   • The API key is read from the environment and NEVER printed.
 *   • PII in the sample record is redacted while field NAMES are preserved, so
 *     the output is safe to paste into a chat or ticket.
 *
 * Usage:
 *   PAYMAXIS_API_KEY=<key> node scripts/discover-paymaxis.mjs
 *   PAYMAXIS_API_KEY=<key> PAYMAXIS_BASE_URL=https://app.paymaxis.com node scripts/discover-paymaxis.mjs
 */

const KEY = process.env.PAYMAXIS_API_KEY;
if (!KEY) {
  console.error('Set PAYMAXIS_API_KEY first. The key is never printed by this script.');
  process.exit(1);
}

// api.paymaxis.com and gate.paymaxis.com are deliberately absent: neither
// resolves. app.paymaxis.com is the host Paymaxis uses for its own webhook
// endpoints and is the one that answers.
const BASES = process.env.PAYMAXIS_BASE_URL
  ? [process.env.PAYMAXIS_BASE_URL.replace(/\/$/, '')]
  : ['https://app.paymaxis.com'];

// Confirmed working first; the rest are kept in case the API changes.
const PATHS = [
  '/api/v1/payments',
  '/api/v1/payments/search',
  '/api/v1/payment',
  '/api/v1/transactions',
  '/v1/payments',
];

// Header styles differ between providers and even between their own docs.
// Bearer is first because that is what Paymaxis actually accepts — X-Api-Key,
// the more common convention and the previous first guess, returns 401.
const AUTHS = [
  { name: 'Authorization: Bearer', headers: { Authorization: `Bearer ${KEY}` } },
  { name: 'X-Api-Key', headers: { 'X-Api-Key': KEY } },
  { name: 'apikey', headers: { apikey: KEY } },
  { name: 'X-API-KEY', headers: { 'X-API-KEY': KEY } },
];

const PII = /email|name|phone|address|card|holder|^ip$|ip_|birth|passport|iban|pan/i;

/**
 * Fields ending in "name" that name a THING, not a person. Without this,
 * `terminalName` is redacted — and that is the field identifying which PSP
 * handled the payment, i.e. one of the main reasons to read the API at all.
 */
const NOT_PII =
  /^(terminal|shop|merchant|product|bank|company|brand|method|provider|gateway|channel|currency)Name$/i;

/** Recursively redacts PII values but keeps every KEY, so field names survive. */
function redact(v, key = '') {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.slice(0, 2).map((x) => redact(x));
  if (typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, redact(val, k)]));
  }
  if (!NOT_PII.test(key) && PII.test(key) && typeof v === 'string' && v.length) {
    return '«redacted»';
  }
  return v;
}

async function attempt(url, auth) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...auth.headers },
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, snippet: text.slice(0, 160).replace(/\s+/g, ' ') };
  } catch (e) {
    return { status: 0, code: e.cause?.code ?? '', error: e.message };
  }
}

console.log('Probing Paymaxis (GET only, key never printed)…\n');

const dead = new Set(); // hosts that do not resolve — skip their remaining paths
let found = null;
const seen = [];

outer: for (const base of BASES) {
  for (const path of PATHS) {
    if (dead.has(base)) continue;
    for (const auth of AUTHS) {
      const url = `${base}${path}?limit=1`;
      const r = await attempt(url, auth);

      if (r.status === 0) {
        if (r.code === 'ENOTFOUND' || r.code === 'EAI_AGAIN') {
          console.log(`  ${base}  — host does not resolve, skipping`);
          dead.add(base);
          // break, not continue: trying the other auth headers against a host
          // that does not exist would print the same line four times.
          break;
        }
        console.log(`  ${base}${path}  ${auth.name.padEnd(22)} -> unreachable (${r.code || r.error})`);
        continue;
      }

      console.log(`  ${base}${path}  ${auth.name.padEnd(22)} -> HTTP ${r.status}`);
      seen.push({ base, path, auth: auth.name, status: r.status, snippet: r.snippet });

      if (r.status >= 200 && r.status < 300 && r.json) {
        found = { base, path, auth: auth.name, json: r.json };
        break outer;
      }
      // A 404 is about the path, not the key — no point trying other headers.
      if (r.status === 404) break;
    }
  }
}

if (!found) {
  console.log('\n──────── NO LIST ENDPOINT ANSWERED ────────');
  const codes = new Set(seen.map((s) => s.status));
  if (!seen.length) {
    console.log(
      'Nothing was even reachable — every candidate host failed to resolve or connect.\n' +
        'Check this machine has internet access, then ask Paymaxis for the API hostname.\n' +
        'Note api.paymaxis.com does not exist; app.paymaxis.com does.',
    );
  } else if (codes.has(401) || codes.has(403)) {
    console.log(
      'Something answered 401/403: the host and path are reachable but the key or\n' +
        'header name was rejected. Ask Paymaxis which header carries the API key.',
    );
  } else if (codes.size && [...codes].every((c) => c === 404)) {
    console.log(
      'Everything answered 404. The likely explanation is that Paymaxis exposes\n' +
        'get-payment-by-id but NOT a list endpoint — you can look a payment up if you\n' +
        'already know its id, but you cannot ask "what is new?".\n\n' +
        'If that is confirmed, polling cannot discover new payments and webhooks are\n' +
        'the only route. That is not a blocker: the webhook receiver is built and\n' +
        'tested. Ask Paymaxis directly: "Is there a GET endpoint that lists or\n' +
        'searches payments by date range?"',
    );
  } else {
    console.log('Send the HTTP codes above to Paymaxis support and ask for the correct GET endpoint.');
  }
  process.exit(2);
}

console.log('\n──────── WORKING ENDPOINT ────────');

const j = found.json;
const arrKey = Array.isArray(j) ? null : Object.keys(j).find((k) => Array.isArray(j[k]));
const list = Array.isArray(j) ? j : arrKey ? j[arrKey] : [];

console.log('\nSet these on the API (Vercel → Settings → Environment Variables):\n');
console.log(`PAYMAXIS_BASE_URL="${found.base}"`);
console.log(`PAYMAXIS_PAYMENTS_PATH="${found.path}"`);
console.log(`PAYMAXIS_AUTH_HEADER="${found.auth.startsWith('Authorization') ? 'Authorization' : found.auth}"`);
if (arrKey) console.log(`PAYMAXIS_RECORDS_PATH="${arrKey}"`);
console.log('PAYMAXIS_POLL_ENABLED="1"');
console.log('# PAYMAXIS_SHOPS="5141:<key>,6321:<key>"   ← shopId:apiKey, one pair per shop');

console.log('\nTop-level keys:', Array.isArray(j) ? '(root array)' : Object.keys(j).join(', '));
console.log(`Records at    : ${Array.isArray(j) ? '(root array)' : (arrKey ?? '(not found)')}`);
console.log(`Records returned: ${list.length}`);

// Pagination and date-filter params are the two things the poller must get
// right; naming them here saves a round trip to support.
if (!Array.isArray(j)) {
  const paging = Object.keys(j).filter((k) =>
    /page|size|limit|offset|cursor|total|count|next|last|first/i.test(k),
  );
  if (paging.length) console.log('Pagination fields:', paging.join(', '));
}

if (list.length) {
  console.log('\nRecord field names:');
  console.log('  ' + Object.keys(list[0]).join(', '));
  console.log('\nSample record (PII redacted — safe to share):');
  console.log(JSON.stringify(redact(list[0]), null, 2));
  console.log(
    '\nStill needed: which query parameter filters by date range (updatedAtFrom?\n' +
      'createdFrom? from?). Set it as PAYMAXIS_SINCE_PARAM — default "updatedAtFrom".',
  );
} else {
  console.log('\nThe endpoint works but returned no records — likely just a quiet window.');
}
