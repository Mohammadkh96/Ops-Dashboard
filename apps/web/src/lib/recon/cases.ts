// Ops workflow persistence for reconciliation cases.
//
// A reconciliation run is stateless — it re-derives every exception from the
// source files. The workflow the team layers on top (who owns it, what state
// it is in, what they found) must survive that, so it is stored separately and
// re-attached by caseKey after each run.
//
// Demo mode keeps it in localStorage; when an API is configured it persists
// server-side so the queue is shared across the team.

import { apiFetch, isDemoMode } from "@/lib/api";
import type { CaseState, ReconRow } from "./types";

const STORAGE_KEY = "opsos.recon.cases";

export const emptyCase = (caseKey: string): CaseState => ({
  caseKey,
  resolution: "Open",
  owner: "",
  notes: "",
});

/** True when the case carries nothing worth persisting. */
export const isBlankCase = (c: CaseState) =>
  (!c.resolution || c.resolution === "Open") && !c.owner?.trim() && !c.notes?.trim();

function loadLocal(): Record<string, CaseState> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, CaseState>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveLocal(map: Record<string, CaseState>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable / quota — the in-memory state still works */
  }
}

/**
 * Loads all known workflow state. In live mode the server is authoritative;
 * if it is unreachable we fall back to whatever this browser has, so the
 * operator never loses their place.
 */
export async function loadCases(): Promise<Record<string, CaseState>> {
  const local = loadLocal();
  if (isDemoMode) return local;
  try {
    const rows = await apiFetch<CaseState[]>("/recon/cases");
    if (!Array.isArray(rows)) return local;
    const map: Record<string, CaseState> = {};
    rows.forEach((r) => {
      if (!r?.caseKey) return;
      map[r.caseKey] = {
        caseKey: r.caseKey,
        resolution: r.resolution || "Open",
        owner: r.owner ?? "",
        notes: r.notes ?? "",
      };
    });
    return map;
  } catch {
    return local;
  }
}

/**
 * Persists one case. Writes locally first so the UI is never blocked on the
 * network, then syncs to the API when one is configured. `row` supplies the
 * denormalised context that makes the stored queue reportable on its own.
 */
export async function saveCase(state: CaseState, row?: ReconRow): Promise<void> {
  const map = loadLocal();
  map[state.caseKey] = state;
  saveLocal(map);
  if (isDemoMode) return;
  try {
    await apiFetch("/recon/cases", {
      method: "PUT",
      body: JSON.stringify({
        cases: [
          {
            ...state,
            priority: row?.priority ?? null,
            status: row?.status ?? null,
            entity: row?.entity ?? null,
            brand: row?.brand ?? null,
            psp: row?.psp ?? null,
            reference: row ? row.leftId || row.rightId : null,
            exposure: row
              ? Math.max(Math.abs(row.diff ?? 0), Math.abs(row.leftAmount ?? 0), Math.abs(row.rightAmount ?? 0))
              : 0,
          },
        ],
      }),
    });
  } catch {
    /* offline — localStorage keeps the change and the next load merges it */
  }
}

/** Counts open vs resolved across the current exception set. */
export function caseTotals(rows: ReconRow[], cases: Record<string, CaseState>) {
  let open = 0;
  let inProgress = 0;
  let done = 0;
  rows.forEach((r) => {
    const res = cases[r.caseKey]?.resolution ?? "Open";
    if (res === "Resolved" || res === "Accepted Exception") done++;
    else if (res === "Open") open++;
    else inProgress++;
  });
  return { open, inProgress, done };
}
