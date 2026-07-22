"use client";

import { useMemo, useState } from "react";

import { DataTable, type Column } from "@/components/ui/data-table";
import { FilterBar } from "@/components/ui/filter-bar";
import { StatusBadge, RiskBadge } from "@/components/ui/status-badge";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { type Transaction } from "@/lib/modules";
import { useTransactions } from "@/hooks/use-modules";

const money = (t: Transaction) => {
  const sign = t.type === "Withdrawal" ? "−" : "+";
  const v = t.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}${t.currency === "USD" ? "$" : ""}${v}${t.currency !== "USD" ? " " + t.currency : ""}`;
};

export function TransactionsTable({ fixedType }: { fixedType?: "Deposit" | "Withdrawal" } = {}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [method, setMethod] = useState("");
  const [gateway, setGateway] = useState("");
  const [selected, setSelected] = useState<Transaction | null>(null);
  const { data: transactions } = useTransactions();

  const base = useMemo(
    () => (fixedType ? transactions.filter((t) => t.type === fixedType) : transactions),
    [fixedType, transactions],
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
    { key: "method", header: "Method", render: (t) => <span className="text-muted-foreground">{t.method}</span> },
    { key: "gateway", header: "PSP", render: (t) => <span className="text-muted-foreground">{t.gateway}</span> },
    { key: "amount", header: "Amount", align: "right", render: (t) => <span className="tnum font-medium">{money(t)}</span> },
    { key: "risk", header: "Risk", render: (t) => <RiskBadge level={t.risk} /> },
    { key: "status", header: "Status", render: (t) => <StatusBadge status={t.status} /> },
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
          { label: "PSP", value: gateway, onChange: setGateway, options: ["ForumPay", "LimePay", "Paystrax", "Coinbase", "Stripe", "Nuvei", "Bridge"].map((g) => ({ label: g, value: g })) },
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
        empty="No transactions match these filters."
      />

      <Drawer
        open={selected !== null}
        onOpenChange={(o) => !o && setSelected(null)}
        title={selected?.reference ?? ""}
        subtitle={selected ? `${selected.type} · ${selected.gateway}` : ""}
        footer={
          selected ? (
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1">Add note</Button>
              {selected.status === "review" ? (
                <Button className="flex-1">Approve</Button>
              ) : (
                <Button variant="outline" className="flex-1">View client</Button>
              )}
            </div>
          ) : null
        }
      >
        {selected ? (
          <div className="flex flex-col gap-5">
            <div className="flex items-center justify-between rounded-xl border border-border bg-card p-4">
              <div className="flex flex-col">
                <span className="text-xs text-muted">Amount</span>
                <span className="tnum text-xl font-semibold">{money(selected)}</span>
              </div>
              <StatusBadge status={selected.status} />
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              {[
                ["Client", selected.client],
                ["Country", selected.country],
                ["Method", selected.method],
                ["Currency", selected.currency],
                ["Gateway", selected.gateway],
                ["Time", selected.createdAt],
              ].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-0.5">
                  <dt className="text-xs text-muted">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs text-muted">Risk</dt>
                <dd><RiskBadge level={selected.risk} /></dd>
              </div>
            </dl>

            <div className="flex flex-col gap-3">
              <span className="text-xs font-medium uppercase tracking-wider text-muted">Timeline</span>
              <ol className="flex flex-col gap-3 border-l border-border pl-4">
                {[
                  ["Created", selected.createdAt],
                  ["Risk scored", selected.createdAt],
                  ["Gateway response", selected.createdAt],
                  ["Webhook received", selected.createdAt],
                ].map(([label, time], i) => (
                  <li key={i} className="relative text-sm">
                    <span className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-accent-blue" />
                    <div className="flex justify-between">
                      <span>{label}</span>
                      <span className="tnum text-xs text-muted">{time}</span>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
