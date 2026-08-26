#!/usr/bin/env node
/**
 * Can Paymaxis give us the OLD payments? — read-only probe.
 *
 * The importer walks the list endpoint with limit+offset and, on the live API,
 * runs out after a couple of hundred records covering about two days. That is
 * either the whole list, or the endpoint is serving a recent window and the
 * history needs asking for differently. Guessing between those two has already
 * cost more than measuring will, so this measures.
 *
 * Four questions, each with a test that can actually fail:
 *
 *   1. How deep does plain offset paging go?
 *      Walks pages until the API says stop, reporting the oldest date reached.
 *
 *   2. Does any date-range parameter WORK?
 *      Not "is it accepted" — every unknown parameter is accepted and ignored,
 *      which is how nine candidates were wrongly cleared before. Each candidate
 *      asks for a window deliberately far in the past, and passes only if the
 *      records that come back actually fall inside it.
 *
 *   3. Can the order be reversed?
 *      An oldest-first sort is a complete answer on its own: walk from the
 *      beginning instead of backwards.
 *
 *   4. Is there a customer filter?
 *      If one payment can be fetched by customer reference, a client's whole
 *      history is one request rather than an import.
 *
 * Safety:
 *   • GET only. It cannot create, modify or capture a payment, though the key
 *     carries write permission.
 *   • The key is read from the environment and never printed.
 *   • Only counts, dates and ids are printed — no names, emails or card data —
 *     so the output is safe to paste into a chat or a ticket.
 *
 * Usage:
 *   PAYMAXIS_API_KEY=<key for one shop> node scripts/probe-history.mjs
 *   ...then run it again with the other shop's key.
 */

const KEY = process.env.PAYMAXIS_API_KEY;
if (!KEY) {
  console.error('Set PAYMAXIS_API_KEY first. The key is never printed.');
  process.exit(1);
}

const BASE = (process.env.PAYMAXIS_BASE_URL ?? 'https://app.paymaxis.com').replace(/\/$/, '');
const PATH = process.env.PAYMAXIS_PAYMENTS_PATH ?? '/api/v1/payments';
const LIMIT = Number(process.env.PAYMAXIS_LIMIT ?? 100);
const MAX_PAGES = Number(process.env.PROBE_MAX_PAGES ?? 40);
const AUTH = process.env.PAYMAXIS_AUTH_HEADER ?? 'Authorization';

const headers = /^authorization$/i.test(AUTH)
  ? { Accept: 'application/json', Authorization: `Bearer ${KEY}` }
  : { Accept: 'application/json', [AUTH]: KEY };

async function get(params) {
  const url = new URL(PATH.replace(/^\//, ''), BASE + '/');
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  });
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, raw: text.slice(0, 200) };
}

/** The records array, wherever this response put it. */
function records(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  for (const k of ['result', 'content', 'data', 'items', 'results', 'payments', 'records']) {
    if (Array.isArray(json[k])) return json[k];
  }
  const any = Object.values(json).find((v) => Array.isArray(v) && v.every((x) => x && typeof x === 'object'));
  return any ?? [];
}

const DATE_FIELDS = ['updatedAt', 'updated', 'createdAt', 'created', 'finalized', 'timestamp'];
function dateOf(r) {
  const inner = r?.payment ?? r?.data ?? r;
  for (const f of DATE_FIELDS) {
    const v = inner?.[f];
    if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(Date.parse(v));
  }
  return null;
}
function span(list) {
  const ds = list.map(dateOf).filter(Boolean).sort((a, b) => a - b);
  return ds.length ? { oldest: ds[0], newest: ds[ds.length - 1] } : { oldest: null, newest: null };
}
const iso = (d) => (d ? d.toISOString() : '—');
const daysAgo = (d) => (d ? Math.round((Date.now() - d.getTime()) / 86_400_000) : null);

const line = (s = '') => console.log(s);
const rule = (t) => line(`\n──────── ${t} ────────`);

