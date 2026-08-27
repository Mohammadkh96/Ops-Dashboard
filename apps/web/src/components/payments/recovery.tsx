"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetch, isDemoMode } from "@/lib/api";
import { cn } from "@/lib/utils";

type CodeRecovery = {
  code: string;
  label: string;
  declines: number;
  retried: number;
  recovered: number;
  recoveryRate: number | null;
  overallRate: number | null;
  recoveredAmount: number;
  neverRetried: number;
  neverRetriedAmount: number;
  switchedProvider: { retried: number; recovered: number };
  medianMins: number | null;
};

type RecoveryReport = {
  declines: number;
  retried: number;
  recovered: number;
  recoveredAmount: number;
  recoveryRate: number | null;
  codes: CodeRecovery[];
  worthChasing: {
    code: string;
    label: string;
    neverRetried: number;
    amount: number;
    recoveryRate: number | null;
  }[];
  attempts: number;
  truncated: boolean;
};

const num = (n: number) => n.toLocaleString();
const money = (n: number) =>
  n.toLocaleString(undefined, { maximumFractionDigits: 0 });

/**
 * What happens after a decline, measured on this desk's own history.
 *
 * The industry quotes "about one in four declines can be recovered". That is
 * true of somebody else's traffic and useless as a decision — it cannot say
 * WHICH declines are worth chasing, and chasing the wrong ones costs a fee per
 * attempt and irritates customers whose card is genuinely dead.
 *
 * So the panel ranks the provider's own decline codes by what actually came
 * back. Two numbers per code that are easy to confuse and must not be: the
 * share of RETRIES that worked, and the count nobody retried at all. A code
 * with no retries has no rate — not a zero — because "nobody tried" and "every
 * try failed" point in opposite directions.
 */
export function RetryRecovery() {
  const [days, setDays] = useState(30);

  const recovery = useQuery({
    queryKey: ["payment-recovery", days],
    queryFn: () => {
      const q = new URLSearchParams({
        from: new Date(Date.now() - days * 86_400_000).toISOString(),
      });
      return apiFetch<RecoveryReport>(`/payments/recovery?${q.toString()}`);
    },
    enabled: !isDemoMode,
  });

  if (isDemoMode) return null;
  const d = recovery.data;

  return (
    <Card className="glass card-seam">
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle className="flex items-center gap-2">
          <RotateCcw className="size-4 text-muted" />
          What happens after a decline
        </CardTitle>
        <div className="flex gap-1">
          {[7, 30, 90].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setDays(n)}
              className={cn(
                "rounded-md px-2 py-1 text-[11px] transition",
                days === n
                  ? "bg-accent-blue-soft text-accent-blue"
                  : "text-muted hover:text-foreground",
              )}
            >
              {n}d
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <p className="text-sm text-muted-foreground">
          Measured here, not quoted from a benchmark. After a decline, did the
          customer try again — and did it work? Ranked by the provider&rsquo;s own
          decline codes, so &ldquo;retry the recoverable ones&rdquo; becomes a list
          rather than an opinion.
        </p>

        {recovery.isLoading ? (
          <p className="py-8 text-center text-sm text-muted">Pairing declines with retries…</p>
        ) : null}

        {recovery.isError ? (
          <p className="rounded-lg border border-accent-red/25 bg-accent-red-soft px-3 py-2 text-xs text-accent-red">
            Could not measure recovery: {String(recovery.error)}
          </p>
        ) : null}

        {d && !d.declines ? (
          <p className="py-8 text-center text-sm text-muted">
            Nothing was declined in this period.
          </p>
        ) : null}

        {d && d.declines ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: "Declined", value: num(d.declines) },
                { label: "Tried again", value: num(d.retried) },
                {
                  label: "Got through",
                  value: num(d.recovered),
                  tone: "text-accent-green",
                },
                {
                  label: "Money recovered",
                  value: money(d.recoveredAmount),
                  tone: "text-accent-green",
                },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-border bg-card p-3">
                  <div className={cn("text-lg font-semibold tabular-nums", s.tone)}>
                    {s.value}
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-muted">
                    {s.label}
                  </div>
                </div>
              ))}
            </div>

            {/* The queue. Ordered by money, but only codes that have ever come
                back — a code with a proven 0% recovery at the top of a work
                list is how the list gets abandoned. */}
            {d.worthChasing.length ? (
              <div className="flex flex-col gap-2">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted">
                  Worth chasing
                </span>
                <div className="overflow-x-auto rounded-lg border border-border bg-card">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-left text-muted">
                        <th className="px-3 py-2 font-medium">Decline code</th>
                        <th className="px-3 py-2 text-right font-medium">Never retried</th>
                        <th className="px-3 py-2 text-right font-medium">Sitting in them</th>
                        <th className="px-3 py-2 text-right font-medium">Recovers when tried</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.worthChasing.map((c) => (
                        <tr key={c.code} className="border-b border-border/60 last:border-0">
                          <td className="px-3 py-2 font-mono">{c.label}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {num(c.neverRetried)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {money(c.amount)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-accent-green">
                            {c.recoveryRate}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-muted">
                  Only codes that have actually come back before. Codes that never
                  recover are left off deliberately — a retry fee on a dead card is
                  a cost, not a chance.
                </p>
              </div>
            ) : null}

            <div className="flex flex-col gap-2">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted">
                Every decline code
              </span>
              <div className="overflow-x-auto rounded-lg border border-border bg-card">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-muted">
                      <th className="px-3 py-2 font-medium">Code</th>
                      <th className="px-3 py-2 text-right font-medium">Declines</th>
                      <th className="px-3 py-2 text-right font-medium">Retried</th>
                      <th className="px-3 py-2 text-right font-medium">Of those, worked</th>
                      <th className="px-3 py-2 text-right font-medium">Switching helped</th>
                      <th className="px-3 py-2 text-right font-medium">Recovered</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.codes.map((c) => (
                      <tr key={c.code} className="border-b border-border/60 last:border-0">
                        <td className="px-3 py-2 font-mono">{c.label}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{num(c.declines)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted">
                          {num(c.retried)}
                        </td>
                        <td
                          className={cn(
                            "px-3 py-2 text-right tabular-nums",
                            c.recoveryRate === null
                              ? "text-muted"
                              : c.recoveryRate > 0
                                ? "text-accent-green"
                                : "text-accent-red",
                          )}
                        >
                          {/* Nobody tried is not nought per cent. */}
                          {c.recoveryRate === null ? "nobody tried" : `${c.recoveryRate}%`}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted">
                          {c.switchedProvider.retried
                            ? `${c.switchedProvider.recovered}/${c.switchedProvider.retried}`
                            : "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {c.recoveredAmount ? money(c.recoveredAmount) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* The limits, on the panel rather than in a doc nobody opens. A
                number whose caveats are invisible gets quoted in a meeting as
                if it had none. */}
            <p className="text-[11px] leading-relaxed text-muted">
              Nothing in the payment data marks one payment as a retry of another —
              only refunds carry a parent. A retry here is <em>inferred</em>: the same
              customer, the same amount and currency, within six hours. That misses a
              customer who tried again with a different card for a different amount,
              so these figures are a floor rather than a measurement.
              {d.truncated ? " Capped — narrow the period." : ""}
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
