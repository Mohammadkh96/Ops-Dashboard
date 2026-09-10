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

export function useImportVerifications() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      rows: VerificationRow[];
      mapping?: Record<string, string>;
    }) =>
      apiFetch<KycImportResult>("/kyc/import", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      for (const key of ["kyc-cases", "kyc-summary", "kyc-coverage"])
        void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
}
