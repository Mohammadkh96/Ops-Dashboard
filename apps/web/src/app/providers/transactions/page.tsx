"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Download, RefreshCw, Upload } from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { parseCsv } from "@/lib/csv";
import {
  usePspImport,
  usePspLedger,
  usePspLedgerSummary,
  usePspSync,
  type LedgerRow,
} from "@/hooks/use-psps";

/**
 * One provider's transactions, as they were reported to us.
 *
 * READ FROM OUR OWN TABLE, not from the provider. A terminal has thousands of
 * these and the provider hands them over fifty at a time, so opening this page
 * against their API would be fifty round trips and several seconds — every
 * time, for everyone. The sync fills the table; this reads it.
 *
 * The values are the PROVIDER'S. Their status word, their direction, their
 * timestamp string. This page exists to be compared against what Paymaxis says,
 * and a comparison between two things we have already normalised compares our
 * own two guesses rather than the two systems.
 */

const field =
  "h-9 rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-border-strong";

const PAGE = 100;

/**
 * Which connection to show, from the address bar.
 *
 * A query parameter rather than a path segment because this app is a static
 * export: a dynamic route needs every id known at build time, and connections
 * are created by a person at runtime.
 *
 * useSearchParams, and NOT a module-level cache of window.location. The cache
 * is the right shape for a value that is read once on a full page load — the
 * login page reads its error that way — and exactly the wrong shape here. This
 * is an SPA route reached by CLIENT-SIDE navigation, so the module stays loaded
 * between visits: landing here once without an id cached `null`, and every
 * later click on a provider then showed "No provider chosen" until the page was
 * reloaded by hand. It would equally have shown the first provider's ledger
 * under the second provider's name.
 *
 * Suspense because useSearchParams suspends during the static prerender, which
 * has no address bar to read.
 */
export default function PspTransactionsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col gap-4">
          <PageHeader title="Transactions" />
          <Card className="glass card-seam">
            <CardContent className="py-10 text-center text-sm text-muted">
              Reading…
            </CardContent>
          </Card>
        </div>
      }
    >
      <Ledger />
    </Suspense>
  );
}

