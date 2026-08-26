"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Download } from "lucide-react";

import { DataTable, type Column } from "@/components/ui/data-table";
import { FilterBar } from "@/components/ui/filter-bar";
import { StatusBadge, RiskBadge } from "@/components/ui/status-badge";
import { ColumnPicker } from "@/components/payments/column-picker";
import { ClientDetail } from "@/components/payments/client-detail";
import { TransactionDetail } from "@/components/payments/transaction-detail";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { apiFetch, isDemoMode } from "@/lib/api";
import { type Transaction } from "@/lib/modules";
import { useTransactions } from "@/hooks/use-modules";
import {
  fieldText,
  useColumnCatalogue,
  useVisibleColumns,
  type FieldSpec,
} from "@/lib/columns";

/** Reads a catalogued value off a row, whichever half of the row holds it. */
const valueOf = (t: Transaction, key: string) => t.fields?.[key] ?? null;

/**
 * Cells the table renders specially — a coloured badge, a signed amount, a
 * monospaced reference. Everything else falls through to plain text, which is
 * what a field like "Billing Postal Code" wants anyway.
 */
export type ClientTotals = Record<
  string,
  {
    deposits: { count: number; amount: number };
    withdrawals: { count: number; amount: number };
    refunds: { count: number; amount: number };
    currencies: string[];
  }
>;

/** A client total: the figure, and how many payments are behind it. */
function totalCell(
  tally: { count: number; amount: number } | undefined,
  currencies: string[] | undefined,
  tone: string,
  loading: boolean,
) {
  if (!tally) {
    return <span className="text-muted">{loading ? "…" : "—"}</span>;
  }
  const ccy = currencies?.length === 1 ? currencies[0] : "";
  return (
    <span className="tnum" title={`${tally.count} settled payment(s)`}>
      <span className={tally.amount ? tone : "text-muted"}>
        {ccy === "USD" ? "$" : ""}
        {tally.amount.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}
        {ccy && ccy !== "USD" ? ` ${ccy}` : ""}
      </span>{" "}
      <span className="text-[11px] text-muted">({tally.count})</span>
    </span>
  );
}

function cellFor(
  spec: FieldSpec,
  t: Transaction,
  onClient?: (reference: string) => void,
  totals?: ClientTotals,
  totalsLoading = false,
) {
  switch (spec.key) {
    case "clientTotalDeposits":
      return totalCell(
        totals?.[t.client]?.deposits,
        totals?.[t.client]?.currencies,
        "text-accent-green",
        totalsLoading,
      );
    case "clientTotalWithdrawals":
      return totalCell(
        totals?.[t.client]?.withdrawals,
        totals?.[t.client]?.currencies,
        "text-accent-magenta",
        totalsLoading,
      );
    case "reference":
      return (
        <span className="font-mono text-xs text-muted-foreground">
          {t.reference}
        </span>
      );
    case "type":
      return (
        <span
          className={
            t.type === "Withdrawal" ? "text-accent-magenta" : "text-accent-blue"
          }
        >
          {t.type}
        </span>
      );
    case "stateLabel":
      return <StatusBadge status={t.status} label={t.stateLabel ?? undefined} />;
    case "amount":
      return <span className="tnum font-medium">{money(t)}</span>;
    case "customer":
      // Opens the client rather than the payment. stopPropagation because the
      // row itself is clickable: without it, both drawers would fire and the
      // payment would win, which is the opposite of what was clicked.
      return (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClient?.(t.client);
          }}
          className="text-left underline decoration-dotted decoration-muted underline-offset-4 transition-colors hover:text-accent-blue"
        >
          {t.client}
        </button>
      );
    case "time":
      return <span className="tnum text-muted">{t.createdAt}</span>;
    default: {
      const v = fieldText(valueOf(t, spec.key));
      if (!v) return <span className="text-muted">—</span>;
      // Long opaque values — addresses, JSON blobs, hashes — would otherwise
      // stretch a column past the width of the screen.
      return (
        <span
          title={v.length > 28 ? v : undefined}
          className={
            spec.align === "right"
              ? "tnum text-muted-foreground"
              : "block max-w-[16rem] truncate text-muted-foreground"
          }
        >
          {v}
        </span>
      );
    }
  }
}

