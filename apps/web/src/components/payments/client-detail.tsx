"use client";

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
  recent: {
    id: string;
    reference: string;
    type: string;
    status: string;
    state: string | null;
    amount: number;
    currency: string | null;
    psp: string | null;
    method: string | null;
    at: string | null;
  }[];
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
 */
export function ClientDetail({ reference }: { reference: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["client", reference],
    queryFn: () =>
      apiFetch<ClientProfile | null>(
        `/clients/${encodeURIComponent(reference)}`,
      ),
    enabled: !isDemoMode,
  });

  if (isDemoMode)
    return (
      <p className="text-xs text-muted">
        Client history is read from the API and is not available in demo mode.
      </p>
    );
  if (isLoading) return <p className="text-xs text-muted">Loading client…</p>;
  if (isError || !data)
    return <p className="text-xs text-muted">No payments found for this client.</p>;

  const lt = data.providerLifetime;
  const hasProviderLifetime =
    lt.depositsCount !== null ||
    lt.depositsAmount !== null ||
    lt.withdrawalsCount !== null ||
    lt.withdrawalsAmount !== null;

  return (
    <div className="flex flex-col gap-6">
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
          note={`From the ${data.payments} payment${data.payments === 1 ? "" : "s"} this dashboard has ingested — not necessarily the account's full history.`}
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

      {data.recent.length ? (
        <Section title="Recent payments">
          <div className="flex flex-col divide-y divide-border">
            {data.recent.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate">
                    {r.type}
                    {r.method ? ` · ${r.method}` : ""}
                    {r.psp ? ` · ${r.psp}` : ""}
                  </span>
                  <span className="tnum text-[11px] text-muted">
                    {r.at ? r.at.slice(0, 16).replace("T", " ") : "—"}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="tnum text-xs">
                    {money(r.amount, r.currency ?? "")}
                  </span>
                  {r.state ? <StatusBadge status={r.status} label={r.state} /> : null}
                </div>
              </div>
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  );
}
