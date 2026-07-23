"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Upload,
  Play,
  Plus,
  Trash2,
  Pencil,
  FileSpreadsheet,
  RotateCcw,
  Database,
  Download,
  AlertTriangle,
  X,
} from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import { StatTileRow, type Stat } from "@/components/ui/stat-tile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

import { parseFile } from "@/lib/recon/parse";
import { loadPsps, savePsps, resetPsps, DEFAULT_PSPS, emptyPsp, missingColumns, CRM_MAP, CASHIER_MAP } from "@/lib/recon/registry";
import { runReconciliation } from "@/lib/recon/engine";
import { reconRowsToCsv, downloadText } from "@/lib/recon/export";
import { loadPspsRemote, savePspsRemote, saveRunRemote, listRunsRemote, type RunSummaryRow } from "@/lib/recon/api";
import type { Dataset, PspConfig, ReconResult, ReconRow } from "@/lib/recon/types";
import { sampleCrm, sampleCashier, samplePaystrax, sampleForumpay } from "@/lib/recon/sample";
import { useAuth } from "@/lib/auth";

const RESULT_KEY = "opsos.recon.result";

const input =
  "h-9 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none transition-colors focus:border-border-strong";
const label = "text-[11px] font-medium uppercase tracking-wider text-muted";

const TABS = [
  { key: "sources", label: "Sources" },
  { key: "psps", label: "PSP Registry" },
  { key: "results", label: "Results" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const STATUS_META: Record<ReconRow["status"], { label: string; variant: "green" | "orange" | "red" | "purple" }> = {
  matched: { label: "Matched", variant: "green" },
  amount: { label: "Amount", variant: "orange" },
  status: { label: "Status Mismatch", variant: "red" },
  "unmatched-cashier": { label: "Unmatched (Cashier)", variant: "purple" },
  "unmatched-psp": { label: "Unmatched (PSP)", variant: "purple" },
  "unmatched-crm": { label: "Unmatched (CRM)", variant: "purple" },
};

const money = (n: number | null) =>
  n === null ? "—" : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function ReconciliationPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [tab, setTab] = useState<TabKey>("sources");
  const [psps, setPsps] = useState<PspConfig[]>([]);
  const [datasets, setDatasets] = useState<Record<string, Dataset>>({});
  const [result, setResult] = useState<ReconResult | null>(null);
  const [editing, setEditing] = useState<PspConfig | null>(null);
  const [warnings, setWarnings] = useState<Record<string, string[]>>({});
  const [runs, setRuns] = useState<RunSummaryRow[]>([]);

  useEffect(() => {
    setPsps(loadPsps());
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      try {
        const raw = window.localStorage.getItem(RESULT_KEY);
        if (raw) setResult(JSON.parse(raw) as ReconResult);
      } catch {
        /* ignore */
      }
      // Live mode: prefer the shared server-side registry + run history.
      const remote = await loadPspsRemote();
      if (active && remote) {
        setPsps(remote);
        savePsps(remote);
      }
      const history = await listRunsRemote();
      if (active && history.length) setRuns(history);
    });
    return () => {
      active = false;
    };
  }, []);

  const validateSource = (key: string, headers: string[]): string[] => {
    const have = new Set(headers.map((h) => h.toLowerCase().trim()));
    const anyOf = (cols: string[]) => cols.some((c) => have.has(c.toLowerCase()));
    if (key === "crm") {
      const miss: string[] = [];
      if (!anyOf(CRM_MAP.idCols)) miss.push("reference/id");
      if (!have.has(CRM_MAP.amountCol.toLowerCase())) miss.push("amount");
      return miss;
    }
    if (key === "cashier") {
      const miss: string[] = [];
      if (!anyOf(CASHIER_MAP.idCols)) miss.push("id");
      if (!CASHIER_MAP.amountCol.split(",").some((c) => have.has(c.trim().toLowerCase()))) miss.push("amount");
      return miss;
    }
    const cfg = psps.find((p) => p.id === key);
    return cfg ? missingColumns(cfg, headers) : [];
  };

  const persist = (next: PspConfig[]) => {
    setPsps(next);
    savePsps(next);
    void savePspsRemote(next);
  };

  const setData = (key: string, ds: Dataset) => setDatasets((d) => ({ ...d, [key]: ds }));
  const clearData = (key: string) => {
    setDatasets((d) => {
      const next = { ...d };
      delete next[key];
      return next;
    });
    setWarnings((w) => {
      const next = { ...w };
      delete next[key];
      return next;
    });
  };

  const readFile = async (key: string, file: File) => {
    try {
      const ds = await parseFile(file);
      if (ds.rows.length === 0) {
        toast({ kind: "warning", title: "Empty file", description: "No data rows found." });
        return;
      }
      setData(key, ds);
      const miss = validateSource(key, ds.headers);
      setWarnings((w) => ({ ...w, [key]: miss }));
      if (miss.length) {
        toast({ kind: "warning", title: `${file.name}: column check`, description: `Missing/renamed: ${miss.join(", ")}. Loaded anyway.` });
      } else {
        toast({ title: `${file.name} loaded`, description: `${ds.rows.length} rows, ${ds.headers.length} columns.` });
      }
    } catch {
      toast({ kind: "warning", title: "Could not read file", description: "Use CSV, TSV, XLS or XLSX." });
    }
  };

  const loadSample = () => {
    setDatasets({
      crm: sampleCrm(),
      cashier: sampleCashier(),
      paystrax: samplePaystrax(),
      forumpay: sampleForumpay(),
    });
    setWarnings({});
    toast({ title: "Sample data loaded", description: "CRM, Cashier, Paystrax and ForumPay populated." });
  };

  const run = () => {
    if (!datasets.crm || !datasets.cashier) {
      toast({ kind: "warning", title: "Missing sources", description: "CRM and Cashier files are required." });
      return;
    }
    const pspData: Record<string, Dataset> = {};
    psps.forEach((p) => {
      if (datasets[p.id]) pspData[p.id] = datasets[p.id];
    });
    const res = runReconciliation(datasets.crm, datasets.cashier, psps, pspData, new Date().toISOString());
    setResult(res);
    try {
      window.localStorage.setItem(RESULT_KEY, JSON.stringify(res));
    } catch {
      /* result too large to persist — keep in memory only */
    }
    setTab("results");
    toast({ title: "Reconciliation complete", description: `${res.exceptions.length} exception(s) found.` });
    // Live mode: persist the run server-side and refresh shared history.
    void saveRunRemote(res, user?.email).then(() => listRunsRemote()).then((h) => {
      if (h.length) setRuns(h);
    });
  };

  const removePsp = (id: string) => {
    persist(psps.filter((p) => p.id !== id));
    clearData(id);
    toast({ kind: "info", title: "PSP removed", description: "It will no longer appear in sources or recon." });
  };

  const savePsp = (cfg: PspConfig) => {
    const exists = psps.some((p) => p.id === cfg.id);
    persist(exists ? psps.map((p) => (p.id === cfg.id ? cfg : p)) : [...psps, cfg]);
    setEditing(null);
    toast({ title: exists ? "PSP updated" : "PSP added", description: `${cfg.label} is now part of the recon.` });
  };

  const restore = () => {
    resetPsps();
    setPsps(DEFAULT_PSPS);
    toast({ kind: "info", title: "Registry reset", description: "Built-in PSPs restored." });
  };

  const canRun = Boolean(datasets.crm && datasets.cashier);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Reconciliation"
        description="Config-driven matching across CRM, Cashier and every PSP — add a PSP without touching code."
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={loadSample}>
              <Database className="size-4" /> Load sample
            </Button>
            <Button size="sm" onClick={run} disabled={!canRun}>
              <Play className="size-4" /> Run reconciliation
            </Button>
          </div>
        }
      />

      <div className="flex items-center gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "relative px-3 py-2.5 text-sm font-medium transition-colors",
              tab === t.key ? "text-foreground" : "text-muted hover:text-muted-foreground",
            )}
          >
            {t.label}
            {t.key === "results" && result ? (
              <span className="ml-1.5 rounded-full bg-accent-red-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent-red">
                {result.exceptions.length}
              </span>
            ) : null}
            {tab === t.key ? (
              <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent-blue" />
            ) : null}
          </button>
        ))}
      </div>

      {tab === "sources" ? (
        <SourcesTab psps={psps} datasets={datasets} warnings={warnings} onFile={readFile} onClear={clearData} />
      ) : tab === "psps" ? (
        <PspRegistryTab
          psps={psps}
          onAdd={() => setEditing(emptyPsp())}
          onEdit={(p) => setEditing(p)}
          onRemove={removePsp}
          onRestore={restore}
        />
      ) : (
        <ResultsTab result={result} runs={runs} />
      )}

      {editing ? (
        <PspEditor
          initial={editing}
          existingIds={psps.map((p) => p.id)}
          onCancel={() => setEditing(null)}
          onSave={savePsp}
        />
      ) : null}
    </div>
  );
}

