"use client";

import { useMemo, useState } from "react";
import { Copy } from "lucide-react";

import { DataTable, type Column } from "@/components/ui/data-table";
import { FilterBar } from "@/components/ui/filter-bar";
import { StatusBadge, RiskBadge } from "@/components/ui/status-badge";
import { TransactionDetail } from "@/components/payments/transaction-detail";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { type Transaction } from "@/lib/modules";
import { useTransactions } from "@/hooks/use-modules";

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
  const { data: transactions, isLoading } = useTransactions(fixedType);
  const { toast } = useToast();

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

  const columns: Column<Transaction>[] = [
    { key: "ref", header: "Reference", render: (t) => <span className="font-mono text-xs text-muted-foreground">{t.reference}</span> },
    { key: "client", header: "Client", render: (t) => t.client },
    { key: "type", header: "Type", render: (t) => <span className={t.type === "Withdrawal" ? "text-accent-magenta" : "text-accent-blue"}>{t.type}</span> },
    {
      key: "method",
      header: "Method",
      // The provider's own name. The filter above still groups by the four
      // buckets, so "Card" finds Basic Card and Google Pay alike, while the row
      // says which of them this actually was.
      render: (t) => (
        <span className="text-muted-foreground">{t.methodLabel ?? t.method}</span>
      ),
    },
    { key: "gateway", header: "PSP", render: (t) => <span className="text-muted-foreground">{t.gateway}</span> },
    { key: "amount", header: "Amount", align: "right", render: (t) => <span className="tnum font-medium">{money(t)}</span> },
    { key: "risk", header: "Risk", render: (t) => <RiskBadge level={t.risk} /> },
    {
      key: "status",
      header: "Status",
      // The provider's own wording, coloured by the bucket it falls into. The
      // bucket name alone flattened five distinct states onto "Pending".
      render: (t) => (
        <StatusBadge status={t.status} label={t.stateLabel ?? undefined} />
      ),
    },
    { key: "time", header: "Time", align: "right", render: (t) => <span className="tnum text-muted">{t.createdAt}</span> },
  ];

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
    </div>
  );
}
