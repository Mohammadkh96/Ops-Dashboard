"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import type { VerificationRow } from "@/lib/kyc/read-export";

/** One verification as the compliance screen reads it. */
export type KycCase = {
  id: string;
  verificationId: string | null;
  applicantId: string | null;
  /** The CRM's own account reference — the join to every payment. */
  reference: string | null;
  country: string | null;
  status: string;
  /** Their word, untranslated. "VALID" in the export, "completed" in callbacks. */
  providerStatus: string | null;
  form: string | null;
  method: string | null;
  declineReasons: string[];
  priceEur: number | null;
  processingMin: number | null;
  submittedAt: string;
};

/**
 * One KYCAID form — which in practice is one brand.
 *
 * The two entities run separate forms and the checks are not identical (one
 * includes ADDRESS), so a single total across both averages away the thing a
 * compliance officer is asked about.
 */
export type KycFormBreakdown = {
  /** null where the import carried no form — kept, never folded into a brand. */
  form: string | null;
  verifications: number;
  byStatus: Record<string, number>;
  spentEur: number;
  unlinked: number;
};

export type KycSummary = {
  verifications: number;
  byForm: KycFormBreakdown[];
  byStatus: { status: string; count: number }[];
  declineReasons: { reason: string; count: number }[];
  spentEur: number;
  averageMinutes: number | null;
  /** Clients who needed more than one attempt, and the worst case. */
  clientsRetried: number;
  mostAttempts: number;
};

/** Who has moved money, and whether anybody checked them. */
export type KycCoverage = {
  tradingClients: number;
  verifiedClients: number;
  tradingWithoutKyc: number;
  examples: string[];
  byStatus: { status: string; clients: number }[];
};

export type KycImportResult = {
  read: number;
  created: number;
  updated: number;
  unusable: number;
  unlinked: number;
  clientsCreated: number;
  clientsUpdated: number;
  /** Every distinct status in the file — the vocabulary to map. */
  statuses: { status: string; rows: number }[];
  forms: { form: string; rows: number }[];
};

export function useKycCases(limit = 200) {
  return useQuery<KycCase[]>({
    queryKey: ["kyc-cases", limit],
    queryFn: () => apiFetch<KycCase[]>(`/kyc/cases?limit=${limit}`),
  });
}

export function useKycSummary() {
  return useQuery<KycSummary>({
    queryKey: ["kyc-summary"],
    queryFn: () => apiFetch<KycSummary>("/kyc/summary"),
  });
}

export function useKycCoverage() {
  return useQuery<KycCoverage>({
    queryKey: ["kyc-coverage"],
    queryFn: () => apiFetch<KycCoverage>("/kyc/coverage"),
  });
}

/**
 * How many verifications go in one request.
 *
 * NOT a tuning knob — a platform limit. The serverless host refuses a request
 * body over 4.5MB, and it refuses it at the edge, before any of our code runs
 * and therefore before any CORS header is attached. The browser cannot read a
 * response it is not allowed to see, so a 30,111-row export arrived as a bare
 * "Failed to fetch" with nothing in the server log at all.
 *
 * Four hundred rows is roughly 120KB — far under the ceiling, and small enough
 * that one request is a short piece of work rather than a long one. A 30,000
 * row export is seventy-five requests, which the progress counter makes
 * legible.
 */
const ROWS_PER_REQUEST = 400;

/**
 * Sends an export in batches and adds up what came back.
 *
 * Sequential on purpose. Each batch creates clients the next may refer to, and
 * firing them together turns one import into a race for the same rows.
 */
async function importInBatches(
  rows: VerificationRow[],
  mapping: Record<string, string> | undefined,
  onProgress?: (done: number, total: number) => void,
): Promise<KycImportResult> {
  const total: KycImportResult = {
    read: 0, created: 0, updated: 0, unusable: 0, unlinked: 0,
    clientsCreated: 0, clientsUpdated: 0, statuses: [], forms: [],
  };
  const statuses = new Map<string, number>();
  const forms = new Map<string, number>();

  for (let i = 0; i < rows.length; i += ROWS_PER_REQUEST) {
    const batch = rows.slice(i, i + ROWS_PER_REQUEST);
    let r: KycImportResult;
    try {
      r = await apiFetch<KycImportResult>("/kyc/import", {
        method: "POST",
        body: JSON.stringify({ rows: batch, mapping }),
      });
    } catch (e) {
      // An import is not atomic across batches, so a failure halfway leaves
      // real rows behind. Saying how many landed turns "it broke" into "start
      // again and the first N will update rather than duplicate" — which is
      // true, because the verification id is the key.
      const done = total.created + total.updated;
      const why = e instanceof Error ? e.message : String(e);
      throw new Error(
        done
          ? `Imported ${done.toLocaleString()} of ${rows.length.toLocaleString()} before this failed: ${why} — re-running is safe, what landed will update rather than duplicate.`
          : why,
      );
    }
    total.read += r.read;
    total.created += r.created;
    total.updated += r.updated;
    total.unusable += r.unusable;
    total.unlinked += r.unlinked;
    total.clientsCreated += r.clientsCreated;
    total.clientsUpdated += r.clientsUpdated;
    for (const s of r.statuses)
      statuses.set(s.status, (statuses.get(s.status) ?? 0) + s.rows);
    for (const f of r.forms)
      forms.set(f.form, (forms.get(f.form) ?? 0) + f.rows);
    onProgress?.(Math.min(i + batch.length, rows.length), rows.length);
  }

  total.statuses = [...statuses.entries()]
    .map(([status, rows]) => ({ status, rows }))
    .sort((a, b) => b.rows - a.rows);
  total.forms = [...forms.entries()]
    .map(([form, rows]) => ({ form, rows }))
    .sort((a, b) => b.rows - a.rows);
  return total;
}