// ── 1. How deep does offset paging go? ──────────────────────────────────────
rule('1. Plain offset paging');
let deepest = null;
let newestOverall = null;
let total = 0;
let pages = 0;
{
  let previous = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const { status, json, raw } = await get({ limit: LIMIT, offset: page * LIMIT || undefined });
    if (status !== 200) {
      line(`  page ${page} (offset ${page * LIMIT}): HTTP ${status} ${raw}`);
      break;
    }
    const list = records(json);
    const { oldest, newest } = span(list);
    const fingerprint = list.map((r) => (r.id ?? r.paymentId ?? '')).join(',');
    const hasMore = !Array.isArray(json) ? json?.hasMore : undefined;
    line(
      `  page ${page} (offset ${page * LIMIT}): ${String(list.length).padStart(4)} records · ` +
        `${iso(newest)} → ${iso(oldest)} · hasMore=${hasMore ?? '(absent)'}`,
    );
    if (!list.length) {
      line('  → the list ran out.');
      break;
    }
    if (fingerprint && fingerprint === previous) {
      line('  → IDENTICAL to the previous page: offset is being ignored, so this walk cannot go deeper.');
      break;
    }
    previous = fingerprint;
    total += list.length;
    pages++;
    if (oldest && (!deepest || oldest < deepest)) deepest = oldest;
    if (newest && (!newestOverall || newest > newestOverall)) newestOverall = newest;
    if (hasMore === false) {
      line('  → the API reported no further pages.');
      break;
    }
  }
  line(
    `  RESULT: ${total} record(s) over ${pages} page(s); oldest reached ${iso(deepest)}` +
      (deepest ? ` (${daysAgo(deepest)} days ago)` : ''),
  );
}

// ── 2. Does any date-range parameter actually work? ─────────────────────────
rule('2. Date-range parameters');
{
  // A window that is definitely OLDER than what plain paging reached, so a
  // parameter that works returns records plain paging could not.
  const to = new Date(Date.now() - 60 * 86_400_000);
  const from = new Date(Date.now() - 90 * 86_400_000);
  const fmt = (d) => d.toISOString();
  const dateOnly = (d) => d.toISOString().slice(0, 10);

  const CANDIDATES = [
    ['createdAtFrom', 'createdAtTo'],
    ['updatedAtFrom', 'updatedAtTo'],
    ['dateFrom', 'dateTo'],
    ['from', 'to'],
    ['fromDate', 'toDate'],
    ['startDate', 'endDate'],
    ['periodFrom', 'periodTo'],
    ['createdFrom', 'createdTo'],
    ['minCreatedAt', 'maxCreatedAt'],
    ['createdAt.gte', 'createdAt.lte'],
    ['filter[createdAtFrom]', 'filter[createdAtTo]'],
  ];

  let worked = null;
  for (const [a, b] of CANDIDATES) {
    for (const shape of ['iso', 'date']) {
      const v = shape === 'iso' ? fmt : dateOnly;
      const { status, json } = await get({ limit: LIMIT, [a]: v(from), [b]: v(to) });
      if (status !== 200) {
        line(`  ${a}/${b} [${shape}]: HTTP ${status}`);
        continue;
      }
      const list = records(json);
      const { oldest, newest } = span(list);
      // The only test that means anything: are the records INSIDE the window?
      const inside = newest && newest <= new Date(to.getTime() + 86_400_000) && oldest && oldest >= new Date(from.getTime() - 86_400_000);
      line(
        `  ${a}/${b} [${shape}]: ${String(list.length).padStart(4)} records · ` +
          `${iso(newest)} → ${iso(oldest)} · ${inside ? '*** HONOURED ***' : 'ignored (returned recent records)'}`,
      );
      if (inside && !worked) worked = { a, b, shape };
    }
  }
  line(
    worked
      ? `  RESULT: ${worked.a}/${worked.b} works (${worked.shape}). The importer can walk month by month with it.`
      : '  RESULT: no date parameter changed what came back. The endpoint cannot be asked for a past window.',
  );
}

