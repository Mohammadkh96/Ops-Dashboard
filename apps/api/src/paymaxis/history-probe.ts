/**
 * Asks the provider whether the OLD payments can be fetched at all.
 *
 * The importer walks the list endpoint with limit+offset and, against the live
 * API, runs out after a couple of hundred records covering about two days. That
 * is either the whole list, or an endpoint serving a recent window — and the
 * remedy is completely different in each case. This measures instead of
 * guessing.
 *
 * It runs on the server, using the keys the API already holds, so the answer is
 * a button in the dashboard rather than a terminal, a checkout and a key pasted
 * into someone's shell. (scripts/probe-history.mjs does the same thing from a
 * laptop, for a key that is not configured here yet.)
 *
 * Read-only: GET only, and the key is never returned. Everything below reports
 * counts, dates and parameter names — nothing from a payment that names a
 * person — so the result can be pasted into a provider ticket as it stands.
 */

export type ProbeAttempt = {
  what: string;
  records: number;
  newest: string | null;
  oldest: string | null;
  /** Did it do what we asked, as opposed to being accepted and ignored? */
  worked: boolean;
  note?: string;
};

export type HistoryProbe = {
  shop: string;
  /** How far plain paging reaches. */
  paging: {
    pages: number;
    records: number;
    oldest: string | null;
    daysBack: number | null;
    stoppedBecause: string;
  };
  dateWindow: ProbeAttempt[];
  ordering: ProbeAttempt[];
  customer: ProbeAttempt[];
  /** The one sentence somebody needs. */
  verdict: string;
  error?: string;
};

type Fetcher = (params: Record<string, string | number | undefined>) => Promise<{
  status: number;
  records: Record<string, unknown>[];
  hasMore?: boolean;
}>;

const DAY = 86_400_000;
const DATE_FIELDS = ['updatedAt', 'updated', 'createdAt', 'created', 'finalized', 'timestamp'];

function dateOf(r: Record<string, unknown>): Date | null {
  const inner = ((r.payment ?? r.data ?? r) ?? {}) as Record<string, unknown>;
  for (const f of DATE_FIELDS) {
    const v = inner[f];
    if (typeof v === 'string') {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return new Date(t);
    }
  }
  return null;
}

