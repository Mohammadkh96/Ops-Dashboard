"use client";

import { useQuery } from "@tanstack/react-query";

import { apiFetch, isDemoMode } from "@/lib/api";
import { useTimeRange, withRange } from "@/lib/time-range";
import {
  transactions,
  gateways,
  kycCases,
  incidents,
  tickets,
  operators,
  shiftChecklist,
  reportTemplates,
  generatedReports,
  scheduledReports,
  auditLog,
  type Transaction,
  type Gateway,
  type KycCase,
  type Incident,
  type Ticket,
  type Operator,
  type ChecklistItem,
  type ReportTemplate,
  type GeneratedReport,
  type ScheduledReport,
  type AuditEntry,
} from "@/lib/modules";

/**
 * Fetches `path` from the API, falling back to bundled demo data in demo mode
 * (no API configured) or on error — so every module renders either way.
 */
function useApi<T>(
  key: string,
  path: string,
  fallback: T,
  { ranged = false }: { ranged?: boolean } = {},
): { data: T; isDemo: boolean; isError: boolean; isLoading: boolean } {
  // Only endpoints whose data is time-bounded take the window. Sending it to a
  // user list or a report template would key the cache on something that
  // cannot change the answer.
  const { query: rangeQuery, key: rangeKey } = useTimeRange();
  const query = useQuery<T>({
    queryKey: ["module", key, ranged ? rangeKey : "all"],
    queryFn: () => apiFetch<T>(ranged ? withRange(path, rangeQuery) : path),
    enabled: !isDemoMode,
    refetchInterval: 30_000,
  });
  return {
    data: query.data ?? fallback,
    isDemo: isDemoMode,
    isError: query.isError,
    isLoading: !isDemoMode && query.isLoading,
  };
}

/**
 * Real payments. The type filter is applied by the API rather than in the
 * browser: the endpoint returns a bounded page, so filtering after the fact
 * meant the Deposits and Withdrawals pages shared one budget of rows and each
 * showed a fraction of what it should.
 */
export const useTransactions = (type?: "Deposit" | "Withdrawal" | "Refund") =>
  useApi<Transaction[]>(
    `transactions:${type ?? "all"}`,
    `/transactions${type ? `?type=${type.toLowerCase()}` : ""}`,
    type ? transactions.filter((t) => t.type === type) : transactions,
    { ranged: true },
  );
export const useGateways = () =>
  useApi<Gateway[]>("gateways", "/gateways", gateways, { ranged: true });
/** What the compliance table is asking the API for. */
export type KycCaseQuery = {
  limit?: number;
  offset?: number;
  status?: string;
  q?: string;
  /** A KYCAID account label — "MU", "SL". Blank is both entities. */
  account?: string;
  /** `YYYY-MM-DD`, inclusive at both ends. */
  from?: string;
  to?: string;
  /**
   * The form's stored id (`12666`), not its name.
   *
   * The name is configuration applied on the way out, so filtering by it would
   * break the day somebody renames a form in the provider's console.
   */
  form?: string;
  /** A check the provider refused — DOCUMENT, ADDRESS, FACIAL… */
  failedCheck?: string;
  /** A decline reason, in the provider's own vocabulary. */
  reason?: string;
  /** Two letters. The jurisdiction the check was assessed against. */
  country?: string;
  /** Documents expiring within this many days, expired ones included. */
  expiringDays?: number;
  /** Only rows the provider has never been asked about. */
  missingDetails?: boolean;
  /**
   * People, lookups, or both. People by default.
   *
   * National-id lookups — an Aadhaar or NIN number being validated — have no
   * applicant and are not rows a compliance officer is scrolling for. They stay
   * in the ledger, the spend and their own panel; they are simply not listed
   * here unless asked for.
   */
  rows?: "verifications" | "lookups" | "all";
};

