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
  ClipboardList,
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
import { runReconciliation, providerCoverage } from "@/lib/recon/engine";
import { reconRowsToCsv, downloadText } from "@/lib/recon/export";
import { loadPspsRemote, savePspsRemote, saveRunRemote, listRunsRemote, type RunSummaryRow } from "@/lib/recon/api";
import { loadCases, saveCase, caseTotals, emptyCase } from "@/lib/recon/cases";
import { Sparkline } from "@/components/ui/sparkline";
import {
  snapshotFromResult,
  appendHistory,
  loadHistory,
  detectAnomalies,
  brandTrends as computeBrandTrends,
  type Anomalies,
} from "@/lib/recon/history";
import type { Breakdown, CaseState, Dataset, PspConfig, ReconMatrix, ReconOptions, ReconResult, ReconRow } from "@/lib/recon/types";
import { RESOLUTIONS } from "@/lib/recon/types";
import { sampleCrm, sampleCashier, samplePaystrax, sampleForumpay, sampleMatch2pay, sampleRapyd } from "@/lib/recon/sample";
import { useAuth } from "@/lib/auth";

const RESULT_KEY = "opsos.recon.result";

const input =
  "h-9 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none transition-colors focus:border-border-strong";
const label = "text-[11px] font-medium uppercase tracking-wider text-muted";

