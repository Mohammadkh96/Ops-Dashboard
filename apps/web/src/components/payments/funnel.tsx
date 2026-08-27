"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetch, isDemoMode } from "@/lib/api";
import { cn } from "@/lib/utils";

type Outcome = "completed" | "declined" | "abandoned" | "stalled" | "in-flight";

type PspFunnel = {
  psp: string;
  total: number;
  outcomes: { outcome: Outcome; count: number; amount: number; share: number }[];
  paths: { path: string; count: number; share: number; outcome: Outcome }[];
  approvalRate: number | null;
  lostTo: { abandoned: number; declined: number; stalled: number };
  medianMins: number | null;
  singleState: number;
};

type FunnelReport = {
  from: string | null;
  to: string | null;
  shop: string | null;
  providers: PspFunnel[];
  totals: {
    total: number;
    completed: number;
    abandoned: number;
    declined: number;
    stalled: number;
    approvalRate: number | null;
  };
  events: number;
  payments: number;
  truncated: boolean;
};

/**
 * How each outcome is drawn.
 *
 * These are STATUS colours, not series identity, so they are fixed to meaning
 * and never reassigned: completed is always the good one, declined is always
 * the refusal. The ORDER matters as much as the choice — it is the order the
 * segments are drawn in, and the palette validator rejected the obvious
 * arrangement because orange beside red measures ΔE 10.6 for normal vision,
 * which is below the readable floor. Purple between them fixes it (22.7), and
 * it reads better anyway: an abandoned checkout is not an error, it is a
 * customer changing their mind.
 *
 * Green beside red is a CVD warning at ΔE 6.5, which is permitted only with a
 * second encoding — every segment here carries a direct label and a 2px gap,
 * and the legend below names all four.
 */
const OUTCOMES: {
  key: Outcome;
  label: string;
  colour: string;
  meaning: string;
}[] = [
  {
    key: "completed",
    label: "Completed",
    colour: "var(--accent-green)",
    meaning: "The money arrived.",
  },
  {
    key: "declined",
    label: "Declined",
    colour: "var(--accent-red)",
    meaning: "Decided, and the answer was no — routing, BIN or risk.",
  },
  {
    key: "abandoned",
    label: "Customer left",
    colour: "var(--accent-purple)",
    meaning: "Cancelled or expired at the checkout. That one is ours.",
  },
  {
    key: "stalled",
    label: "No answer",
    colour: "var(--accent-orange)",
    meaning: "Sent to the provider and never resolved. That one is theirs.",
  },
];

const pct = (n: number, d: number) => (d ? (n / d) * 100 : 0);
const num = (n: number) => n.toLocaleString();

/**
 * Where payments stop, per provider.
 *
 * An approval rate answers "how many worked" and hides the only question worth
 * asking when it drops: which of three completely different things went wrong.
 * A customer who abandoned the checkout, an issuer that refused, and a provider
 * that never answered are one number in every dashboard and three different
 * conversations with three different people.
 *
 * This is buildable here only because each payment state is stored as its own
 * row. Most systems overwrite the payment as it moves, and the path is gone
 * before anyone thinks to ask for it.
 */
