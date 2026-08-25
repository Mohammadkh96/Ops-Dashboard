"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Card, CardContent } from "@/components/ui/card";
import { apiFetch, isDemoMode } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Volume and outcome for a period, four ways: everything, deposits,
 * withdrawals, refunds.
 *
 * Each card answers three questions in the same order — how much moved, how
 * much of it succeeded, and what happened to the rest — because "is today going
 * well" is asked of all four at once, and a different layout per group makes
 * them uncomparable.
 *
 * The period belongs to this panel, not to the page: the overview is read
 * against a period somebody names ("how was Tuesday afternoon"), which moves
 * independently of whichever rows the table below is showing.
 *
 * On colour: this uses the dashboard's own tokens rather than copying the
 * provider console's four. Cancelled is NEUTRAL, not amber — nobody failed, the
 * customer walked away, and painting that in a warning colour puts an abandoned
 * checkout beside a refused card as though they were the same event. It also
 * removes the one pairing that was genuinely hard to read: red against amber
 * measures ΔE 10.6 in normal vision, and worse under colour-vision deficiency.
 *
 * What is left — green, red, neutral, blue — passes adjacent-pair separation
 * except green↔red, which is the classic confusion and is why identity never
 * rests on colour alone here: every segment wide enough carries its percentage,
 * segments are separated by a surface gap, and the legend names each state in
 * text beside its count and value.
 */

type StateKey = "completed" | "declined" | "cancelled" | "pending";

type Group = {
  key: "total" | "deposits" | "withdrawals" | "refunds";
  label: string;
  amount: number;
  count: number;
  successRate: number | null;
  decided: number;
  slices: { key: StateKey; count: number; amount: number; share: number }[];
};

type Report = {
  groups: Group[];
  from: string | null;
  to: string | null;
  currencies: string[];
  payments: number;
  events: number;
  truncated: boolean;
  shop: string | null;
  shops: { shop: string; entity: string | null; events: number }[];
};

const STATE: Record<StateKey, { label: string; color: string }> = {
  completed: { label: "Completed", color: "var(--accent-green)" },
  declined: { label: "Declined", color: "var(--accent-red)" },
  // Neutral on purpose: an abandoned checkout is not a fault, and a warning
  // colour would file it next to a refusal.
  cancelled: { label: "Cancelled", color: "var(--muted)" },
  pending: { label: "Pending", color: "var(--accent-blue)" },
};

/**
 * "Today" is a whole day, both ends. It used to send only a start, which made
 * the period "since midnight, unbounded" — not the day the provider console
 * reports, and open to anything dated ahead of now.
 *
 * `days` counts back from today INCLUSIVE, so 7d is the last seven whole days,
 * the same thing a console means by a date range.
 */
