"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAdminLock } from "@/lib/admin-lock";

/** One endpoint's request shape, as typed in from the provider's docs. */
export type EndpointConfig = {
  path: string;
  recordsPath?: string;
  fields?: {
    amount?: string;
    currency?: string;
    account?: string;
    // Transactions only.
    id?: string;
    status?: string;
    date?: string;
    reference?: string;
  };
  query?: Record<string, string>;
};

/** A provider connection. Never carries the credential — only whether one is stored. */
export type Psp = {
  id: string;
  terminal: string;
  provider: string;
  label: string;
  baseUrl: string | null;
  authMode: string;
  authName: string | null;
  hasKey: boolean;
  hasSecret: boolean;
  keyHint: string | null;
  /** Lengths only, never the values — providers reject on length. */
  keyLength: number | null;
  secretLength: number | null;
  endpoints: Record<string, EndpointConfig>;
  enabled: boolean;
  lastOkAt: string | null;
  lastTriedAt: string | null;
  lastError: string | null;
  balances: { at: string; rows: Balance[] } | null;
  ready: boolean;
};

export type Balance = {
  account: string | null;
  currency: string | null;
  amount: number;
};

/**
 * One transaction as the provider reports it.
 *
 * `status` is their word, untranslated; `at` is their timestamp verbatim and
 * `atISO` our reading of it, which can be null when their format is one we
 * cannot parse.
 */
export type Txn = {
  id: string | null;
  amount: number | null;
  currency: string | null;
  status: string | null;
  at: string | null;
  atISO: string | null;
  reference: string | null;
};

export type TestResult =
  | {
      ok: true;
      status: number;
      ms: number;
      balances: Balance[];
      transactions: Txn[];
      note?: string;
      body: unknown;
    }
  | {
      ok: false;
      status: number | null;
      error: string;
      ms: number;
      body?: unknown;
      /** A few response headers — www-authenticate names the auth mode. */
      headers?: Record<string, string>;
    };

export const AUTH_MODES = [
  "bearer",
  "header",
  "basic",
  "query",
  "hmac",
] as const;

export function usePsps() {
  const { authFetch, unlocked } = useAdminLock();
  return useQuery<Psp[]>({
    queryKey: ["admin", "psps", unlocked],
    queryFn: () => authFetch<Psp[]>("/psps"),
    enabled: unlocked,
    retry: false,
  });
}

export function useCredentialsKey() {
  const { authFetch, unlocked } = useAdminLock();
  return useQuery<{ configured: boolean; variable: string }>({
    queryKey: ["admin", "psp-key", unlocked],
    queryFn: () => authFetch("/psps/key-status"),
    enabled: unlocked,
    retry: false,
  });
}

/**
 * Every write the PSP screen makes.
 *
 * `test` is a POST and is not in the query cache on purpose: it spends a real
 * outbound call against a live payment credential, and a cached "last test
 * result" shown as if it were current is how somebody concludes a provider is
 * fine ten minutes after it stopped answering.
 */
export function usePspAdmin() {
  const { authFetch } = useAdminLock();
  const queryClient = useQueryClient();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["admin", "psps"] });

  const create = useMutation({
    mutationFn: (body: {
      terminal: string;
      provider?: string;
      label?: string;
    }) =>
      authFetch<Psp>("/psps", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: refresh,
  });

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      authFetch<{ ok: boolean }>(`/psps/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: refresh,
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      authFetch<{ ok: boolean }>(`/psps/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  const test = useMutation({
    mutationFn: ({
      id,
      capability = "balance",
    }: {
      id: string;
      capability?: "balance" | "transactions";
    }) =>
      authFetch<TestResult>(`/psps/${id}/test?capability=${capability}`, {
        method: "POST",
      }),
    onSuccess: refresh,
  });

  return { create, update, remove, test };
}
