"use client";

import { useQuery } from "@tanstack/react-query";

import { apiFetch, isDemoMode } from "@/lib/api";
import { useTimeRange, withRange } from "@/lib/time-range";
import { demoSummary, type DashboardSummary } from "@/lib/dashboard";

/**
 * Returns the dashboard summary. In demo mode (no API configured) or if the
 * API errors, it falls back to bundled demo data so the UI always renders.
 */
export function useDashboardSummary() {
  // The selected window is part of the key, so changing it refetches rather
  // than showing the previous period's numbers under the new label.
  const { query: rangeQuery, key: rangeKey } = useTimeRange();
  const query = useQuery({
    queryKey: ["dashboard-summary", rangeKey],
    queryFn: () =>
      apiFetch<DashboardSummary>(withRange("/dashboard/summary", rangeQuery)),
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
