// The V15 pipeline as the Reconciliation tab's engine.
//
// `buildReconOne` produces the authoritative output: one flat row per
// transaction, one verdict, the whole CRM → Paymaxis → PSP chain. That is the
// shape the Apps Script settled on, and it is what the tab now renders.
//
// The adapter below also projects those rows into the ReconResult shape the
// existing breakdowns, matrix and case queue read. It is a VIEW, not a second
// opinion: every verdict, priority and exposure figure comes from the rows
// above, so the summary tables can never disagree with the queue.

import type {
  Breakdown, Dataset, LayerStats, MatchStatus, MatrixCell, PspConfig,
  ReconMatrix, ReconOptions, ReconResult, ReconRow, Row,
} from "../types";
import { buildReconOne, PRIORITY_RANK, type OneRow, type ReconOne } from "./master";
import { dateMs } from "./values";

export type { OneRow, ReconOne };
export { buildReconOne };

/** V15 status text → the badge vocabulary the tab already uses. */
function toMatchStatus(status: string): MatchStatus {
  if (status.startsWith("✅")) return "matched";
  if (status.includes("Status Mismatch")) return "status";
  if (status.includes("Amount Mismatch")) return "amount";
  if (status.includes("Missing in CRM")) return "unmatched-cashier";
  if (status.includes("Missing in Cashier")) return "unmatched-crm";
  if (status.includes("Missing in PSP") || status.includes("Unmatched PSP")) return "unmatched-psp";
  if (status.includes("Out of Scope")) return "out-of-scope";
  if (status.includes("Agreed Decline")) return "agreed-decline";
  if (status.includes("Incomplete")) return "incomplete";
  if (status.includes("Not Reconciled")) return "not-reconciled";
  if (status.includes("Dropped · Completed")) return "unmatched-cashier";
  return "needs-review";
}

/** A flat row projected onto the tab's row shape. */
function toReconRow(o: OneRow): ReconRow {
  const l2Side = Boolean(o.pspId || o.pspName);
  return {
    status: toMatchStatus(o.status),
    priority: o.priority,
    entity: o.entity,
    brand: o.crmStatus ? "" : "", // set by the caller from the CRM brand column
    psp: l2Side ? o.pspName : undefined,
    matchKey: o.matchKeys,
    // Left is the CRM side when there is one, else the cashier row.
    leftId: o.crmId || o.cashierId,
    leftAmount: o.crmAmount ?? o.cashierAmount,
    leftCurrency: o.crmCurrency || o.cashierCurrency,
    leftStatus: o.crmStatus || o.cashierState,
    rightId: o.pspId || o.cashierId,
    rightAmount: o.pspAmount ?? o.cashierAmount,
    rightCurrency: o.pspCurrency || o.cashierCurrency,
    rightStatus: o.pspStatus || o.cashierState,
    diff: o.l2diff ?? o.l1diff,
    note: [o.status, o.notes].filter(Boolean).join(" — "),
    caseKey: o.caseKey,
    timing: o.timing,
  };
}

const emptyStats = (): LayerStats => ({
  total: 0, matched: 0, amount: 0, status: 0, unmatched: 0,
  matchRate: 0, matchedAmount: 0, exposure: 0,
});

const INFORMATIONAL = new Set<MatchStatus>([
  "out-of-scope", "agreed-decline", "incomplete", "not-reconciled",
]);

function statsFor(rows: OneRow[]): LayerStats {
  const s = emptyStats();
  rows.forEach((o) => {
    const ms = toMatchStatus(o.status);
    // Informational rows are excluded from the denominator so the rate measures
    // reconciliation quality, not data volume.
    if (INFORMATIONAL.has(ms)) return;
    s.total++;
    if (ms === "matched") {
      s.matched++;
      s.matchedAmount += Math.abs(o.cashierAmount ?? o.crmAmount ?? 0);
    } else if (ms === "amount") s.amount++;
    else if (ms === "status") s.status++;
    else s.unmatched++;
    if (ms !== "matched") s.exposure += o.exposure;
  });
  s.matchedAmount = Math.round(s.matchedAmount * 100) / 100;
  s.exposure = Math.round(s.exposure * 100) / 100;
  s.matchRate = s.total ? Math.round((s.matched / s.total) * 100) : 0;
  return s;
}

function groupBy(rows: OneRow[], keyOf: (o: OneRow) => string): Breakdown[] {
  const map = new Map<string, Breakdown>();
  rows.forEach((o) => {
    const key = keyOf(o) || "—";
    const ms = toMatchStatus(o.status);
    if (INFORMATIONAL.has(ms)) return;
    const b =
      map.get(key) ??
      { key, matched: 0, amount: 0, status: 0, unmatched: 0, total: 0, matchRate: 0, exposure: 0 };
    b.total++;
    if (ms === "matched") b.matched++;
    else if (ms === "amount") b.amount++;
    else if (ms === "status") b.status++;
    else b.unmatched++;
    if (ms !== "matched") b.exposure = Math.round((b.exposure + o.exposure) * 100) / 100;
    map.set(key, b);
  });
  const out = [...map.values()];
  out.forEach((b) => {
    b.matchRate = b.total ? Math.round((b.matched / b.total) * 100) : 0;
  });
  // Worst first: the row that needs attention should not be buried
  // alphabetically.
  return out.sort((a, b) => b.exposure - a.exposure || a.key.localeCompare(b.key));
}

