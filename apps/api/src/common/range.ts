/**
 * The time window a request is asking about.
 *
 * Every figure on the dashboard was hardcoded to a rolling 24 hours, so
 * "yesterday was worse than today" was a question the product could not answer.
 * One parser, shared by every endpoint, so a window means the same thing on the
 * KPI tiles, the transaction list and the PSP breakdown — otherwise the same
 * screen shows three different periods and nobody can tell.
 */
export type TimeRange = {
  from: Date;
  to: Date;
  /** What to echo back to the client, so the UI can label what it is showing. */
  label: string;
  /** Length in ms, used to derive the preceding window for comparisons. */
  spanMs: number;
};

const DAY = 86_400_000;

const PRESETS: Record<string, number> = {
  '1h': 3_600_000,
  '24h': DAY,
  '7d': 7 * DAY,
  '30d': 30 * DAY,
  '90d': 90 * DAY,
};

/**
 * Builds a window from explicit from/to, or a preset name, defaulting to 24h.
 *
 * Invalid input falls back to the default rather than erroring: a malformed
 * date in a URL should show the usual view, not break the page.
 */
export function parseRange(q: {
  from?: string;
  to?: string;
  range?: string;
}): TimeRange {
  const now = Date.now();

  const parsed = (s?: string) => {
    if (!s) return null;
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  };

  const fromMs = parsed(q.from);
  const toMs = parsed(q.to);

  if (fromMs !== null) {
    // An explicit start with no end means "from then until now".
    const to = toMs !== null ? toMs : now;
    // Tolerate a reversed pair rather than returning an empty window.
    const [a, b] = fromMs <= to ? [fromMs, to] : [to, fromMs];
    return {
      from: new Date(a),
      to: new Date(b),
      label: 'custom',
      spanMs: Math.max(1, b - a),
    };
  }

  const key = (q.range ?? '24h').toLowerCase();
  const span = PRESETS[key] ?? DAY;
  return {
    from: new Date(now - span),
    to: new Date(now),
    label: PRESETS[key] ? key : '24h',
    spanMs: span,
  };
}

/** The window immediately before this one, for period-on-period comparison. */
export function precedingRange(r: TimeRange): TimeRange {
  return {
    from: new Date(r.from.getTime() - r.spanMs),
    to: new Date(r.from.getTime()),
    label: `${r.label} (previous)`,
    spanMs: r.spanMs,
  };
}
