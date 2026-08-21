"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { apiFetch, isDemoMode } from "@/lib/api";
import { StatusBadge } from "@/components/ui/status-badge";

type Tally = { count: number; amount: number };

export type ClientProfile = {
  reference: string;
  email: string | null;
  phone: string | null;
  accountNumber: string | null;
  country: string | null;
  citizenshipCountry: string | null;
  kycStatus: string | null;
  entity: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  payments: number;
  providerLifetime: {
    depositsCount: number | null;
    depositsAmount: number | null;
    withdrawalsCount: number | null;
    withdrawalsAmount: number | null;
    dateOfFirstDeposit: string | null;
  };
  totals: {
    currency: string;
    deposits: Tally;
    withdrawals: Tally;
    refunds: Tally;
    declined: Tally;
    pending: Tally;
  }[];
  methods: { label: string; count: number; amount: number }[];
  psps: { psp: string; count: number; amount: number; successRate: number | null }[];
  declineReasons: { reason: string; code: string | null; count: number }[];
  /** Every payment in the window, newest first. */
  history: {
    id: string;
    reference: string;
    type: "Deposit" | "Withdrawal" | "Refund";
    status: string;
    state: string | null;
    amount: number;
    currency: string | null;
    psp: string | null;
    method: string | null;
    at: string | null;
  }[];
  window: {
    from: string | null;
    to: string | null;
    truncated: boolean;
    heldFrom: string | null;
    heldTo: string | null;
  };
};

const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

function money(n: number, ccy: string) {
  const unit = SYMBOLS[ccy] ?? "";
  const v = n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return unit ? `${unit}${v}` : `${v} ${ccy}`;
}

const day = (s: string | null) => (s ? s.slice(0, 10) : "—");

/** An ISO instant as the operator's own clock reads it. */
const stamp = (s: string | null) =>
  s ? new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

/**
 * A Date as a `datetime-local` input value, in the browser's timezone.
 *
 * The input has no timezone of its own, so this pair of conversions — local
 * string in, ISO instant out — is what keeps "from 09:00" meaning nine in the
 * morning where the operator is sitting rather than nine UTC.
 */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** A `datetime-local` value as an ISO instant, or undefined if unset/invalid. */
function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const t = Date.parse(local);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

const HOUR = 3_600_000;
const PRESETS: { label: string; hours: number | null }[] = [
  { label: "All time", hours: null },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 24 * 7 },
  { label: "30d", hours: 24 * 30 },
  { label: "90d", hours: 24 * 90 },
];

type Kind = "all" | "Deposit" | "Withdrawal" | "Refund";
const KINDS: { key: Kind; label: string }[] = [
  { key: "all", label: "All" },
  { key: "Deposit", label: "Deposits" },
  { key: "Withdrawal", label: "Withdrawals" },
  { key: "Refund", label: "Refunds" },
];

