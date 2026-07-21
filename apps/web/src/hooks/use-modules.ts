"use client";

import { useQuery } from "@tanstack/react-query";

import { apiFetch, isDemoMode } from "@/lib/api";
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
  opsUsers,
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
  type OpsUser,
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
): { data: T; isDemo: boolean; isError: boolean; isLoading: boolean } {
  const query = useQuery<T>({
    queryKey: ["module", key],
    queryFn: () => apiFetch<T>(path),
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

export const useTransactions = () => useApi<Transaction[]>("transactions", "/transactions", transactions);
export const useGateways = () => useApi<Gateway[]>("gateways", "/gateways", gateways);
export const useKycCases = () => useApi<KycCase[]>("kyc", "/compliance/kyc", kycCases);
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

export const useUsers = () => useApi<OpsUser[]>("users", "/admin/users", opsUsers);
export const useAuditLog = () => useApi<AuditEntry[]>("audit", "/admin/audit-logs", auditLog);