function buildMatrix(rows: OneRow[]): ReconMatrix {
  const brands = new Set<string>();
  const psps = new Set<string>();
  const cells: Record<string, Record<string, MatrixCell>> = {};

  rows.forEach((o) => {
    if (!o.pspName) return;
    const ms = toMatchStatus(o.status);
    if (INFORMATIONAL.has(ms)) return;
    const brand = o.entity || "—";
    brands.add(brand);
    psps.add(o.pspName);
    cells[brand] = cells[brand] ?? {};
    const cell = cells[brand][o.pspName] ?? { matched: 0, total: 0, rate: 0, exposure: 0 };
    cell.total++;
    if (ms === "matched") cell.matched++;
    else cell.exposure = Math.round((cell.exposure + o.exposure) * 100) / 100;
    cell.rate = cell.total ? Math.round((cell.matched / cell.total) * 100) : 0;
    cells[brand][o.pspName] = cell;
  });

  return { brands: [...brands].sort(), psps: [...psps].sort(), cells };
}

/** Restrict a dataset to a window, on whichever date column it carries. */
function filterByDate(ds: Dataset, cols: string[], from: string, to: string): Dataset {
  if (!from && !to) return ds;
  const fromMs = from ? dateMs(from) : null;
  const toMs = to ? dateMs(`${to}T23:59:59Z`) ?? dateMs(to) : null;
  const rows = ds.rows.filter((r) => {
    let t: number | null = null;
    for (const c of cols) {
      t = dateMs(r[c]);
      if (t !== null) break;
    }
    // A row with no readable date is kept: dropping it would silently shrink the
    // population and inflate the match rate.
    if (t === null) return true;
    if (fromMs !== null && t < fromMs) return false;
    if (toMs !== null && t > toMs) return false;
    return true;
  });
  return { ...ds, rows };
}

export type V15Run = {
  one: ReconOne;
  result: ReconResult;
};

/**
 * Runs the ported pipeline and returns both surfaces.
 *
 * @param uploaded PSP ids whose file was supplied for this period. A PSP without
 *   one cannot be matched, and its rows are reported as not reconciled rather
 *   than blamed as unmatched.
 */
export function runReconV15(
  crm: Dataset | null,
  cashier: Dataset | null,
  psps: PspConfig[],
  pspData: Record<string, Dataset>,
  nowIso: string,
  opts: ReconOptions = {},
  priorWorkflow?: Map<string, { resolution: string; owner: string; opsNotes: string }>,
): V15Run {
  const from = opts.dateFrom ?? "";
  const to = opts.dateTo ?? "";

  const crmF = crm ? filterByDate(crm, ["LastUpdated", "Last Updated", "CreatedOn", "Created On"], from, to) : null;
  const cashF = cashier ? filterByDate(cashier, ["Finalized", "Updated", "Created"], from, to) : null;

  const data: Record<string, Row[]> = {};
  const uploaded = new Set<string>();
  psps.forEach((p) => {
    const ds = pspData[p.id];
    data[p.id] = ds?.rows ?? [];
    // "Uploaded for this period" is evidenced by the file having rows at all.
    if (ds && ds.rows.length > 0) uploaded.add(p.id);
  });

  const one = buildReconOne(
    crmF?.rows ?? [], cashF?.rows ?? [], psps, data, uploaded, priorWorkflow,
  );

  // Brand comes off the CRM row; the flat row carries the entity.
  const brandByCrmId = new Map<string, string>();
  (crmF?.rows ?? []).forEach((r) => {
    const brand = r["Brand Title"] ?? r["Brand"] ?? "";
    ["Psp Transaction ID", "Order No", "Withdrawal Psp Transaction ID"].forEach((c) => {
      const k = String(r[c] ?? "").trim();
      if (k && brand && !brandByCrmId.has(k)) brandByCrmId.set(k, String(brand));
    });
  });

  const rows = one.rows.map((o) => {
    const r = toReconRow(o);
    r.brand = (o.crmId && brandByCrmId.get(o.crmId)) || "";
    return r;
  });

  // The layer split is presentational: a row with a PSP leg belongs to the
  // Cashier ↔ PSP view, everything else to CRM ↔ Cashier.
  const l1Rows = rows.filter((r) => !r.psp);
  const l2Rows = rows.filter((r) => Boolean(r.psp));
  const l1One = one.rows.filter((o) => !o.pspName);
  const l2One = one.rows.filter((o) => Boolean(o.pspName));

  const sorter = (a: ReconRow, b: ReconRow) =>
    (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);

  const exceptions = rows
    .filter((r) => r.status !== "matched" && !INFORMATIONAL.has(r.status))
    .sort(sorter);

  return {
    one,
    result: {
      completeness: {
        rows: [],
        surfaced: one.completeness.surfaced,
        dropped: one.completeness.dropped,
        total: one.completeness.total,
        balanced: one.completeness.balanced,
        flagged: one.kpis.audit,
      },
      layer1: { rows: l1Rows.sort(sorter), stats: statsFor(l1One) },
      layer2: { rows: l2Rows.sort(sorter), stats: statsFor(l2One) },
      byPsp: groupBy(l2One, (o) => o.pspName || "Unrouted"),
      byBrand: groupBy(one.rows, (o) => (o.crmId && brandByCrmId.get(o.crmId)) || "—"),
      byEntity: groupBy(one.rows, (o) => o.entity),
      matrix: buildMatrix(l2One),
      exceptions,
      matched: rows.filter((r) => r.status === "matched"),
      ranAt: nowIso,
    },
  };
}
