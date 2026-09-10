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

export type KycSummary = {
  verifications: number;
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
 * A thousand rows is roughly 300KB. Well under the ceiling, few enough round
 * trips that a large export still finishes in a sensible time.
 */
const ROWS_PER_REQUEST = 1000;

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
    const r = await apiFetch<KycImportResult>("/kyc/import", {
      method: "POST",
      body: JSON.stringify({ rows: batch, mapping }),
    });
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
      for (const key of ["kyc-cases", "kyc-summary", "kyc-coverage"])
        void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
}
