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
  // Refund is a real Paymaxis payment type and belongs in its own bucket:
  // money going back to a customer is not a withdrawal they requested.
  type: "Deposit" | "Withdrawal" | "Refund";
  status: TxStatus;
  // null when nothing scores risk. The column previously showed a level for
  // every row, all of it invented.
  risk: Risk | null;
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

// ---------- Operations: tickets, team, shift ----------

export type TicketStatus = "open" | "in_progress" | "escalated" | "resolved" | "closed";
export type TicketPriority = "low" | "medium" | "high" | "urgent";
export type Ticket = {
  id: string;
  subject: string;
  client: string;
  assignee: string;
  status: TicketStatus;
  priority: TicketPriority;
  slaRemaining: string;
  slaBreached: boolean;
  updatedAt: string;
};

export const tickets: Ticket[] = [
  { id: "TC-9931", subject: "Withdrawal stuck in review", client: "Client #77120", assignee: "Fatima Noor", status: "escalated", priority: "urgent", slaRemaining: "12m", slaBreached: false, updatedAt: "3m ago" },
  { id: "TC-9930", subject: "KYC document rejected — appeal", client: "Client #30918", assignee: "David Chen", status: "in_progress", priority: "high", slaRemaining: "48m", slaBreached: false, updatedAt: "14m ago" },
  { id: "TC-9929", subject: "Deposit not credited (crypto)", client: "Client #10042", assignee: "Sara Ahmed", status: "in_progress", priority: "high", slaRemaining: "1h 20m", slaBreached: false, updatedAt: "22m ago" },
  { id: "TC-9928", subject: "Duplicate charge dispute", client: "Client #22981", assignee: "Unassigned", status: "open", priority: "medium", slaRemaining: "Overdue 18m", slaBreached: true, updatedAt: "31m ago" },
  { id: "TC-9927", subject: "Card payment declined repeatedly", client: "Client #55210", assignee: "Yusuf Ali", status: "open", priority: "medium", slaRemaining: "2h 05m", slaBreached: false, updatedAt: "44m ago" },
  { id: "TC-9926", subject: "Account statement request", client: "Client #66203", assignee: "Fatima Noor", status: "resolved", priority: "low", slaRemaining: "—", slaBreached: false, updatedAt: "1h ago" },
];

export type Presence = "online" | "away" | "offline";
export type Operator = {
  name: string;
  role: string;
  presence: Presence;
  active: number;
  handledToday: number;
  avgHandleMin: number;
  initials: string;
};

export const operators: Operator[] = [
  { name: "Sara Ahmed", role: "Operations", presence: "online", active: 4, handledToday: 37, avgHandleMin: 6.2, initials: "SA" },
  { name: "David Chen", role: "Compliance", presence: "online", active: 7, handledToday: 21, avgHandleMin: 11.4, initials: "DC" },
  { name: "Fatima Noor", role: "Support", presence: "online", active: 2, handledToday: 44, avgHandleMin: 4.1, initials: "FN" },
  { name: "Yusuf Ali", role: "Operations", presence: "away", active: 5, handledToday: 29, avgHandleMin: 7.8, initials: "YA" },
  { name: "Lina Park", role: "Support", presence: "offline", active: 0, handledToday: 33, avgHandleMin: 5.0, initials: "LP" },
];

export type ChecklistItem = { label: string; done: boolean };
export const shiftChecklist: ChecklistItem[] = [
  { label: "Review overnight alerts", done: true },
  { label: "Clear escalated tickets queue", done: true },
  { label: "Reconcile PSP settlements", done: false },
  { label: "Approve pending large withdrawals", done: false },
  { label: "Post handover notes", done: false },
];

// ---------- Reports ----------

export type ReportFormat = "PDF" | "Excel";
export type ReportTemplate = { id: string; name: string; description: string; formats: ReportFormat[] };
export const reportTemplates: ReportTemplate[] = [
  { id: "r1", name: "Daily Operations Summary", description: "Volume, success rate, incidents and pending work for the day.", formats: ["PDF", "Excel"] },
  { id: "r2", name: "PSP Performance", description: "Per-gateway success, latency, downtime and webhook failures.", formats: ["PDF", "Excel"] },
  { id: "r3", name: "Compliance & KYC", description: "KYC throughput, EDD cases, sanctions/PEP screening outcomes.", formats: ["PDF"] },
  { id: "r4", name: "Financial Reconciliation", description: "Deposits, withdrawals, refunds and settlement reconciliation.", formats: ["Excel"] },
  { id: "r5", name: "Executive Overview", description: "KPIs, trends and risk posture for leadership.", formats: ["PDF"] },
  { id: "r6", name: "Incident Report", description: "Timeline, impact, root cause and preventive actions.", formats: ["PDF"] },
];

