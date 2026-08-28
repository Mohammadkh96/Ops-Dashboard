"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAdminLock } from "@/lib/admin-lock";
import type { AuditEntry } from "@/lib/modules";

/** An account, as the Admin tab needs to see it. */
export type AdminUser = {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  /** The enum value — ADMIN, OPERATIONS_MANAGER, … */
  role: string;
  status: "active" | "disabled";
  /** Has signed in with Google at least once. */
  google: boolean;
  /** A password could work. False for an account that only Google can open. */
  hasPassword: boolean;
  adminUnlockSet: boolean;
  createdAt: string;
  lastSeen: string;
};

/**
 * The Admin tab's own data, fetched with the unlock attached.
 *
 * Separate from useApi in use-modules, and NOT sharing its behaviour, for one
 * reason: that hook falls back to bundled sample data when a request fails, so
 * every module renders something. On an admin screen that is the wrong trade —
 * it would put invented accounts and a fictional audit trail in front of
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
    // A 403 from a lost unlock is not worth retrying — the answer is to type
    // the passphrase again, which the gate is already showing.
    retry: false,
    refetchInterval: 60_000,
  });
}

export const useAdminUsers = () =>
  useAdminQuery<AdminUser[]>("accounts", "/admin/accounts");

export const useAdminRoles = () =>
  useAdminQuery<string[]>("roles", "/admin/roles");

export const useAdminAuditLog = () =>
  useAdminQuery<AuditEntry[]>("audit", "/admin/audit-logs");

/**
 * Every write the Users screen makes.
 *
 * One hook rather than five, because they all invalidate the same list and all
 * fail the same way — and because a screen where four separate mutations each
 * decide independently whether to refetch is a screen that shows stale rows
 * after exactly one of them.
 */
export function useUserAdmin() {
  const { authFetch } = useAdminLock();
  const queryClient = useQueryClient();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["admin", "accounts"] });

  const create = useMutation({
    mutationFn: (body: {
      email: string;
      firstName?: string;
      lastName?: string;
      role: string;
      password?: string;
    }) =>
      authFetch<{ id: string; email: string; role: string }>("/admin/accounts", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: refresh,
  });

  const update = useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      role?: string;
      isActive?: boolean;
      firstName?: string;
      lastName?: string;
    }) =>
      authFetch<{ id: string }>(`/admin/accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: refresh,
  });

  const setPassword = useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      authFetch<{ ok: boolean; email: string }>(
        `/admin/accounts/${id}/password`,
        { method: "POST", body: JSON.stringify({ password }) },
      ),
    onSuccess: refresh,
  });

  const clearPassword = useMutation({
    mutationFn: (id: string) =>
      authFetch<{ ok: boolean; email: string }>(
        `/admin/accounts/${id}/password/clear`,
        { method: "POST" },
      ),
    onSuccess: refresh,
  });

  const resetAdminPassphrase = useMutation({
    mutationFn: (id: string) =>
      authFetch<{ ok: boolean; email: string }>(
        `/auth/admin/lock/reset/${id}`,
        { method: "POST" },
      ),
    onSuccess: refresh,
  });

  return { create, update, setPassword, clearPassword, resetAdminPassphrase };
}

/** ADMIN → "Admin", OPERATIONS_MANAGER → "Operations Manager". */
export function roleLabel(role: string): string {
  return role
    .split("_")
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(" ");
}
