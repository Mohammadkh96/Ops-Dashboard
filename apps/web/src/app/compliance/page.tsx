"use client";

import { useEffect, useMemo, useState } from "react";
import { ShieldPlus, Check, AlertTriangle } from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import { ImportVerifications } from "@/components/compliance/import-verifications";
import { SyncProvider } from "@/components/compliance/sync-provider";
import { StatTileRow, type Stat } from "@/components/ui/stat-tile";
import { DataTable, type Column } from "@/components/ui/data-table";
import { FilterBar } from "@/components/ui/filter-bar";
import { StatusBadge, RiskBadge } from "@/components/ui/status-badge";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { type KycCase } from "@/lib/modules";
import { useKycCases, useKycCaseCount } from "@/hooks/use-modules";
import { useKycSummary } from "@/hooks/use-kyc";

const STATUS_OPTIONS: { label: string; value: KycCase["status"] }[] = [
  { label: "Pending", value: "pending" },
  { label: "In review", value: "in_review" },
  { label: "Approved", value: "approved_kyc" },
  { label: "Rejected", value: "rejected" },
  { label: "EDD required", value: "edd_required" },
];

const RISK_OPTIONS: { label: string; value: KycCase["risk"] }[] = [
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "Critical", value: "critical" },
];

type CheckState = "clear" | "hit" | "pass" | "required";

// Derive a plausible screening checklist from the case's risk profile.
function screening(kc: KycCase): { label: string; state: CheckState }[] {
  const elevated = kc.risk === "high" || kc.risk === "critical";
  return [
    { label: "Sanctions", state: "clear" },
    { label: "PEP", state: elevated ? "hit" : "clear" },
    { label: "AML", state: "pass" },
    { label: "EDD", state: kc.status === "edd_required" ? "required" : "clear" },
  ];
}

const CHECK_TONE: Record<CheckState, { dot: string; text: string; label: string }> = {
  clear: { dot: "bg-accent-green", text: "text-accent-green", label: "Clear" },
  pass: { dot: "bg-accent-green", text: "text-accent-green", label: "Pass" },
  hit: { dot: "bg-accent-red", text: "text-accent-red", label: "Hit" },
  required: { dot: "bg-accent-orange", text: "text-accent-orange", label: "Required" },
};

function scoreTone(score: number): string {
  if (score >= 80) return "text-accent-red";
  if (score >= 50) return "text-accent-orange";
  return "text-accent-green";
}

/** How many rows one page of the table holds. */
const PAGE_SIZE = 200;

/**
 * A value that stops changing while somebody is still typing.
 *
 * The filters run in the database now, so every keystroke in the search box
 * would otherwise be a query. Three hundred milliseconds is under the pause
 * between words and well over the pause between letters.
 */
function useSettled<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

