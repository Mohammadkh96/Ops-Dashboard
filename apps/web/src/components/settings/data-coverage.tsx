"use client";

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Play, Square, Upload } from "lucide-react";

import { apiFetch, isDemoMode } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { parseFile } from "@/lib/recon/parse";
import { cn } from "@/lib/utils";

/**
 * Rows sent to the API in one request.
 *
 * The file is parsed here and posted in slices for the same reason the backwards
 * walk is sliced: the host kills a request at 60 seconds, and a slice that
 * returns is a slice that is stored. Small enough to be quick, large enough that
 * a year of history is a few dozen requests rather than thousands.
 */
const IMPORT_BATCH = 500;

type Progress = {
  shop: string;
  done: boolean;
  nextPage: number;
  pages: number;
  fetched: number;
  stored: number;
  oldestSeen: string | null;
  error: string | null;
  ranPages: number;
  ranStored: number;
  busy: boolean;
  coverageFrom: string | null;
  coverageTo: string | null;
  payments: number;
};

/** The API answers with an object instead of a list when nothing is configured. */
type StepResponse = Progress[] | { error: string };

type ProbeAttempt = {
  what: string;
  records: number;
  newest: string | null;
  oldest: string | null;
  worked: boolean;
  note?: string;
};

type TryResult = {
  shop: string;
  path: string;
  status: number;
  records: number;
  newest: string | null;
  oldest: string | null;
  fields: string[];
  note: string;
};

type ImportSummary = {
  read: number;
  mapped: number;
  stored: number;
  refreshed: number;
  unusable: number;
  duplicates: number;
  oldest: string | null;
  newest: string | null;
  undated: number;
  warnings: string[];
};

type HistoryProbe = {
  shop: string;
  paging: {
    pages: number;
    records: number;
    oldest: string | null;
    daysBack: number | null;
    stoppedBecause: string;
  };
  dateWindow: ProbeAttempt[];
  ordering: ProbeAttempt[];
  customer: ProbeAttempt[];
  verdict: string;
  error?: string;
};

/** One tried parameter, and whether it did anything. */
function Attempt({ a }: { a: ProbeAttempt }) {
  return (
    <li className="flex items-baseline justify-between gap-3">
      <span className={cn("font-mono", a.worked ? "text-accent-green" : "text-muted")}>
        {a.what}
      </span>
      <span className="text-right text-muted">
        {a.worked ? "works" : (a.note ?? "no effect")}
        {a.records ? ` · ${a.records} record(s)` : ""}
      </span>
    </li>
  );
}

/** "a, b or c" — a list a person can read aloud. */
const list = (items: string[]) =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;

const stamp = (s: string | null) =>
  s ? new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

const day = (s: string | null) =>
  s ? new Date(s).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";

function Line({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-muted">{label}</span>
      <span className={cn("tnum text-right", tone)}>{value}</span>
    </div>
  );
}

/**
 * How far back the dashboard's payment data reaches, and a way to reach further.
 *
 * The poller reads Paymaxis newest-first and stops at the first page it already
 * knows — correct for staying current, and the reason nothing older than the day
 * polling started is ever fetched. So a client who deposited in January is
 * simply absent from a dashboard that started reading in June, their totals are
 * short by that much, and reconciliation reports gaps that are really just
 * unfetched history. No filter can recover them; someone has to walk the list
 * backwards.
 *
 * That walk cannot be one request: the provider's list has no date filter, the
 * host kills a request at 60 seconds, and the list is as long as the merchant is
 * old. So the API does one bounded slice per call and this page keeps calling
 * until it reports done — the browser is the loop, and every step's progress is
 * already on disk before it returns.
 */
