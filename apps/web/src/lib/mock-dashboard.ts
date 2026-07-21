export type SystemStatus = "operational" | "degraded" | "down";

export const operationalHealth = {
  score: 92,
  label: "Healthy",
  trend: +3,
};

export type TodayMetric = {
  label: string;
  value: number;
  format: "currency" | "currency-k";
  change: string;
  positive: boolean;
  tone: "blue" | "green" | "magenta" | "purple";
  spark: number[];
};

export const todayMetrics: TodayMetric[] = [
  {
    label: "Total Volume",
    value: 4.82,
    format: "currency",
    change: "+8.4%",
    positive: true,
    tone: "blue",
    spark: [3.1, 3.4, 3.2, 3.9, 4.1, 4.0, 4.5, 4.82],
  },
  {
    label: "Deposits",
    value: 2.91,
    format: "currency",
    change: "+12.1%",
    positive: true,
    tone: "green",
    spark: [1.8, 2.0, 2.1, 2.4, 2.3, 2.6, 2.8, 2.91],
  },
  {
    label: "Withdrawals",
    value: 1.91,
    format: "currency",
    change: "-3.2%",
    positive: false,
    tone: "magenta",
    spark: [2.1, 2.0, 2.05, 1.95, 1.98, 1.9, 1.93, 1.91],
  },
  {
    label: "Revenue",
    value: 186.4,
    format: "currency-k",
    change: "+5.6%",
    positive: true,
    tone: "purple",
    spark: [140, 150, 148, 162, 170, 168, 180, 186.4],
  },
];

export const performanceMetrics = [
  { label: "Success Rate", value: 97.8, suffix: "%" },
  { label: "Approval Rate", value: 94.2, suffix: "%" },
  { label: "Decline Rate", value: 5.8, suffix: "%" },
  { label: "Refund Rate", value: 1.4, suffix: "%" },
];

export const pendingWork = [
  { label: "Pending KYC", value: 34, href: "/compliance", tone: "blue" as const },
  { label: "Pending Compliance", value: 12, href: "/compliance", tone: "purple" as const },
  { label: "Escalated Tickets", value: 7, href: "/operations", tone: "red" as const },
  { label: "Failed Payments", value: 19, href: "/payments", tone: "orange" as const },
  { label: "Pending Refunds", value: 5, href: "/payments", tone: "blue" as const },
  { label: "High Risk Clients", value: 3, href: "/compliance", tone: "red" as const },
];

export const criticalAlerts = [
  {
    id: "al-1",
    severity: "critical" as const,
    title: "ForumPay gateway offline",
    detail: "No successful transactions in the last 6 minutes",
    time: "2m ago",
  },
  {
    id: "al-2",
    severity: "warning" as const,
    title: "Decline rate spike — Visa EU",
    detail: "Decline rate up 14% over rolling 30 min window",
    time: "11m ago",
  },
  {
    id: "al-3",
    severity: "warning" as const,
    title: "Webhook delay — Coinbase Commerce",
    detail: "Average webhook latency 42s (SLA: 10s)",
    time: "18m ago",
  },
  {
    id: "al-4",
    severity: "info" as const,
    title: "Large withdrawal flagged",
    detail: "Client #48213 requested $92,000 withdrawal — pending review",
    time: "26m ago",
  },
];

export const systemStatus: { name: string; status: SystemStatus; latency: string }[] = [
  { name: "Core API", status: "operational", latency: "84ms" },
  { name: "Payment Gateways", status: "degraded", latency: "412ms" },
  { name: "CRM", status: "operational", latency: "132ms" },
  { name: "Trading Platform (MT5)", status: "operational", latency: "61ms" },
];

export const volumeSeries = [
  { time: "00:00", deposits: 120, withdrawals: 80 },
  { time: "03:00", deposits: 90, withdrawals: 60 },
  { time: "06:00", deposits: 140, withdrawals: 95 },
  { time: "09:00", deposits: 310, withdrawals: 180 },
  { time: "12:00", deposits: 420, withdrawals: 260 },
  { time: "15:00", deposits: 380, withdrawals: 240 },
  { time: "18:00", deposits: 290, withdrawals: 210 },
  { time: "21:00", deposits: 210, withdrawals: 150 },
];

export const liveQueue = [
  { id: "TX-88213", type: "Withdrawal", client: "Client #48213", amount: "$92,000", status: "review" as const },
  { id: "TX-88214", type: "Deposit", client: "Client #10042", amount: "$4,200", status: "processing" as const },
  { id: "KYC-3341", type: "KYC Review", client: "Client #55210", amount: "—", status: "pending" as const },
  { id: "TX-88215", type: "Withdrawal", client: "Client #22981", amount: "$1,850", status: "processing" as const },
  { id: "TC-9931", type: "Ticket", client: "Client #77120", amount: "—", status: "escalated" as const },
];

export const onlineEmployees = [
  { name: "Sara Ahmed", role: "Operations", workload: 4, initials: "SA" },
  { name: "David Chen", role: "Compliance", workload: 7, initials: "DC" },
  { name: "Fatima Noor", role: "Support", workload: 2, initials: "FN" },
  { name: "Yusuf Ali", role: "Operations", workload: 5, initials: "YA" },
];