/* ─────────────── Sources ─────────────── */

function SourceCard({
  title,
  desc,
  ds,
  warning,
  onFile,
  onClear,
}: {
  title: string;
  desc: string;
  ds?: Dataset;
  warning?: string[];
  onFile: (f: File) => void;
  onClear?: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
      }}
      className={cn(
        "flex flex-col gap-3 rounded-xl border bg-card p-4 transition-colors",
        drag ? "border-accent-blue bg-accent-blue-soft" : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">{title}</span>
          <span className="text-xs text-muted">{desc}</span>
        </div>
        {ds ? (
          warning && warning.length ? (
            <Badge variant="orange">Check columns</Badge>
          ) : (
            <Badge variant="green">Loaded</Badge>
          )
        ) : (
          <Badge variant="default">Empty</Badge>
        )}
      </div>

      {ds ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2 text-xs">
            <span className="flex items-center gap-2 text-muted-foreground">
              <FileSpreadsheet className="size-3.5 text-accent-blue" />
              {ds.fileName || "data"} · {ds.rows.length} rows
            </span>
            {onClear ? (
              <button onClick={onClear} aria-label="Remove file" className="text-muted hover:text-accent-red">
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
          {warning && warning.length ? (
            <span className="flex items-center gap-1.5 text-[11px] text-accent-orange">
              <AlertTriangle className="size-3" /> Missing/renamed: {warning.join(", ")}
            </span>
          ) : null}
        </div>
      ) : (
        <button
          onClick={() => ref.current?.click()}
          className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border-strong py-3 text-xs text-muted transition-colors hover:border-accent-blue hover:text-accent-blue"
        >
          <Upload className="size-3.5" /> Drop CSV or click to upload
        </button>
      )}
      <input
        ref={ref}
        type="file"
        accept=".csv,.tsv,.txt,.xls,.xlsx"
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.[0]) onFile(e.target.files[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function SourcesTab({
  psps,
  datasets,
  warnings,
  onFile,
  onClear,
}: {
  psps: PspConfig[];
  datasets: Record<string, Dataset>;
  warnings: Record<string, string[]>;
  onFile: (key: string, f: File) => void;
  onClear: (key: string) => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs text-muted">Accepts CSV, TSV, XLS and XLSX. Files are parsed in your browser and never uploaded anywhere.</p>
      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Core sources (required)</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <SourceCard title="CRM export" desc="The book of record — customer transactions." ds={datasets.crm} warning={warnings.crm} onFile={(f) => onFile("crm", f)} onClear={() => onClear("crm")} />
          <SourceCard title="Cashier / Paymaxis" desc="The processing layer that routes to PSPs." ds={datasets.cashier} warning={warnings.cashier} onFile={(f) => onFile("cashier", f)} onClear={() => onClear("cashier")} />
        </div>
      </div>
      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">
          PSP sources ({psps.length}) — one upload slot per registered PSP
        </h3>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {psps.map((p) => (
            <SourceCard
              key={p.id}
              title={p.label}
              desc={p.entity === "All" ? "Optional PSP export" : `${p.entity} · optional`}
              ds={datasets[p.id]}
              warning={warnings[p.id]}
              onFile={(f) => onFile(p.id, f)}
              onClear={() => onClear(p.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─────────────── PSP registry ─────────────── */

function PspRegistryTab({
  psps,
  onAdd,
  onEdit,
  onRemove,
  onRestore,
}: {
  psps: PspConfig[];
  onAdd: () => void;
  onEdit: (p: PspConfig) => void;
  onRemove: (id: string) => void;
  onRestore: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Each PSP is a <span className="text-foreground">configuration</span>, not code. Define its
          column mappings and status synonyms here; the engine reads them at run time. Add a new PSP
          and its upload slot appears under Sources automatically.
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={onRestore}>
            <RotateCcw className="size-4" /> Reset
          </Button>
          <Button size="sm" onClick={onAdd}>
            <Plus className="size-4" /> Add PSP
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {psps.map((p) => (
          <div key={p.id} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{p.label}</span>
                <Badge variant={p.entity === "All" ? "blue" : "purple"}>{p.entity}</Badge>
                {p.builtin ? <Badge variant="default">Built-in</Badge> : <Badge variant="green">Custom</Badge>}
              </div>
              <div className="flex gap-1">
                <button onClick={() => onEdit(p)} aria-label="Edit" className="flex size-8 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-card-hover">
                  <Pencil className="size-3.5" />
                </button>
                <button onClick={() => onRemove(p.id)} aria-label="Remove" className="flex size-8 items-center justify-center rounded-lg border border-border text-muted-foreground hover:border-accent-red/30 hover:bg-accent-red-soft hover:text-accent-red">
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              <Meta k="Match keys" v={p.fields.idCols.join(", ") || "—"} />
              <Meta k="Amount" v={p.fields.amountCol || "—"} />
              <Meta k="Status" v={p.fields.statusCol || "—"} />
              <Meta k="Date" v={p.fields.dateCol || "—"} />
              <Meta k="Amount tol." v={`±${p.amountTolerance}`} />
              <Meta k="Time window" v={`${p.dateWindowMins}m`} />
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-muted">{k}</dt>
      <dd className="truncate font-mono text-muted-foreground">{v}</dd>
    </div>
  );
}

/* ─────────────── PSP editor (modal) ─────────────── */

function PspEditor({
  initial,
  existingIds,
  onCancel,
  onSave,
}: {
  initial: PspConfig;
  existingIds: string[];
  onCancel: () => void;
  onSave: (cfg: PspConfig) => void;
}) {
  const [f, setF] = useState<PspConfig>(initial);
  const isNew = !initial.id;

  const set = (patch: Partial<PspConfig>) => setF((prev) => ({ ...prev, ...patch }));
  const setField = (patch: Partial<PspConfig["fields"]>) =>
    setF((prev) => ({ ...prev, fields: { ...prev.fields, ...patch } }));

  const idErr =
    isNew && f.id && existingIds.includes(f.id) ? "A PSP with this ID already exists" : "";
  const valid = f.id.trim() && f.label.trim() && f.fields.idCols.length > 0 && f.fields.amountCol.trim() && !idErr;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onCancel}>
      <div
        className="glass card-seam flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <span className="text-sm font-semibold">{isNew ? "Add PSP" : `Edit ${initial.label}`}</span>
          <button onClick={onCancel} aria-label="Close" className="text-muted hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-2 gap-3">
            <Fld label="PSP ID (slug)">
              <input
                className={input}
                value={f.id}
                disabled={!isNew}
                placeholder="e.g. stripe"
                onChange={(e) => set({ id: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") })}
              />
            </Fld>
            <Fld label="Display name">
              <input className={input} value={f.label} placeholder="Stripe" onChange={(e) => set({ label: e.target.value })} />
            </Fld>
          </div>
          {idErr ? <p className="-mt-2 text-xs text-accent-red">{idErr}</p> : null}

          <Fld label="Entity">
            <select className={input} value={f.entity} onChange={(e) => set({ entity: e.target.value })}>
              <option value="All">All</option>
              <option value="Mauritius">Mauritius</option>
              <option value="Saint Lucia">Saint Lucia</option>
            </select>
          </Fld>

          <Fld label="Match-key columns (comma-separated — matched against Cashier ID / Reference / External Id)">
            <input
              className={input}
              value={f.fields.idCols.join(", ")}
              placeholder="UniqueId, TransactionId"
              onChange={(e) => setField({ idCols: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
            />
          </Fld>

          <div className="grid grid-cols-2 gap-3">
            <Fld label="Amount column(s)">
              <input className={input} value={f.fields.amountCol} placeholder="Debit,Credit" onChange={(e) => setField({ amountCol: e.target.value })} />
            </Fld>
            <Fld label="Currency column">
              <input className={input} value={f.fields.currencyCol ?? ""} placeholder="Currency" onChange={(e) => setField({ currencyCol: e.target.value })} />
            </Fld>
            <Fld label="Status column">
              <input className={input} value={f.fields.statusCol ?? ""} placeholder="Result" onChange={(e) => setField({ statusCol: e.target.value })} />
            </Fld>
            <Fld label="Type column">
              <input className={input} value={f.fields.typeCol ?? ""} placeholder="PaymentType" onChange={(e) => setField({ typeCol: e.target.value })} />
            </Fld>
            <Fld label="Date column">
              <input className={input} value={f.fields.dateCol ?? ""} placeholder="RequestTimestamp" onChange={(e) => setField({ dateCol: e.target.value })} />
            </Fld>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Fld label="Active status synonyms">
              <input className={input} value={f.activeStatuses.join(", ")} placeholder="APPROVED, OK" onChange={(e) => set({ activeStatuses: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
            </Fld>
            <Fld label="Failed status synonyms">
              <input className={input} value={f.failedStatuses.join(", ")} placeholder="DECLINED, ERROR" onChange={(e) => set({ failedStatuses: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
            </Fld>
            <Fld label="Amount tolerance">
              <input type="number" step="0.01" className={input} value={f.amountTolerance} onChange={(e) => set({ amountTolerance: Number(e.target.value) })} />
            </Fld>
            <Fld label="Time window (minutes)">
              <input type="number" className={input} value={f.dateWindowMins} onChange={(e) => set({ dateWindowMins: Number(e.target.value) })} />
            </Fld>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Fld label="Deposit type values (optional)">
              <input className={input} value={(f.depositTypes ?? []).join(", ")} placeholder="DB, SELL" onChange={(e) => set({ depositTypes: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
            </Fld>
            <Fld label="Withdrawal type values (optional)">
              <input className={input} value={(f.withdrawalTypes ?? []).join(", ")} placeholder="CD, BUY" onChange={(e) => set({ withdrawalTypes: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
            </Fld>
          </div>
          <p className="-mt-1 text-[11px] text-muted">
            Type values stop a deposit being matched to a withdrawal (e.g. Paystrax DB/CD, ForumPay SELL/BUY). Leave blank to skip the check.
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={!valid} onClick={() => onSave(f)}>
            {isNew ? "Add PSP" : "Save changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Fld({ label: l, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className={label}>{l}</span>
      {children}
    </label>
  );
}

/* ─────────────── Results ─────────────── */

function RunHistory({ runs }: { runs: RunSummaryRow[] }) {
  if (!runs.length) return null;
  const rate = (m: number, t: number) => (t > 0 ? Math.round((m / t) * 100) : 0);
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted">
        Run history — saved to the shared database
      </h3>
      <Card className="glass card-seam overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface/40 text-left text-xs uppercase tracking-wider text-muted">
                <th className="px-5 py-3 font-medium">When</th>
                <th className="px-5 py-3 font-medium">By</th>
                <th className="px-5 py-3 text-right font-medium">L1</th>
                <th className="px-5 py-3 text-right font-medium">L2</th>
                <th className="px-5 py-3 text-right font-medium">Exceptions</th>
                <th className="px-5 py-3 text-right font-medium">Exposure</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-border/50 last:border-0">
                  <td className="px-5 py-3 text-muted-foreground">{new Date(r.ranAt).toLocaleString()}</td>
                  <td className="px-5 py-3 text-muted-foreground">{r.ranBy || "—"}</td>
                  <td className="px-5 py-3 text-right tnum">{rate(r.layer1Matched, r.layer1Total)}%</td>
                  <td className="px-5 py-3 text-right tnum">{rate(r.layer2Matched, r.layer2Total)}%</td>
                  <td className="px-5 py-3 text-right tnum text-accent-red">{r.exceptionCount}</td>
                  <td className="px-5 py-3 text-right tnum">${money(r.exposure)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function ResultsTab({ result, runs }: { result: ReconResult | null; runs: RunSummaryRow[] }) {
  const columns: Column<ReconRow>[] = useMemo(
    () => [
      { key: "status", header: "Status", render: (r) => <Badge variant={STATUS_META[r.status].variant}>{STATUS_META[r.status].label}</Badge> },
      { key: "src", header: "Source", render: (r) => <span className="text-muted-foreground">{r.psp ?? "CRM ↔ Cashier"}</span> },
      { key: "entity", header: "Entity", render: (r) => <span className="text-muted-foreground">{r.entity || "—"}</span> },
      { key: "left", header: "Left ID", render: (r) => <span className="font-mono text-xs">{r.leftId || "—"}</span> },
      { key: "leftAmt", header: "Left Amt", align: "right", render: (r) => <span className="tnum">{money(r.leftAmount)}</span> },
      { key: "right", header: "Right ID", render: (r) => <span className="font-mono text-xs">{r.rightId || "—"}</span> },
      { key: "rightAmt", header: "Right Amt", align: "right", render: (r) => <span className="tnum">{money(r.rightAmount)}</span> },
      { key: "diff", header: "Diff", align: "right", render: (r) => <span className={cn("tnum", r.diff && Math.abs(r.diff) > 0.05 ? "text-accent-orange" : "text-muted")}>{money(r.diff)}</span> },
      { key: "note", header: "Note", render: (r) => <span className="text-xs text-muted">{r.note}</span> },
    ],
    [],
  );

  if (!result) {
    return (
      <div className="flex flex-col gap-5">
        <Card className="glass card-seam">
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="flex size-11 items-center justify-center rounded-xl border border-border bg-card text-muted">
              <Play className="size-5" />
            </span>
            <span className="text-sm text-muted-foreground">
              Upload CRM + Cashier (and any PSP files), then run the reconciliation.
            </span>
            <span className="text-xs text-muted">Tip: use “Load sample” to see it end-to-end.</span>
          </CardContent>
        </Card>
        <RunHistory runs={runs} />
      </div>
    );
  }

  const { layer1, layer2, byPsp, exceptions } = result;
  const stats: Stat[] = [
    { label: "L1 match rate", value: `${layer1.stats.matchRate}%`, tone: layer1.stats.matchRate >= 90 ? "green" : "orange" },
    { label: "L2 match rate", value: `${layer2.stats.matchRate}%`, tone: layer2.stats.matchRate >= 90 ? "green" : "orange" },
    { label: "Exceptions", value: String(exceptions.length), tone: exceptions.length ? "red" : "green" },
    { label: "Exposure", value: `$${money(layer2.stats.exposure + layer1.stats.exposure)}`, tone: "purple" },
  ];

  const pspColumns: Column<(typeof byPsp)[number]>[] = [
    { key: "psp", header: "PSP", render: (b) => <span className="font-medium">{b.psp}</span> },
    { key: "matched", header: "Matched", align: "right", render: (b) => <span className="tnum text-accent-green">{b.matched}</span> },
    { key: "amount", header: "Amount", align: "right", render: (b) => <span className="tnum text-accent-orange">{b.amount}</span> },
    { key: "status", header: "Status", align: "right", render: (b) => <span className="tnum text-accent-red">{b.status}</span> },
    { key: "unmatched", header: "Unmatched", align: "right", render: (b) => <span className="tnum text-accent-purple">{b.unmatched}</span> },
    { key: "total", header: "Total", align: "right", render: (b) => <span className="tnum">{b.total}</span> },
    { key: "rate", header: "Match %", align: "right", render: (b) => <span className={cn("tnum", b.matchRate >= 90 ? "text-accent-green" : "text-accent-orange")}>{b.matchRate}%</span> },
  ];

  return (
    <div className="flex flex-col gap-5">
      <StatTileRow stats={stats} />

      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted">Breakdown by PSP — Layer 2</h3>
        <DataTable columns={pspColumns} rows={byPsp} getRowKey={(b) => b.psp} empty="No PSP rows matched." />
      </div>

      <ExceptionsSection columns={columns} exceptions={exceptions} />
      <RunHistory runs={runs} />
    </div>
  );
}

function ExceptionsSection({ columns, exceptions }: { columns: Column<ReconRow>[]; exceptions: ReconRow[] }) {
  const [fLayer, setFLayer] = useState<"all" | "l1" | "l2">("all");
  const [fStatus, setFStatus] = useState<"all" | ReconRow["status"]>("all");
  const [q, setQ] = useState("");

  const filtered = useMemo(
    () =>
      exceptions.filter((r) => {
        if (fLayer === "l1" && r.psp) return false;
        if (fLayer === "l2" && !r.psp) return false;
        if (fStatus !== "all" && r.status !== fStatus) return false;
        if (q) {
          const hay = `${r.leftId} ${r.rightId} ${r.note} ${r.psp ?? ""} ${r.entity}`.toLowerCase();
          if (!hay.includes(q.toLowerCase())) return false;
        }
        return true;
      }),
    [exceptions, fLayer, fStatus, q],
  );

  const sel = "h-9 cursor-pointer rounded-lg border border-border bg-card px-2.5 text-sm outline-none focus:border-border-strong";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted">
          Exceptions ({filtered.length} of {exceptions.length})
        </h3>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search id, note…"
            className="h-9 w-44 rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-border-strong"
          />
          <select value={fLayer} onChange={(e) => setFLayer(e.target.value as typeof fLayer)} className={sel}>
            <option value="all">All layers</option>
            <option value="l1">Layer 1 (CRM↔Cashier)</option>
            <option value="l2">Layer 2 (Cashier↔PSP)</option>
          </select>
          <select value={fStatus} onChange={(e) => setFStatus(e.target.value as typeof fStatus)} className={sel}>
            <option value="all">All statuses</option>
            <option value="status">Status mismatch</option>
            <option value="amount">Amount mismatch</option>
            <option value="unmatched-crm">Unmatched CRM</option>
            <option value="unmatched-cashier">Unmatched Cashier</option>
            <option value="unmatched-psp">Unmatched PSP</option>
          </select>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => downloadText("recon-exceptions.csv", reconRowsToCsv(filtered))}
            disabled={filtered.length === 0}
          >
            <Download className="size-4" /> Export CSV
          </Button>
        </div>
      </div>
      <DataTable
        columns={columns}
        rows={filtered}
        getRowKey={(r, i) => `${r.psp ?? "l1"}-${r.leftId}-${r.rightId}-${i}`}
        pageSize={12}
        empty="No exceptions match these filters. 🎉"
      />
    </div>
  );
}
