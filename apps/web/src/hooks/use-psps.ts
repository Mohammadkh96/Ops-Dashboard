"use client";

import { useEffect } from "react";
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
    /** When it SETTLED, where the provider reports that separately. */
    settled?: string;
    /**
     * The provider's cut, where it reports one apart from the amount. Must be
     * in the SAME currency as the amount — see the note by the input.
     */
    fee?: string;
    reference?: string;
    direction?: string;
    customer?: string;
    /** Extra columns, as `Label` → path. */
    extras?: Record<string, string>;
  };
  query?: Record<string, string>;
  /**
   * How to ask for the next page. Names differ per provider — BEEM calls the
   * page size `max`, ForumPay `limit` — and getting one wrong truncates a sync
   * silently. See the note by the inputs.
   */
  pagination?: {
    limitParam?: string;
    offsetParam?: string;
    pageSize?: number;
  };
};

/**
 * Which of the provider's own words move the balance, and which way.
 *
 * The provider's vocabulary, not ours: ForumPay says "Sell" and "Buy",
 * Paymaxis says "DEPOSIT" and "WITHDRAWAL". Matching is case-insensitive but
 * otherwise exact, which is why the configuration screen offers the words the
 * data actually contains rather than a text box.
 */
export type MovementRules = {
  currency?: string;
  add?: string[];
  subtract?: string[];
  statuses?: string[];
  /**
   * The provider already puts the sign in the amount, as BEEM's wallet export
   * does. Then add and subtract mean only "counts" — see the service.
   */
  signed?: boolean;
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
  movementRules: MovementRules | null;
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
  // Not a way of presenting the key — a step before presenting anything. See
  // AuthMode in the API's psp-connector.ts.
  "oauth2",
  // Nor this: it signs the request instead of presenting a credential at all.
  "signature",
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

  // Not in the query cache either, and for a plainer reason than `test`: it is
  // a question about how a connection SHOULD be configured, asked while
  // somebody is typing. Caching an answer to that means showing a token
  // endpoint discovered against a base URL that has since been corrected.
  const discoverToken = useMutation({
    mutationFn: (id: string) =>
      authFetch<TokenDiscovery>(`/psps/${id}/discover-token`, {
        method: "POST",
      }),
  });

  return { create, update, remove, test, discoverToken };
}

/** Where a provider says it mints tokens — see discoverTokenEndpoint. */
export type TokenDiscovery =
  | {
      ok: true;
      found: { from: string; tokenEndpoint: string; grants?: string[] }[];
    }
  | { ok: false; error: string };

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
  /**
   * Set when the ledger was cut short at this many events. A Paymaxis ledger
   * is collapsed from an event log, and there is a limit on how much of that
   * log one read scans — said out loud rather than shown as a short list.
   */
  truncated?: number;
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
      // The balance is COMPUTED FROM these rows, so a sync that brings in a
      // transaction changes it — and leaving these out is why a fresh payment
      // appeared in the table while the balance above it still read +0.00.
      // Every query built on the stored ledger has to be listed here.
      void queryClient.invalidateQueries({ queryKey: ["psp-balance"] });
      void queryClient.invalidateQueries({ queryKey: ["psp-directory"] });
    },
  });
}

/** How often an open ledger pulls the provider's new transactions. */
const AUTO_SYNC_MS = 120_000;

/**
 * Keeps an open ledger current without anybody pressing anything.
 *
 * WHY: the stored ledger — and the balance computed from it — is only as fresh
 * as the last sync, and until now the only thing that caused one was a person
 * remembering to press a button. A payment taken at 05:41 was not on the screen
 * at 05:45 because nothing had asked ForumPay about it.
 *
 * WHAT IT COSTS: a call or two. The sync is incremental — providers return
 * newest first, so it stops at the first page with nothing new — and it is a
 * GET, the method is not configurable, and the credential never leaves the
 * server. This is not a background job that can do anything a person pressing
 * Sync could not.
 *
 * ONLY WHILE THE PAGE IS OPEN, and only for the provider being looked at.
 * Closing the tab stops it. For the hours when nobody has it open, the
 * scheduled run on the server does the same job — see `sync-all`.
 *
 * Skipped for a Paymaxis-sourced terminal, which has no API to call: its
 * transactions arrive by callback and are already here.
 */