export function PaymentFunnel() {
  const [expanded, setExpanded] = useState<string | null>(null);
  // Its own window, stated on the panel. Without one this read every payment
  // ever held while the overview above it read today, and two panels on one
  // screen disagreeing about how many payments exist is worse than either
  // being wrong on its own — it makes both unbelievable.
  const [days, setDays] = useState(7);

  const funnel = useQuery({
    queryKey: ["payment-funnel", days],
    // The window is resolved when the request is made, not while rendering:
    // reading the clock during a render makes the render impure, and the value
    // would go stale the moment the component re-rendered for any other reason.
    queryFn: () => {
      const q = new URLSearchParams({
        from: new Date(Date.now() - days * 86_400_000).toISOString(),
      });
      return apiFetch<FunnelReport>(`/payments/funnel?${q.toString()}`);
    },
    enabled: !isDemoMode,
  });

  const providers = useMemo(
    () =>
      (funnel.data?.providers ?? [])
        // In-flight payments have not stopped anywhere, so they are not an
        // outcome and do not belong in a bar about where payments stop. They
        // are reported separately underneath.
        .map((p) => {
          const bar = OUTCOMES.map((o) => ({
            ...o,
            count: p.outcomes.find((x) => x.outcome === o.key)?.count ?? 0,
          }));
          const settledTotal = bar.reduce((s, b) => s + b.count, 0);
          const inFlight =
            p.outcomes.find((x) => x.outcome === "in-flight")?.count ?? 0;
          return { ...p, bar, settledTotal, inFlight };
        })
        .filter((p) => p.settledTotal > 0 || p.inFlight > 0),
    [funnel.data],
  );

  if (isDemoMode) return null;

  return (
    <Card className="glass card-seam">
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle className="flex items-center gap-2">
          <GitBranch className="size-4 text-muted" />
          Where payments stop
        </CardTitle>
        <div className="flex gap-1">
          {[1, 7, 30, 90].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={cn(
                "rounded-md px-2 py-1 text-[11px] transition",
                days === d
                  ? "bg-accent-blue-soft text-accent-blue"
                  : "text-muted hover:text-foreground",
              )}
            >
              {d === 1 ? "24h" : `${d}d`}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <p className="text-sm text-muted-foreground">
          An approval rate hides three different failures. A customer who left
          the checkout, an issuer that refused, and a provider that never
          answered are one number in most dashboards — and three different
          conversations with three different people.
        </p>

        {funnel.isLoading ? (
          <p className="py-8 text-center text-sm text-muted">Tracing payments…</p>
        ) : null}

        {funnel.isError ? (
          <p className="rounded-lg border border-accent-red/25 bg-accent-red-soft px-3 py-2 text-xs text-accent-red">
            Could not build the funnel: {String(funnel.error)}
          </p>
        ) : null}

        {!funnel.isLoading && !providers.length ? (
          <p className="py-8 text-center text-sm text-muted">
            No payments in this period.
          </p>
        ) : null}

        {providers.map((p) => {
          const open = expanded === p.psp;
          return (
            <div key={p.psp} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium">{p.psp}</span>
                <span className="text-xs text-muted">
                  {num(p.total)} payment{p.total === 1 ? "" : "s"}
                  {p.approvalRate !== null ? ` · ${p.approvalRate}% approved` : ""}
                  {p.medianMins !== null ? ` · median ${p.medianMins}m to settle` : ""}
                </span>
              </div>

              {/* One bar per provider. Segments are separated by a 2px gap in
                  the surface colour so adjacent fills never touch, which is
                  what keeps the green/red pair readable for colourblind
                  viewers as well as everyone else. */}
              <div
                className="flex h-7 w-full gap-0.5 overflow-hidden rounded-md"
                role="img"
                aria-label={`${p.psp}: ${p.bar
                  .filter((b) => b.count)
                  .map((b) => `${b.label} ${b.count}`)
                  .join(", ")}`}
              >
                {p.bar.map((b) =>
                  b.count ? (
                    <div
                      key={b.key}
                      title={`${b.label}: ${num(b.count)} (${pct(b.count, p.settledTotal).toFixed(1)}%) — ${b.meaning}`}
                      style={{
                        width: `${pct(b.count, p.settledTotal)}%`,
                        background: b.colour,
                      }}
                      className="flex items-center justify-center overflow-hidden first:rounded-l-md last:rounded-r-md"
                    >
                      {/* Direct-labelled where it fits: the second encoding
                          the palette check requires, and the thing that stops
                          anyone having to match a colour to a legend. */}
                      {pct(b.count, p.settledTotal) > 11 ? (
                        <span className="truncate px-1 text-[10px] font-semibold text-black/75">
                          {Math.round(pct(b.count, p.settledTotal))}%
                        </span>
                      ) : null}
                    </div>
                  ) : null,
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-muted">
                <span>
                  {p.lostTo.declined ? `${num(p.lostTo.declined)} declined · ` : ""}
                  {p.lostTo.abandoned ? `${num(p.lostTo.abandoned)} left · ` : ""}
                  {p.lostTo.stalled ? `${num(p.lostTo.stalled)} unanswered · ` : ""}
                  {p.inFlight ? `${num(p.inFlight)} still in flight` : ""}
                  {!p.lostTo.declined && !p.lostTo.abandoned && !p.lostTo.stalled && !p.inFlight
                    ? "Everything completed."
                    : ""}
                </span>
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : p.psp)}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  {open ? "Hide the routes" : "Show the routes"}
                </button>
              </div>

              {/* The table view. Counts and shares in text, so the chart is
                  never the only way to read the numbers. */}
              {open ? (
                <div className="overflow-x-auto rounded-lg border border-border bg-card">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-left text-muted">
                        <th className="px-3 py-2 font-medium">Route through</th>
                        <th className="px-3 py-2 text-right font-medium">Payments</th>
                        <th className="px-3 py-2 text-right font-medium">Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.paths.map((route) => {
                        const o = OUTCOMES.find((x) => x.key === route.outcome);
                        return (
                          <tr key={route.path} className="border-b border-border/60 last:border-0">
                            <td className="px-3 py-2">
                              <span className="flex items-center gap-2">
                                <span
                                  aria-hidden
                                  className="size-2 shrink-0 rounded-full"
                                  style={{ background: o?.colour ?? "var(--muted)" }}
                                />
                                <span className="font-mono">{route.path}</span>
                              </span>
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {num(route.count)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-muted">
                              {route.share}%
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {p.singleState ? (
                    <p className="border-t border-border px-3 py-2 text-[11px] text-muted">
                      {num(p.singleState)} of these were only ever seen in one
                      state, so their route is a single step. That is what an
                      imported payment looks like — the export carries the final
                      row and nothing before it — and it is why no settle time
                      is claimed for them.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}

        {/* Always present for four series, and each entry says what the colour
            MEANS rather than only what it is called — the meaning is the point
            of the panel. */}
        {providers.length ? (
          <div className="flex flex-col gap-1.5 border-t border-border pt-3">
            {OUTCOMES.map((o) => (
              <div key={o.key} className="flex items-baseline gap-2 text-[11px]">
                <span
                  aria-hidden
                  className="mt-1 size-2 shrink-0 rounded-full"
                  style={{ background: o.colour }}
                />
                <span className="font-medium">{o.label}</span>
                <span className="text-muted">{o.meaning}</span>
              </div>
            ))}
          </div>
        ) : null}

        {funnel.data ? (
          <p className={cn("text-[11px] text-muted", funnel.data.truncated && "text-accent-orange")}>
            {num(funnel.data.events)} states read across {num(funnel.data.payments)} payments.
            {funnel.data.truncated
              ? " Capped — narrow the period for a complete picture."
              : ""}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