function kycQuery(o: KycCaseQuery): string {
  const p = new URLSearchParams();
  if (o.limit) p.set("limit", String(o.limit));
  if (o.offset) p.set("offset", String(o.offset));
  if (o.status) p.set("status", o.status);
  if (o.q) p.set("q", o.q);
  if (o.account) p.set("account", o.account);
  if (o.from) p.set("from", o.from);
  if (o.to) p.set("to", o.to);
  if (o.form) p.set("form", o.form);
  if (o.failedCheck) p.set("failedCheck", o.failedCheck);
  if (o.reason) p.set("reason", o.reason);
  if (o.country) p.set("country", o.country);
  if (o.expiringDays) p.set("expiringDays", String(o.expiringDays));
  if (o.missingDetails) p.set("missingDetails", "1");
  if (o.rows && o.rows !== "verifications") p.set("rows", o.rows);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/**
 * A PAGE of verifications, filtered by the database.
 *
 * Both halves of that used to be untrue. The endpoint took the first 500 rows
 * and stopped — so on a twelve-thousand-row import most of the table could not
 * be reached at all — and the filters ran in the browser over whatever those
 * 500 happened to be, which made a client on page four indistinguishable from
 * a client nobody had ever verified.
 */
export const useKycCases = (opts: KycCaseQuery = {}) =>
  useApi<KycCase[]>(
    `kyc:${kycQuery(opts)}`,
    `/compliance/kyc${kycQuery(opts)}`,
    kycCases,
  );

/** How many match — what the page size is measured against. */
export const useKycCaseCount = (opts: KycCaseQuery = {}) =>
  useApi<{ total: number }>(
    `kyc-count:${kycQuery({ ...opts, limit: undefined, offset: undefined })}`,
    `/compliance/kyc/count${kycQuery({ ...opts, limit: undefined, offset: undefined })}`,
    { total: kycCases.length },
  );
/**
 * Every series the analytics screen draws, measured from real rows.
 *
 * One request for both sides: payments and verifications cut on the same
 * buckets, so a dip in the pass rate can be read against the deposits of the
 * same afternoon rather than against a chart with its own axis.
 */
export type Analytics = {
  from: string;
  to: string;
  bucket: "hour" | "day";
  payments: {
    settled: number;
    failed: number;
    /** Of the DECIDED ones. A pending payment has neither succeeded nor failed. */
    successRate: number | null;
    volume: number;
    /** More than one and the volume figures are adding unlike things. */
    currencies: string[];
  };
  kyc: {
    approved: number;
    rejected: number;
    passRate: number | null;
    spentEur: number;
    /** Including the failed attempts — four tries to verify one person cost four times. */
    costPerApproved: number | null;
  };
  series: {
    label: string;
    settled: number;
    failed: number;
    successRate: number | null;
    volume: number;
    approved: number;
    rejected: number;
    passRate: number | null;
    kycSpentEur: number;
  }[];
  /** Geography the payment provider never sent, from the one that verifies. */
  byCountry: {
    country: string;
    name: string | null;
    deposits: number;
    volume: number;
  }[];
  /** What share of the volume could be placed in a country at all. */
  countryCoverage: number;
};

export const useAnalytics = () =>
  useApi<Analytics>(
    "analytics",
    "/analytics",
    {
      from: "",
      to: "",
      bucket: "day" as const,
      payments: { settled: 0, failed: 0, successRate: null, volume: 0, currencies: [] },
      kyc: { approved: 0, rejected: 0, passRate: null, spentEur: 0, costPerApproved: null },
      series: [],
      byCountry: [],
      countryCoverage: 0,
    },
    { ranged: true },
  );

export const useIncidents = () => useApi<Incident[]>("incidents", "/incidents", incidents);

type OperationsData = { tickets: Ticket[]; team: Operator[]; shiftChecklist: ChecklistItem[] };
export const useOperations = () =>
  useApi<OperationsData>("operations", "/operations", { tickets, team: operators, shiftChecklist });

type ReportsData = {
  templates: ReportTemplate[];
  generated: GeneratedReport[];
  scheduled: ScheduledReport[];
};
export const useReports = () =>
  useApi<ReportsData>("reports", "/reports", {
    templates: reportTemplates,
    generated: generatedReports,
    scheduled: scheduledReports,
  });

export const useAuditLog = () => useApi<AuditEntry[]>("audit", "/admin/audit-logs", auditLog);
