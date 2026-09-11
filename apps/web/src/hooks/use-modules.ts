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
