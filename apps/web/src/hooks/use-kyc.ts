"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";

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
  /**
   * The group's value — a form name, or a KYCAID account label.
   *
   * null where the row does not carry one; kept as its own line rather than
   * folded into an entity that may not have produced it.
   */
  form: string | null;
  verifications: number;
  byStatus: Record<string, number>;
  spentEur: number;
  unlinked: number;
};

export type KycSummary = {
  verifications: number;
  byForm: KycFormBreakdown[];
  /** The same figures per KYCAID account — which is per entity. */
  byAccount: KycFormBreakdown[];
  byStatus: { status: string; count: number }[];
  declineReasons: { reason: string; count: number }[];
  spentEur: number;
  averageMinutes: number | null;
  /** Clients who needed more than one attempt, and the worst case. */
  clientsRetried: number;
  mostAttempts: number;
};

/**
 * Everything KYCAID holds about one applicant, read live and kept nowhere.
 *
 * The table holds the outcome, the jurisdiction and the account reference. The
 * person is fetched when somebody opens the row, which is why this is a query
 * with an `enabled` flag rather than part of the row: one request per row
 * actually looked at, and no second permanent copy of everybody's identity
 * documents sitting in a dashboard.
 */
export type KycApplicant = {
  account: string;
  applicantId: string;
  verificationId: string | null;
  applicant: {
    name: string | null;
    dob: string | null;
    gender: string | null;
    residenceCountry: string | null;
    citizenshipCountry: string | null;
    email: string | null;
    phone: string | null;
    externalApplicantId: string | null;
    createdAt: string | null;
    type: string | null;
    addresses: {
      country: string | null;
      region: string | null;
      city: string | null;
      street: string | null;
      postalCode: string | null;
    }[];
    /** Numbers are masked to their last four — KYCAID holds the full one. */
    documents: {
      type: string | null;
      number: string | null;
      issuedCountry: string | null;
      issuedAt: string | null;
      expiresAt: string | null;
      status: string | null;
    }[];
  };
  note: string;
};

