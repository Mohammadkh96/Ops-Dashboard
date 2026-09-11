"use client";

import { ArrowRight } from "lucide-react";

import { useKycSummary, type KycFormBreakdown } from "@/hooks/use-kyc";

/**
 * One card per entity, and clicking one opens that entity's desk.
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
 *
 * THE THIRD CARD IS GONE. "Unattributed" sat beside the two entities holding
 * every row loaded before the account column existed, which made it read as a
 * third brand. It answered no question anybody has — those rows are in the
 * table either way, and re-fetching their dates attributes them — and the
 * count is still reported by the fetch panel, where it belongs.
 *
 * The figures follow the page's date range, so these cards and the table below
 * them are always describing the same period.
 */

const LABELS: Record<string, string> = {
  MU: "Mauritius",
  SL: "Saint Lucia",
};

export function entityName(account: string | null | undefined): string {
  if (!account) return "All entities";
  return LABELS[account] ?? account;
}

export function ByBrand({
  from,
  to,
  selected,
  onSelect,
}: {
  from: string;
  to: string;
  /** The entity being shown, or "" for both. */
  selected: string;
  onSelect: (account: string) => void;
}) {
  const { data } = useKycSummary({ from, to });
  const accounts = (data?.byAccount ?? []).filter((a) => a.form);
  if (!accounts.length) return null;

  const shown = selected
    ? accounts.filter((a) => a.form === selected)
    : [...accounts].sort((a, b) => (a.form ?? "").localeCompare(b.form ?? ""));

  return (
    <div className={`grid gap-3 ${shown.length > 1 ? "sm:grid-cols-2" : ""}`}>
      {shown.map((a) => (
        <Card
          key={a.form ?? "(none)"}
          entity={a}
          open={Boolean(selected)}
          onOpen={() => onSelect(a.form ?? "")}
        />
      ))}
    </div>
  );
}

function Card({
  entity: e,
  open,
  onOpen,
}: {
  entity: KycFormBreakdown;
  open: boolean;
  onOpen: () => void;
}) {
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

  /**
   * A button, not a div with a click handler: this navigates, so it has to be
   * reachable from the keyboard and announce itself as something that acts.
   * With an entity already open it is inert — a heading, not a link to here.
   */
  return (
    <button
      type="button"
      disabled={open}
      onClick={onOpen}
      className={`group flex flex-col gap-3 rounded-xl border border-border bg-card/60 px-4 py-3 text-left ${
        open
          ? ""
          : "cursor-pointer transition-colors hover:border-border-strong hover:bg-card"
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[13px] font-medium">
          {entityName(e.form)}
          {open ? null : (
            <ArrowRight className="size-3 text-muted opacity-0 transition-opacity group-hover:opacity-100" />
          )}
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
    </button>
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
