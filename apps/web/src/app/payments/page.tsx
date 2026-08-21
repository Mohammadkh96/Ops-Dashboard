"use client";

import { useState } from "react";

import { PageHeader } from "@/components/ui/page-header";
import { type Stat } from "@/components/ui/stat-tile";
import { PaymentStats } from "@/components/payments/payment-stats";
import { cn } from "@/lib/utils";
import { TransactionsTable } from "@/components/payments/transactions-table";
import { GatewayGrid } from "@/components/payments/gateway-grid";

// Shown only when no real payments exist yet — see PaymentStats.
const demoStats: Stat[] = [
  { label: "Today's Volume", value: "$4.82M", delta: { text: "+8.4% vs yesterday", positive: true }, tone: "blue", spark: [3.1, 3.4, 3.2, 3.9, 4.1, 4.0, 4.5, 4.82] },
  { label: "Success Rate", value: "97.8%", delta: { text: "+0.6 pts", positive: true }, tone: "green", spark: [96, 97, 97, 98, 97, 98, 98, 97.8] },
  { label: "Failed Payments", value: "19", delta: { text: "+7 vs yesterday", positive: false }, tone: "orange", spark: [8, 10, 9, 12, 14, 16, 18, 19] },
  { label: "Pending Refunds", value: "5", delta: { text: "$18.4K held", positive: false }, tone: "magenta", spark: [2, 3, 3, 4, 4, 5, 5, 5] },
];

const TABS = [
  { key: "transactions", label: "Transactions" },
  { key: "gateways", label: "Payment Gateways" },
] as const;

export default function PaymentsPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("transactions");

  return (
    <div className="flex flex-col gap-6">
      {/*
        Export moved next to the table. It raised a toast promising a download
        that never arrived, and it sat in the page header where it had no idea
        which columns were shown or which filters were applied — the two things
        that decide what an export should contain.
      */}
      <PageHeader
        title="Payments"
        description="Every transaction and PSP, monitored in real time."
      />

      <PaymentStats demo={demoStats} />

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
            {tab === t.key ? (
              <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent-blue" />
            ) : null}
          </button>
        ))}
      </div>

      {tab === "transactions" ? <TransactionsTable /> : <GatewayGrid />}
    </div>
  );
}