export function useApplicant(caseId: string | null, enabled: boolean) {
  return useQuery<KycApplicant>({
    queryKey: ["kyc-applicant", caseId],
    queryFn: () =>
      apiFetch<KycApplicant>(
        `/kyc/cases/${encodeURIComponent(caseId ?? "")}/applicant`,
      ),
    enabled: enabled && Boolean(caseId),
    // Nothing about a submitted applicant changes while a drawer is open, and
    // re-asking the provider on every focus is a request per tab switch.
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * What the provider actually sends, measured on the rows it sent.
 *
 * The answer to "what data can we get from this API", from the account's own
 * responses rather than from the reference — which has been wrong twice about
 * this provider's units, and silent about a country field that was arriving in
 * every row while the column read "—".
 */
export type KycFields = {
  sampled: number;
  held: number;
  /** Rows stored before the whole row was kept. Ours to fix, by re-fetching. */
  withoutRaw: number;
  fields: {
    field: string;
    filled: number;
    /** How often it carries a value. 0% is a column that will never fill. */
    fillRate: number;
    example: string | null;
    /** Which column of ours it lands in, or null for "available, unused". */
    storedAs: string | null;
  }[];
  /** Read from the provider and deliberately never stored. */
  refused: string[];
};

export function useKycFields(enabled: boolean) {
  return useQuery<KycFields>({
    queryKey: ["kyc-fields"],
    queryFn: () => apiFetch<KycFields>("/kyc/fields"),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** Who has moved money, and whether anybody checked them. */
export type KycCoverage = {
  tradingClients: number;
  verifiedClients: number;
  tradingWithoutKyc: number;
  examples: string[];
  byStatus: { status: string; clients: number }[];
};

/**
 * What a write into the compliance table did.
 *
 * Still called an import because that is what the provider read performs: the
 * rows come from KYCAID rather than a file, and land the same way.
 */
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

/** The period and entity a screen is asking about. Unset is everything held. */
export type KycWindow = { from?: string; to?: string; account?: string };

function windowQuery(w: KycWindow): string {
  const p = new URLSearchParams();
  if (w.from) p.set("from", w.from);
  if (w.to) p.set("to", w.to);
  if (w.account) p.set("account", w.account);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/**
 * The headline figures, over the period the screen is showing.
 *
 * The cards above the table used to be totals over everything ever loaded
 * while the table answered to a date range, so the two could disagree by a
 * year and nothing on the page said which was which.
 */
export function useKycSummary(window: KycWindow = {}) {
  const query = windowQuery(window);
  return useQuery<KycSummary>({
    queryKey: ["kyc-summary", query],
    queryFn: () => apiFetch<KycSummary>(`/kyc/summary${query}`),
  });
}

export function useKycCoverage() {
  return useQuery<KycCoverage>({
    queryKey: ["kyc-coverage"],
    queryFn: () => apiFetch<KycCoverage>("/kyc/coverage"),
  });
}

/**
 * How long one sync request may spend walking days on the server.
 *
 * Comfortably under the browser's own ceiling for this call. The two used to
 * be the same number, which meant the only way for the server to use its full
 * budget was for the browser to give up on it.
 */
const SERVER_BUDGET_MS = 12_000;

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
  /** Accounts whose form names could not be read — why the column shows ids. */
  formNamesUnavailable: { account: string; why: string }[];
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
    testSkipped: 0, accounts: [], formNamesUnavailable: [],
  };
  const statuses = new Map<string, number>();
  const forms = new Map<string, number>();

  let cursor: string | null = from;
  // A range is finite and each call advances by at least one day, so this
  // cannot run for ever. The guard is against an API that stops advancing —
  // a bug there would otherwise be an infinite loop in somebody's browser.
  for (let call = 0; cursor && call < 500; call++) {
    /**
     * The server's budget and the browser's patience, kept apart.
     *
     * Both were twenty seconds, so the function was still writing rows when
     * the browser gave up — and a run that had actually stored a day and a
     * half of verifications reported "the API did not answer within 20s". The
     * server now stops at twelve and the browser waits forty, which leaves
     * room for the reply itself, a cold start, and the database.
     */
    const r: KycSyncResult = await apiFetch<KycSyncResult>(
      "/kyc/sync",
      {
        method: "POST",
        body: JSON.stringify({ from: cursor, to, budgetMs: SERVER_BUDGET_MS }),
      },
      { timeoutMs: 40_000 },
    );
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
    // Once per account, not once per call: the same 404 on every day of a
    // year-long range is one finding, not three hundred and sixty-five.
    for (const f of r.formNamesUnavailable ?? [])
      if (!total.formNamesUnavailable.some((x) => x.account === f.account))
        total.formNamesUnavailable.push(f);
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

/**
 * Everything a completed read invalidates.
 *
 * `module` IS IN THIS LIST and was not. The compliance table is fetched
 * through useApi, whose keys start with "module" — so a sync refreshed the
 * cards, the coverage and the provider status, and left the table showing
 * what it held before the fetch. It corrected itself thirty seconds later on
 * that hook's own interval, which is exactly long enough to press Fetch,
 * watch the table not change, and conclude the fetch did nothing.
 */
const STALE_AFTER_SYNC = [
  "kyc-cases",
  "kyc-summary",
  "kyc-coverage",
  "kyc-provider",
  "module",
];

export function useSyncProvider(
  onProgress?: (day: string, days: number) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { from: string; to: string }) =>
      syncUntilDone(body.from, body.to, onProgress),
    onSuccess: () => {
      for (const key of STALE_AFTER_SYNC)
        void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
}

/** How often an open KYC page asks the provider what is new. */
const CATCH_UP_MS = 5 * 60_000;

function isoDay(shiftDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + shiftDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Keeps the page current without anybody pressing anything.
 *
 * WHY THIS EXISTS. Nothing read the provider between the nightly cron and
 * somebody pressing Fetch. A verification that arrived three minutes ago was
 * therefore not missing, not filtered and not late — it had never been asked
 * for, and would not be until 04:00 the next morning. The screen gave no hint
 * of that: it showed the newest row it held as though that were the newest row
 * there is.
 *
 * TWO DAYS, NOT ONE. The provider's report takes a single `date` and our days
 * are UTC, so at 01:00 in Mauritius (UTC+4) "today" here is still yesterday
 * there. Re-reading yesterday costs one extra request per account and removes
 * the whole class of bug; re-reading is free in any case, because the
 * verification id is the key and what is already stored simply updates.
 *
 * A QUERY, THOUGH IT POSTS. The sync is idempotent — it reads the provider and
 * upserts the rows it finds — which is what makes it safe to run on a timer,
 * and useQuery is what gives it a timer, a de-duplicated in-flight request,
 * a refetch when the tab is focused again, and an honest "last checked".
 */
export function useCatchUp(enabled: boolean) {
  const queryClient = useQueryClient();
  return useQuery<KycSyncResult>({
    queryKey: ["kyc-catch-up"],
    queryFn: async () => {
      const result = await syncUntilDone(isoDay(-1), isoDay(0));
      for (const key of STALE_AFTER_SYNC)
        void queryClient.invalidateQueries({ queryKey: [key] });
      return result;
    },
    enabled,
    refetchInterval: CATCH_UP_MS,
    refetchOnWindowFocus: true,
    // A provider that is down should not retry three times every five
    // minutes; the next tick is the retry.
    retry: false,
    staleTime: CATCH_UP_MS,
  });
}

