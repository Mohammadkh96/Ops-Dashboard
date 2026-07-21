// Demo datasets + types for the operational modules. These power the UI in
// demo mode and mirror the shapes the API will return.

export type TxStatus = "approved" | "processing" | "pending" | "review" | "declined" | "failed" | "refunded";
export type TxMethod = "Card" | "Crypto" | "Bank" | "Local";
export type Risk = "low" | "medium" | "high" | "critical";

export type Transaction = {
  id: string;
  reference: string;
  client: string;
  country: string;
  gateway: string;
  method: TxMethod;
  currency: string;
  amount: number;
  type: "Deposit" | "Withdrawal";
  status: TxStatus;
  risk: Risk;
  createdAt: string;
};

export type Gateway = {
  id: string;
  name: string;
  status: "operational" | "degraded" | "down";
  successRate: number;
  avgLatencyMs: number;
  todayVolume: number;
  webhookFailures: number;
  spark: number[];
};

export type KycStatus = "pending" | "in_review" | "approved_kyc" | "rejected" | "edd_required";
export type KycCase = {
  id: string;
  client: string;
  country: string;
  status: KycStatus;
  risk: Risk;
  riskScore: number;
  documents: number;
  submittedAt: string;
  assignee: string;
};

export type IncidentSeverity = "low" | "medium" | "high" | "critical";
export type IncidentStatus = "open" | "investigating" | "resolved" | "closed";
export type Incident = {
  id: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  owner: string;
  impact: string;
  rootCause?: string;
  openedAt: string;
  timeline: { time: string; text: string }[];
};

const CLIENTS = ["#48213", "#10042", "#55210", "#22981", "#77120", "#30918", "#66203", "#12844", "#90117", "#40551"];
const COUNTRIES = ["AE", "DE", "GB", "FR", "SA", "NG", "IN", "SG", "BR", "ES"];
const GATEWAYS = ["ForumPay", "LimePay", "Paystrax", "Coinbase", "Stripe", "Nuvei", "Bridge"];
const METHODS: TxMethod[] = ["Card", "Crypto", "Bank", "Local"];
const CCY = ["USD", "EUR", "GBP", "AED", "BTC"];
const STATUSES: TxStatus[] = ["approved", "processing", "pending", "review", "declined", "failed", "refunded"];
const RISKS: Risk[] = ["low", "low", "low", "medium", "medium", "high", "critical"];

