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

export async function saveRunRemote(res: ReconResult, ranBy?: string): Promise<void> {
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
        exceptionCount: res.exceptions.length,
        exposure: res.layer1.stats.exposure + res.layer2.stats.exposure,
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