// ── 3. Can the order be reversed? ───────────────────────────────────────────
rule('3. Oldest-first ordering');
{
  const CANDIDATES = [
    { sort: 'createdAt,asc' },
    { sort: 'createdAt' , order: 'asc' },
    { sortBy: 'createdAt', sortOrder: 'asc' },
    { sortField: 'createdAt', sortDirection: 'ASC' },
    { order: 'asc' },
    { direction: 'ASC' },
  ];
  let worked = null;
  for (const params of CANDIDATES) {
    const { status, json } = await get({ limit: LIMIT, ...params });
    if (status !== 200) {
      line(`  ${JSON.stringify(params)}: HTTP ${status}`);
      continue;
    }
    const list = records(json);
    const { oldest, newest } = span(list);
    // Ascending worked if this page STARTS somewhere other than the top of the
    // list. Comparing against the deepest date instead was wrong: when plain
    // paging has already reached the very first payment, an ascending page
    // legitimately ends later than that, and the check reported "unchanged" for
    // a parameter that had worked perfectly.
    const reversed =
      newest && newestOverall && newest.getTime() < newestOverall.getTime() - 86_400_000;
    line(
      `  ${JSON.stringify(params)}: ${iso(newest)} → ${iso(oldest)} · ${reversed ? '*** REVERSED ***' : 'unchanged'}`,
    );
    if (reversed && !worked) worked = params;
  }
  line(
    worked
      ? `  RESULT: ${JSON.stringify(worked)} returns the oldest first — the whole history can be walked forwards.`
      : '  RESULT: ordering could not be reversed.',
  );
}

// ── 4. Is there a customer filter? ──────────────────────────────────────────
rule('4. Filtering by customer');
{
  const CU = process.env.PROBE_CUSTOMER;
  if (!CU) {
    line('  Skipped. Set PROBE_CUSTOMER=CU60573 (any reference from the dashboard) to test this.');
  } else {
    const CANDIDATES = [
      { customerReferenceId: CU },
      { customerId: CU },
      { 'customer.referenceId': CU },
      { customerReference: CU },
      { reference: CU },
      { search: CU },
      { query: CU },
    ];
    let worked = null;
    for (const params of CANDIDATES) {
      const { status, json } = await get({ limit: LIMIT, ...params });
      if (status !== 200) {
        line(`  ${JSON.stringify(params)}: HTTP ${status}`);
        continue;
      }
      const list = records(json);
      const mine = list.filter((r) => {
        const inner = r?.payment ?? r?.data ?? r;
        const c = inner?.customer ?? {};
        return [c.referenceId, c.id, inner.customerReferenceId, inner.customerId].includes(CU);
      });
      const { oldest, newest } = span(list);
      const filtered = list.length > 0 && mine.length === list.length;
      line(
        `  ${JSON.stringify(params)}: ${String(list.length).padStart(4)} records, ${mine.length} for this customer · ` +
          `${iso(newest)} → ${iso(oldest)} · ${filtered ? '*** FILTERED ***' : 'ignored'}`,
      );
      if (filtered && !worked) worked = { params, oldest };
    }
    line(
      worked
        ? `  RESULT: ${JSON.stringify(worked.params)} filters by customer, back to ${iso(worked.oldest)} — a client's history is one request.`
        : '  RESULT: no customer filter took effect.',
    );
  }
}

rule('What this means');
line(
  deepest && daysAgo(deepest) <= 7
    ? '  Plain paging reaches only the last few days. If sections 2–4 all say no,\n' +
      '  the history is not available through this endpoint and Paymaxis needs to\n' +
      '  say which call returns it (their own console clearly has the data).'
    : '  Plain paging reaches further back than the importer managed — re-run the\n' +
      '  import; if it still stops early, the page cap or budget is the limit, not\n' +
      '  the API.',
);
line('\n  Paste this whole output back — it names the exact call that works.\n');
