"use client";

import { useQuery } from "@tanstack/react-query";

import { StatTileRow, type Stat } from "@/components/ui/stat-tile";
import { apiFetch, isDemoMode } from "@/lib/api";
import { useTimeRange, withRange } from "@/lib/time-range";

export type PaymentStats = {
  window: string;
  currency: string;
  volume: number;
  count: number;
  settled: number;
  declined: number;
  average: number;
  largest: number;
  successRate: number | null;
  topPsp: { psp: string; volume: number } | null;
};

// Symbols where they exist, the code otherwise — "USD2.0K" reads as a part
// number, "$2.0K" reads as money.
const SYMBOLS: Record<string, string> = { USD: "$", EUR: "\u20ac", GBP: "\u00a3", JPY: "\u00a5" };

function money(n: number, ccy: string) {
  const unit = SYMBOLS[ccy] ?? (ccy ? `${ccy} ` : "");
  if (n >= 1_000_000) return `${unit}${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${unit}${(n / 1_000).toFixed(1)}K`;
  return `${unit}${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/**
 * Headline figures for a payment page, measured over the last 24 hours.
 *
 * These pages previously carried fixed tiles — "$2.91M today", "94.2% approval",
 * "38s average processing" — that never changed and never matched the rows
 * underneath them. Every value here is computed from real payments, and any
 * figure with no source is left out rather than filled in: nothing measures
 * processing time, so no processing-time tile exists.
 *
 * `demo` supplies the illustrative set for an environment with no data yet.
 */
export function PaymentStats({ type, demo }: { type?: string; demo: Stat[] }) {
  const { query: rangeQuery, key: rangeKey, label: rangeLabel } = useTimeRange();
  const query = useQuery({
    queryKey: ["payment-stats", type ?? "all", rangeKey],
    queryFn: () =>
      apiFetch<PaymentStats | null>(
        withRange(
          `/payments/stats${type ? `?type=${encodeURIComponent(type)}` : ""}`,
          rangeQuery,
        ),
      ),
    enabled: !isDemoMode,
    refetchInterval: 30_000,
  });

  const s = query.data;
  if (!s) return <StatTileRow stats={demo} />;

  const noun = type ? type[0].toUpperCase() + type.slice(1) : "Payment";

  // The label names the selected window. It read "· 24h" whatever was
  // selected, so a 30-day figure was presented as a day's takings.
  const stats: Stat[] = [
    {
      label: `Settled ${noun}s · ${rangeLabel}`,
      value: money(s.volume, s.currency),
      // No delta: comparing against the previous day needs a previous day, and
      // a percentage against a near-empty window is noise, not information.
      tone: "green",
    },
    {
      label: `Average ${noun}`,
      value: money(s.average, s.currency),
      tone: "blue",
    },
    {
      label: "Success Rate",
      value: s.successRate === null ? "—" : `${s.successRate}%`,
      tone: "orange",
    },
    {
      label: s.topPsp ? `Top PSP · ${s.topPsp.psp}` : `Attempts · ${rangeLabel}`,
      value: s.topPsp
        ? money(s.topPsp.volume, s.currency)
        : s.count.toLocaleString(),
      tone: "purple",
    },
  ];

  return <StatTileRow stats={stats} />;
}
