import { apiFetch, isDemoMode } from "@/lib/api";
import type { PspConfig, ReconResult } from "./types";

// Optional backend sync. When an API is configured (live mode) the PSP registry
// and run history persist server-side (shared across the team); in demo mode
// every call is a no-op and the page falls back to localStorage.

export type RunSummaryRow = {
  id: string;
  ranAt: string;
  ranBy?: string | null;
  layer1Matched: number;
  layer1Total: number;
  layer2Matched: number;
  layer2Total: number;
  // Chain-level figures — the ones the history table reports. Absent on runs
  // saved before the column existed, which is why they are optional.
  reconciled?: number;
  inScope?: number;
  p1?: number;
  exceptionCount: number;
  exposure: number;
};

export async function loadPspsRemote(): Promise<PspConfig[] | null> {
  if (isDemoMode) return null;
  try {
    const rows = await apiFetch<PspConfig[]>("/recon/psps");
    return Array.isArray(rows) && rows.length ? rows : null;
  } catch {
    return null;
  }
}

export async function savePspsRemote(psps: PspConfig[]): Promise<void> {
  if (isDemoMode) return;
  try {
    await apiFetch("/recon/psps", { method: "PUT", body: JSON.stringify({ psps }) });
  } catch {
    /* offline / not configured — localStorage remains the source of truth */
  }
}

/**
 * @param kpis the run's chain-level figures. The history table reports these, so
 *   a saved run and the page that produced it cannot disagree; the per-layer
 *   counts are still recorded as a per-leg view.
 */
export async function saveRunRemote(
  res: ReconResult,
  ranBy?: string,
  kpis?: { reconciled: number; inScope: number; p1: number; exposure: number },
): Promise<void> {
  if (isDemoMode) return;
  try {
    await apiFetch("/recon/runs", {
      method: "POST",
      body: JSON.stringify({
        ranBy,
        layer1Matched: res.layer1.stats.matched,
        layer1Total: res.layer1.stats.total,
        layer2Matched: res.layer2.stats.matched,
        layer2Total: res.layer2.stats.total,
        reconciled: kpis?.reconciled,
        inScope: kpis?.inScope,
        p1: kpis?.p1,
        exceptionCount: res.exceptions.length,
        exposure: kpis ? kpis.exposure : res.layer1.stats.exposure + res.layer2.stats.exposure,
        summary: { byPsp: res.byPsp, exceptions: res.exceptions, ranAt: res.ranAt },
      }),
    });
  } catch {
    /* ignore */
  }
}

export async function listRunsRemote(): Promise<RunSummaryRow[]> {
  if (isDemoMode) return [];
  try {
    return await apiFetch<RunSummaryRow[]>("/recon/runs");
  } catch {
    return [];
  }
}