/** What the direct reader can do, and what is already loaded. */
export type KycProviderStatus = {
  provider: string;
  configured: boolean;
  /** The environment variable to set, so the screen can name it. */
  variable: string;
  /**
   * One per KYCAID account. The two entities hold separate accounts with
   * separate tokens, so this is the list of entities the API can read.
   */
  accounts: { account: string; variable: string; verifications: number }[];
  /** Rows from a console export, which does not say which account made them. */
  unattributed: number;
  verifications: number;
  oldest: string | null;
  newest: string | null;
  /** The provider's today, from the API's clock rather than the browser's. */
  today: string;
};

export type KycSyncResult = KycImportResult & {
  from: string;
  to: string;
  days: number;
  fetched: number;
  nextDate: string | null;
  done: boolean;
  truncated: string[];
  /** Rows the provider returned in TEST mode, dropped rather than counted. */
  testSkipped: number;
  /** What each entity's account returned. A zero here is the finding. */
  accounts: { account: string; rows: number }[];
};

export function useKycProvider() {
  return useQuery<KycProviderStatus>({
    queryKey: ["kyc-provider"],
    queryFn: () => apiFetch<KycProviderStatus>("/kyc/provider"),
  });
}

/**
 * Reads the provider across as many requests as the range takes.
 *
 * The API reads one day at a time and stops on a day boundary when its budget
 * runs out, handing back the day it did not reach. This asks again with that
 * date until there is none — so a year of history is a hundred short requests
 * rather than one that gets killed at sixty seconds, and every one of them
 * lands its rows permanently.
 *
 * A day that has already been read updates rather than duplicates, because the
 * verification id is the key. That is what makes resuming safe.
 */
async function syncUntilDone(
  from: string,
  to: string,
  onProgress?: (day: string, done: number) => void,
): Promise<KycSyncResult> {
  const total: KycSyncResult = {
    read: 0, created: 0, updated: 0, unusable: 0, unlinked: 0,
    clientsCreated: 0, clientsUpdated: 0, statuses: [], forms: [],
    from, to, days: 0, fetched: 0, nextDate: null, done: false, truncated: [],
    testSkipped: 0, accounts: [],
  };
  const statuses = new Map<string, number>();
  const forms = new Map<string, number>();

  let cursor: string | null = from;
  // A range is finite and each call advances by at least one day, so this
  // cannot run for ever. The guard is against an API that stops advancing —
  // a bug there would otherwise be an infinite loop in somebody's browser.
  for (let call = 0; cursor && call < 500; call++) {
    const r: KycSyncResult = await apiFetch<KycSyncResult>("/kyc/sync", {
      method: "POST",
      body: JSON.stringify({ from: cursor, to }),
    });
    total.read += r.read;
    total.created += r.created;
    total.updated += r.updated;
    total.unusable += r.unusable;
    total.unlinked += r.unlinked;
    total.clientsCreated += r.clientsCreated;
    total.clientsUpdated += r.clientsUpdated;
    total.days += r.days;
    total.fetched += r.fetched;
    total.testSkipped += r.testSkipped ?? 0;
    for (const a of r.accounts ?? []) {
      const seen = total.accounts.find((x) => x.account === a.account);
      if (seen) seen.rows += a.rows;
      else total.accounts.push({ ...a });
    }
    total.truncated.push(...r.truncated);
    for (const s of r.statuses)
      statuses.set(s.status, (statuses.get(s.status) ?? 0) + s.rows);
    for (const f of r.forms)
      forms.set(f.form, (forms.get(f.form) ?? 0) + f.rows);

    const next: string | null = r.nextDate;
    if (next && next === cursor) {
      throw new Error(
        `The sync stopped advancing at ${cursor}. ${total.created + total.updated} verifications were stored before that.`,
      );
    }
    cursor = next;
    onProgress?.(cursor ?? to, total.days);
  }

  total.done = cursor === null;
  total.nextDate = cursor;
  total.statuses = [...statuses.entries()]
    .map(([status, rows]) => ({ status, rows }))
    .sort((a, b) => b.rows - a.rows);
  total.forms = [...forms.entries()]
    .map(([form, rows]) => ({ form, rows }))
    .sort((a, b) => b.rows - a.rows);
  return total;
}

export function useSyncProvider(
  onProgress?: (day: string, days: number) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { from: string; to: string }) =>
      syncUntilDone(body.from, body.to, onProgress),
    onSuccess: () => {
      for (const key of ["kyc-cases", "kyc-summary", "kyc-coverage", "kyc-provider"])
        void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
}

export function useImportVerifications(
  onProgress?: (done: number, total: number) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      rows: VerificationRow[];
      mapping?: Record<string, string>;
    }) => importInBatches(body.rows, body.mapping, onProgress),
    onSuccess: () => {
      for (const key of ["kyc-cases", "kyc-summary", "kyc-coverage", "kyc-provider"])
        void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
}
