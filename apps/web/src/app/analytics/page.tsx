"use client";

import { useState } from "react";

import { PageHeader } from "@/components/ui/page-header";
import { StatTileRow, type Stat } from "@/components/ui/stat-tile";
import { cn } from "@/lib/utils";
import {
  ApprovalsDeclinesChart,
  GatewayPerformanceChart,
  SuccessRateChart,
  VolumeByCountryChart,
  type ApprovalPoint,
  type CountryPoint,
  type GatewayPoint,
  type SuccessPoint,
} from "@/components/analytics/charts";

/* ------------------------------------------------------------------ */
/* Demo data — static, realistic for a forex/CFD broker ops console   */
/* ------------------------------------------------------------------ */

const kpis: Stat[] = [
  {
    label: "Approval %",
    value: "96.4%",
    delta: { text: "+0.9 pts vs prev", positive: true },
    tone: "blue",
    spark: [94.1, 94.8, 95.2, 95.0, 95.9, 96.1, 96.0, 96.4],
  },
  {
    label: "Decline %",
    value: "3.6%",
    delta: { text: "-0.9 pts vs prev", positive: true },
    tone: "magenta",
    spark: [5.9, 5.2, 4.8, 5.0, 4.1, 3.9, 4.0, 3.6],
  },
  {
    label: "Avg deposit time",
    value: "42s",
    delta: { text: "-6s vs prev", positive: true },
    tone: "green",
    spark: [58, 55, 51, 49, 47, 46, 44, 42],
  },
  {
    label: "Avg withdrawal time",
    value: "3h 12m",
    delta: { text: "+18m vs prev", positive: false },
    tone: "orange",
    spark: [2.4, 2.6, 2.5, 2.8, 2.9, 3.0, 3.1, 3.2],
  },
];

const successRate: SuccessPoint[] = [
  { label: "00:00", rate: 95.8 },
  { label: "03:00", rate: 96.2 },
  { label: "06:00", rate: 95.4 },
  { label: "09:00", rate: 97.1 },
  { label: "12:00", rate: 96.8 },
  { label: "15:00", rate: 97.6 },
  { label: "18:00", rate: 96.9 },
  { label: "21:00", rate: 97.3 },
];

const approvals: ApprovalPoint[] = [
  { label: "Mon", approvals: 4210, declines: 168 },
  { label: "Tue", approvals: 4585, declines: 152 },
  { label: "Wed", approvals: 4390, declines: 197 },
  { label: "Thu", approvals: 4812, declines: 141 },
  { label: "Fri", approvals: 5104, declines: 210 },
  { label: "Sat", approvals: 3288, declines: 96 },
  { label: "Sun", approvals: 2971, declines: 84 },
];

const gateways: GatewayPoint[] = [
  { gateway: "LimePay", rate: 98.1 },
  { gateway: "Stripe", rate: 97.4 },
  { gateway: "Nuvei", rate: 96.2 },
  { gateway: "Paystrax", rate: 94.8 },
  { gateway: "Coinbase", rate: 93.5 },
  { gateway: "Bridge", rate: 91.2 },
  { gateway: "ForumPay", rate: 0.4 },
];

const countries: CountryPoint[] = [
  { country: "AE", volume: 8.6 },
  { country: "DE", volume: 6.9 },
  { country: "GB", volume: 5.4 },
  { country: "FR", volume: 4.1 },
  { country: "SA", volume: 3.3 },
  { country: "IN", volume: 2.7 },
];

const RANGES = ["Hourly", "Daily", "Weekly", "Monthly"] as const;
type Range = (typeof RANGES)[number];

export default function AnalyticsPage() {
  const [range, setRange] = useState<Range>("Daily");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Analytics"
        description="Performance, gateways, geography and risk trends."
        actions={
          <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-1">
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  range === r
                    ? "bg-accent-blue text-white shadow-sm shadow-accent-blue/20"
                    : "text-muted hover:text-foreground",
                )}
              >
                {r}
              </button>
            ))}
          </div>
        }
      />

      <StatTileRow stats={kpis} />

      <div className="grid gap-4 lg:grid-cols-2">
        <SuccessRateChart data={successRate} />
        <ApprovalsDeclinesChart data={approvals} />
        <GatewayPerformanceChart data={gateways} />
        <VolumeByCountryChart data={countries} />
      </div>
    </div>
  );
}