export function DataCoverage() {
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<Progress[] | null>(null);
  const [running, setRunning] = useState(false);
  const [notConfigured, setNotConfigured] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [steps, setSteps] = useState(0);
  const [probe, setProbe] = useState<HistoryProbe[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [customer, setCustomer] = useState("");
  const [tryPath, setTryPath] = useState("/api/v1/payments");
  const [tryQuery, setTryQuery] = useState("");
  const [tried, setTried] = useState<TryResult | null>(null);
  const [trying, setTrying] = useState(false);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<(ImportSummary & { file: string }) | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [sent, setSent] = useState({ done: 0, total: 0 });
  const fileInput = useRef<HTMLInputElement>(null);
  // A ref, not state: the loop below reads it between awaits, and a state value
  // captured at the start of the loop would never see the change.
  const stop = useRef(false);

  const status = useQuery({
    queryKey: ["paymaxis-backfill"],
    queryFn: () => apiFetch<Progress[]>("/paymaxis/backfill"),
    enabled: !isDemoMode,
  });

  const shown = rows ?? status.data ?? [];
  // Nothing left to walk. The import button is withdrawn rather than left there
  // doing nothing when pressed; restarting from the newest is still offered,
  // since that is the answer to a provider back-loading old payments.
  const allDone = shown.length > 0 && shown.every((r) => r.done);

  const step = async (reset: boolean) => {
    const res = await apiFetch<StepResponse>("/paymaxis/backfill", {
      method: "POST",
      body: JSON.stringify(reset ? { reset: true } : {}),
    });
    if (!Array.isArray(res)) {
      setNotConfigured(res.error);
      return null;
    }
    setNotConfigured(null);
    setRows(res);
    return res;
  };

  const run = async (reset: boolean) => {
    stop.current = false;
    setRunning(true);
    setFailure(null);
    setSteps(0);
    try {
      let first = true;
      for (;;) {
        const res = await step(first && reset);
        first = false;
        if (!res) break;
        setSteps((n) => n + 1);
        // Every shop finished, or one of them is stuck: either way there is
        // nothing for another step to do.
        if (res.every((r) => r.done || r.error)) break;
        if (stop.current) break;
      }
      // Anything downstream that counts payments is now looking at more of them.
      await queryClient.invalidateQueries();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      void status.refetch();
    }
  };

  /**
   * Asks the provider whether the older payments can be fetched at all.
   *
   * The import stopping early has two possible causes with opposite remedies —
   * our walk giving up, or the endpoint only serving recent records — and this
   * is the difference between them. It runs on the API, which already holds the
   * keys, so nobody has to check the repo out and paste a key into a shell.
   */
  const runProbe = async () => {
    setProbing(true);
    setFailure(null);
    try {
      const res = await apiFetch<HistoryProbe[] | { error: string }>(
        "/paymaxis/probe-history",
        { method: "POST", body: JSON.stringify({ customer: customer.trim() || undefined }) },
        { retries: 1 },
      );
      if (Array.isArray(res)) setProbe(res);
      else setNotConfigured(res.error);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setProbing(false);
    }
  };

  /**
   * The provider's console shows a customer's whole history, so the archive is
   * reachable — just not through the endpoint we poll. Read the call the console
   * makes off its network tab, put it here, and this says whether OUR key can
   * make the same call.
   */
  const runTry = async () => {
    setTrying(true);
    setFailure(null);
    try {
      const params: Record<string, string> = {};
      new URLSearchParams(tryQuery.replace(/^\?/, "")).forEach((v, k) => {
        params[k] = v;
      });
      setTried(
        await apiFetch<TryResult>(
          "/paymaxis/try-call",
          { method: "POST", body: JSON.stringify({ path: tryPath, params }) },
          { retries: 1 },
        ),
      );
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setTrying(false);
    }
  };

  /**
   * Loads a file exported out of the Paymaxis console.
   *
   * The provider's list endpoint serves a rolling 24 hours — measured, on both
   * shops, and no date parameter, ordering or paging reaches past it. The
   * console holds the whole archive but is a session-bound back-office
   * application, not something a server can be pointed at. Its export, though,
   * is an ordinary file: Actions → Download → CSV, with the period the operator
   * chose. That is the route the history takes.
   *
   * Parsed here and posted in slices, so the browser is the loop and no request
   * carries more than it can finish. Re-importing a period already held stores
   * nothing twice — the rows are keyed exactly as polled payments are — so
   * nobody has to remember where the last export stopped.
   */
  const importFile = async (file: File) => {
    setImporting(true);
    setImportError(null);
    setImported(null);
    setSent({ done: 0, total: 0 });
    try {
      const ds = await parseFile(file);
      const rows = ds.rows.filter((r) =>
        Object.values(r).some((v) => String(v ?? "").trim() !== ""),
      );
      if (!rows.length) {
        setImportError(
          `${ds.fileName} has no rows. Export the worksheet itself rather than a summary view.`,
        );
        return;
      }
      setSent({ done: 0, total: rows.length });

      const totals: ImportSummary = {
        read: 0,
        mapped: 0,
        stored: 0,
        refreshed: 0,
        unusable: 0,
        duplicates: 0,
        oldest: null,
        newest: null,
        undated: 0,
        warnings: [],
      };
      let firstBatch = true;

      for (let i = 0; i < rows.length; i += IMPORT_BATCH) {
        const slice = rows.slice(i, i + IMPORT_BATCH);
        const res = await apiFetch<ImportSummary>(
          "/paymaxis/import",
          { method: "POST", body: JSON.stringify({ rows: slice }) },
          { retries: 1 },
        );
        totals.read += res.read;
        totals.mapped += res.mapped;
        totals.stored += res.stored;
        totals.refreshed += res.refreshed;
        totals.unusable += res.unusable;
        totals.duplicates += res.duplicates;
        totals.undated += res.undated;
        if (res.oldest && (!totals.oldest || res.oldest < totals.oldest)) totals.oldest = res.oldest;
        if (res.newest && (!totals.newest || res.newest > totals.newest)) totals.newest = res.newest;
        // A column counts as missing from the FILE only if it was missing from
        // every slice — one slice of refunds with no error codes says nothing
        // about the file.
        totals.warnings = firstBatch
          ? res.warnings
          : totals.warnings.filter((w) => res.warnings.includes(w));
        firstBatch = false;

        setSent({ done: Math.min(i + IMPORT_BATCH, rows.length), total: rows.length });
        setImported({ ...totals, file: ds.fileName });
      }

      // Every total, chart and client drawer is now looking at more history.
      await queryClient.invalidateQueries();
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
      // So "Payments held" and the covering dates move as soon as it lands.
      void status.refetch();
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  if (isDemoMode) {
    return (
      <Card className="glass card-seam">
        <CardHeader>
          <CardTitle>Data coverage</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted">
            Coverage is read from the API and is not available in demo mode.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="glass card-seam">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="size-4 text-muted" />
          Data coverage
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <p className="text-sm text-muted-foreground">
          Payments are pulled newest-first, and the poll stops at the first page it
          already knows — so nothing older than the day polling started arrives on
          its own. Walking the provider&rsquo;s list backwards recovers about a day
          past that and no further: the endpoint serves a rolling window, which the
          diagnosis below measures. Everything older comes in from a console export.
        </p>

        {notConfigured ? (
          <p className="rounded-lg border border-accent-orange/25 bg-accent-orange-soft px-3 py-2 text-xs text-accent-orange">
            {notConfigured} — the API holds no credentials to read with, so there is
            nothing to import.
          </p>
        ) : null}

        {failure ? (
          <p className="rounded-lg border border-accent-red/25 bg-accent-red-soft px-3 py-2 text-xs text-accent-red">
            The import stopped: {failure}
          </p>
        ) : null}

        {status.isLoading && !rows ? (
          <p className="text-sm text-muted">Reading coverage…</p>
        ) : null}

        {shown.map((r) => {
          /*
            "Complete" means the provider's list ran out — which is only good
            news if that list actually went back. When the oldest record it
            returned is NEWER than payments we already hold, the endpoint is
            serving a recent window rather than the history, and calling that
            Complete tells somebody the import worked when the older payments
            they are looking for were never on offer.
          */
          const listShort =
            r.done &&
            Boolean(r.oldestSeen && r.coverageFrom) &&
            Date.parse(r.oldestSeen as string) > Date.parse(r.coverageFrom as string);
          const state = r.error
            ? { label: "Stopped", tone: "text-accent-red" }
            : listShort
              ? { label: "Provider list ends early", tone: "text-accent-orange" }
              : r.done
                ? { label: "Complete", tone: "text-accent-green" }
                : r.pages > 0
                  ? { label: "Partly imported", tone: "text-accent-orange" }
                  : { label: "Not started", tone: "text-muted" };
          return (
            <div key={r.shop} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">Shop {r.shop}</span>
                <span className={cn("text-xs font-medium", state.tone)}>{state.label}</span>
              </div>
              <Line label="Payments held" value={r.payments.toLocaleString()} />
              <Line
                label="Covering"
                value={r.payments ? `${day(r.coverageFrom)} → ${day(r.coverageTo)}` : "nothing yet"}
              />
              {/* The oldest payment the walk has reached is the honest progress
                  figure: the length of the provider's list is unknown until the
                  walk ends, so a percentage would be invented. */}
              <Line label="Import reached back to" value={stamp(r.oldestSeen)} />
              <Line
                label="Pages read"
                value={`${r.pages.toLocaleString()} · ${r.stored.toLocaleString()} stored of ${r.fetched.toLocaleString()} read`}
              />
              {r.error ? (
                <p className="rounded-md border border-accent-red/25 bg-accent-red-soft px-2 py-1.5 text-[11px] text-accent-red">
                  {r.error}
                </p>
              ) : null}

              {listShort ? (
                <p className="rounded-md border border-accent-orange/25 bg-accent-orange-soft px-2 py-1.5 text-[11px] text-accent-orange">
                  The walk read the provider&rsquo;s whole list —{" "}
                  {r.fetched.toLocaleString()} record(s) over {r.pages} page(s) — and its
                  oldest was {stamp(r.oldestSeen)}, which is NEWER than payments this
                  dashboard already holds ({stamp(r.coverageFrom)}). The endpoint is
                  returning a recent window rather than the account&rsquo;s history, so
                  older payments cannot be imported through it however many times this
                  is run. Ask Paymaxis for a date-ranged export, or for the parameter
                  that pages further back, and it can be wired here.
                </p>
              ) : null}
              {r.busy ? (
                <p className="text-[11px] text-muted">
                  Another import is running for this shop — nothing was done here.
                </p>
              ) : null}
            </div>
          );
        })}

        {/* The route the archive actually takes. */}
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
          <div className="flex flex-col gap-0.5">
            <span className="flex items-center gap-2 text-sm font-medium">
              <Upload className="size-3.5 text-muted" />
              Load history from a Paymaxis export
            </span>
            <span className="text-[11px] text-muted">
              The provider&rsquo;s API only serves the last day or so, whatever it is
              asked — but their console can export everything. Open it, set the period
              you want, then <span className="text-foreground">Actions → Download → CSV</span>{" "}
              and drop the file here. Payments already held are not stored twice, so
              overlapping exports are safe and there is nothing to keep track of.
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.tsv,.txt,.xls,.xlsx"
              disabled={importing}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importFile(f);
              }}
              className="text-xs text-muted file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-xs file:text-foreground hover:file:bg-elevated"
            />
            {importing ? (
              <span className="text-xs text-muted">
                Loading… {sent.done.toLocaleString()} of {sent.total.toLocaleString()} row(s)
              </span>
            ) : null}
          </div>

          {importError ? (
            <p className="rounded-md border border-accent-red/25 bg-accent-red-soft px-2 py-1.5 text-[11px] text-accent-red">
              The file could not be loaded: {importError}
            </p>
          ) : null}

          {imported ? (
            <div className="flex flex-col gap-1 border-t border-border pt-2 text-xs">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono">{imported.file}</span>
                <span className={imported.stored ? "text-accent-green" : "text-muted"}>
                  {imported.stored.toLocaleString()} new payment(s) stored
                </span>
              </div>
              <Line
                label="Covering"
                value={
                  imported.oldest
                    ? `${stamp(imported.oldest)} → ${stamp(imported.newest)}`
                    : "no dates in this file"
                }
              />
              <Line
                label="Rows read"
                value={`${imported.read.toLocaleString()} · ${imported.duplicates.toLocaleString()} already held`}
              />
              {/* Loading the same file again is how rows stored before a
                  mapping was fixed get repaired, so it needs to be visible
                  that something happened — "0 stored" alone reads as a
                  wasted upload. */}
              {imported.refreshed ? (
                <Line
                  label="Already held, rewritten from this file"
                  value={imported.refreshed.toLocaleString()}
                />
              ) : null}
              {/* Named rather than hidden: a row nothing could key on is a row
                  that will never appear in any figure, and how many there were
                  is the difference between "a stray footer line" and "the wrong
                  columns were exported". */}
              {imported.unusable ? (
                <Line
                  label="Skipped (no id or reference)"
                  value={imported.unusable.toLocaleString()}
                  tone="text-accent-orange"
                />
              ) : null}
              {imported.undated ? (
                <Line
                  label="Stored without a date"
                  value={imported.undated.toLocaleString()}
                  tone="text-accent-orange"
                />
              ) : null}
              {imported.undated ? (
                <p className="text-[11px] text-muted">
                  Those rows are held but fall outside every date filter. It usually
                  means a spreadsheet reformatted the dates when it opened the file —
                  re-exporting as CSV and loading that file fixes them in place.
                </p>
              ) : null}
              {/* One line, however many columns are missing: a file exported
                  with the wrong view selected is missing most of them, and six
                  identical banners say the same thing six times. */}
              {imported.warnings.length ? (
                <p className="rounded-md border border-accent-orange/25 bg-accent-orange-soft px-2 py-1.5 text-[11px] text-accent-orange">
                  No {list(imported.warnings)} anywhere in this file — every row was
                  blank there. Show{" "}
                  {imported.warnings.length === 1 ? "that column" : "those columns"} in
                  the console before exporting, or every figure built on{" "}
                  {imported.warnings.length === 1 ? "it" : "them"} reads as zero.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* The diagnosis, when the import ends early and the reason matters. */}
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Can the provider give us older payments?</span>
              <span className="text-[11px] text-muted">
                Tries paging deeper, a date window, an oldest-first sort and a customer
                filter, and reports which of them the API actually honours. Read-only.
              </span>
            </div>
            <div className="flex items-end gap-2">
              <label className="flex flex-col gap-0.5">
                <span className="text-[10px] text-muted">Client to test (optional)</span>
                <input
                  value={customer}
                  onChange={(e) => setCustomer(e.target.value)}
                  placeholder="CU60573"
                  className="rounded-md border border-border bg-surface px-2 py-1 text-xs"
                />
              </label>
              <Button variant="secondary" onClick={() => void runProbe()} disabled={probing}>
                {probing ? "Asking the provider…" : "Diagnose"}
              </Button>
            </div>
          </div>

          {probe?.map((p) => (
            <div key={p.shop} className="flex flex-col gap-1.5 border-t border-border pt-2 text-xs">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">Shop {p.shop}</span>
                <span className="text-muted">
                  paging: {p.paging.records} record(s) over {p.paging.pages} page(s)
                  {p.paging.daysBack !== null ? `, ${p.paging.daysBack} day(s) back` : ""} —{" "}
                  {p.paging.stoppedBecause}
                </span>
              </div>
              {p.dateWindow.length ? (
                <>
                  <span className="text-[11px] uppercase tracking-wider text-muted">Date window</span>
                  <ul className="flex flex-col gap-0.5">
                    {p.dateWindow.map((a) => <Attempt key={a.what} a={a} />)}
                  </ul>
                </>
              ) : null}
              {p.ordering.length ? (
                <>
                  <span className="text-[11px] uppercase tracking-wider text-muted">Ordering</span>
                  <ul className="flex flex-col gap-0.5">
                    {p.ordering.map((a) => <Attempt key={a.what} a={a} />)}
                  </ul>
                </>
              ) : null}
              {p.customer.length ? (
                <>
                  <span className="text-[11px] uppercase tracking-wider text-muted">Customer filter</span>
                  <ul className="flex flex-col gap-0.5">
                    {p.customer.map((a) => <Attempt key={a.what} a={a} />)}
                  </ul>
                </>
              ) : null}
              <p className="rounded-md border border-accent-blue/25 bg-accent-blue-soft px-2 py-1.5 text-accent-blue">
                {p.verdict}
              </p>
              {p.error ? <p className="text-accent-red">{p.error}</p> : null}
            </div>
          ))}

          {probe?.length ? (
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(JSON.stringify(probe, null, 2));
              }}
              className="self-start text-[11px] text-muted underline underline-offset-2 hover:text-foreground"
            >
              Copy the full result
            </button>
          ) : null}
        </div>

        {/* For the call the provider's own console makes. */}
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">Try a call the console makes</span>
            <span className="text-[11px] text-muted">
              Paymaxis&rsquo;s own console can show a customer&rsquo;s whole history, so
              some call reaches it. Open the console with the browser&rsquo;s network tab
              recording, search a customer, and copy the request&rsquo;s path and query
              here — this reports whether our key can make the same call. Read-only.
            </span>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-1 flex-col gap-0.5">
              <span className="text-[10px] text-muted">Path</span>
              <input
                value={tryPath}
                onChange={(e) => setTryPath(e.target.value)}
                placeholder="/api/v1/payments"
                className="rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs"
              />
            </label>
            <label className="flex flex-1 flex-col gap-0.5">
              <span className="text-[10px] text-muted">Query</span>
              <input
                value={tryQuery}
                onChange={(e) => setTryQuery(e.target.value)}
                placeholder="customerReferenceId=CU60573&limit=100"
                className="rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs"
              />
            </label>
            <Button variant="secondary" onClick={() => void runTry()} disabled={trying}>
              {trying ? "Trying…" : "Try"}
            </Button>
          </div>

          {tried ? (
            <div className="flex flex-col gap-1 border-t border-border pt-2 text-xs">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono">{tried.path}</span>
                <span className={tried.status === 200 ? "text-accent-green" : "text-accent-orange"}>
                  HTTP {tried.status} · {tried.records} record(s)
                </span>
              </div>
              {tried.records ? (
                <span className="text-muted">
                  {stamp(tried.newest)} → {stamp(tried.oldest)}
                </span>
              ) : null}
              <span className="text-muted-foreground">{tried.note}</span>
              {tried.fields.length ? (
                <span className="text-[11px] text-muted">
                  Fields returned: {tried.fields.join(", ")}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <Button
              variant="secondary"
              onClick={() => {
                stop.current = true;
              }}
            >
              <Square className="size-3.5" />
              Stop after this slice
            </Button>
          ) : allDone ? null : (
            <Button onClick={() => void run(false)}>
              <Play className="size-3.5" />
              {shown.some((r) => r.pages > 0 && !r.done) ? "Resume import" : "Import older history"}
            </Button>
          )}
          {/* Only offered once a walk has finished: it is the answer to "the
              provider bulk-loaded old payments after we passed that point",
              which is the one case a completed cursor is wrong. */}
          {!running && shown.some((r) => r.done) ? (
            <Button variant={allDone ? "secondary" : "ghost"} onClick={() => void run(true)}>
              Start again from the newest
            </Button>
          ) : null}
          <span className="text-xs text-muted">
            {running
              ? `Importing… ${steps} slice${steps === 1 ? "" : "s"} done. Safe to leave this page — the position is saved.`
              : shown.every((r) => r.done) && shown.length
                ? "Every page has been read."
                : ""}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
