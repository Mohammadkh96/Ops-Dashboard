"use client";

import { useMemo, useState } from "react";
import { ShieldPlus, Check, AlertTriangle } from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import { StatTileRow, type Stat } from "@/components/ui/stat-tile";
import { DataTable, type Column } from "@/components/ui/data-table";
import { FilterBar } from "@/components/ui/filter-bar";
import { StatusBadge, RiskBadge } from "@/components/ui/status-badge";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { kycCases, type KycCase } from "@/lib/modules";

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

export default function CompliancePage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [risk, setRisk] = useState("");
  const [selected, setSelected] = useState<KycCase | null>(null);

  const stats: Stat[] = useMemo(() => {
    const pending = kycCases.filter((c) => c.status === "pending").length;
    const inReview = kycCases.filter((c) => c.status === "in_review").length;
    const edd = kycCases.filter((c) => c.status === "edd_required").length;
    const avg = Math.round(
      kycCases.reduce((sum, c) => sum + c.riskScore, 0) / kycCases.length,
    );
    return [
      { label: "Pending KYC", value: String(pending), tone: "blue", spark: [1, 2, 1, 3, 2, 2, pending] },
      { label: "In review", value: String(inReview), tone: "purple", spark: [3, 2, 4, 2, 3, 2, inReview] },
      { label: "EDD required", value: String(edd), tone: "orange", spark: [0, 1, 1, 2, 1, 1, edd] },
      { label: "Avg risk score", value: String(avg), tone: "red", delta: { text: `${kycCases.length} open cases`, positive: false } },
    ];
  }, []);

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
    [search, status, risk],
  );

  const columns: Column<KycCase>[] = [
    { key: "client", header: "Client", render: (c) => <span className="font-medium">{c.client}</span> },
    { key: "country", header: "Country", render: (c) => <span className="text-muted-foreground">{c.country}</span> },
    { key: "documents", header: "Documents", render: (c) => <span className="tnum text-muted-foreground">{c.documents}</span> },
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

      <div className="flex flex-col gap-4">
        <FilterBar
          search={search}
          onSearch={setSearch}
          searchPlaceholder="Search client, country…"
          filters={[
            { label: "Status", value: status, onChange: setStatus, options: STATUS_OPTIONS },
            { label: "Risk", value: risk, onChange: setRisk, options: RISK_OPTIONS },
          ]}
        >
          <span className="ml-auto text-xs text-muted">
            {filtered.length} of {kycCases.length}
          </span>
        </FilterBar>

        <DataTable
          columns={columns}
          rows={filtered}
          getRowKey={(c) => c.id}
          onRowClick={setSelected}
          empty="No KYC cases match these filters."
        />
      </div>

      <Drawer
        open={selected !== null}
        onOpenChange={(o) => !o && setSelected(null)}
        title={selected?.client ?? ""}
        subtitle={selected ? `${selected.country} · ${selected.documents} documents` : ""}
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
                ["Documents", String(selected.documents)],
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