export function usePspAutoSync(id: string | null, enabled: boolean) {
  const sync = usePspSync();
  // `mutate` is referentially stable, so the interval is created once per
  // connection rather than restarted on every render — which it would be if
  // this depended on the mutation object, and it would then never fire.
  const { mutate } = sync;

  useEffect(() => {
    if (!id || !enabled) return;
    const tick = () => mutate({ id });
    // Once on open, because the reason somebody opened this page is to see
    // what has happened, and waiting two minutes to find out is the complaint
    // this exists to answer.
    tick();
    const timer = setInterval(tick, AUTO_SYNC_MS);
    return () => clearInterval(timer);
  }, [id, enabled, mutate]);

  return sync.isPending;
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
  /** The estimated balance — see BalanceView. Null until somebody anchors one. */
  balance: BalanceView | null;
};

/** One anchor: a figure somebody read off the provider's own portal. */
export type Anchor = {
  id: string;
  amount: number;
  currency: string;
  takenAt: string;
  enteredAt: string;
  enteredBy: string | null;
  note: string | null;
  /** What was on screen the instant before this replaced it, and the gap. */
  estimateWas: number | null;
  drift: number | null;
};

/**
 * An ESTIMATED balance: an anchor plus the movement since.
 *
 * Never to be rendered as a plain figure. It is a number nobody read anywhere —
 * it is arithmetic on top of one that somebody did, and it misses the
 * provider's fees, conversion spread, settlements out, and anything done by
 * hand in the portal. Every place it appears carries the word "estimated" and
 * the age of the anchor it sits on.
 */
export type BalanceView = {
  connectionId: string;
  anchor: Anchor | null;
  rules: MovementRules | null;
  estimate: number | null;
  currency: string | null;
  movement: {
    net: number;
    added: number;
    subtracted: number;
    counted: number;
    ignoredDirection: number;
    ignoredStatus: number;
    ignoredCurrency: number;
    /** Of `subtracted`, how much was the provider's cut rather than payments. */
    fees: number;
    undated: number;
    /** Already inside the anchor figure — moved before it was taken. */
    beforeAnchor: number;
  };
  /**
   * What the PROVIDER says, when it has a balance endpoint that answers.
   *
   * Not another input to the estimate — the answer the estimate was standing
   * in for. Null for the providers this whole apparatus exists for, which
   * publish no readable balance at all.
   */
  reported: {
    amount: number;
    currency: string | null;
    account: string | null;
    at: string;
    ageHours: number;
  } | null;
  /** Estimate minus reported, signed. Positive = we were claiming too much. */
  drift: number | null;
  /**
   * What past corrections say the estimate is probably out by now.
   *
   * Deliberately not folded into `estimate` — see the service. The estimate
   * stays a stated derivation you can check against the ledger; this is a
   * correction fitted to how wrong that derivation has been, shown with the
   * number of intervals behind it so a two-sample hint cannot pass for a rate.
   */
  expectedDrift: {
    samples: number;
    rate: number;
    fittedOver: number;
    expected: number;
    adjusted: number;
    /**
     * The projected drift has outgrown the largest correction ever measured, so
     * the rate is being extrapolated past everything it was fitted on. What
     * "stale" means for a balance — set by the data, not by a calendar.
     */
    beyondExperience: boolean;
  } | null;
  /** False when no rule can classify anything — see the note on the card. */
  configured: boolean;
  ageHours: number | null;
  /**
   * How the movement was worked out.
   *
   * "baseline" — what counts now, minus what counted when the balance was
   * entered. Exact, and the only one that catches a payment settling late or
   * being reversed afterwards.
   *
   * "date" — everything that moved after the anchor. What balances entered
   * before baselines existed fall back to; it cannot see a late settlement on
   * a provider that reports only one timestamp, which Paymaxis does.
   */
  basis?: "baseline" | "date";
  /** The rules changed after the baseline was measured, so it must be re-entered. */
  rulesChanged?: boolean;
};