function span(list: Record<string, unknown>[]) {
  const ds = list
    .map(dateOf)
    .filter((d): d is Date => Boolean(d))
    .sort((a, b) => a.getTime() - b.getTime());
  return {
    oldest: ds.length ? ds[0] : null,
    newest: ds.length ? ds[ds.length - 1] : null,
  };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Candidate parameter names, in the order they are worth trying. */
const DATE_PAIRS: [string, string][] = [
  ['createdAtFrom', 'createdAtTo'],
  ['updatedAtFrom', 'updatedAtTo'],
  ['dateFrom', 'dateTo'],
  ['from', 'to'],
  ['startDate', 'endDate'],
  ['createdFrom', 'createdTo'],
];
const ORDERINGS: Record<string, string>[] = [
  { sort: 'createdAt,asc' },
  { sort: 'createdAt', order: 'asc' },
  { sortBy: 'createdAt', sortOrder: 'asc' },
  { order: 'asc' },
];
const CUSTOMER_PARAMS = [
  'customerReferenceId',
  'customerId',
  'customerReference',
  'search',
  'query',
];

export async function probeHistory(
  shop: string,
  fetchPage: Fetcher,
  opts: { limit?: number; maxPages?: number; budgetMs?: number; customer?: string } = {},
): Promise<HistoryProbe> {
  const limit = opts.limit ?? 100;
  const maxPages = opts.maxPages ?? 8;
  const budgetMs = opts.budgetMs ?? 25_000;
  const started = Date.now();
  const spent = () => Date.now() - started;

  const probe: HistoryProbe = {
    shop,
    paging: { pages: 0, records: 0, oldest: null, daysBack: null, stoppedBecause: 'not run' },
    dateWindow: [],
    ordering: [],
    customer: [],
    verdict: '',
  };

  // ── 1. How deep does plain paging go? ─────────────────────────────────────
  let deepest: Date | null = null;
  let newestOverall: Date | null = null;
  let previous = '';
  try {
    for (let page = 0; page < maxPages; page++) {
      if (spent() > budgetMs) {
        probe.paging.stoppedBecause = 'the probe ran out of time, not the list';
        break;
      }
      const { status, records, hasMore } = await fetchPage({
        limit,
        offset: page * limit || undefined,
      });
      if (status !== 200) {
        probe.paging.stoppedBecause = `HTTP ${status}`;
        break;
      }
      if (!records.length) {
        probe.paging.stoppedBecause = 'the list ran out';
        break;
      }
      const fingerprint = records.map((r) => String(r.id ?? r.paymentId ?? '')).join(',');
      if (fingerprint && fingerprint === previous) {
        // The failure this whole walk is most afraid of: an offset that is
        // accepted and ignored returns the same page forever.
        probe.paging.stoppedBecause =
          'the page repeated itself — offset is being ignored, so paging cannot go deeper';
        break;
      }
      previous = fingerprint;
      const { oldest, newest } = span(records);
      if (oldest && (!deepest || oldest < deepest)) deepest = oldest;
      if (newest && (!newestOverall || newest > newestOverall)) newestOverall = newest;
      probe.paging.pages++;
      probe.paging.records += records.length;
      if (hasMore === false) {
        probe.paging.stoppedBecause = 'the API reported no further pages';
        break;
      }
      if (page === maxPages - 1) {
        probe.paging.stoppedBecause = `the probe's page cap (${maxPages}) — the list may go deeper`;
      }
    }
    probe.paging.oldest = iso(deepest);
    probe.paging.daysBack = deepest ? Math.round((Date.now() - deepest.getTime()) / DAY) : null;

    // ── 2. Does a date window work? ─────────────────────────────────────────
    // Asked for a period well before anything plain paging reached, so a
    // parameter that works returns records paging could not have produced.
    const to = new Date(Date.now() - 60 * DAY);
    const from = new Date(Date.now() - 90 * DAY);
    for (const [a, b] of DATE_PAIRS) {
      if (spent() > budgetMs) break;
      const { status, records } = await fetchPage({
        limit,
        [a]: from.toISOString(),
        [b]: to.toISOString(),
      });
      const { oldest, newest } = span(records);
      // The only test that means anything: did the records land INSIDE the
      // window? Being accepted proves nothing — an unknown parameter is
      // accepted and ignored, which is how earlier candidates were cleared.
      const worked =
        status === 200 &&
        Boolean(newest && oldest) &&
        (newest as Date).getTime() <= to.getTime() + DAY &&
        (oldest as Date).getTime() >= from.getTime() - DAY;
      probe.dateWindow.push({
        what: `${a} / ${b}`,
        records: records.length,
        newest: iso(newest),
        oldest: iso(oldest),
        worked,
        note: status !== 200 ? `HTTP ${status}` : worked ? undefined : 'ignored — returned recent records',
      });
      if (worked) break;
    }

    // ── 3. Can the order be reversed? ───────────────────────────────────────
    for (const params of ORDERINGS) {
      if (spent() > budgetMs) break;
      const { status, records } = await fetchPage({ limit, ...params });
      const { oldest, newest } = span(records);
      // Reversed means this page starts somewhere other than the top of the
      // list — compared against the NEWEST seen, since when paging has already
      // reached the first payment an ascending page legitimately ends later
      // than the oldest.
      const worked =
        status === 200 &&
        Boolean(newest && newestOverall) &&
        (newest as Date).getTime() < (newestOverall as Date).getTime() - DAY;
      probe.ordering.push({
        what: Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' '),
        records: records.length,
        newest: iso(newest),
        oldest: iso(oldest),
        worked,
        note: status !== 200 ? `HTTP ${status}` : worked ? undefined : 'unchanged',
      });
      if (worked) break;
    }

    // ── 4. Is there a customer filter? ──────────────────────────────────────
    if (opts.customer) {
      for (const key of CUSTOMER_PARAMS) {
        if (spent() > budgetMs) break;
        const { status, records } = await fetchPage({ limit, [key]: opts.customer });
        const mine = records.filter((r) => {
          const inner = ((r.payment ?? r.data ?? r) ?? {}) as Record<string, unknown>;
          const c = (inner.customer ?? {}) as Record<string, unknown>;
          return [c.referenceId, c.id, inner.customerReferenceId, inner.customerId].includes(
            opts.customer,
          );
        });
        const { oldest, newest } = span(records);
        const worked = status === 200 && records.length > 0 && mine.length === records.length;
        probe.customer.push({
          what: `${key}=${opts.customer}`,
          records: records.length,
          newest: iso(newest),
          oldest: iso(oldest),
          worked,
          note:
            status !== 200
              ? `HTTP ${status}`
              : worked
                ? undefined
                : `${mine.length} of ${records.length} belong to this customer — not filtered`,
        });
        if (worked) break;
      }
    }
  } catch (e) {
    probe.error = (e as Error).message;
  }

  const dateOk = probe.dateWindow.find((a) => a.worked);
  const orderOk = probe.ordering.find((a) => a.worked);
  const custOk = probe.customer.find((a) => a.worked);

  probe.verdict = dateOk
    ? `${dateOk.what} works — the import can walk the history month by month.`
    : orderOk
      ? `${orderOk.what} returns the oldest first — the history can be walked forwards.`
      : custOk
        ? `${custOk.what} filters by customer — one client's whole history is a single request.`
        : probe.paging.daysBack !== null && probe.paging.daysBack > 30
          ? `Plain paging reaches ${probe.paging.daysBack} days back, so the history IS available this way — re-run the import.`
          : 'None of these reached older payments. This endpoint serves only recent records, ' +
            'so ask Paymaxis for a date-ranged export, the parameter that pages further back, ' +
            'or the customer lifetime counters in the payment payload.';

  return probe;
}
