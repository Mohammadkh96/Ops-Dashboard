"use client";

import { useState } from "react";

import { PageHeader } from "@/components/ui/page-header";
import { StatTileRow, type Stat } from "@/components/ui/stat-tile";
import { cn } from "@/lib/utils";
import { isDemoMode } from "@/lib/api";
import { useDashboardSummary } from "@/hooks/use-dashboard";
import { useAnalytics, useGateways } from "@/hooks/use-modules";
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
  const { data: summary } = useDashboardSummary();
  const { data: liveGateways } = useGateways();

  // Live: every figure is measured, and a panel with no real source is left
  // out rather than filled with a plausible shape. Country volume needs a
  // customer-country field Paymaxis does not send, and success-over-time needs
  // history this has not accumulated yet — so neither is drawn.
  const live = !isDemoMode && summary.live;

  const liveKpis: Stat[] = live
    ? [
        {
          label: "Success Rate · 24h",
          value: `${summary.performance.find((m) => m.label === "Success Rate")?.value ?? 0}%`,
          tone: "blue",
        },
        {
          label: "Settled · 24h",
          value: String(summary.performance.find((m) => m.label === "Settled")?.value ?? 0),
          tone: "green",
        },
        {
          label: "Declined · 24h",
          value: String(summary.performance.find((m) => m.label === "Declined")?.value ?? 0),
          tone: "orange",
        },
        {
          label: "Operational Health",
          value: `${summary.health.score}`,
          tone: "purple",
        },
      ]
    : [];

  const livePspRates: GatewayPoint[] = live
    ? liveGateways.map((g) => ({ gateway: g.name, rate: g.successRate }))
    : [];

  /**
   * The series that used to be missing, and the note that used to explain why.
   *
   * Success history was said to need more data than had been collected, and
   * country volume a customer country the payment provider does not send.
   * There are months of events now, and the country arrives on every KYCAID
   * verification — the same join that put a CU reference beside a payment also
   * supplies the geography the payment side never had.
   */
  const { data: measured } = useAnalytics();
  const hhmm = (label: string) =>
    label.length > 10 ? label.slice(11, 16) : label.slice(5);

  const liveSuccess: SuccessPoint[] = measured.series
    .filter((p) => p.successRate !== null)
    .map((p) => ({ label: hhmm(p.label), rate: p.successRate as number }));

  const liveApprovals: ApprovalPoint[] = measured.series
    .filter((p) => p.settled + p.failed > 0)
    .map((p) => ({
      label: hhmm(p.label),
      approvals: p.settled,
      declines: p.failed,
    }));

  /** Named where the provider's list could be read; the code otherwise. */
  const liveCountries: CountryPoint[] = measured.byCountry.map((c) => ({
    country: c.name ?? c.country,
    volume: Math.round(c.volume),
  }));

  /**
   * KYC beside the payments, because the two are the same business.
   *
   * Cost per APPROVED client rather than per verification: a client verified
   * four times costs four times, and a per-verification figure is precisely
   * the one that hides it.
   */
  const kycKpis: Stat[] = live
    ? [
        {
          label: "KYC pass rate",
          value: measured.kyc.passRate === null ? "—" : `${measured.kyc.passRate}%`,
          tone: "green",
          delta: {
            text: `${measured.kyc.approved.toLocaleString()} approved, ${measured.kyc.rejected.toLocaleString()} rejected`,
            positive: (measured.kyc.passRate ?? 0) >= 70,
          },
        },
        {
          label: "Cost per approved client",
          value:
            measured.kyc.costPerApproved === null
              ? "—"
              : `€${measured.kyc.costPerApproved.toFixed(2)}`,
          tone: "orange",
          delta: {
            text: `€${measured.kyc.spentEur.toLocaleString(undefined, { maximumFractionDigits: 0 })} spent on checks`,
            positive: true,
          },
        },
      ]
    : [];

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

      <StatTileRow stats={live ? [...liveKpis, ...kycKpis] : kpis} />

      <div className="grid gap-4 lg:grid-cols-2">
        <SuccessRateChart data={live ? liveSuccess : successRate} />
        <ApprovalsDeclinesChart data={live ? liveApprovals : approvals} />
        <GatewayPerformanceChart data={live ? livePspRates : gateways} />
        <VolumeByCountryChart data={live ? liveCountries : countries} />
      </div>

      {/* WHAT THE GEOGRAPHY IS DRAWN OVER. The country comes from the KYC side,
          so a client nobody has verified has none — and a chart covering 60% of
          the money while looking like all of it is the kind of picture
          decisions get made on. */}
      {live && measured.byCountry.length ? (
        <p className="text-xs text-muted">
          Country is taken from the verification that assessed each client, so
          the geography covers {measured.countryCoverage}% of settled deposit
          volume — the rest belongs to clients with no verification on record.
          {measured.payments.currencies.length > 1
            ? ` The ledger holds ${measured.payments.currencies.join(", ")} in this period and these volumes add them together.`
            : ""}
        </p>
      ) : null}
      {live && !measured.byCountry.length ? (
        <p className="text-xs text-muted">
          Volume by country is empty: it is taken from the verification that
          assessed each client, and none of the clients who deposited in this
          period have a verification on record.
        </p>
      ) : null}
    </div>
  );
}