const PRESETS: { label: string; days: number }[] = [
  { label: "Today", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
];

const pad = (n: number) => String(n).padStart(2, "0");

function toLocalInput(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** The same wall-clock reading, but as UTC — for the UTC basis. */
function toUtcInput(d: Date): string {
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  );
}

/**
 * A datetime-local value as an instant, read in the chosen basis.
 *
 * This is the whole timezone question in one function. The provider reports its
 * day in UTC; an operator reads the clock on the wall. Taking one for the other
 * shifts the day boundary by the offset — which is why our "today" swept in the
 * tail of the provider's previous day and every bucket came out larger.
 */
function toIso(local: string, basis: "utc" | "local"): string | undefined {
  if (!local) return undefined;
  const t = Date.parse(basis === "utc" ? `${local}:00Z` : local);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Compact for the headline, exact underneath — both, never one rounded figure. */
function compact(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(2)}K`;
  return `${sign}${abs.toFixed(2)}`;
}

const exact = (n: number) =>
  n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The rate as a ring: one number, read at a glance, no axis needed. */
function Ring({ pct }: { pct: number | null }) {
  const r = 18;
  const c = 2 * Math.PI * r;
  const value = pct ?? 0;
  const tone =
    pct === null
      ? "var(--muted)"
      : pct >= 95
        ? "var(--accent-green)"
        : pct >= 80
          ? "var(--accent-orange)"
          : "var(--accent-red)";
  return (
    <div className="relative size-12 shrink-0">
      <svg viewBox="0 0 44 44" className="size-12 -rotate-90">
        <circle cx="22" cy="22" r={r} fill="none" stroke="var(--border)" strokeWidth="3.5" />
        {pct !== null ? (
          <circle
            cx="22" cy="22" r={r} fill="none" stroke={tone} strokeWidth="3.5"
            strokeLinecap="round"
            strokeDasharray={`${(value / 100) * c} ${c}`}
          />
        ) : null}
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold tnum">
        {pct === null ? "—" : `${pct}%`}
      </span>
    </div>
  );
}

function GroupCard({ g }: { g: Group }) {
  const visible = g.slices.filter((s) => s.count > 0);
  return (
    <Card className="glass card-seam">
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium">{g.label}</span>
            <span className="tnum text-xl font-semibold">${compact(g.amount)}</span>
            {/* The rounded headline is for scanning; this is the figure that
                gets typed into a reconciliation. */}
            <span className="tnum text-[11px] text-muted">${exact(g.amount)}</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <Ring pct={g.successRate} />
            <span className="text-[10px] text-muted">
              {g.decided ? `of ${g.decided} decided` : "no verdicts"}
            </span>
          </div>
        </div>

        {/* Share of payments by count. Segments are separated by a surface gap
            and labelled with their own percentage, so neither the boundary nor
            the identity depends on telling two colours apart. */}
        {g.count ? (
          <div className="flex flex-col gap-1">
            <div className="flex h-9 w-full gap-[2px] overflow-hidden rounded">
              {visible.map((s) => {
                const meta = STATE[s.key];
                return (
                  <div
                    key={s.key}
                    title={`${meta.label}: ${s.count} payment(s), ${s.share}%`}
                    style={{ width: `${Math.max(s.share, 2)}%`, backgroundColor: meta.color }}
                    className="rounded-[3px]"
                  />
                );
              })}
            </div>
            <div className="flex w-full gap-[2px]">
              {visible.map((s) => (
                <span
                  key={s.key}
                  style={{ width: `${Math.max(s.share, 2)}%` }}
                  className="tnum overflow-hidden text-center text-[10px] text-muted"
                >
                  {/* A label only where there is room for it. Below this the
                      numbers overlap each other and read as one nonsense
                      figure ("2%0%11%") — the legend underneath already carries
                      every count, so the small slices lose nothing. */}
                  {s.share >= 8 ? `${s.share}%` : ""}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <p className="py-2 text-xs text-muted">No payments in this period.</p>
        )}

        <ul className="flex flex-col gap-1 rounded-lg border border-border bg-card p-2.5">
          {g.slices.map((s) => {
            const meta = STATE[s.key];
            const dim = s.count === 0;
            return (
              <li key={s.key} className="flex items-center justify-between gap-3 text-xs">
                <span className={cn("flex items-center gap-1.5", dim && "opacity-45")}>
                  <span
                    aria-hidden
                    className="size-2 rounded-full"
                    style={{ backgroundColor: meta.color }}
                  />
                  {/* The state is named in text: colour is a second channel here,
                      never the only one. */}
                  <span>{meta.label}</span>
                  <span className="tnum text-muted">({s.count})</span>
                </span>
                <span className={cn("tnum", dim ? "text-muted" : "text-muted-foreground")}>
                  ${compact(s.amount)}
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

/** The whole days a preset covers, in the chosen basis. */
function presetWindow(days: number, basis: "utc" | "local") {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);
  if (basis === "utc") {
    start.setUTCDate(start.getUTCDate() - (days - 1));
    start.setUTCHours(0, 0, 0, 0);
    end.setUTCHours(23, 59, 0, 0);
    return { from: toUtcInput(start), to: toUtcInput(end) };
  }
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 0, 0);
  return { from: toLocalInput(start), to: toLocalInput(end) };
}

export function SuccessRateOverview() {
  // UTC by default, because that is how the provider stamps a payment and how
  // its console reports a day. Reading the same dates on a local clock shifts
  // the boundary by the offset and quietly changes which payments belong to the
  // period — the reason our figures sat above the console's.
  const [basis, setBasis] = useState<"utc" | "local">("utc");
  const [shop, setShop] = useState("");
  const [{ from, to }, setWindow] = useState(() => presetWindow(1, "utc"));
  const [preset, setPreset] = useState("Today");

  const fromIso = toIso(from, basis);
  const toIso_ = toIso(to, basis);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["success-rate", fromIso ?? "", toIso_ ?? "", shop],
    queryFn: () => {
      const q = new URLSearchParams();
      if (fromIso) q.set("from", fromIso);
      if (toIso_) q.set("to", toIso_);
      if (shop) q.set("shop", shop);
      const qs = q.toString();
      return apiFetch<Report>(`/payments/success-rate${qs ? `?${qs}` : ""}`);
    },
    enabled: !isDemoMode,
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });

  const apply = (p: (typeof PRESETS)[number]) => {
    setPreset(p.label);
    setWindow(presetWindow(p.days, basis));
  };

  const switchBasis = (next: "utc" | "local") => {
    setBasis(next);
    // Re-derive the window in the new basis rather than reinterpreting the same
    // wall-clock numbers, which would silently move the period by the offset.
    const p = PRESETS.find((x) => x.label === preset);
    if (p) setWindow(presetWindow(p.days, next));
  };

  const shopLabel = (s: { shop: string; entity: string | null }) =>
    s.entity ? `${s.shop} · ${s.entity}` : s.shop;

  if (isDemoMode) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-medium">Success rate</h3>
          <span className="text-[11px] text-muted">
            Completed as a share of decided payments — cancelled and in-flight are
            shown but not counted as failures. Money in is positive, money out
            negative, so the total is net flow.
            {data?.currencies.length && data.currencies.length > 1
              ? ` Amounts are as the provider books them in each shop's base currency (${data.currencies.join(", ")} seen).`
              : ""}
          </span>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          {/* One shop at a time is how the provider console reports; summing
              every shop made our figure the larger one and it read as wrong. */}
          {data?.shops.length ? (
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] text-muted">Shop</span>
              <select
                value={shop}
                onChange={(e) => setShop(e.target.value)}
                className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
              >
                <option value="">All shops</option>
                {data.shops.map((s) => (
                  <option key={s.shop} value={s.shop}>
                    {shopLabel(s)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-muted">Clock</span>
            <select
              value={basis}
              onChange={(e) => switchBasis(e.target.value as "utc" | "local")}
              className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
            >
              <option value="utc">UTC (matches Paymaxis)</option>
              <option value="local">This browser</option>
            </select>
          </label>

          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => apply(p)}
              className={cn(
                "rounded-md border px-2 py-1 text-xs transition-colors",
                preset === p.label
                  ? "border-accent-blue/40 bg-accent-blue-soft text-accent-blue"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {p.label}
            </button>
          ))}
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-muted">From</span>
            <input
              type="datetime-local"
              value={from}
              onChange={(e) => {
                setWindow((w) => ({ ...w, from: e.target.value }));
                setPreset("");
              }}
              className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-muted">To</span>
            <input
              type="datetime-local"
              value={to}
              onChange={(e) => {
                setWindow((w) => ({ ...w, to: e.target.value }));
                setPreset("");
              }}
              className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
            />
          </label>
        </div>
      </div>

      {isError ? (
        <p className="rounded-lg border border-accent-red/25 bg-accent-red-soft px-3 py-2 text-xs text-accent-red">
          The overview could not be read from the API, so no figures are shown —
          an out-of-date number here would be quoted as current.
        </p>
      ) : null}

      {data ? (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {data.groups.map((g) => (
              <GroupCard key={g.key} g={g} />
            ))}
          </div>
          <span className="text-[11px] text-muted">
            {data.payments.toLocaleString()} payment(s) in this period, each counted
            once at its latest state, from {data.events.toLocaleString()} stored
            state(s).{" "}
            {/* The exact instants queried. Any disagreement with another system
                is almost always the window, so it is stated rather than left to
                be inferred from two date pickers. */}
            {data.from ? (
              <>
                Window: {data.from} → {data.to ?? "open-ended"}
                {data.shop ? ` · shop ${data.shop}` : " · all shops"}.
              </>
            ) : null}
            {data.truncated
              ? " More than 20,000 states matched, so this is the most recent of them — narrow the period."
              : ""}
          </span>
        </>
      ) : isLoading ? (
        <p className="text-xs text-muted">Reading the period…</p>
      ) : null}
    </div>
  );
}