/** RFC 4180: quotes doubled, and any field containing a comma, quote or newline quoted. */
function csvCell(v: string) {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const money = (t: Transaction) => {
  const sign = t.type === "Withdrawal" ? "−" : "+";
  const v = t.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}${t.currency === "USD" ? "$" : ""}${v}${t.currency !== "USD" ? " " + t.currency : ""}`;
};

export function TransactionsTable({ fixedType }: { fixedType?: "Deposit" | "Withdrawal" | "Refund" } = {}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [method, setMethod] = useState("");
  const [gateway, setGateway] = useState("");
  const [selected, setSelected] = useState<Transaction | null>(null);
  const [client, setClient] = useState<string | null>(null);
  const { data: transactions, isLoading } = useTransactions(fixedType);
  const { toast } = useToast();
  const { data: catalogue } = useColumnCatalogue();
  const { visible, isCustom, set: setVisible, reset } = useVisibleColumns(catalogue);
  const byKey = useMemo(
    () => new Map((catalogue?.fields ?? []).map((f) => [f.key, f])),
    [catalogue],
  );

  const base = useMemo(
    () => (fixedType ? transactions.filter((t) => t.type === fixedType) : transactions),
    [fixedType, transactions],
  );

  // Only PSPs that actually appear in the data, alphabetically.
  const pspOptions = useMemo(
    () =>
      [...new Set(base.map((t) => t.gateway).filter(Boolean))]
        .sort()
        .map((g) => ({ label: g, value: g })),
    [base],
  );

  const filtered = useMemo(
    () =>
      base.filter((t) => {
        if (status && t.status !== status) return false;
        if (method && t.method !== method) return false;
        if (gateway && t.gateway !== gateway) return false;
        if (search) {
          const q = search.toLowerCase();
          if (
            !t.reference.toLowerCase().includes(q) &&
            !t.client.toLowerCase().includes(q) &&
            !t.country.toLowerCase().includes(q)
          )
            return false;
        }
        return true;
      }),
    [base, search, status, method, gateway],
  );

  // Only fetched when a total column is actually shown, and only for the
  // clients on screen: this reads a client's whole history, which is not work to
  // do for a column nobody has asked for.
  const wantsTotals =
    visible.includes("clientTotalDeposits") || visible.includes("clientTotalWithdrawals");
  const refs = useMemo(
    () => (wantsTotals ? [...new Set(filtered.map((t) => t.client).filter(Boolean))] : []),
    [wantsTotals, filtered],
  );
  const { data: totals, isFetching: totalsLoading } = useQuery({
    queryKey: ["client-totals", refs],
    queryFn: () =>
      apiFetch<ClientTotals>(
        "/clients/totals",
        { method: "POST", body: JSON.stringify({ refs }) },
        // A read behind a POST, so it is safe to send again on a cold start.
        { retries: 2 },
      ),
    enabled: !isDemoMode && refs.length > 0,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });

  const columns: Column<Transaction>[] = visible.map((key) => {
    const spec =
      byKey.get(key) ?? ({ key, label: key, group: "payment" } as FieldSpec);
    return {
      key,
      header: spec.label,
      align: spec.align,
      render: (t: Transaction) => cellFor(spec, t, setClient, totals, totalsLoading),
    };
  });

  /**
   * Exports what is on screen: the chosen columns, the applied filters, in the
   * order shown. The button used to raise a toast saying a download would start
   * and then not download anything.
   */
  function exportCsv() {
    const header = columns.map((c) => csvCell(c.header)).join(",");
    const body = filtered.map((t) =>
      visible
        .map((key) => {
          // Bespoke cells hold their value on the row rather than in `fields`.
          if (key === "reference") return csvCell(t.reference);
          if (key === "type") return csvCell(t.type);
          if (key === "customer") return csvCell(t.client);
          if (key === "clientTotalDeposits")
            return csvCell(String(totals?.[t.client]?.deposits.amount ?? ""));
          if (key === "clientTotalWithdrawals")
            return csvCell(String(totals?.[t.client]?.withdrawals.amount ?? ""));
          if (key === "amount")
            return csvCell(
              `${t.type === "Withdrawal" ? "-" : ""}${t.amount}`,
            );
          return csvCell(fieldText(valueOf(t, key)));
        })
        .join(","),
    );
    // The BOM makes Excel read it as UTF-8; without it, a customer name with an
    // accent in it arrives mangled.
    const blob = new Blob(["\ufeff" + [header, ...body].join("\r\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payments-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({
      title: "Export ready",
      description: `${filtered.length} rows, ${columns.length} columns.`,
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <FilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search reference, client, country…"
        filters={[
          {
            label: "Status",
            value: status,
            onChange: setStatus,
            options: ["approved", "processing", "pending", "review", "declined", "failed", "refunded"].map((s) => ({ label: s[0].toUpperCase() + s.slice(1), value: s })),
          },
          { label: "Method", value: method, onChange: setMethod, options: ["Card", "Crypto", "Bank", "Local"].map((m) => ({ label: m, value: m })) },
          // Derived from the rows on screen. The list was hardcoded to seven
          // names including four PSPs this business does not use, so the filter
          // offered choices that could never match anything.
          { label: "PSP", value: gateway, onChange: setGateway, options: pspOptions },
        ]}
      >
        <span className="ml-auto text-xs text-muted">
          {filtered.length} of {transactions.length}
        </span>
        {catalogue ? (
          <ColumnPicker
            catalogue={catalogue}
            visible={visible}
            onChange={setVisible}
            onReset={reset}
            isCustom={isCustom}
          />
        ) : null}
        <button
          type="button"
          onClick={exportCsv}
          disabled={!filtered.length}
          className="flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs font-medium text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground disabled:opacity-40"
        >
          <Download className="size-3.5" />
          Export
        </button>
      </FilterBar>

      <DataTable
        columns={columns}
        rows={filtered}
        getRowKey={(t) => t.id}
        onRowClick={setSelected}
        pageSize={9}
        loading={isLoading}
        empty="No transactions match these filters."
      />

      <Drawer
        open={selected !== null}
        onOpenChange={(o) => !o && setSelected(null)}
        title={
          selected ? (
            <span className="flex items-center gap-2">
              {selected.reference}
              <button
                type="button"
                aria-label="Copy reference"
                onClick={() => {
                  navigator.clipboard?.writeText(selected.reference);
                  toast({ kind: "info", title: "Reference copied", description: selected.reference });
                }}
                className="text-muted transition-colors hover:text-foreground"
              >
                <Copy className="size-3.5" />
              </button>
            </span>
          ) : (
            ""
          )
        }
        subtitle={selected ? `${selected.type} · ${selected.gateway}` : ""}
        footer={
          selected ? (
            <div className="flex gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() =>
                  toast({ kind: "info", title: "Note added", description: `${selected.reference} updated.` })
                }
              >
                Add note
              </Button>
              {selected.status === "review" ? (
                <Button
                  className="flex-1"
                  onClick={() => {
                    toast({ title: "Transaction approved", description: `${selected.reference} released.` });
                    setSelected(null);
                  }}
                >
                  Approve
                </Button>
              ) : (
                <Button variant="outline" className="flex-1">View client</Button>
              )}
            </div>
          ) : null
        }
      >
        {selected ? <TransactionDetail row={selected} /> : null}
      </Drawer>

      <Drawer
        open={client !== null}
        onOpenChange={(o) => !o && setClient(null)}
        title={client ?? ""}
        subtitle="Client history"
      >
        {client ? <ClientDetail reference={client} /> : null}
      </Drawer>
    </div>
  );
}