function Ledger() {
  const { toast } = useToast();
  const id = useSearchParams().get("id");

  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState("");
  const [direction, setDirection] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");

  const query = {
    limit: PAGE,
    offset,
    status: status || undefined,
    direction: direction || undefined,
    from: from || undefined,
    to: to || undefined,
    search: search.trim() || undefined,
  };

  const ledger = usePspLedger(id, query);
  const summary = usePspLedgerSummary(id);
  const sync = usePspSync();
  const importRows = usePspImport();

  const rows = ledger.data?.rows ?? [];
  const total = ledger.data?.total ?? 0;
  // Configured in Admin, headed here. The table does not know what they mean —
  // which is the point: a new provider gets its own columns without a change
  // to this file.
  const extraColumns = ledger.data?.extraColumns ?? [];
  // A terminal whose transactions arrive through Paymaxis has nothing to pull:
  // they are pushed by the provider and imported already. Buttons that cannot
  // do anything are worse than no buttons — they read as broken.
  const viaPaymaxis = ledger.data?.source === "paymaxis";

  // A filter change with a page-3 offset shows an empty table and reads as
  // "there is nothing", when what happened is that the result is shorter.
  const filter = (set: (v: string) => void) => (v: string) => {
    set(v);
    setOffset(0);
  };

  if (!id) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Transactions" />
        <Card className="glass card-seam">
          <CardContent className="py-10 text-center text-sm text-muted">
            No provider chosen. Open this from{" "}
            <Link href="/providers" className="underline">
              Providers
            </Link>
            .
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Transactions"
        description="As the provider reported them — their status words, their timestamps."
        actions={
          <div className="flex items-center gap-2">
            {viaPaymaxis ? (
              <span className="text-[11px] text-muted">
                Arrives through Paymaxis — always current
              </span>
            ) : null}
            <Link href="/providers">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="size-3.5" />
                Providers
              </Button>
            </Link>
            {/* For providers with a portal but no readable API — which is most
                of them. Match2Pay publishes two endpoints and both create
                money movements; its portal has an Export to CSV button. */}
            {viaPaymaxis ? null : (
              <label className="inline-flex">
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    // Cleared immediately so the SAME file can be chosen
                    // again after a failed import — otherwise the input holds
                    // it and the second attempt fires no event at all.
                    e.target.value = "";
                    if (!file || !id) return;
                    const rows = parseCsv(await file.text());
                    if (!rows.length) {
                      toast({
                        kind: "warning",
                        title: "That file had no rows",
                        description:
                          "A CSV needs a heading row and at least one record.",
                      });
                      return;
                    }
                    importRows.mutate(
                      { id, rows },
                      {
                        onSuccess: (r) =>
                          toast({
                            kind: "success",
                            title: `${r.created} new, ${r.updated} updated`,
                            description: r.skipped
                              ? `${r.skipped} row${r.skipped === 1 ? "" : "s"} had no id and were left out.`
                              : `${r.total} rows read.`,
                          }),
                        onError: (err: unknown) =>
                          toast({
                            kind: "warning",
                            title:
                              err instanceof Error ? err.message : String(err),
                          }),
                      },
                    );
                  }}
                />
                <Button variant="secondary" size="sm" asChild>
                  <span>
                    <Upload className="size-3.5" />
                    {importRows.isPending ? "Importing…" : "Import CSV"}
                  </span>
                </Button>
              </label>
            )}
            {viaPaymaxis ? null : (
              <>
                <Button
                  size="sm"
                  disabled={sync.isPending}
                  onClick={() =>
                    sync.mutate(
                      { id },
                      {
                        onSuccess: (r) =>
                          toast({
                            kind: r.ok ? "success" : "warning",
                            title: r.ok
                              ? `${r.created} new, ${r.updated} updated`
                              : (r.error ?? "Sync failed"),
                            description: r.stopped,
                          }),
                        onError: (e: unknown) =>
                          toast({
                            kind: "warning",
                            title: e instanceof Error ? e.message : String(e),
                          }),
                      },
                    )
                  }
                >
                  <RefreshCw
                    className={
                      sync.isPending ? "size-3.5 animate-spin" : "size-3.5"
                    }
                  />
                  {sync.isPending ? "Reading…" : "Sync new"}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={sync.isPending}
                  onClick={() =>
                    sync.mutate(
                      { id, full: true },
                      {
                        onSuccess: (r) =>
                          toast({
                            kind: r.ok ? "success" : "warning",
                            title: r.ok
                              ? `${r.fetched} read over ${r.pages} pages — ${r.created} new`
                              : (r.error ?? "Sync failed"),
                            description: r.stopped,
                          }),
                      },
                    )
                  }
                >
                  Full sync
                </Button>
              </>
            )}
          </div>
        }
      />

      {summary.data ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted">
          <span>
            <span className="tnum font-medium text-foreground">
              {summary.data.count.toLocaleString()}
            </span>{" "}
            stored
          </span>
          {summary.data.oldest && summary.data.newest ? (
            <span>
              {summary.data.oldest.slice(0, 10)} →{" "}
              {summary.data.newest.slice(0, 10)}
            </span>
          ) : null}
          {summary.data.byStatus.slice(0, 5).map((s) => (
            <span key={s.status}>
              {s.status}:{" "}
              <span className="tnum">{s.count.toLocaleString()}</span>
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <input
          value={search}
          onChange={(e) => filter(setSearch)(e.target.value)}
          placeholder="Payment id, reference or client"
          className={`${field} min-w-56 flex-1`}
        />
        <input
          value={status}
          onChange={(e) => filter(setStatus)(e.target.value)}
          placeholder="Status, e.g. confirmed"
          className={field}
        />
        <input
          value={direction}
          onChange={(e) => filter(setDirection)(e.target.value)}
          placeholder="Direction, e.g. Sell"
          className={field}
        />
        <input
          type="date"
          value={from}
          onChange={(e) => filter(setFrom)(e.target.value)}
          className={field}
        />
        <input
          type="date"
          value={to}
          onChange={(e) => filter(setTo)(e.target.value)}
          className={field}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setSearch("");
            setStatus("");
            setDirection("");
            setFrom("");
            setTo("");
            setOffset(0);
          }}
        >
          Clear
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => downloadCsv(rows, extraColumns)}
        >
          <Download className="size-3.5" />
          CSV
        </Button>
      </div>

      {ledger.isError ? (
        <p className="rounded-lg border border-accent-red/25 bg-accent-red-soft px-3 py-2 text-xs text-accent-red">
          Could not read the transactions: {String(ledger.error)}
        </p>
      ) : null}

      <Card className="glass card-seam">
        <CardContent className="p-0">
          {ledger.isLoading ? (
            <p className="py-10 text-center text-sm text-muted">Reading…</p>
          ) : rows.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">
              {summary.data?.count
                ? "Nothing matches those filters."
                : "Nothing stored yet — press “Full sync” to read the provider’s ledger in."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-border text-muted">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-medium">When</th>
                    <th className="px-3 py-2 font-medium">Payment id</th>
                    <th className="px-3 py-2 font-medium">Reference</th>
                    {extraColumns.map((c) => (
                      <th key={c} className="px-3 py-2 font-medium">
                        {c}
                      </th>
                    ))}
                    <th className="px-3 py-2 font-medium">Client</th>
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      className="border-b border-border/50 last:border-0"
                    >
                      {/* Their string, not our parse of it. These carry no
                          timezone, and a converted time shown as fact is how a
                          payment lands in the wrong shift. */}
                      <td className="px-3 py-2 whitespace-nowrap">
                        {r.rawAt ??
                          r.occurredAt?.replace("T", " ").slice(0, 19) ??
                          "—"}
                      </td>
                      <td className="px-3 py-2 font-mono">
                        {r.externalId.slice(0, 12)}…
                      </td>
                      <td className="px-3 py-2 font-mono break-all">
                        {r.reference ?? "—"}
                      </td>
                      {extraColumns.map((c) => (
                        <td key={c} className="px-3 py-2 font-mono break-all">
                          {r.extras?.[c] ?? "—"}
                        </td>
                      ))}
                      <td className="px-3 py-2 font-mono">
                        {r.customer ?? "—"}
                      </td>
                      <td className="px-3 py-2">{r.direction ?? "—"}</td>
                      <td className="tnum px-3 py-2 text-right whitespace-nowrap">
                        {/* A dash is a question; 0.00 would be a wrong answer. */}
                        {r.amount === null ? "—" : money(r.amount)}{" "}
                        <span className="text-muted">{r.currency ?? ""}</span>
                      </td>
                      <td className="px-3 py-2">{r.status ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {total > PAGE ? (
        <div className="flex items-center justify-between text-xs text-muted">
          <span>
            {offset + 1}–{Math.min(offset + PAGE, total)} of{" "}
            {total.toLocaleString()}
          </span>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >
              Previous
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={offset + PAGE >= total}
              onClick={() => setOffset(offset + PAGE)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function money(n: number): string {
  const abs = Math.abs(n);
  const digits = n === 0 ? 2 : abs < 0.01 ? 8 : abs < 1 ? 6 : 2;
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  });
}

/**
 * The rows on screen, as a file.
 *
 * The page you are looking at, not the whole table: exporting more than is
 * displayed makes the button a different action from the one it appears to be.
 */
function downloadCsv(rows: LedgerRow[], extraColumns: string[]) {
  const head = [
    "when",
    "payment_id",
    "reference",
    ...extraColumns,
    "client",
    "type",
    "amount",
    "currency",
    "status",
  ];
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    // Quoted always. A reference containing a comma would otherwise shift every
    // column after it, which is the kind of error nobody notices in a spreadsheet.
    return `"${s.replace(/"/g, '""')}"`;
  };
  const csv = [
    head.join(","),
    ...rows.map((r) =>
      [
        r.rawAt ?? r.occurredAt ?? "",
        r.externalId,
        r.reference,
        ...extraColumns.map((c) => r.extras?.[c] ?? ""),
        r.customer,
        r.direction,
        r.amount,
        r.currency,
        r.status,
      ]
        .map(cell)
        .join(","),
    ),
  ].join("\n");

  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `transactions-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
