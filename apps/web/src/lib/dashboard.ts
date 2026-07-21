// Shared dashboard summary types — mirror the API's GET /api/dashboard/summary.
// `demoSummary` is the fallback used when no API is configured (demo mode) or
// when the API is unreachable, so the dashboard is never empty.

export type Tone = "blue" | "green" | "magenta" | "purple" | "red" | "orange";
export type PendingTone = "blue" | "purple" | "red" | "orange";
export type SystemState = "operational" | "degraded" | "down";
export type QueueState = "review" | "processing" | "pending" | "escalated";
export type Severity = "critical" | "warning" | "info";

export type KpiMetric = {
  key: string;
  label: string;
  value: number;
  unit: "M" | "K";
  change: string;
  positive: boolean;
  tone: Tone;
  spark: number[];
};

export type PerfMetric = { label: string; value: number };
export type PendingItem = { label: string; value: number; href: string; tone: PendingTone };
export type AlertItem = { id: string; severity: Severity; title: string; detail: string; time: string };
export type SystemStatusItem = { name: string; status: SystemState; latency: string };
export type VolumePoint = { time: string; deposits: number; withdrawals: number };
export type QueueItem = { id: string; type: string; client: string; amount: string; status: QueueState };
export type TeamMember = { name: string; role: string; workload: number; initials: string };

export type DashboardSummary = {
  generatedAt: string;
  health: { score: number; label: string; trend: number };
  today: KpiMetric[];
  performance: PerfMetric[];
  pendingWork: PendingItem[];
  alerts: AlertItem[];
  volumeSeries: VolumePoint[];
  liveQueue: QueueItem[];
  systemStatus: SystemStatusItem[];
  team: { online: number; members: TeamMember[] };
};

export function formatKpi(m: Pick<KpiMetric, "value" | "unit">) {
  return (n: number) => (m.unit === "M" ? `$${n.toFixed(2)}M` : `$${n.toFixed(1)}K`);
}

export const demoSummary: DashboardSummary = {
  generatedAt: new Date(0).toISOString(),
  health: { score: 92, label: "Healthy", trend: 3 },
  today: [
    { key: "volume", label: "Total Volume", value: 4.82, unit: "M", change: "+8.4%", positive: true, tone: "blue", spark: [3.1, 3.4, 3.2, 3.9, 4.1, 4.0, 4.5, 4.82] },
    { key: "deposits", label: "Deposits", value: 2.91, unit: "M", change: "+12.1%", positive: true, tone: "green", spark: [1.8, 2.0, 2.1, 2.4, 2.3, 2.6, 2.8, 2.91] },
    { key: "withdrawals", label: "Withdrawals", value: 1.91, unit: "M", change: "-3.2%", positive: false, tone: "magenta", spark: [2.1, 2.0, 2.05, 1.95, 1.98, 1.9, 1.93, 1.91] },
    { key: "revenue", label: "Revenue", value: 186.4, unit: "K", change: "+5.6%", positive: true, tone: "purple", spark: [140, 150, 148, 162, 170, 168, 180, 186.4] },
  ],
  performance: [
    { label: "Success Rate", value: 97.8 },
    { label: "Approval Rate", value: 94.2 },
    { label: "Decline Rate", value: 5.8 },
    { label: "Refund Rate", value: 1.4 },
  ],
  pendingWork: [
    { label: "Pending KYC", value: 34, href: "/compliance", tone: "blue" },
    { label: "Pending Compliance", value: 12, href: "/compliance", tone: "purple" },
    { label: "Escalated Tickets", value: 7, href: "/operations", tone: "red" },
    { label: "Failed Payments", value: 19, href: "/payments", tone: "orange" },
    { label: "Pending Refunds", value: 5, href: "/payments", tone: "blue" },
    { label: "High Risk Clients", value: 3, href: "/compliance", tone: "red" },
  ],
  alerts: [
    { id: "al-1", severity: "critical", title: "ForumPay gateway offline", detail: "No successful transactions in the last 6 minutes", time: "2m ago" },
    { id: "al-2", severity: "warning", title: "Decline rate spike — Visa EU", detail: "Decline rate up 14% over rolling 30 min window", time: "11m ago" },
    { id: "al-3", severity: "warning", title: "Webhook delay — Coinbase Commerce", detail: "Average webhook latency 42s (SLA: 10s)", time: "18m ago" },
    { id: "al-4", severity: "info", title: "Large withdrawal flagged", detail: "Client #48213 requested $92,000 withdrawal — pending review", time: "26m ago" },
  ],
  volumeSeries: [
    { time: "00:00", deposits: 120, withdrawals: 80 },
    { time: "03:00", deposits: 90, withdrawals: 60 },
    { time: "06:00", deposits: 140, withdrawals: 95 },
    { time: "09:00", deposits: 310, withdrawals: 180 },
    { time: "12:00", deposits: 420, withdrawals: 260 },
    { time: "15:00", deposits: 380, withdrawals: 240 },
    { time: "18:00", deposits: 290, withdrawals: 210 },
    { time: "21:00", deposits: 210, withdrawals: 150 },
  ],
  liveQueue: [
    { id: "TX-88213", type: "Withdrawal", client: "Client #48213", amount: "$92,000", status: "review" },
    { id: "TX-88214", type: "Deposit", client: "Client #10042", amount: "$4,200", status: "processing" },
    { id: "KYC-3341", type: "KYC Review", client: "Client #55210", amount: "—", status: "pending" },
    { id: "TX-88215", type: "Withdrawal", client: "Client #22981", amount: "$1,850", status: "processing" },
    { id: "TC-9931", type: "Ticket", client: "Client #77120", amount: "—", status: "escalated" },
  ],
  systemStatus: [
    { name: "Core API", status: "operational", latency: "84ms" },
    { name: "Payment Gateways", status: "degraded", latency: "412ms" },
    { name: "CRM", status: "operational", latency: "132ms" },
    { name: "Trading Platform (MT5)", status: "operational", latency: "61ms" },
  ],
  team: {
    online: 4,
    members: [
      { name: "Sara Ahmed", role: "Operations", workload: 4, initials: "SA" },
      { name: "David Chen", role: "Compliance", workload: 7, initials: "DC" },
      { name: "Fatima Noor", role: "Support", workload: 2, initials: "FN" },
      { name: "Yusuf Ali", role: "Operations", workload: 5, initials: "YA" },
    ],
  },
};
