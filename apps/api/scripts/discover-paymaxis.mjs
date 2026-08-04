#!/usr/bin/env node
/**
 * Paymaxis API discovery — read-only.
 *
 * Finds the "list payments" endpoint and prints its response SHAPE so the
 * poller's field mapping can be configured from fact rather than guesswork.
 * Provider docs and real payloads diverge constantly, so this reads one page
 * from the real API and reports what actually came back.
 *
 * Safety:
 *   • GET requests only — it can never modify anything.
 *   • The API key is read from the environment and NEVER printed.
 *   • Obvious PII (emails, names, phones, addresses, card numbers) is redacted
 *     in the sample so the output is safe to paste into a chat or ticket.
 *
 * Usage:
 *   PAYMAXIS_API_KEY=... node scripts/discover-paymaxis.mjs
 *   PAYMAXIS_API_KEY=... PAYMAXIS_BASE_URL=https://api.paymaxis.com node scripts/discover-paymaxis.mjs
 */

const KEY = process.env.PAYMAXIS_API_KEY;
if (!KEY) {
  console.error('Set PAYMAXIS_API_KEY first. The key is never printed by this script.');
  process.exit(1);
}

const BASES = process.env.PAYMAXIS_BASE_URL
  ? [process.env.PAYMAXIS_BASE_URL.replace(/\/$/, '')]
  : ['https://api.paymaxis.com', 'https://gate.paymaxis.com', 'https://app.paymaxis.com'];

const PATHS = [
  '/api/v1/payment?limit=1',
  '/api/v1/payments?limit=1',
  '/api/v1/payment/list?limit=1',
  '/v1/payment?limit=1',
  '/api/payment?limit=1',
];

// Header styles differ between providers and even between their own docs.
const AUTHS = [
  { name: 'X-Api-Key', headers: { 'X-Api-Key': KEY } },
  { name: 'Authorization: Bearer', headers: { Authorization: `Bearer ${KEY}` } },
  { name: 'apikey', headers: { apikey: KEY } },
  { name: 'X-API-KEY (upper)', headers: { 'X-API-KEY': KEY } },
];

const PII = /email|name|phone|address|card|holder|ip$|ip_|birth|passport|iban|pan/i;

/** Recursively redacts PII values but keeps every KEY, so field names survive. */
function redact(v, key = '') {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.slice(0, 2).map((x) => redact(x));
  if (typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, redact(val, k)]));
  }
  if (PII.test(key) && typeof v === 'string' && v.length) return '«redacted»';
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
    return { status: res.status, json, snippet: text.slice(0, 200) };
  } catch (e) {
    return { status: 0, error: e.message };
  }
}

console.log('Probing Paymaxis (GET only)…\n');
let found = null;

for (const base of BASES) {
  for (const path of PATHS) {
    for (const auth of AUTHS) {
      const url = base + path;
      const r = await attempt(url, auth);
      const label = `${path.padEnd(30)} ${auth.name.padEnd(22)}`;
      if (r.status === 0) {
        console.log(`  ${base}  ${label} -> unreachable (${r.error})`);
        continue;
      }
      console.log(`  ${base}  ${label} -> HTTP ${r.status}`);
      if (r.status >= 200 && r.status < 300 && r.json) {
        found = { base, path, auth: auth.name, json: r.json };
        break;
      }
    }
    if (found) break;
  }
  if (found) break;
}

if (!found) {
  console.log(
    '\nNo endpoint answered 2xx. Send the HTTP codes above to whoever owns the integration —\n' +
      '401/403 means the key or header name is wrong; 404 means the path differs.',
  );
  process.exit(2);
}

console.log('\n──────── WORKING ENDPOINT ────────');
console.log(`Base URL   : ${found.base}`);
console.log(`Path       : ${found.path}`);
console.log(`Auth header: ${found.auth}`);

const j = found.json;
console.log('\nTop-level keys:', Object.keys(j).join(', '));

// Find the array of records wherever it sits.
const arrKey = Array.isArray(j)
  ? null
  : Object.keys(j).find((k) => Array.isArray(j[k]));
const list = Array.isArray(j) ? j : arrKey ? j[arrKey] : [];
console.log(`Records are at: ${Array.isArray(j) ? '(root array)' : arrKey ?? '(not found)'}`);
console.log(`Records returned: ${list.length}`);

if (list.length) {
  console.log('\nRecord field names:');
  console.log('  ' + Object.keys(list[0]).join(', '));
  console.log('\nSample record (PII redacted — safe to share):');
  console.log(JSON.stringify(redact(list[0]), null, 2));
}

console.log(
  '\nAlso useful: paste the pagination fields above (page/offset/cursor/total)\n' +
    'and confirm which query params filter by date range.',
);