// Deterministic pseudo-random so demo data is stable across renders/builds.
function seeded(n: number) {
  let s = n * 9301 + 49297;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

export const transactions: Transaction[] = Array.from({ length: 42 }, (_, i) => {
  const r = seeded(i + 1);
  const type = r() > 0.55 ? "Withdrawal" : "Deposit";
  const amount = Math.round((r() * (type === "Withdrawal" ? 95000 : 12000) + 120) * 100) / 100;
  return {
    id: `tx-${i + 1}`,
    reference: `TX-${88200 + i}`,
    client: `Client ${CLIENTS[Math.floor(r() * CLIENTS.length)]}`,
    country: COUNTRIES[Math.floor(r() * COUNTRIES.length)],
    gateway: GATEWAYS[Math.floor(r() * GATEWAYS.length)],
    method: METHODS[Math.floor(r() * METHODS.length)],
    currency: CCY[Math.floor(r() * CCY.length)],
    amount,
    type,
    status: STATUSES[Math.floor(r() * STATUSES.length)],
    risk: RISKS[Math.floor(r() * RISKS.length)],
    createdAt: `${String(Math.floor(r() * 23)).padStart(2, "0")}:${String(Math.floor(r() * 59)).padStart(2, "0")}`,
  };
});

export const gateways: Gateway[] = [
  { id: "g1", name: "ForumPay", status: "down", successRate: 0, avgLatencyMs: 0, todayVolume: 0, webhookFailures: 14, spark: [98, 97, 96, 40, 0, 0, 0, 0] },
  { id: "g2", name: "LimePay", status: "operational", successRate: 98.6, avgLatencyMs: 142, todayVolume: 812000, webhookFailures: 0, spark: [96, 97, 98, 98, 99, 98, 99, 98.6] },
  { id: "g3", name: "Paystrax", status: "operational", successRate: 97.1, avgLatencyMs: 210, todayVolume: 604000, webhookFailures: 1, spark: [95, 96, 97, 96, 97, 98, 97, 97.1] },
  { id: "g4", name: "Coinbase", status: "degraded", successRate: 91.4, avgLatencyMs: 480, todayVolume: 388000, webhookFailures: 6, spark: [97, 96, 94, 92, 90, 91, 90, 91.4] },
  { id: "g5", name: "Stripe", status: "operational", successRate: 99.2, avgLatencyMs: 96, todayVolume: 1240000, webhookFailures: 0, spark: [99, 99, 98, 99, 99, 99, 99, 99.2] },
  { id: "g6", name: "Nuvei", status: "operational", successRate: 96.8, avgLatencyMs: 176, todayVolume: 521000, webhookFailures: 2, spark: [95, 96, 97, 96, 97, 96, 97, 96.8] },
  { id: "g7", name: "Bridge", status: "operational", successRate: 95.3, avgLatencyMs: 233, todayVolume: 274000, webhookFailures: 3, spark: [94, 95, 96, 95, 94, 95, 96, 95.3] },
];

export const kycCases: KycCase[] = [
  { id: "k1", client: "Client #55210", country: "NG", status: "in_review", risk: "high", riskScore: 78, documents: 4, submittedAt: "2h ago", assignee: "David Chen" },
  { id: "k2", client: "Client #90117", country: "AE", status: "pending", risk: "low", riskScore: 22, documents: 3, submittedAt: "3h ago", assignee: "Unassigned" },
  { id: "k3", client: "Client #40551", country: "BR", status: "edd_required", risk: "critical", riskScore: 91, documents: 6, submittedAt: "5h ago", assignee: "David Chen" },
  { id: "k4", client: "Client #12844", country: "IN", status: "pending", risk: "medium", riskScore: 54, documents: 2, submittedAt: "6h ago", assignee: "Unassigned" },
  { id: "k5", client: "Client #66203", country: "GB", status: "approved_kyc", risk: "low", riskScore: 18, documents: 4, submittedAt: "1d ago", assignee: "Sara Ahmed" },
  { id: "k6", client: "Client #30918", country: "SA", status: "rejected", risk: "high", riskScore: 83, documents: 5, submittedAt: "1d ago", assignee: "David Chen" },
  { id: "k7", client: "Client #22981", country: "DE", status: "in_review", risk: "medium", riskScore: 47, documents: 3, submittedAt: "1d ago", assignee: "Sara Ahmed" },
];

export const incidents: Incident[] = [
  {
    id: "INC-104",
    title: "ForumPay gateway offline",
    severity: "critical",
    status: "investigating",
    owner: "Yusuf Ali",
    impact: "All ForumPay deposits failing; ~$180K/hr volume affected",
    rootCause: "Upstream PSP API returning 503 since 14:02 UTC",
    openedAt: "18m ago",
    timeline: [
      { time: "14:02", text: "Automated alert: success rate dropped to 0%" },
      { time: "14:05", text: "On-call paged; incident opened at SEV-1" },
      { time: "14:11", text: "PSP status page confirms upstream outage" },
      { time: "14:16", text: "Deposits rerouted to LimePay for affected regions" },
    ],
  },
  {
    id: "INC-103",
    title: "Elevated decline rate — Visa EU",
    severity: "high",
    status: "open",
    owner: "Sara Ahmed",
    impact: "Card decline rate +14% for EU BINs over 30 min",
    openedAt: "42m ago",
    timeline: [
      { time: "13:38", text: "Decline-spike alert triggered for Visa EU" },
      { time: "13:44", text: "Investigating acquirer-side 3DS friction" },
    ],
  },
  {
    id: "INC-102",
    title: "Webhook delivery delay — Coinbase",
    severity: "medium",
    status: "investigating",
    owner: "David Chen",
    impact: "Deposit confirmations delayed ~40s; no funds at risk",
    openedAt: "1h ago",
    timeline: [{ time: "13:20", text: "Webhook latency breached 10s SLA" }],
  },
  {
    id: "INC-101",
    title: "Duplicate transaction anomaly",
    severity: "low",
    status: "resolved",
    owner: "Sara Ahmed",
    impact: "3 duplicate authorizations auto-voided",
    rootCause: "Client double-submit; idempotency key added",
    openedAt: "4h ago",
    timeline: [
      { time: "10:02", text: "Anomaly detector flagged duplicates" },
      { time: "10:31", text: "Duplicates voided; fix shipped" },
      { time: "10:40", text: "Resolved" },
    ],
  },
];

export const fmtMoney = (n: number, ccy = "USD") =>
  n >= 1000
    ? `${ccy === "USD" ? "$" : ""}${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}K`
    : `${ccy === "USD" ? "$" : ""}${n.toLocaleString()}`;
