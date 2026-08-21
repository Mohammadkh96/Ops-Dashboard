// Per-stage transaction clock.
//
// A reconciliation says whether the systems agree. It does not say that a
// deposit took nine hours to settle, or that one terminal is consistently slow
// — and those are operational faults that never show up as a mismatch because
// every leg eventually agrees.
//
// The stages follow the real flow:
//
//   CRM request → CRM processed → Paymaxis created → Paymaxis finalized,
//   with PSP requested / PSP confirmed inside that window.
//
// Deposits:    CRM → Paymaxis → PSP (the PSP confirms, Paymaxis finalizes).
// Withdrawals: finalization WAITS on the PSP, so Paymaxis→PSP and
//              PSP req→confirm sit before Paymaxis settle rather than after.
//
// TIMEZONES: every source logs UTC, but only some say so. Match2pay writes
// "…Z"; CRM and Paymaxis write a naive "2026-08-06 00:01:37". Parsing the naive
// form with the platform parser applies the VIEWER's timezone, so the same
// payment measured in London and Dubai produced gaps four hours apart. Every
// value here is forced to UTC, which is what makes the two comparable.

export type Stage = {
  label: string;
  /** Milliseconds, or null when either endpoint is missing or unparseable. */
  ms: number | null;
};

export type TransactionTiming = {
  stages: Stage[];
  totalMs: number | null;
  /** Rounded minutes, for sorting and thresholds. */
  totalMins: number | null;
  speed: SpeedBucket;
  /** True when the whole chain took longer than a day. */
  slow: boolean;
};

export type SpeedBucket =
  | "instant"
  | "fast"
  | "normal"
  | "slow"
  | "very-slow"
  | "unknown";

export const SPEED_LABEL: Record<SpeedBucket, string> = {
  instant: "Instant (under 1m)",
  fast: "Fast (1–10m)",
  normal: "Normal (10–60m)",
  slow: "Slow (1–24h)",
  "very-slow": "Very slow (over 24h)",
  unknown: "Not measurable",
};

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Rejects a parse that landed outside a plausible range.
 *
 * Without this, a spreadsheet serial ("46234") parses as the year 46234 and the
 * resulting gap reads as -16,115,743 days — a number that looks like a code
 * fault but is really a bad input silently accepted.
 */
function inRange(d: Date): Date | null {
  if (isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  return y >= 2000 && y <= 2100 ? d : null;
}

/**
 * Parses a provider timestamp as an instant in UTC, whatever shape it arrives
 * in. A value that already carries a zone keeps it; a naive value is read as
 * UTC rather than as the viewer's local time.
 */
export function parseUtc(v: unknown): Date | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return inRange(v);

  const s = String(v).trim();
  if (!s) return null;

  // DD/MM/YYYY [HH:mm[:ss]] — the CRM export's format.
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m)
    return inRange(
      new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))),
    );

  // DD Mon YYYY [HH:mm[:ss]]
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined)
    return inRange(
      new Date(
        Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)),
      ),
    );

  // ISO-ish, with or without a zone. A trailing Z or offset is honoured by the
  // platform parser; a naive value is forced to UTC here.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s) && /(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    return inRange(new Date(s));
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m)
    return inRange(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0))));

  // Date only.
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return inRange(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));

  // A bare number is a spreadsheet serial, not a date. Refusing it is the whole
  // point of the sanity bound above.
  if (/^\d+$/.test(s)) return null;

  return inRange(new Date(s));
}

const ms = (v: unknown): number | null => {
  const d = parseUtc(v);
  return d ? d.getTime() : null;
};

/** Signed gap from `a` to `b`. Null when either end is unusable. */
export function gap(a: unknown, b: unknown): number | null {
  const x = ms(a);
  const y = ms(b);
  return x === null || y === null ? null : y - x;
}

/** "2d 3h", "14m", "0s" — two units is enough to act on. */
export function formatDuration(msSpan: number | null): string {
  if (msSpan === null || msSpan === undefined) return "—";
  const negative = msSpan < 0;
  let s = Math.abs(msSpan) / 1000;
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const sec = Math.round(s);

  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!d && !h && (sec || !m)) parts.push(`${sec}s`);

  return (negative ? "-" : "") + (parts.slice(0, 2).join(" ") || "0s");
}

export function speedBucket(msSpan: number | null): SpeedBucket {
  if (msSpan === null) return "unknown";
  const mins = Math.abs(msSpan) / 60000;
  if (mins < 1) return "instant";
  if (mins < 10) return "fast";
  if (mins < 60) return "normal";
  if (mins < 1440) return "slow";
  return "very-slow";
}

export type TimingInput = {
  crmRequested?: unknown;
  crmProcessed?: unknown;
  cashierCreated?: unknown;
  cashierFinalized?: unknown;
  pspRequested?: unknown;
  pspConfirmed?: unknown;
};

/**
 * The stage clock for one transaction.
 *
 * End-to-end is the span between the earliest and latest usable stamp rather
 * than a fixed pair, so a chain missing its middle still reports the total it
 * can actually evidence instead of nothing.
 */
export function computeTiming(t: TimingInput): TransactionTiming {
  const stages: Stage[] = [
    { label: "CRM req → proc", ms: gap(t.crmRequested, t.crmProcessed) },
    { label: "CRM → Paymaxis", ms: gap(t.crmProcessed, t.cashierCreated) },
    { label: "Paymaxis settle", ms: gap(t.cashierCreated, t.cashierFinalized) },
    { label: "Paymaxis → PSP", ms: gap(t.cashierCreated, t.pspRequested) },
    { label: "PSP req → confirm", ms: gap(t.pspRequested, t.pspConfirmed) },
  ];

  const stamps = [
    t.crmRequested, t.crmProcessed, t.cashierCreated,
    t.cashierFinalized, t.pspRequested, t.pspConfirmed,
  ]
    .map(ms)
    .filter((x): x is number => x !== null);

  const totalMs = stamps.length >= 2 ? Math.max(...stamps) - Math.min(...stamps) : null;

  return {
    stages,
    totalMs,
    totalMins: totalMs === null ? null : Math.round(totalMs / 60000),
    speed: speedBucket(totalMs),
    slow: totalMs !== null && Math.abs(totalMs) > 1440 * 60000,
  };
}
