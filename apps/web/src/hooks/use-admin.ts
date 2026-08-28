"use client";

import { useQuery } from "@tanstack/react-query";

import { useAdminLock } from "@/lib/admin-lock";
import type { AuditEntry, OpsUser } from "@/lib/modules";

/**
 * The Admin tab's own data, fetched with the unlock attached.
 *
 * Separate from useApi in use-modules, and NOT sharing its behaviour, for one
 * reason: that hook falls back to bundled sample data when a request fails, so
 * every module renders something. On an admin screen that is the wrong trade —
 * it would put four invented accounts and a fictional audit trail in front of
 * somebody at the exact moment the real ones could not be read, and they would
 * have no way to tell.
 *
 * These fail visibly instead.
 */
function useAdminQuery<T>(key: string, path: string) {
  const { authFetch, unlocked } = useAdminLock();
  return useQuery<T>({
    queryKey: ["admin", key, unlocked],
    queryFn: () => authFetch<T>(path),
    // Only once the tab is unlocked. Asking while locked would spend a request
    // to be refused, and paint an error over a screen that is working
    // correctly.
    enabled: unlocked,
    // A 403 from an expired unlock is not worth retrying — the answer is to
    // type the passphrase again, which the gate is already showing.
    retry: false,
    refetchInterval: 60_000,
  });
}

export const useAdminUsers = () => useAdminQuery<OpsUser[]>("users", "/admin/users");

export const useAdminAuditLog = () =>
  useAdminQuery<AuditEntry[]>("audit", "/admin/audit-logs");