const TABS = [
  { key: "sources", label: "Sources" },
  { key: "psps", label: "PSP Registry" },
  { key: "results", label: "Results" },
  { key: "actions", label: "Action Center" },
  { key: "matched", label: "Matched" },
  { key: "analytics", label: "Analytics" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const STATUS_META: Record<
  ReconRow["status"],
  { label: string; variant: "green" | "orange" | "red" | "purple" | "blue" | "default" }
> = {
  matched: { label: "Reconciled", variant: "green" },
  amount: { label: "Amount", variant: "orange" },
  status: { label: "Status Mismatch", variant: "red" },
  "needs-review": { label: "Needs Review", variant: "orange" },
  "unmatched-cashier": { label: "Missing in CRM", variant: "purple" },
  "unmatched-psp": { label: "Missing in PSP", variant: "purple" },
  "unmatched-crm": { label: "Missing in Cashier", variant: "purple" },
  // ⏭️ informational — never counted as exceptions
  "out-of-scope": { label: "Out of Scope", variant: "default" },
  "agreed-decline": { label: "Agreed Decline", variant: "default" },
  incomplete: { label: "Incomplete", variant: "default" },
  "not-reconciled": { label: "Not Reconciled", variant: "blue" },
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
  const [anomalies, setAnomalies] = useState<Anomalies | null>(null);
  const [trends, setTrends] = useState<Record<string, number[]>>({});
  const [drill, setDrill] = useState<{ brand?: string; psp?: string } | null>(null);
  const [opts, setOpts] = useState<ReconOptions>({});
  const [cases, setCases] = useState<Record<string, CaseState>>({});

  // Ops workflow is stored separately from the run and re-attached by caseKey,
  // so re-running the reconciliation never wipes what the team recorded.
  const updateCase = (next: CaseState, row?: ReconRow) => {
    setCases((prev) => ({ ...prev, [next.caseKey]: next }));
    void saveCase(next, row);
  };

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
      const saved = await loadCases();
      if (active) setCases(saved);
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
      // Keyed to the per-entity configs the sample cashier rows actually route
      // to: Paystrax rows are tradin_mu, ForumPay/Match2pay rows are tradin_sl.
      paystrax_mu: samplePaystrax(),
      forumpay_sl: sampleForumpay(),
      match2pay_sl: sampleMatch2pay(),
      rapyd: sampleRapyd(),
    });
    setWarnings({});
    toast({ title: "Sample data loaded", description: "CRM, Cashier and 4 PSP files across 4 brands." });
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
    const res = runReconciliation(datasets.crm, datasets.cashier, psps, pspData, new Date().toISOString(), opts);
    setResult(res);
    try {
      window.localStorage.setItem(RESULT_KEY, JSON.stringify(res));
    } catch {
      /* result too large to persist — keep in memory only */
    }
    // Anomaly detection vs prior runs, then record this run into the rolling history.
    const snapshot = snapshotFromResult(res);
    const prior = loadHistory();
    const anoms = detectAnomalies(prior, snapshot);
    const history = appendHistory(snapshot);
    setAnomalies(anoms);
    setTrends(computeBrandTrends(history));
    setDrill(null);
    setTab("results");
    toast({
      title: "Reconciliation complete",
      description:
        `${res.exceptions.length} exception(s)` +
        (anoms.list.length ? ` · ${anoms.list.length} regression(s) flagged` : ""),
    });
    // Live mode: persist the run server-side and refresh shared history.
    void saveRunRemote(res, user?.email).then(() => listRunsRemote()).then((h) => {
      if (h.length) setRuns(h);
    });
  };

  const handleDrill = (brand?: string, psp?: string) => {
    setDrill({ brand, psp });
    setTab("results");
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

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-border bg-card/40 px-4 py-3">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted">Run options</span>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">Date from</span>
          <input type="date" value={opts.dateFrom ?? ""} onChange={(e) => setOpts((o) => ({ ...o, dateFrom: e.target.value }))}
            className="h-8 rounded-lg border border-border bg-card px-2 text-xs outline-none focus:border-border-strong" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">Date to</span>
          <input type="date" value={opts.dateTo ?? ""} onChange={(e) => setOpts((o) => ({ ...o, dateTo: e.target.value }))}
            className="h-8 rounded-lg border border-border bg-card px-2 text-xs outline-none focus:border-border-strong" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">Amount tolerance ($)</span>
          <input type="number" step="0.01" min="0" value={opts.amountTolAbs ?? 1} onChange={(e) => setOpts((o) => ({ ...o, amountTolAbs: Number(e.target.value) }))}
            className="h-8 w-28 rounded-lg border border-border bg-card px-2 text-xs outline-none focus:border-border-strong" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">Fee tolerance (%)</span>
          <input type="number" step="0.1" min="0" value={opts.amountTolPct ?? 0} onChange={(e) => setOpts((o) => ({ ...o, amountTolPct: Number(e.target.value) }))}
            className="h-8 w-28 rounded-lg border border-border bg-card px-2 text-xs outline-none focus:border-border-strong" />
        </label>
        {opts.dateFrom || opts.dateTo || opts.amountTolPct ? (
          <button type="button" onClick={() => setOpts({})} className="mb-0.5 text-xs text-muted-foreground hover:text-foreground">
            Reset
          </button>
        ) : null}
        <span className="mb-1 ml-auto text-[11px] text-muted">Re-run after changing options.</span>
      </div>

      {tab === "sources" ? (
        <SourcesTab psps={psps} datasets={datasets} warnings={warnings} onFile={readFile} onClear={clearData} />
      ) : tab === "psps" ? (
        <PspRegistryTab
          psps={psps}
          datasets={datasets}
          onAdd={() => setEditing(emptyPsp())}
          onEdit={(p) => setEditing(p)}
          onRemove={removePsp}
          onRestore={restore}
        />
      ) : tab === "actions" ? (
        <ActionCenterTab result={result} cases={cases} onUpdate={updateCase} />
      ) : tab === "analytics" ? (
        <AnalyticsTab result={result} anomalies={anomalies} trends={trends} onDrill={handleDrill} />
      ) : tab === "matched" ? (
        <MatchedTab result={result} />
      ) : (
        <ResultsTab result={result} runs={runs} drill={drill} onClearDrill={() => setDrill(null)} />
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
  datasets,
  onAdd,
  onEdit,
  onRemove,
  onRestore,
}: {
  psps: PspConfig[];
  datasets: Record<string, Dataset>;
  onAdd: () => void;
  onEdit: (p: PspConfig) => void;
  onRemove: (id: string) => void;
  onRestore: () => void;
}) {
  const pspData = useMemo(() => {
    const d: Record<string, Dataset> = {};
    psps.forEach((p) => {
      if (datasets[p.id]) d[p.id] = datasets[p.id];
    });
    return d;
  }, [psps, datasets]);
  const coverage = useMemo(
    () => providerCoverage(datasets.cashier ?? null, psps, pspData),
    [datasets.cashier, psps, pspData],
  );

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

      {coverage.length > 0 ? <PspReadiness coverage={coverage} /> : null}

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

/* ─────────────── Action Center (the operational queue) ─────────────── */

function ActionCenterTab({
  result,
  cases,
  onUpdate,
}: {
  result: ReconResult | null;
  cases: Record<string, CaseState>;
  onUpdate: (next: CaseState, row?: ReconRow) => void;
}) {
  const [showDone, setShowDone] = useState(false);
  const [fPrio, setFPrio] = useState<string>("all");
  const [q, setQ] = useState("");

  const exceptions = result?.exceptions ?? [];
  const totals = useMemo(() => caseTotals(exceptions, cases), [exceptions, cases]);

  const rows = useMemo(
    () =>
      exceptions.filter((r) => {
        const res = cases[r.caseKey]?.resolution ?? "Open";
        const done = res === "Resolved" || res === "Accepted Exception";
        if (!showDone && done) return false;
        if (fPrio !== "all" && r.priority !== fPrio) return false;
        if (q) {
          const c = cases[r.caseKey];
          const hay = `${r.leftId} ${r.rightId} ${r.note} ${r.brand} ${r.entity} ${c?.owner ?? ""} ${c?.notes ?? ""}`;
          if (!hay.toLowerCase().includes(q.toLowerCase())) return false;
        }
        return true;
      }),
    [exceptions, cases, showDone, fPrio, q],
  );

  if (!result) {
    return (
      <Card className="glass card-seam">
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <span className="flex size-11 items-center justify-center rounded-xl border border-border bg-card text-muted">
            <ClipboardList className="size-5" />
          </span>
          <span className="text-sm text-muted-foreground">
            Run a reconciliation to build the action queue.
          </span>
          <span className="text-xs text-muted">
            Owner, status and notes you record here survive future runs.
          </span>
        </CardContent>
      </Card>
    );
  }

  const exposure = (r: ReconRow) =>
    Math.max(Math.abs(r.diff ?? 0), Math.abs(r.leftAmount ?? 0), Math.abs(r.rightAmount ?? 0));
  const prioExposure = (p: string) =>
    exceptions.filter((r) => r.priority === p).reduce((s, r) => s + exposure(r), 0);

  const sel = "h-9 cursor-pointer rounded-lg border border-border bg-card px-2.5 text-sm outline-none focus:border-border-strong";

  return (
    <div className="flex flex-col gap-4">
      <StatTileRow
        stats={[
          { label: `P1 — act now · $${money(prioExposure("P1"))}`, value: String(exceptions.filter((r) => r.priority === "P1").length), tone: "red" },
          { label: `P2 — high · $${money(prioExposure("P2"))}`, value: String(exceptions.filter((r) => r.priority === "P2").length), tone: "orange" },
          { label: `P3 — review · $${money(prioExposure("P3"))}`, value: String(exceptions.filter((r) => r.priority === "P3").length), tone: "purple" },
          { label: "Open", value: String(totals.open), tone: "blue" },
          { label: "In progress", value: String(totals.inProgress), tone: "magenta" },
          { label: "Resolved", value: String(totals.done), tone: "green" },
        ]}
      />

      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted">
          Queue ({rows.length} of {exceptions.length})
        </h3>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search id, note, owner…"
            className="h-9 w-48 rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-border-strong"
          />
          <select value={fPrio} onChange={(e) => setFPrio(e.target.value)} className={sel}>
            <option value="all">All priorities</option>
            <option value="P1">P1 — act now</option>
            <option value="P2">P2 — high</option>
            <option value="P3">P3 — review</option>
          </select>
          <Button variant="secondary" size="sm" onClick={() => setShowDone((v) => !v)}>
            {showDone ? "Hide" : "Show"} resolved
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card/40 px-4 py-10 text-center text-sm text-muted">
            Nothing in the queue. 🎉
          </div>
        ) : (
          rows.slice(0, 100).map((r) => (
            <CaseCard
              key={r.caseKey}
              row={r}
              state={cases[r.caseKey] ?? emptyCase(r.caseKey)}
              onUpdate={(next) => onUpdate(next, r)}
            />
          ))
        )}
        {rows.length > 100 ? (
          <p className="text-xs text-muted">
            Showing the first 100 of {rows.length} — narrow the filters to see the rest.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function CaseCard({
  row,
  state,
  onUpdate,
}: {
  row: ReconRow;
  state: CaseState;
  onUpdate: (next: CaseState) => void;
}) {
  const [notes, setNotes] = useState(state.notes);
  const [owner, setOwner] = useState(state.owner);
  const done = state.resolution === "Resolved" || state.resolution === "Accepted Exception";

  const exposure = Math.max(
    Math.abs(row.diff ?? 0), Math.abs(row.leftAmount ?? 0), Math.abs(row.rightAmount ?? 0),
  );

  return (
    <div className={cn("flex flex-col gap-3 rounded-xl border border-border bg-card p-4", done && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-[11px] font-medium",
            row.priority === "P1"
              ? "bg-accent-red-soft text-accent-red"
              : row.priority === "P2"
                ? "bg-accent-orange-soft text-accent-orange"
                : "bg-card-hover text-muted",
          )}
        >
          {row.priority}
        </span>
        <Badge variant={STATUS_META[row.status].variant}>{STATUS_META[row.status].label}</Badge>
        <span className="text-xs text-muted-foreground">{row.psp ?? "CRM ↔ Cashier"}</span>
        {row.brand ? <span className="text-xs text-muted">· {row.brand}</span> : null}
        {row.entity ? <span className="text-xs text-muted">· {row.entity}</span> : null}
        <span className="ml-auto tnum text-sm font-medium">${money(exposure)}</span>
      </div>

      <p className="text-xs text-muted-foreground">{row.note}</p>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <Meta k="CRM / Cashier ID" v={row.leftId || "—"} />
        <Meta k="Left amount" v={money(row.leftAmount)} />
        <Meta k="Counterpart ID" v={row.rightId || "—"} />
        <Meta k="Right amount" v={money(row.rightAmount)} />
      </dl>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <span className={label}>Status</span>
          <select
            value={state.resolution}
            onChange={(e) => onUpdate({ ...state, resolution: e.target.value, owner, notes })}
            className="h-9 cursor-pointer rounded-lg border border-border bg-card px-2.5 text-sm outline-none focus:border-border-strong"
          >
            {RESOLUTIONS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <span className={label}>Owner</span>
          <input
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            onBlur={() => owner !== state.owner && onUpdate({ ...state, owner, notes })}
            placeholder="unassigned"
            className="h-9 w-40 rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-border-strong"
          />
        </div>
        <div className="flex min-w-56 flex-1 flex-col gap-1">
          <span className={label}>Ops notes</span>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes !== state.notes && onUpdate({ ...state, owner, notes })}
            placeholder="What did you find?"
            className="h-9 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-border-strong"
          />
        </div>
      </div>
    </div>
  );
}

function PspReadiness({
  coverage,
}: {
  coverage: { provider: string; entity: string; count: number; psp: string | null; hasFile: boolean }[];
}) {
  const ready = coverage.filter((c) => c.hasFile).length;
  const routed = coverage.filter((c) => c.psp).length;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted">
          Layer 2 readiness — providers in your cashier file
        </h3>
        <span className="text-xs text-muted-foreground">
          {routed}/{coverage.length} routed · {ready} with a file loaded
        </span>
      </div>
      <div className="flex flex-col divide-y divide-border/60">
        {coverage.map((c) => (
          <div key={`${c.provider}|${c.entity}`} className="flex items-center gap-3 py-1.5 text-sm">
            <span className="font-mono text-xs text-muted-foreground">{c.provider}</span>
            <span className="text-xs text-muted">{c.entity}</span>
            <span className="text-xs text-muted">{c.count.toLocaleString()} rows</span>
            <span className="ml-auto flex items-center gap-1.5">
              {c.hasFile ? (
                <Badge variant="green">File loaded — {c.psp}</Badge>
              ) : c.psp ? (
                <Badge variant="blue">Upload {c.psp} file</Badge>
              ) : (
                <Badge variant="default">No PSP config</Badge>
              )}
            </span>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted">
        Layer 2 (Cashier ↔ PSP) reconciles each provider against its settlement export. Upload a
        file for any provider above to switch it on — no code changes needed.
      </p>
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

function ResultsTab({
  result,
  runs,
  drill,
  onClearDrill,
}: {
  result: ReconResult | null;
  runs: RunSummaryRow[];
  drill: { brand?: string; psp?: string } | null;
  onClearDrill: () => void;
}) {
  const columns: Column<ReconRow>[] = useMemo(
    () => [
      {
        key: "prio",
        header: "Prio",
        render: (r) => (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[11px] font-medium",
              r.priority === "P1"
                ? "bg-accent-red-soft text-accent-red"
                : r.priority === "P2"
                  ? "bg-accent-orange-soft text-accent-orange"
                  : "bg-card text-muted",
            )}
          >
            {r.priority}
          </span>
        ),
      },
      { key: "status", header: "Status", render: (r) => <Badge variant={STATUS_META[r.status].variant}>{STATUS_META[r.status].label}</Badge> },
      { key: "src", header: "Source", render: (r) => <span className="text-muted-foreground">{r.psp ?? "CRM ↔ Cashier"}</span> },
      { key: "brand", header: "Brand", render: (r) => <span className="text-muted-foreground">{r.brand || "—"}</span> },
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

  const { layer1, layer2, byPsp, byBrand, byEntity, exceptions } = result;
  const netted = layer1.rows.filter((r) => r.matchKey === "Aggregated").length;
  const stats: Stat[] = [
    { label: "L1 match rate", value: layer1.stats.total ? `${layer1.stats.matchRate}%` : "N/A", tone: layer1.stats.matchRate >= 90 ? "green" : "orange" },
    { label: "L2 match rate", value: layer2.stats.total ? `${layer2.stats.matchRate}%` : "N/A", tone: !layer2.stats.total ? "blue" : layer2.stats.matchRate >= 90 ? "green" : "orange" },
    { label: "Matched", value: layer1.stats.matched.toLocaleString(), tone: "green" },
    { label: "Exceptions", value: exceptions.length.toLocaleString(), tone: exceptions.length ? "red" : "green" },
    { label: "Exposure", value: `$${money(layer2.stats.exposure + layer1.stats.exposure)}`, tone: "purple" },
  ];

  const breakdownColumns = (firstHeader: string): Column<Breakdown>[] => [
    { key: "k", header: firstHeader, render: (b) => <span className="font-medium">{b.key}</span> },
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

      {netted > 0 ? (
        <p className="rounded-lg border border-accent-blue/25 bg-accent-blue-soft px-3 py-2 text-xs text-accent-blue">
          {netted.toLocaleString()} matches were <span className="font-medium">netted</span> — split
          transactions (several CRM legs summing to one cashier movement) reconciled into a single line.
          See “Matched via: Aggregated” in the Matched tab.
        </p>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted">Breakdown by Brand — Layer 1</h3>
          <DataTable columns={breakdownColumns("Brand")} rows={byBrand} getRowKey={(b) => b.key} empty="No rows." />
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted">Breakdown by Entity — Layer 1</h3>
          <DataTable columns={breakdownColumns("Entity")} rows={byEntity} getRowKey={(b) => b.key} empty="No rows." />
        </div>
      </div>

      {byPsp.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted">Breakdown by PSP — Layer 2</h3>
          <DataTable columns={breakdownColumns("PSP")} rows={byPsp} getRowKey={(b) => b.key} empty="No PSP rows matched." />
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border bg-card/40 px-4 py-3 text-xs text-muted">
          <span className="text-muted-foreground">Layer 2 (Cashier ↔ PSP) is off.</span> Upload PSP
          settlement files under Sources to reconcile each provider — see the readiness list in the
          PSP Registry tab.
        </div>
      )}

      <ExceptionsSection
        key={`${drill?.brand ?? ""}|${drill?.psp ?? ""}`}
        columns={columns}
        exceptions={exceptions}
        initialBrand={drill?.brand}
        initialPsp={drill?.psp}
        onClearDrill={onClearDrill}
      />
      <RunHistory runs={runs} />
    </div>
  );
}

/* ─────────────── Analytics (per brand / per PSP / per cashier) ─────────────── */

function rateTone(rate: number) {
  if (rate >= 90) return { bg: "bg-accent-green-soft", fg: "text-accent-green", bar: "bg-accent-green" };
  if (rate >= 70) return { bg: "bg-accent-orange-soft", fg: "text-accent-orange", bar: "bg-accent-orange" };
  return { bg: "bg-accent-red-soft", fg: "text-accent-red", bar: "bg-accent-red" };
}

function BrandCard({
  b,
  trend,
  anomalyDelta,
  onClick,
}: {
  b: Breakdown;
  trend?: number[];
  anomalyDelta?: number;
  onClick?: () => void;
}) {
  const tone = rateTone(b.matchRate);
  const issues = b.amount + b.status + b.unmatched;
  const cell = (n: string | number, l: string, c: string) => (
    <div className="flex flex-col">
      <span className={cn("tnum text-sm font-semibold", c)}>{n}</span>
      <span className="text-[10px] uppercase tracking-wide text-muted">{l}</span>
    </div>
  );
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left hover-lift"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{b.key}</span>
        <div className="flex items-center gap-1.5">
          {anomalyDelta !== undefined ? (
            <span className="flex items-center gap-0.5 rounded-full bg-accent-red-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent-red">
              ▼ {Math.abs(anomalyDelta)}
            </span>
          ) : null}
          <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", tone.bg, tone.fg)}>{b.matchRate}%</span>
        </div>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface">
        <div className={cn("h-full rounded-full", tone.bar)} style={{ width: `${b.matchRate}%` }} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        {cell(b.matched, "Matched", "text-accent-green")}
        {cell(issues, "Issues", "text-accent-orange")}
        {cell(`$${money(b.exposure)}`, "Exposure", "text-foreground")}
      </div>
      {trend && trend.length > 1 ? (
        <div className="flex items-center gap-2 border-t border-border/60 pt-2">
          <span className="text-[10px] uppercase tracking-wide text-muted">Trend</span>
          <Sparkline data={trend} stroke={`var(--accent-${b.matchRate >= 90 ? "green" : b.matchRate >= 70 ? "orange" : "red"})`} fill={`var(--accent-${b.matchRate >= 90 ? "green" : b.matchRate >= 70 ? "orange" : "red"})`} />
        </div>
      ) : null}
    </button>
  );
}

function MatrixHeatmap({
  matrix,
  anomalies,
  onDrill,
}: {
  matrix: ReconMatrix;
  anomalies?: Anomalies | null;
  onDrill?: (brand: string, psp: string) => void;
}) {
  if (!matrix.brands.length) {
    return <p className="text-sm text-muted">No Layer 2 rows to chart yet.</p>;
  }
  return (
    <Card className="glass card-seam overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface/40">
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted">
                Brand \ PSP
              </th>
              {matrix.psps.map((p) => (
                <th key={p} className="px-3 py-3 text-center text-xs font-medium uppercase tracking-wider text-muted">
                  {p}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.brands.map((brand) => (
              <tr key={brand} className="border-b border-border/50 last:border-0">
                <td className="px-4 py-2.5 font-medium">{brand}</td>
                {matrix.psps.map((psp) => {
                  const c = matrix.cells[brand]?.[psp];
                  if (!c) {
                    return (
                      <td key={psp} className="px-3 py-2.5 text-center text-muted">
                        —
                      </td>
                    );
                  }
                  const tone = rateTone(c.rate);
                  const anom = anomalies?.cell[`${brand}|||${psp}`];
                  return (
                    <td key={psp} className="px-2 py-2 text-center">
                      <button
                        type="button"
                        onClick={() => onDrill?.(brand, psp)}
                        className={cn(
                          "relative inline-flex min-w-16 flex-col rounded-lg px-2 py-1 transition-transform hover:scale-[1.05]",
                          tone.bg,
                          tone.fg,
                          anom ? "ring-1 ring-accent-red" : "",
                        )}
                        title={`${c.matched}/${c.total} matched${c.exposure ? ` · $${money(c.exposure)} exposure` : ""}${anom ? ` · ▼ ${Math.abs(anom.delta)} pts vs avg ${anom.baseline}%` : ""} — click to drill in`}
                      >
                        {anom ? (
                          <span className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-accent-red text-[8px] font-bold text-white">
                            !
                          </span>
                        ) : null}
                        <span className="tnum text-sm font-semibold">{c.rate}%</span>
                        <span className="tnum text-[10px] opacity-80">
                          {c.matched}/{c.total}
                        </span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function AnalyticsTab({
  result,
  anomalies,
  trends,
  onDrill,
}: {
  result: ReconResult | null;
  anomalies: Anomalies | null;
  trends: Record<string, number[]>;
  onDrill: (brand?: string, psp?: string) => void;
}) {
  if (!result) {
    return (
      <Card className="glass card-seam">
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <span className="flex size-11 items-center justify-center rounded-xl border border-border bg-card text-muted">
            <Play className="size-5" />
          </span>
          <span className="text-sm text-muted-foreground">Run a reconciliation to unlock per-brand analytics.</span>
        </CardContent>
      </Card>
    );
  }

  const entityCols: Column<Breakdown>[] = [
    { key: "k", header: "Cashier entity", render: (b) => <span className="font-medium">{b.key}</span> },
    { key: "m", header: "Matched", align: "right", render: (b) => <span className="tnum text-accent-green">{b.matched}</span> },
    { key: "i", header: "Issues", align: "right", render: (b) => <span className="tnum text-accent-orange">{b.amount + b.status + b.unmatched}</span> },
    { key: "t", header: "Total", align: "right", render: (b) => <span className="tnum">{b.total}</span> },
    { key: "e", header: "Exposure", align: "right", render: (b) => <span className="tnum">${money(b.exposure)}</span> },
    { key: "r", header: "Match %", align: "right", render: (b) => <span className={cn("tnum", rateTone(b.matchRate).fg)}>{b.matchRate}%</span> },
  ];

  return (
    <div className="flex flex-col gap-6">
      {anomalies && anomalies.list.length ? (
        <div className="flex flex-col gap-2 rounded-xl border border-accent-red/20 bg-accent-red-soft px-4 py-3">
          <span className="flex items-center gap-2 text-sm font-medium text-accent-red">
            <AlertTriangle className="size-4" /> {anomalies.list.length} regression(s) vs recent runs
          </span>
          <div className="flex flex-wrap gap-2">
            {anomalies.list.slice(0, 8).map((a) => (
              <button
                key={a.key}
                type="button"
                onClick={() => onDrill(a.brand, a.psp)}
                className="rounded-lg border border-accent-red/20 bg-card/60 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <span className="font-medium text-foreground">{a.key}</span>{" "}
                <span className="text-accent-red">▼ {Math.abs(a.delta)} pts</span>{" "}
                <span className="text-muted">({a.current}% vs {a.baseline}% avg)</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted">
          Per-brand health <span className="text-muted/70">· click a card to drill into its exceptions</span>
        </h3>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {result.byBrand.map((b) => (
            <BrandCard
              key={b.key}
              b={b}
              trend={trends[b.key]}
              anomalyDelta={anomalies?.brand[b.key]?.delta}
              onClick={() => onDrill(b.key)}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted">
          Brand × PSP match-rate matrix — click a cell to drill in; ▼ flags a regression vs history
        </h3>
        <MatrixHeatmap matrix={result.matrix} anomalies={anomalies} onDrill={(b, p) => onDrill(b, p)} />
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted">Per-cashier entity</h3>
        <DataTable columns={entityCols} rows={result.byEntity} getRowKey={(b) => b.key} empty="No rows." />
      </div>
    </div>
  );
}

function MatchedTab({ result }: { result: ReconResult | null }) {
  const [q, setQ] = useState("");
  const matched = result?.matched ?? [];
  const filtered = useMemo(
    () =>
      q
        ? matched.filter((r) =>
            `${r.leftId} ${r.rightId} ${r.psp ?? ""} ${r.brand} ${r.entity} ${r.matchKey}`
              .toLowerCase()
              .includes(q.toLowerCase()),
          )
        : matched,
    [matched, q],
  );

  const columns: Column<ReconRow>[] = [
    { key: "src", header: "Source", render: (r) => <span className="text-muted-foreground">{r.psp ?? "CRM ↔ Cashier"}</span> },
    { key: "brand", header: "Brand", render: (r) => <span className="text-muted-foreground">{r.brand || "—"}</span> },
    { key: "via", header: "Matched via", render: (r) => <span className="text-xs text-accent-green">{r.matchKey || "—"}</span> },
    { key: "left", header: "CRM / Cashier ID", render: (r) => <span className="font-mono text-xs">{r.leftId || "—"}</span> },
    { key: "leftAmt", header: "Left Amt", align: "right", render: (r) => <span className="tnum">{money(r.leftAmount)}</span> },
    { key: "right", header: "Counterpart ID", render: (r) => <span className="font-mono text-xs">{r.rightId || "—"}</span> },
    { key: "rightAmt", header: "Right Amt", align: "right", render: (r) => <span className="tnum">{money(r.rightAmount)}</span> },
    { key: "status", header: "Status", render: (r) => <span className="text-xs text-muted-foreground">{r.leftStatus} / {r.rightStatus}</span> },
  ];

  if (!result) {
    return (
      <Card className="glass card-seam">
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <span className="flex size-11 items-center justify-center rounded-xl border border-border bg-card text-muted">
            <Play className="size-5" />
          </span>
          <span className="text-sm text-muted-foreground">Run a reconciliation to see matched transactions.</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted">
          Matched transactions ({filtered.length} of {matched.length})
        </h3>
        <div className="ml-auto flex items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search id, brand, PSP…"
            className="h-9 w-56 rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-border-strong"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => downloadText("recon-matched.csv", reconRowsToCsv(filtered))}
            disabled={filtered.length === 0}
          >
            <Download className="size-4" /> Export CSV
          </Button>
        </div>
      </div>
      <DataTable
        columns={columns}
        rows={filtered}
        getRowKey={(r, i) => `m-${r.leftId}-${r.rightId}-${i}`}
        pageSize={15}
        empty="No matched transactions."
      />
    </div>
  );
}

function ExceptionsSection({
  columns,
  exceptions,
  initialBrand,
  initialPsp,
  onClearDrill,
}: {
  columns: Column<ReconRow>[];
  exceptions: ReconRow[];
  initialBrand?: string;
  initialPsp?: string;
  onClearDrill?: () => void;
}) {
  const [fLayer, setFLayer] = useState<"all" | "l1" | "l2">("all");
  const [fStatus, setFStatus] = useState<"all" | ReconRow["status"]>("all");
  const [fBrand, setFBrand] = useState<string>(initialBrand ?? "all");
  const [fEntity, setFEntity] = useState<string>("all");
  const [fPrio, setFPrio] = useState<string>("all");
  const [fPsp, setFPsp] = useState<string>(initialPsp ?? "all");
  const [q, setQ] = useState("");

  const brands = useMemo(
    () => Array.from(new Set(exceptions.map((r) => r.brand).filter(Boolean))).sort(),
    [exceptions],
  );
  const entities = useMemo(
    () => Array.from(new Set(exceptions.map((r) => r.entity).filter(Boolean))).sort(),
    [exceptions],
  );
  const psps = useMemo(
    () => Array.from(new Set(exceptions.map((r) => r.psp ?? "").filter(Boolean))).sort(),
    [exceptions],
  );

  const filtered = useMemo(
    () =>
      exceptions.filter((r) => {
        if (fLayer === "l1" && r.psp) return false;
        if (fLayer === "l2" && !r.psp) return false;
        if (fStatus !== "all" && r.status !== fStatus) return false;
        if (fBrand !== "all" && r.brand !== fBrand) return false;
        if (fEntity !== "all" && r.entity !== fEntity) return false;
        if (fPrio !== "all" && r.priority !== fPrio) return false;
        if (fPsp !== "all" && (r.psp ?? "") !== fPsp) return false;
        if (q) {
          const hay = `${r.leftId} ${r.rightId} ${r.note} ${r.psp ?? ""} ${r.brand} ${r.entity}`.toLowerCase();
          if (!hay.includes(q.toLowerCase())) return false;
        }
        return true;
      }),
    [exceptions, fLayer, fStatus, fBrand, fEntity, fPrio, fPsp, q],
  );

  const sel = "h-9 cursor-pointer rounded-lg border border-border bg-card px-2.5 text-sm outline-none focus:border-border-strong";
  const drilled = (initialBrand || initialPsp) && (fBrand !== "all" || fPsp !== "all");

  const clearDrill = () => {
    setFBrand("all");
    setFPsp("all");
    onClearDrill?.();
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted">
          Exceptions ({filtered.length} of {exceptions.length})
        </h3>
        {drilled ? (
          <button
            type="button"
            onClick={clearDrill}
            className="flex items-center gap-1 rounded-full border border-accent-blue/30 bg-accent-blue-soft px-2 py-0.5 text-xs text-accent-blue"
          >
            {[initialBrand, initialPsp].filter(Boolean).join(" × ")}
            <X className="size-3" />
          </button>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search id, note…"
            className="h-9 w-40 rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-border-strong"
          />
          <select value={fBrand} onChange={(e) => setFBrand(e.target.value)} className={sel}>
            <option value="all">All brands</option>
            {brands.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
          <select value={fEntity} onChange={(e) => setFEntity(e.target.value)} className={sel}>
            <option value="all">All entities</option>
            {entities.map((en) => (
              <option key={en} value={en}>{en}</option>
            ))}
          </select>
          <select value={fPsp} onChange={(e) => setFPsp(e.target.value)} className={sel}>
            <option value="all">All PSPs</option>
            {psps.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <select value={fPrio} onChange={(e) => setFPrio(e.target.value)} className={sel}>
            <option value="all">All priorities</option>
            <option value="P1">P1 — act now</option>
            <option value="P2">P2 — high</option>
            <option value="P3">P3 — review</option>
          </select>
          <select value={fStatus} onChange={(e) => setFStatus(e.target.value as typeof fStatus)} className={sel}>
            <option value="all">All statuses</option>
            <option value="status">Status mismatch</option>
            <option value="amount">Amount mismatch</option>
            <option value="needs-review">Needs review</option>
            <option value="unmatched-crm">Missing in Cashier</option>
            <option value="unmatched-cashier">Missing in CRM</option>
            <option value="unmatched-psp">Missing in PSP</option>
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
