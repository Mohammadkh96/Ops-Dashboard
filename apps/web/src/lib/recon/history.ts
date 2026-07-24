import type { ReconResult } from "./types";

// A compact rolling history of runs kept in localStorage. It powers anomaly
// detection and per-brand trend sparklines without any backend, so the "smart"
// behaviour works on the standalone demo URL too. (In live mode the full runs
// also persist server-side via the API.)

export type RunSnapshot = {
  ranAt: string;
  overallL2: number;
  brands: Record<string, number>; // brand -> match rate
  cells: Record<string, number>; // `${brand}|||${psp}` -> match rate
};

export type Anomaly = {
  key: string; // brand, or `${brand} · ${psp}`
  brand: string;
  psp?: string;
  current: number;
  baseline: number;
  delta: number; // current - baseline (negative = regression)
};

export type Anomalies = {
  brand: Record<string, Anomaly>;
  cell: Record<string, Anomaly>; // keyed `${brand}|||${psp}`
  list: Anomaly[]; // regressions only, worst first
};

const KEY = "opsos.recon.history";
const CAP = 20;
const THRESHOLD = 8; // points drop vs baseline to flag

export function snapshotFromResult(res: ReconResult): RunSnapshot {
  const brands: Record<string, number> = {};
  res.byBrand.forEach((b) => (brands[b.key] = b.matchRate));
  const cells: Record<string, number> = {};
  res.matrix.brands.forEach((br) =>
    res.matrix.psps.forEach((psp) => {
      const c = res.matrix.cells[br]?.[psp];
      if (c) cells[`${br}|||${psp}`] = c.rate;
    }),
  );
  return { ranAt: res.ranAt, overallL2: res.layer2.stats.matchRate, brands, cells };
}

export function loadHistory(): RunSnapshot[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as RunSnapshot[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function appendHistory(snapshot: RunSnapshot): RunSnapshot[] {
  const next = [...loadHistory(), snapshot].slice(-CAP);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
  return next;
}

function mean(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : NaN;
}

/**
 * Compares the current snapshot against the trailing average of prior runs and
 * flags brands / brand×PSP cells whose match rate dropped by ≥ THRESHOLD points.
 */
export function detectAnomalies(prior: RunSnapshot[], current: RunSnapshot): Anomalies {
  const brand: Record<string, Anomaly> = {};
  const cell: Record<string, Anomaly> = {};
  const list: Anomaly[] = [];

  Object.entries(current.brands).forEach(([b, rate]) => {
    const hist = prior.map((s) => s.brands[b]).filter((v): v is number => typeof v === "number");
    if (hist.length < 1) return;
    const baseline = Math.round(mean(hist));
    const delta = rate - baseline;
    if (delta <= -THRESHOLD) {
      const a: Anomaly = { key: b, brand: b, current: rate, baseline, delta };
      brand[b] = a;
      list.push(a);
    }
  });

  Object.entries(current.cells).forEach(([k, rate]) => {
    const hist = prior.map((s) => s.cells[k]).filter((v): v is number => typeof v === "number");
    if (hist.length < 1) return;
    const baseline = Math.round(mean(hist));
    const delta = rate - baseline;
    if (delta <= -THRESHOLD) {
      const [b, psp] = k.split("|||");
      const a: Anomaly = { key: `${b} · ${psp}`, brand: b, psp, current: rate, baseline, delta };
      cell[k] = a;
      list.push(a);
    }
  });

  list.sort((a, b) => a.delta - b.delta);
  return { brand, cell, list };
}

/** Per-brand match-rate series (oldest→newest) across history + current, for sparklines. */
export function brandTrends(history: RunSnapshot[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  history.forEach((s) => {
    Object.entries(s.brands).forEach(([b, rate]) => {
      (out[b] = out[b] ?? []).push(rate);
    });
  });
  return out;
}
