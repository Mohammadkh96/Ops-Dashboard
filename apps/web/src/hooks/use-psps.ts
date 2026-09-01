"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAdminLock } from "@/lib/admin-lock";
import { apiFetch } from "@/lib/api";

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
    direction?: string;
    customer?: string;
    /** Extra columns, as `Label` → path. */
    extras?: Record<string, string>;
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
  /** "provider" — call its API. "paymaxis" — read what Paymaxis imported. */
  ledgerSource: string;
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
  /** The provider's own word for the direction: "Buy", "Sell", "payout"… */
  direction: string | null;
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

/** One stored transaction, read from our own table rather than the provider. */
export type LedgerRow = {
  id: string;
  externalId: string;
  reference: string | null;
  direction: string | null;
  status: string | null;
  amount: number | null;
  currency: string | null;
  occurredAt: string | null;
  rawAt: string | null;
  customer: string | null;
  /** The configured extra columns, as `Label` → value. */
  extras: Record<string, string | null>;
};

export type LedgerPage = {
  total: number;
  limit: number;
  offset: number;
  /** Where these rows came from: the provider's API, or Paymaxis. */
  source?: string;
  /** Labels in the order they were configured, so the table can head them. */
  extraColumns: string[];
  rows: LedgerRow[];
};

export type LedgerSummary = {
  count: number;
  oldest: string | null;
  newest: string | null;
  byStatus: { status: string; count: number }[];
};

export type LedgerQuery = {
  limit?: number;
  offset?: number;
  status?: string;
  direction?: string;
  from?: string;
  to?: string;
  search?: string;
};

function ledgerParams(q: LedgerQuery): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && v !== null && String(v) !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

/**
 * The stored ledger for one connection.
 *
 * A plain session read. The operations team reads this every shift, and
 * requiring the admin passphrase would mean the admin passphrase gets shared —
 * which is worse than what it would be protecting, because that same
 * passphrase also changes roles, reveals the audit trail and stores payment
 * credentials. Reading is what a session buys; spending a credential is not.
 */
export function usePspLedger(id: string | null, q: LedgerQuery) {
  return useQuery<LedgerPage>({
    queryKey: ["psp-ledger", id, q],
    queryFn: () => apiFetch<LedgerPage>(`/psps/${id}/ledger${ledgerParams(q)}`),
    enabled: Boolean(id),
    // Kept briefly so paging back and forth does not re-query, but not so long
    // that a sync finishes and the table still shows the old count.
    staleTime: 10_000,
  });
}

export function usePspLedgerSummary(id: string | null) {
  return useQuery<LedgerSummary>({
    queryKey: ["psp-ledger-summary", id],
    queryFn: () => apiFetch<LedgerSummary>(`/psps/${id}/ledger-summary`),
    enabled: Boolean(id),
    staleTime: 10_000,
  });
}

export type SyncResult = {
  ok: boolean;
  pages: number;
  fetched: number;
  created: number;
  updated: number;
  stopped: string;
  error?: string;
};

/**
 * Pulls the provider's ledger in.
 *
 * A plain session. Syncing is fetching data, which is the desk's job — and it
 * is safe to hand over because of what it structurally cannot do: every
 * outbound call is a GET, the method is not configurable, and the credential
 * is decrypted on the server and never reaches this code.
 */
export function usePspSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, full }: { id: string; full?: boolean }) =>
      apiFetch<SyncResult>(`/psps/${id}/sync${full ? "?full=1" : ""}`, {
        method: "POST",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["psp-ledger"] });
      void queryClient.invalidateQueries({ queryKey: ["psp-ledger-summary"] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "psps"] });
    },
  });
}

/** One provider as the desk sees it — no credentials, no configuration. */
export type PspCard = {
  id: string;
  terminal: string;
  label: string;
  provider: string;
  enabled: boolean;
  ledgerSource: string;
  hasTransactions: boolean;
  stored: number;
  newest: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  balances: { at: string; rows: Balance[] } | null;
};

/**
 * The provider list for the Providers tab.
 *
 * A plain session read, unlike usePsps() which is behind the admin lock and
 * carries base URLs and key hints. This one carries neither.
 */
export function usePspDirectory() {
  return useQuery<PspCard[]>({
    queryKey: ["psp-directory"],
    queryFn: () => apiFetch<PspCard[]>("/psps/directory"),
    staleTime: 30_000,
  });
}

/**
 * Every field this provider actually sends, read off the stored records.
 *
 * The answer to "what do I put in the extras box". A provider's documentation
 * is wrong as often as not and its portal shows columns the API does not
 * return, so the reliable source is what arrived.
 */
export function usePspFields(id: string | null) {
  const { authFetch, unlocked } = useAdminLock();
  return useQuery<{
    sampled: number;
    fields: { path: string; filled: number; example: string | null }[];
  }>({
    queryKey: ["psp-fields", id, unlocked],
    queryFn: () => authFetch(`/psps/${id}/fields`),
    enabled: Boolean(id) && unlocked,
    staleTime: 60_000,
  });
}
