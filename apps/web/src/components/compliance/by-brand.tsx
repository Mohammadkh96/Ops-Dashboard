"use client";

import { Info } from "lucide-react";

import { useKycSummary, type KycFormBreakdown } from "@/hooks/use-kyc";

/**
 * One card per entity.
 *
 * THE ENTITY IS THE KYCAID ACCOUNT. Tradin Mauritius and Tradin Saint Lucia
 * hold separate accounts with separate tokens, and a verification is fetched
 * with the credential of exactly one of them — so the account is a fact about
 * where the row came from rather than an inference. The form was standing in
 * for this and is weaker: it can be renamed, and two accounts can name a form
 * the same thing.
 *
 * Two cards rather than one table because the question is never "how many
 * verifications are there" — it is whether THIS entity is verifying the people
 * it takes money from, and at what cost. A combined figure answers neither,
 * and looks perfectly healthy while one of the two is empty.
 */

const LABELS: Record<string, string> = {
  MU: "Mauritius",
  SL: "Saint Lucia",
};

function name(account: string | null): string {
  if (!account) return "Unattributed";
  return LABELS[account] ?? account;
}

export function ByBrand() {
  const { data } = useKycSummary();
  const accounts = data?.byAccount ?? [];
  if (!accounts.length) return null;

  // Named entities first, then anything the provider read did not attribute.
  const sorted = [...accounts].sort((a, b) => {
    if (!a.form !== !b.form) return a.form ? -1 : 1;
    return (a.form ?? "").localeCompare(b.form ?? "");
  });

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {sorted.map((a) => (
        <Card key={a.form ?? "(none)"} entity={a} />
      ))}
    </div>
  );
}

function Card({ entity: e }: { entity: KycFormBreakdown }) {
  const approved = e.byStatus.APPROVED ?? 0;
  const rejected = e.byStatus.REJECTED ?? 0;
  const awaiting =
    (e.byStatus.PENDING ?? 0) +
    (e.byStatus.IN_REVIEW ?? 0) +
    (e.byStatus.EDD_REQUIRED ?? 0) +
    (e.byStatus.NOT_STARTED ?? 0);

  /**
   * Of the DECIDED ones, not of everything.
   *
   * A pass rate that counts pending checks in the denominator falls whenever
   * the queue grows, which reads as quality dropping when nothing about the
   * decisions has changed.
   */
  const decided = approved + rejected;
  const pass = decided ? Math.round((approved / decided) * 100) : null;
  const unattributed = !e.form;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card/60 px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={`text-[13px] font-medium ${unattributed ? "text-accent-orange" : ""}`}
        >
          {name(e.form)}
        </span>
        <span className="tnum text-[11px] text-muted">
          {e.verifications.toLocaleString()} verification
          {e.verifications === 1 ? "" : "s"}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Figure label="Approved" value={approved} tone="text-accent-green" />
        <Figure label="Rejected" value={rejected} tone="text-accent-red" />
        <Figure
          label="Awaiting"
          value={awaiting}
          tone={awaiting ? "text-accent-orange" : "text-muted-foreground"}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
        <span>
          Pass rate{" "}
          <span className="tnum text-muted-foreground">
            {pass === null ? "—" : `${pass}%`}
          </span>
          {decided ? (
            <span className="text-muted"> of {decided.toLocaleString()} decided</span>
          ) : null}
        </span>
        <span>
          Spend{" "}
          <span className="tnum text-muted-foreground">
            €{e.spentEur.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </span>
        </span>
        {/* Kept and counted, never dropped: an application abandoned before it
            reached an account still cost money and still carries a reason. */}
        {e.unlinked ? (
          <span>
            No account{" "}
            <span className="tnum text-muted-foreground">
              {e.unlinked.toLocaleString()}
            </span>
          </span>
        ) : null}
      </div>

      {unattributed ? (
        <p className="flex items-start gap-1.5 text-[11px] text-accent-orange">
          <Info className="mt-px size-3.5 shrink-0" />
          These were loaded before the entity was recorded against each row, so
          they cannot be attributed to either account. Fetching those dates from
          the provider again assigns them.
        </p>
      ) : null}
    </div>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="flex flex-col">
      <span className={`tnum text-[18px] leading-tight font-medium ${tone}`}>
        {value.toLocaleString()}
      </span>
      <span className="text-[10px] tracking-wider text-muted uppercase">
        {label}
      </span>
    </div>
  );
}
