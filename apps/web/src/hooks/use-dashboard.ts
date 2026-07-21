"use client";

import { useQuery } from "@tanstack/react-query";

import { apiFetch, isDemoMode } from "@/lib/api";
import { demoSummary, type DashboardSummary } from "@/lib/dashboard";

/**
 * Returns the dashboard summary. In demo mode (no API configured) or if the
 * API errors, it falls back to bundled demo data so the UI always renders.
 */
export function useDashboardSummary() {
  const query = useQuery({
    queryKey: ["dashboard-summary"],
    queryFn: () => apiFetch<DashboardSummary>("/dashboard/summary"),
    enabled: !isDemoMode,
    refetchInterval: 30_000,
  });

  return {
    data: query.data ?? demoSummary,
    isDemo: isDemoMode,
    isError: query.isError,
    isLoading: !isDemoMode && query.isLoading,
  };
}