export type GeneratedReport = { id: string; name: string; format: ReportFormat; size: string; by: string; at: string };
export const generatedReports: GeneratedReport[] = [
  { id: "gr1", name: "Daily Operations Summary — Jul 21", format: "PDF", size: "1.2 MB", by: "Mohammad K.", at: "08:12" },
  { id: "gr2", name: "PSP Performance — Jul 20", format: "Excel", size: "486 KB", by: "Sara Ahmed", at: "Yesterday" },
  { id: "gr3", name: "Financial Reconciliation — Jul 20", format: "Excel", size: "912 KB", by: "Finance bot", at: "Yesterday" },
  { id: "gr4", name: "Executive Overview — Week 29", format: "PDF", size: "2.4 MB", by: "Mohammad K.", at: "Mon" },
];

export type ScheduledReport = { id: string; name: string; cadence: string; nextRun: string; recipients: number };
export const scheduledReports: ScheduledReport[] = [
  { id: "sr1", name: "Daily Operations Summary", cadence: "Daily · 08:00", nextRun: "Tomorrow 08:00", recipients: 6 },
  { id: "sr2", name: "PSP Performance", cadence: "Weekly · Mon", nextRun: "Mon 07:00", recipients: 3 },
  { id: "sr3", name: "Executive Overview", cadence: "Weekly · Mon", nextRun: "Mon 07:00", recipients: 4 },
];

// ---------- Admin: users & audit ----------

export type UserRole =
  | "Admin" | "Operations Manager" | "Operations" | "Compliance"
  | "Support" | "Finance" | "Executive" | "Auditor" | "Read Only";
export type UserStatus = "active" | "invited" | "suspended";
export type OpsUser = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  lastActive: string;
  initials: string;
};

export const opsUsers: OpsUser[] = [
  { id: "u1", name: "Mohammad K.", email: "mohammad@tradin.com", role: "Admin", status: "active", lastActive: "now", initials: "MK" },
  { id: "u2", name: "Sara Ahmed", email: "sara@tradin.com", role: "Operations", status: "active", lastActive: "2m ago", initials: "SA" },
  { id: "u3", name: "David Chen", email: "david@tradin.com", role: "Compliance", status: "active", lastActive: "5m ago", initials: "DC" },
  { id: "u4", name: "Fatima Noor", email: "fatima@tradin.com", role: "Support", status: "active", lastActive: "1m ago", initials: "FN" },
  { id: "u5", name: "Yusuf Ali", email: "yusuf@tradin.com", role: "Operations", status: "active", lastActive: "18m ago", initials: "YA" },
  { id: "u6", name: "Lina Park", email: "lina@tradin.com", role: "Support", status: "active", lastActive: "3h ago", initials: "LP" },
  { id: "u7", name: "Omar Haddad", email: "omar@tradin.com", role: "Finance", status: "active", lastActive: "1d ago", initials: "OH" },
  { id: "u8", name: "Priya Rao", email: "priya@tradin.com", role: "Executive", status: "active", lastActive: "2d ago", initials: "PR" },
  { id: "u9", name: "New Analyst", email: "analyst@tradin.com", role: "Read Only", status: "invited", lastActive: "—", initials: "NA" },
  { id: "u10", name: "Contractor X", email: "contractor@ext.com", role: "Auditor", status: "suspended", lastActive: "12d ago", initials: "CX" },
];

export type AuditEntry = {
  id: string;
  user: string;
  action: string;
  entityType: string;
  entityId: string;
  ip: string;
  at: string;
};

export const auditLog: AuditEntry[] = [
  { id: "a1", user: "Sara Ahmed", action: "Approved withdrawal", entityType: "Transaction", entityId: "TX-88175", ip: "10.2.4.11", at: "14:22:07" },
  { id: "a2", user: "David Chen", action: "Escalated KYC case", entityType: "KycCase", entityId: "k3", ip: "10.2.4.31", at: "14:18:42" },
  { id: "a3", user: "Mohammad K.", action: "Changed user role", entityType: "User", entityId: "u9", ip: "10.2.4.2", at: "14:05:19" },
  { id: "a4", user: "Fatima Noor", action: "Resolved ticket", entityType: "Ticket", entityId: "TC-9926", ip: "10.2.4.22", at: "13:58:03" },
  { id: "a5", user: "System", action: "Auto-voided duplicate", entityType: "Transaction", entityId: "TX-88101", ip: "—", at: "13:40:55" },
  { id: "a6", user: "Yusuf Ali", action: "Declared incident", entityType: "Incident", entityId: "INC-104", ip: "10.2.4.19", at: "14:02:11" },
  { id: "a7", user: "Mohammad K.", action: "Suspended user", entityType: "User", entityId: "u10", ip: "10.2.4.2", at: "12:31:44" },
  { id: "a8", user: "Sara Ahmed", action: "Added internal note", entityType: "Transaction", entityId: "TX-88160", ip: "10.2.4.11", at: "12:15:30" },
];