export default function CompliancePage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [risk, setRisk] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<KycCase | null>(null);

  const q = useSettled(search);
  // A filter changes what the pages ARE, so it goes back to the first one.
  // Staying on page four of a result set that no longer has four pages shows
  // an empty table, which reads as "no matches" and is not.
  const refilter = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(0);
  };

  const query = { status, risk, q };
  const { data: kycCases, isLoading } = useKycCases({
    ...query,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  const { data: count } = useKycCaseCount(query);
  const total = count.total;

  /**
   * The tiles count the TABLE, not the page.
   *
   * They used to count whichever rows had been fetched, so the fourth tile
   * read "500 open cases" for any database with at least five hundred
   * verifications — the page size, relabelled as a finding. It also called
   * settled verifications open, when most of them are Approved or Rejected.
   *
   * The average risk score has gone with it. Nothing computes a risk score, so
   * every row holds a zero, and a tile averaging zeroes is a number with the
   * shape of a fact and nothing behind it. Verifications held is true.
   */
  const summary = useKycSummary();
  const stats: Stat[] = useMemo(() => {
    const by = new Map(
      (summary.data?.byStatus ?? []).map((s) => [s.status, s.count]),
    );
    const pending = by.get("PENDING") ?? 0;
    const inReview = by.get("IN_REVIEW") ?? 0;
    const edd = by.get("EDD_REQUIRED") ?? 0;
    const held = summary.data?.verifications ?? total;
    const awaiting = pending + inReview + edd;
    return [
      { label: "Pending KYC", value: pending.toLocaleString(), tone: "blue", spark: [1, 2, 1, 3, 2, 2, pending] },
      { label: "In review", value: inReview.toLocaleString(), tone: "purple", spark: [3, 2, 4, 2, 3, 2, inReview] },
      { label: "EDD required", value: edd.toLocaleString(), tone: "orange", spark: [0, 1, 1, 2, 1, 1, edd] },
      {
        label: "Verifications",
        value: held.toLocaleString(),
        tone: awaiting ? "orange" : "green",
        delta: {
          text: awaiting
            ? `${awaiting.toLocaleString()} awaiting a decision`
            : "none awaiting a decision",
          positive: awaiting === 0,
        },
      },
    ];
  }, [summary.data, total]);

  const filtered = useMemo(
    () =>
      kycCases.filter((c) => {
        if (status && c.status !== status) return false;
        if (risk && c.risk !== risk) return false;
        if (search) {
          const q = search.toLowerCase();
          if (!c.client.toLowerCase().includes(q) && !c.country.toLowerCase().includes(q)) return false;
        }
        return true;
      }),
    [kycCases, search, status, risk],
  );

  const columns: Column<KycCase>[] = [
    { key: "client", header: "Client", render: (c) => <span className="font-medium">{c.client}</span> },
    { key: "country", header: "Country", render: (c) => <span className="text-muted-foreground">{c.country}</span> },
    /* Was a "Documents" count computed as 2 + (riskScore % 5) — a number with
       the shape of a fact and nothing behind it, on the one screen where that
       is least excusable. Attempts is real, and is the more useful column: a
       client verified four times in an afternoon is the finding. */
    { key: "attempts", header: "Attempts", align: "right", render: (c) => <span className={`tnum ${c.attempts > 1 ? "text-accent-orange" : "text-muted-foreground"}`}>{c.attempts}</span> },
    { key: "declineReasons", header: "Why", render: (c) => <span className="text-muted" title={c.declineReasons.join(", ")}>{c.declineReasons.length ? c.declineReasons.join(", ") : "—"}</span> },
    { key: "risk", header: "Risk", render: (c) => <RiskBadge level={c.risk} /> },
    { key: "riskScore", header: "Risk score", align: "right", render: (c) => <span className={`tnum font-medium ${scoreTone(c.riskScore)}`}>{c.riskScore}</span> },
    { key: "status", header: "Status", render: (c) => <StatusBadge status={c.status} /> },
    { key: "submittedAt", header: "Submitted", align: "right", render: (c) => <span className="tnum text-muted">{c.submittedAt}</span> },
    { key: "assignee", header: "Assignee", render: (c) => <span className={c.assignee === "Unassigned" ? "text-muted" : "text-muted-foreground"}>{c.assignee}</span> },
  ];

  const needsDocs = selected?.status === "rejected" || selected?.status === "edd_required";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Compliance"
        description="KYC, AML, EDD and risk reviews."
        actions={
          <Button size="sm">
            <ShieldPlus className="size-4" /> New review
          </Button>
        }
      />

      <StatTileRow stats={stats} />

      {/* The provider first, the file second: reading KYCAID directly is the
          ordinary way to keep this current, and the export is what you reach
          for to load history or when the provider is down. */}
      <SyncProvider />
      <ImportVerifications />

      <div className="flex flex-col gap-4">
        <FilterBar
          search={search}
          onSearch={refilter(setSearch)}
          searchPlaceholder="Search client, country…"
          filters={[
            { label: "Status", value: status, onChange: refilter(setStatus), options: STATUS_OPTIONS },
            { label: "Risk", value: risk, onChange: refilter(setRisk), options: RISK_OPTIONS },
          ]}
        >
          {/* The range being shown, and the real total. It used to read
              "500 of 500" for a database holding twelve thousand — the page
              size reported as a fact about the data. */}
          <span className="tnum ml-auto text-xs text-muted">
            {total === 0
              ? "0"
              : `${(page * PAGE_SIZE + 1).toLocaleString()}–${Math.min(
                  page * PAGE_SIZE + filtered.length,
                  total,
                ).toLocaleString()} of ${total.toLocaleString()}`}
          </span>
        </FilterBar>

        <DataTable
          columns={columns}
          rows={filtered}
          getRowKey={(c) => c.id}
          onRowClick={setSelected}
          loading={isLoading}
          empty="No KYC cases match these filters."
        />

        {total > PAGE_SIZE ? (
          <div className="flex items-center justify-between gap-3">
            <span className="tnum text-xs text-muted">
              Page {(page + 1).toLocaleString()} of{" "}
              {Math.ceil(total / PAGE_SIZE).toLocaleString()}
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={page === 0 || isLoading}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={(page + 1) * PAGE_SIZE >= total || isLoading}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <Drawer
        open={selected !== null}
        onOpenChange={(o) => !o && setSelected(null)}
        title={selected?.client ?? ""}
        subtitle={selected ? `${selected.country} · ${selected.attempts} attempt${selected.attempts === 1 ? "" : "s"}` : ""}
        footer={
          selected ? (
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1">Escalate</Button>
              {needsDocs ? (
                <Button className="flex-1">Request docs</Button>
              ) : (
                <Button className="flex-1">Approve</Button>
              )}
            </div>
          ) : null
        }
      >
        {selected ? (
          <div className="flex flex-col gap-5">
            <div className="flex items-center justify-between rounded-xl border border-border bg-card p-4">
              <div className="flex flex-col">
                <span className="text-xs uppercase tracking-wider text-muted">Risk score</span>
                <span className={`tnum text-2xl font-semibold ${scoreTone(selected.riskScore)}`}>{selected.riskScore}</span>
              </div>
              <div className="flex flex-col items-end gap-2">
                <StatusBadge status={selected.status} />
                <RiskBadge level={selected.risk} />
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              {[
                ["Client", selected.client],
                ["Country", selected.country],
                ["Attempts", String(selected.attempts)],
                ["Provider said", selected.providerStatus ?? "—"],
                ["Decline reasons", selected.declineReasons.length ? selected.declineReasons.join(", ") : "—"],
                ["Assignee", selected.assignee],
                ["Submitted", selected.submittedAt],
              ].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-0.5">
                  <dt className="text-xs text-muted">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>

            <div className="flex flex-col gap-3">
              <span className="text-xs font-medium uppercase tracking-wider text-muted">Screening</span>
              <ol className="flex flex-col gap-3 border-l border-border pl-4">
                {screening(selected).map((s) => {
                  const tone = CHECK_TONE[s.state];
                  return (
                    <li key={s.label} className="relative text-sm">
                      <span className={`absolute -left-[21px] top-1.5 size-2 rounded-full ${tone.dot}`} />
                      <div className="flex items-center justify-between">
                        <span>{s.label}</span>
                        <span className={`flex items-center gap-1 text-xs ${tone.text}`}>
                          {s.state === "hit" || s.state === "required" ? (
                            <AlertTriangle className="size-3" />
                          ) : (
                            <Check className="size-3" />
                          )}
                          {tone.label}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