function Row({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted">{label}</span>
      <span className="break-words text-sm">{value}</span>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium uppercase tracking-wider text-muted">
          {title}
        </span>
        {note ? <span className="text-[11px] text-muted">{note}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** A settled figure and, underneath, the attempts behind it. */
function Total({
  label,
  tally,
  currency,
  tone,
}: {
  label: string;
  tally: Tally;
  currency: string;
  tone: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-card p-3">
      <span className="text-[11px] text-muted">{label}</span>
      <span className={`tnum text-base font-semibold ${tone}`}>
        {money(tally.amount, currency)}
      </span>
      <span className="text-[11px] text-muted">
        {tally.count} {tally.count === 1 ? "payment" : "payments"}
      </span>
    </div>
  );
}

/**
 * One client, assembled from their payments.
 *
 * Opened from the customer reference in the table, which is the only identity
 * the provider puts on every payment and the thing a client quotes on the
 * phone. It answers what someone actually asks at that moment: has this person
 * ever funded successfully, how much have they taken out, which provider keeps
 * declining them.
 *
 * The two sources of truth are kept apart on purpose. Our figures cover the
 * payments this dashboard has ingested; Paymaxis reports its own lifetime
 * counters over the account's entire history. Presenting either as the other
 * would be wrong, so both are shown and labelled.
 *
 * The window belongs to this panel, not to the page. The filter above the table
 * answers "what is happening right now"; a client's history is a different
 * question asked at a different moment, and defaults to everything we hold.
 * Tying the two together meant opening a client from a 24h view and being told
 * they had never deposited.
 */
export function ClientDetail({ reference }: { reference: string }) {
  // Preset buttons write into these rather than being remembered as a preset:
  // a window computed from Date.now() on every render would change the query key
  // continuously, and this way the chosen range is visible and editable.
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [kind, setKind] = useState<Kind>("all");

  const fromIso = toIso(from);
  const toIso_ = toIso(to);

  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: ["client", reference, fromIso ?? "", toIso_ ?? ""],
    queryFn: () => {
      const q = new URLSearchParams();
      if (fromIso) q.set("from", fromIso);
      if (toIso_) q.set("to", toIso_);
      const qs = q.toString();
      return apiFetch<ClientProfile | null>(
        `/clients/${encodeURIComponent(reference)}${qs ? `?${qs}` : ""}`,
      );
    },
    enabled: !isDemoMode,
    // Keeping the previous profile on screen while a new window loads stops the
    // panel collapsing to "Loading…" every time a bound is nudged.
    placeholderData: (prev) => prev,
  });

  const applyPreset = (hours: number | null) => {
    if (hours === null) {
      setFrom("");
      setTo("");
      return;
    }
    const now = new Date();
    setFrom(toLocalInput(new Date(now.getTime() - hours * HOUR)));
    setTo(toLocalInput(now));
  };

  const windowControl = (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] uppercase tracking-wider text-muted">Period</span>
        {PRESETS.map((p) => {
          const active = p.hours === null ? !from && !to : false;
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => applyPreset(p.hours)}
              className={
                "rounded-md border px-2 py-1 text-xs transition-colors " +
                (active
                  ? "border-accent-blue/40 bg-accent-blue-soft text-accent-blue"
                  : "border-border text-muted-foreground hover:text-foreground")
              }
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-[11px] text-muted">From</span>
          <input
            type="datetime-local"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[11px] text-muted">To</span>
          <input
            type="datetime-local"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
          />
        </label>
        {from || to ? (
          <button
            type="button"
            onClick={() => applyPreset(null)}
            className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        ) : null}
        {isFetching ? <span className="pb-1 text-[11px] text-muted">Loading…</span> : null}
      </div>
      <span className="text-[11px] text-muted">
        This period applies to this client only — it is independent of the date
        filter above the table. With nothing set, every figure below covers the
        client&rsquo;s whole history as we hold it.
      </span>
    </div>
  );

  if (isDemoMode)
    return (
      <p className="text-xs text-muted">
        Client history is read from the API and is not available in demo mode.
      </p>
    );
  if (isLoading) return <p className="text-xs text-muted">Loading client…</p>;
  if (isError || !data)
    return (
      <div className="flex flex-col gap-4">
        {windowControl}
        <p className="text-xs text-muted">
          {from || to
            ? "No payments for this client in the selected period."
            : "No payments found for this client."}
        </p>
      </div>
    );

  const lt = data.providerLifetime;
  const windowed = Boolean(data.window.from || data.window.to);
  const counts = {
    Deposit: data.history.filter((h) => h.type === "Deposit").length,
    Withdrawal: data.history.filter((h) => h.type === "Withdrawal").length,
    Refund: data.history.filter((h) => h.type === "Refund").length,
  };
  const shown = kind === "all" ? data.history : data.history.filter((h) => h.type === kind);
  const periodNote = windowed
    ? `${stamp(data.window.from)} → ${data.window.to ? stamp(data.window.to) : "now"}`
    : "their whole history";
  const hasProviderLifetime =
    lt.depositsCount !== null ||
    lt.depositsAmount !== null ||
    lt.withdrawalsCount !== null ||
    lt.withdrawalsAmount !== null;

  return (
    <div className="flex flex-col gap-6">
      {windowControl}

      {/*
        What the store actually holds for this client. Without it, an empty
        stretch reads as "this client did nothing then" when it can equally mean
        "we had not started polling yet" — and the two call for opposite actions.
      */}
      {data.window.heldFrom ? (
        <p className="text-[11px] text-muted">
          Showing <span className="text-muted-foreground">{periodNote}</span>. We hold payments for
          this client from {stamp(data.window.heldFrom)} to {stamp(data.window.heldTo)}
          {data.window.truncated
            ? " — more than this request reads, so the figures below cover the most recent payments in the period, not all of them. Narrow the period for exact totals."
            : "."}
        </p>
      ) : null}

      <Section title="Client">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Row label="Reference" value={data.reference} />
          <Row label="Email" value={data.email} />
          <Row label="Phone" value={data.phone} />
          <Row label="Account number" value={data.accountNumber} />
          <Row label="Country" value={data.country} />
          <Row label="Citizenship" value={data.citizenshipCountry} />
          <Row label="KYC" value={data.kycStatus} />
          <Row label="Entity" value={data.entity} />
          <Row label="First payment seen" value={day(data.firstSeen)} />
          <Row label="Last payment seen" value={day(data.lastSeen)} />
        </div>
      </Section>

      {data.totals.map((t) => (
        <Section
          key={t.currency}
          title={`Settled · ${t.currency}`}
          note={
            `From the ${data.payments} payment${data.payments === 1 ? "" : "s"} ` +
            (windowed
              ? "in the selected period."
              : "this dashboard has ingested — not necessarily the account's full history.")
          }
        >
          <div className="grid grid-cols-2 gap-2">
            <Total label="Total deposits" tally={t.deposits} currency={t.currency} tone="text-accent-green" />
            <Total label="Total withdrawals" tally={t.withdrawals} currency={t.currency} tone="text-accent-magenta" />
            <Total label="Total refunds" tally={t.refunds} currency={t.currency} tone="text-accent-orange" />
            <Total label="Declined attempts" tally={t.declined} currency={t.currency} tone="text-accent-red" />
            {t.pending.count ? (
              <Total label="Still in flight" tally={t.pending} currency={t.currency} tone="text-accent-blue" />
            ) : null}
          </div>
        </Section>
      ))}

      {hasProviderLifetime ? (
        <Section
          title="Lifetime, per Paymaxis"
          note="The provider's own counters, over the whole account history."
        >
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Row
              label="Deposits"
              value={
                lt.depositsCount !== null || lt.depositsAmount !== null
                  ? `${lt.depositsCount ?? "—"} · ${lt.depositsAmount !== null ? lt.depositsAmount.toLocaleString() : "—"}`
                  : null
              }
            />
            <Row
              label="Withdrawals"
              value={
                lt.withdrawalsCount !== null || lt.withdrawalsAmount !== null
                  ? `${lt.withdrawalsCount ?? "—"} · ${lt.withdrawalsAmount !== null ? lt.withdrawalsAmount.toLocaleString() : "—"}`
                  : null
              }
            />
            <Row label="First deposit" value={lt.dateOfFirstDeposit} />
          </div>
        </Section>
      ) : null}

      {data.methods.length ? (
        <Section title="Methods used">
          <div className="flex flex-col gap-1.5">
            {data.methods.map((m) => (
              <div key={m.label} className="flex items-center justify-between gap-3 text-sm">
                <span>{m.label}</span>
                <span className="tnum text-xs text-muted">
                  {m.count} · settled {m.amount.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {data.psps.length ? (
        <Section title="PSPs used">
          <div className="flex flex-col gap-1.5">
            {data.psps.map((p) => (
              <div key={p.psp} className="flex items-center justify-between gap-3 text-sm">
                <span>{p.psp}</span>
                <span className="tnum text-xs text-muted">
                  {p.count} ·{" "}
                  {/* Only decided payments count toward this, so a client with
                      one pending attempt does not read as 0%. */}
                  {p.successRate === null ? "—" : `${p.successRate}% approved`}
                </span>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {data.declineReasons.length ? (
        <Section title="Why payments failed">
          <div className="flex flex-col gap-1.5">
            {data.declineReasons.map((d) => (
              <div key={d.reason} className="flex items-start justify-between gap-3 text-sm">
                <span className="text-accent-red">{d.reason}</span>
                <span className="tnum shrink-0 text-xs text-muted">{d.count}×</span>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      <Section
        title="Payment history"
        note={`Every payment in the period, newest first — deposits, withdrawals and refunds, settled or not.`}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          {KINDS.map((k) => {
            const n = k.key === "all" ? data.history.length : counts[k.key];
            return (
              <button
                key={k.key}
                type="button"
                onClick={() => setKind(k.key)}
                className={
                  "rounded-md border px-2 py-1 text-xs transition-colors " +
                  (kind === k.key
                    ? "border-accent-blue/40 bg-accent-blue-soft text-accent-blue"
                    : "border-border text-muted-foreground hover:text-foreground")
                }
              >
                {k.label} <span className="tnum text-muted">{n}</span>
              </button>
            );
          })}
        </div>

        {shown.length ? (
          // Scrolls inside the panel rather than being cut off at some arbitrary
          // count: the whole period is here, however long it is.
          <div className="max-h-[26rem] overflow-y-auto rounded-lg border border-border">
            <div className="flex flex-col divide-y divide-border">
              {shown.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate">
                      {r.type}
                      {r.method ? ` · ${r.method}` : ""}
                      {r.psp ? ` · ${r.psp}` : ""}
                    </span>
                    <span className="tnum text-[11px] text-muted">
                      {stamp(r.at)}
                      {r.reference ? ` · ${r.reference}` : ""}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="tnum text-xs">{money(r.amount, r.currency ?? "")}</span>
                    {r.state ? <StatusBadge status={r.status} label={r.state} /> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted">
            {data.history.length
              ? "No payments of this type in the period."
              : "No payments in the selected period."}
          </p>
        )}
      </Section>
    </div>
  );
}