/** One connection's estimated balance. A plain session read. */
export function usePspBalance(id: string | null) {
  return useQuery<BalanceView>({
    queryKey: ["psp-balance", id],
    queryFn: () => apiFetch<BalanceView>(`/psps/${id}/balance`),
    enabled: Boolean(id),
    staleTime: 10_000,
  });
}

/** Every balance ever entered, with the drift each one revealed. */
export function usePspAnchors(id: string | null) {
  return useQuery<Anchor[]>({
    queryKey: ["psp-anchors", id],
    queryFn: () => apiFetch<Anchor[]>(`/psps/${id}/anchors`),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

/**
 * Records what the portal actually says.
 *
 * A plain session, like the sync. Typing in a figure somebody is looking at is
 * desk work; putting it behind the admin passphrase would mean either that
 * passphrase gets shared or the estimate never gets corrected, and an estimate
 * nobody re-anchors drifts for ever.
 */
/**
 * Re-anchors to the provider's own reading rather than a typed figure.
 *
 * Separate from useSetAnchor because there is nothing to type: the whole point
 * is that no number passes through a person. Same invalidations — it writes an
 * anchor exactly like the manual one, drift and all.
 */
export function useAnchorFromProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ anchor: Anchor; balance: BalanceView }>(
        `/psps/${id}/anchor-from-provider`,
        { method: "POST" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["psp-balance"] });
      void queryClient.invalidateQueries({ queryKey: ["psp-anchors"] });
      void queryClient.invalidateQueries({ queryKey: ["psp-directory"] });
    },
  });
}

export function useSetAnchor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      amount: number;
      currency: string;
      takenAt?: string;
      note?: string;
    }) =>
      apiFetch<{ anchor: Anchor; balance: BalanceView }>(`/psps/${id}/anchor`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["psp-balance"] });
      void queryClient.invalidateQueries({ queryKey: ["psp-anchors"] });
      void queryClient.invalidateQueries({ queryKey: ["psp-directory"] });
    },
  });
}

/**
 * The direction and status words this terminal actually uses.
 *
 * Behind the admin lock, because it exists to fill in the movement rules and
 * those are configuration. It is what makes the rules configurable at all:
 * matching is exact, so typing "WITHDRAWAL" at a provider that says "payout"
 * gives a rule that matches nothing and a balance that silently stops moving.
 */
export function usePspVocabulary(id: string | null) {
  const { authFetch, unlocked } = useAdminLock();
  return useQuery<{
    directions: { value: string; count: number }[];
    statuses: { value: string; count: number }[];
    currencies: { value: string; count: number }[];
  }>({
    queryKey: ["psp-vocabulary", id, unlocked],
    queryFn: () => authFetch(`/psps/${id}/vocabulary`),
    enabled: Boolean(id) && unlocked,
    staleTime: 60_000,
  });
}

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

export type ImportResult = {
  created: number;
  updated: number;
  skipped: number;
  total: number;
};

/**
 * A ledger from a file the provider let somebody download.
 *
 * The third way in, and for several providers the only one — Match2Pay
 * publishes no readable endpoint but its portal has an Export to CSV button.
 * A session, like the sync: it spends no credential at all.
 */
export function usePspImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      rows,
    }: {
      id: string;
      rows: Record<string, string>[];
    }) =>
      apiFetch<ImportResult>(`/psps/${id}/import`, {
        method: "POST",
        body: JSON.stringify({ rows }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["psp-ledger"] });
      void queryClient.invalidateQueries({ queryKey: ["psp-ledger-summary"] });
      void queryClient.invalidateQueries({ queryKey: ["psp-directory"] });
      // An import adds transactions, so it moves the balance too.
      void queryClient.invalidateQueries({ queryKey: ["psp-balance"] });
    },
  });
}
