import { CASHIER_MAP, CRM_MAP } from "./registry";
import type {
  Breakdown,
  Dataset,
  FieldMap,
  LayerStats,
  MatrixCell,
  PspConfig,
  ReconMatrix,
  ReconResult,
  ReconRow,
  Row,
} from "./types";

// ── status classification (generic keyword lists + per-config synonyms) ──
const FAILED_KEYWORDS = [
  "CANCEL", "DECLINE", "FAIL", "REJECT", "EXPIRE", "ERROR",
  "CHARGEBACK", "REVERSED", "VOID", "ABORT", "AWAITING WEBHOOK",
];
const ACTIVE_KEYWORDS = [
  "APPROVED", "APPROVE", "COMPLETED", "COMPLETE", "SUCCESS", "SETTLED",
  "SETTLE", "CONFIRMED", "CONFIRM", "PAID", "PROCESSED", "CAPTURED",
  "AUTHORIZED", "AUTHORISED", "PAYMENT",
];

const up = (v: unknown) => String(v ?? "").toUpperCase().trim();

function isFailed(status: string, extra?: string[]): boolean {
  const s = up(status);
  if (!s) return false;
  if (extra?.some((k) => s === up(k) || (up(k) && s.includes(up(k))))) return true;
  return FAILED_KEYWORDS.some((k) => s.includes(k));
}
function isActive(status: string, extra?: string[]): boolean {
  const s = up(status);
  if (!s) return false;
  if (extra?.some((k) => s === up(k) || (up(k) && s.includes(up(k))))) return true;
  return ACTIVE_KEYWORDS.some((k) => s.includes(k));
}

// ── value helpers ──
function firstVal(row: Row, cols: string[]): string {
  for (const col of cols) {
    for (const c of col.split(",").map((x) => x.trim())) {
      const v = row[c];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    }
  }
  return "";
}
function fieldVal(row: Row, spec: string | undefined): string {
  if (!spec) return "";
  return firstVal(row, [spec]);
}
function num(v: string): number {
  if (!v) return 0;
  let s = String(v).trim().replace(/["']/g, "").replace(/\s/g, "");
  if (s.indexOf(",") > -1 && s.indexOf(".") === -1) s = s.replace(/,/g, ".");
  else s = s.replace(/,/g, "");
  s = s.replace(/[^0-9.\-]/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
const round = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const norm = (v: string) => String(v || "").replace(/-/g, "").toLowerCase().trim();

function toDate(v: string): number | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.getTime();
}
function minutesBetween(a: string, b: string): number {
  const da = toDate(a);
  const db = toDate(b);
  if (da === null || db === null) return Number.POSITIVE_INFINITY;
  return Math.abs(da - db) / 60000;
}

function entityFromShop(shop: string): string {
  return /_sl/i.test(shop) ? "Saint Lucia" : "Mauritius";
}
function entityFromBrand(brand: string): string {
  return /global/i.test(brand) ? "Saint Lucia" : "Mauritius";
}

type Kind = "deposit" | "withdrawal" | "";
function kindFromType(t: string): Kind {
  const s = up(t);
  if (s.includes("DEPOSIT")) return "deposit";
  if (s.includes("WITHDRAW") || s.includes("REFUND")) return "withdrawal";
  return "";
}
function pspKind(row: Row, cfg: PspConfig): Kind {
  const t = up(fieldVal(row, cfg.fields.typeCol));
  if (!t) return "";
  if (cfg.depositTypes?.some((x) => t === up(x))) return "deposit";
  if (cfg.withdrawalTypes?.some((x) => t === up(x))) return "withdrawal";
  return kindFromType(t);
}
/** True when the cashier and PSP transaction types are compatible (or unknown). */
function typeCompatible(cashType: string, row: Row, cfg: PspConfig): boolean {
  const ck = kindFromType(cashType);
  const pk = pspKind(row, cfg);
  if (!ck || !pk) return true;
  return ck === pk;
}

/** Pulls extra candidate keys out of the cashier's JSON `External Refs`/`External Id`. */
function jsonCandidateKeys(c: Row): string[] {
  const out: string[] = [];
  ["External Refs", "External Id"].forEach((col) => {
    const raw = firstVal(c, [col]);
    if (!raw) return;
    let s = raw.trim();
    if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).replace(/""/g, '"');
    if (!s.startsWith("{")) return;
    try {
      const obj = JSON.parse(s) as Record<string, unknown>;
      ["webhookPaymentId", "requestId", "authenticateRequestId", "paymentId", "id"].forEach((k) => {
        const v = obj[k];
        if (v !== undefined && v !== null && String(v).trim()) out.push(norm(String(v)));
      });
    } catch {
      /* not JSON */
    }
  });
  return out;
}

// ── stats ──
function emptyStats(): LayerStats {
  return { total: 0, matched: 0, amount: 0, status: 0, unmatched: 0, matchRate: 0, matchedAmount: 0, exposure: 0 };
}
function computeStats(rows: ReconRow[]): LayerStats {
  const s = emptyStats();
  rows.forEach((r) => {
    s.total++;
    if (r.status === "matched") {
      s.matched++;
      s.matchedAmount += Math.abs(r.leftAmount ?? r.rightAmount ?? 0);
    } else if (r.status === "amount") {
      s.amount++;
      s.exposure += Math.abs(r.diff ?? 0);
    } else if (r.status === "status") {
      s.status++;
    } else {
      s.unmatched++;
    }
  });
  s.matchRate = s.total > 0 ? Math.round((s.matched / s.total) * 100) : 0;
  s.matchedAmount = round(s.matchedAmount);
  s.exposure = round(s.exposure);
  return s;
}

// ── index a PSP dataset by each id column value ──
function buildIndex(rows: Row[], cfg: PspConfig): Map<string, Row[]> {
  const m = new Map<string, Row[]>();
  rows.forEach((r) => {
    cfg.fields.idCols.forEach((col) => {
      const v = r[col];
      if (!v) return;
      const k = norm(v);
      if (!k) return;
      const arr = m.get(k) ?? [];
      arr.push(r);
      m.set(k, arr);
    });
  });
  return m;
}

// ═══════════════════════════════════════════════════════════
//  LAYER 1 — CRM ↔ CASHIER (by reference)
// ═══════════════════════════════════════════════════════════
function reconcileLayer1(crm: Dataset, cashier: Dataset): ReconRow[] {
  const rows: ReconRow[] = [];
  const used = new Set<number>();

  const cashByRef = new Map<string, number>();
  cashier.rows.forEach((r, i) => {
    const ref = norm(firstVal(r, ["Reference ID"]));
    if (ref && !cashByRef.has(ref)) cashByRef.set(ref, i);
  });

  crm.rows.forEach((cr) => {
    const crmAmt = num(fieldVal(cr, CRM_MAP.amountCol));
    const crmStatus = firstVal(cr, [CRM_MAP.statusCol ?? ""]);
    const crmType = firstVal(cr, [CRM_MAP.typeCol ?? ""]);
    const entity = entityFromBrand(firstVal(cr, [CRM_MAP.entityCol]));
    const key = norm(firstVal(cr, CRM_MAP.idCols));

    let cashIdx: number | undefined;
    if (key && cashByRef.has(key)) {
      const idx = cashByRef.get(key)!;
      if (!used.has(idx)) cashIdx = idx;
    }

    if (cashIdx === undefined) {
      if (isFailed(crmStatus)) return; // failed & unmatched → noise, skip
      rows.push(mkRow("unmatched-crm", entity, undefined, "", key, crmAmt,
        firstVal(cr, [CRM_MAP.currencyCol ?? ""]), crmStatus, "", null, "", "", null,
        "In CRM, no Cashier match"));
      return;
    }

    used.add(cashIdx);
    const c = cashier.rows[cashIdx];
    const cashAmt = num(fieldVal(c, CASHIER_MAP.amountCol));
    const cashState = firstVal(c, [CASHIER_MAP.statusCol ?? ""]);
    const diff = round(crmAmt - cashAmt);

    let status: ReconRow["status"] = "matched";
    let note = "Matched by reference";
    if (isFailed(crmStatus) && isFailed(cashState)) return; // both failed → skip
    if ((isActive(crmStatus) && isFailed(cashState)) || (isFailed(crmStatus) && isActive(cashState))) {
      status = "status";
      note = `CRM: ${crmStatus || "?"} vs Cashier: ${cashState || "?"}`;
    } else if (Math.abs(diff) >= 1) {
      status = "amount";
      note = `Amount diff ${diff}`;
    }

    rows.push(mkRow(status, entity, undefined, "Reference ID", key, crmAmt,
      firstVal(cr, [CRM_MAP.currencyCol ?? ""]), crmStatus,
      firstVal(c, CASHIER_MAP.idCols), cashAmt, firstVal(c, [CASHIER_MAP.currencyCol ?? ""]),
      cashState, diff, note));
  });

  // Cashier rows never matched to CRM
  cashier.rows.forEach((c, i) => {
    if (used.has(i)) return;
    const cashState = firstVal(c, [CASHIER_MAP.statusCol ?? ""]);
    if (isFailed(cashState)) return;
    rows.push(mkRow("unmatched-cashier", entityFromShop(firstVal(c, [CASHIER_MAP.entityCol])),
      undefined, "", "", null, "", "", firstVal(c, CASHIER_MAP.idCols),
      num(fieldVal(c, CASHIER_MAP.amountCol)), firstVal(c, [CASHIER_MAP.currencyCol ?? ""]),
      cashState, null, "In Cashier, no CRM match"));
  });

  return rows;
}

// ═══════════════════════════════════════════════════════════
//  LAYER 2 — CASHIER ↔ PSPs (config-driven)
// ═══════════════════════════════════════════════════════════
function reconcileLayer2(cashier: Dataset, psps: PspConfig[], pspData: Record<string, Dataset>): ReconRow[] {
  const rows: ReconRow[] = [];
  const usedPsp: Record<string, Set<number>> = {};
  psps.forEach((p) => (usedPsp[p.id] = new Set()));
  const indexes: Record<string, Map<string, Row[]>> = {};
  const rowIndexOf: Record<string, Map<Row, number>> = {};
  psps.forEach((p) => {
    const ds = pspData[p.id];
    if (!ds) return;
    indexes[p.id] = buildIndex(ds.rows, p);
    const ri = new Map<Row, number>();
    ds.rows.forEach((r, i) => ri.set(r, i));
    rowIndexOf[p.id] = ri;
  });

  // Which PSP does a cashier row route to? Use Provider/Terminal text.
  const routeToPsp = (c: Row): PspConfig | null => {
    const route = `${firstVal(c, ["Provider"])} ${firstVal(c, ["Terminal"])}`.toLowerCase();
    for (const p of psps) {
      if (route.includes(p.id.toLowerCase()) || route.includes(p.label.toLowerCase())) return p;
    }
    return null;
  };

  cashier.rows.forEach((c) => {
    const entity = entityFromShop(firstVal(c, [CASHIER_MAP.entityCol]));
    const cashId = firstVal(c, CASHIER_MAP.idCols);
    const cashAmt = num(fieldVal(c, CASHIER_MAP.amountCol));
    const cashState = firstVal(c, [CASHIER_MAP.statusCol ?? ""]);
    const cashDate = firstVal(c, [CASHIER_MAP.dateCol ?? ""]);
    const cashType = firstVal(c, [CASHIER_MAP.typeCol ?? ""]);
    if (!/deposit|withdraw|refund/i.test(cashType)) return;

    const cfg = routeToPsp(c);

    let matchRow: Row | null = null;
    let matchKey = "";
    let matched: PspConfig | null = null;

    // exact: cashier key candidates (incl. JSON External Refs) → PSP index
    const candidateCfgs = cfg ? [cfg] : psps;
    const keys = Array.from(
      new Set([
        ...CASHIER_MAP.idCols.map((col) => norm(firstVal(c, [col]))),
        ...jsonCandidateKeys(c),
      ].filter(Boolean)),
    );
    for (const p of candidateCfgs) {
      const idx = indexes[p.id];
      if (!idx) continue;
      for (const k of keys) {
        const hits = idx.get(k);
        if (!hits) continue;
        const hit = hits.find(
          (h) => !usedPsp[p.id].has(rowIndexOf[p.id].get(h)!) && typeCompatible(cashType, h, p),
        );
        if (hit) {
          matchRow = hit;
          matched = p;
          matchKey = "Exact ID";
          break;
        }
      }
      if (matchRow) break;
    }

    // fuzzy fallback (amount + time) within the routed PSP
    if (!matchRow && cfg) {
      const ds = pspData[cfg.id];
      if (ds) {
        let best: Row | null = null;
        let bestScore = Number.POSITIVE_INFINITY;
        ds.rows.forEach((pr, i) => {
          if (usedPsp[cfg.id].has(i)) return;
          if (!typeCompatible(cashType, pr, cfg)) return;
          const amtDiff = Math.abs(num(fieldVal(pr, cfg.fields.amountCol)) - cashAmt);
          const minDiff = minutesBetween(cashDate, fieldVal(pr, cfg.fields.dateCol));
          if (amtDiff <= cfg.amountTolerance && minDiff <= cfg.dateWindowMins) {
            const score = amtDiff + minDiff / 1000;
            if (score < bestScore) {
              best = pr;
              bestScore = score;
            }
          }
        });
        if (best) {
          matchRow = best;
          matched = cfg;
          matchKey = "Fuzzy amount+time";
        }
      }
    }

    const pspName = matched?.label ?? cfg?.label ?? "Unrouted";

    if (!matchRow || !matched) {
      if (isFailed(cashState) && (firstVal(c, ["Provider"]) || firstVal(c, ["Terminal"]))) return;
      rows.push(mkRow("unmatched-cashier", entity, pspName, "", cashId, cashAmt,
        firstVal(c, [CASHIER_MAP.currencyCol ?? ""]), cashState, "", null, "", "", null,
        "In Cashier, no PSP match"));
      return;
    }

    usedPsp[matched.id].add(rowIndexOf[matched.id].get(matchRow)!);
    const pspAmt = num(fieldVal(matchRow, matched.fields.amountCol));
    const pspStatus = fieldVal(matchRow, matched.fields.statusCol);
    const diff = round(cashAmt - pspAmt);

    let status: ReconRow["status"] = "matched";
    let note = matchKey;
    if (isFailed(cashState) && isFailed(pspStatus, matched.failedStatuses)) return;
    if (
      (isActive(cashState) && isFailed(pspStatus, matched.failedStatuses)) ||
      (isFailed(cashState) && isActive(pspStatus, matched.activeStatuses))
    ) {
      status = "status";
      note = `Cashier: ${cashState || "?"} vs PSP: ${pspStatus || "?"}`;
    } else if (Math.abs(diff) > matched.amountTolerance) {
      status = "amount";
      note = `Amount diff ${diff}`;
    }

    rows.push(mkRow(status, entity, matched.label, matchKey, cashId, cashAmt,
      firstVal(c, [CASHIER_MAP.currencyCol ?? ""]), cashState,
      fieldVal(matchRow, matched.fields.idCols[0]), pspAmt,
      fieldVal(matchRow, matched.fields.currencyCol), pspStatus, diff, note));
  });

  // PSP rows never matched to a cashier row
  psps.forEach((p) => {
    const ds = pspData[p.id];
    if (!ds) return;
    ds.rows.forEach((pr, i) => {
      if (usedPsp[p.id].has(i)) return;
      const st = fieldVal(pr, p.fields.statusCol);
      if (isFailed(st, p.failedStatuses)) return;
      rows.push(mkRow("unmatched-psp", p.entity === "All" ? "" : p.entity, p.label, "", "", null,
        "", "", firstVal(pr, p.fields.idCols), num(fieldVal(pr, p.fields.amountCol)),
        fieldVal(pr, p.fields.currencyCol), st, null, `In ${p.label}, no Cashier match`));
    });
  });

  return rows;
}

function mkRow(
  status: ReconRow["status"], entity: string, psp: string | undefined, matchKey: string,
  leftId: string, leftAmount: number | null, leftCurrency: string, leftStatus: string,
  rightId: string, rightAmount: number | null, rightCurrency: string, rightStatus: string,
  diff: number | null, note: string,
): ReconRow {
  return { status, entity, brand: "", psp, matchKey, leftId, leftAmount, leftCurrency, leftStatus,
    rightId, rightAmount, rightCurrency, rightStatus, diff, note };
}

/** Generic dimensional breakdown (PSP, brand, entity — driven by the key fn). */
function groupBy(rows: ReconRow[], keyOf: (r: ReconRow) => string): Breakdown[] {
  const m = new Map<string, Breakdown>();
  rows.forEach((r) => {
    const key = keyOf(r) || "—";
    const b =
      m.get(key) ??
      { key, matched: 0, amount: 0, status: 0, unmatched: 0, total: 0, matchRate: 0, exposure: 0 };
    b.total++;
    if (r.status === "matched") b.matched++;
    else if (r.status === "amount") {
      b.amount++;
      b.exposure += Math.abs(r.diff ?? 0);
    } else if (r.status === "status") b.status++;
    else b.unmatched++;
    m.set(key, b);
  });
  const out = Array.from(m.values());
  out.forEach((b) => {
    b.matchRate = b.total > 0 ? Math.round((b.matched / b.total) * 100) : 0;
    b.exposure = round(b.exposure);
  });
  return out.sort((a, b) => b.total - a.total);
}

/** Brand × PSP health grid from Layer 2 rows. */
function buildMatrix(rows: ReconRow[]): ReconMatrix {
  const brands = new Set<string>();
  const psps = new Set<string>();
  const cells: Record<string, Record<string, MatrixCell>> = {};
  rows.forEach((r) => {
    const brand = r.brand || "—";
    const psp = r.psp || "Unrouted";
    brands.add(brand);
    psps.add(psp);
    cells[brand] = cells[brand] ?? {};
    const c = cells[brand][psp] ?? { matched: 0, total: 0, rate: 0, exposure: 0 };
    c.total++;
    if (r.status === "matched") c.matched++;
    if (r.status === "amount") c.exposure += Math.abs(r.diff ?? 0);
    cells[brand][psp] = c;
  });
  Object.values(cells).forEach((row) =>
    Object.values(row).forEach((c) => {
      c.rate = c.total > 0 ? Math.round((c.matched / c.total) * 100) : 0;
      c.exposure = round(c.exposure);
    }),
  );
  return { brands: Array.from(brands).sort(), psps: Array.from(psps).sort(), cells };
}

/**
 * Enriches every row with its brand. Brand lives in the CRM (Brand Title); it is
 * propagated to Layer-2 (cashier↔PSP) rows through the cashier reference so the
 * whole result can be sliced per brand. This does NOT alter any matching.
 */
function enrichBrands(
  crm: Dataset | null,
  cashier: Dataset | null,
  l1: ReconRow[],
  l2: ReconRow[],
) {
  const brandByCrmKey = new Map<string, string>();
  crm?.rows.forEach((cr) => {
    const brand = firstVal(cr, [CRM_MAP.entityCol]);
    if (!brand) return;
    CRM_MAP.idCols.forEach((col) => {
      const k = norm(firstVal(cr, [col]));
      if (k && !brandByCrmKey.has(k)) brandByCrmKey.set(k, brand);
    });
  });
  const brandByCashId = new Map<string, string>();
  cashier?.rows.forEach((c) => {
    const id = firstVal(c, ["ID"]);
    const ref = norm(firstVal(c, ["Reference ID"]));
    const brand = ref ? brandByCrmKey.get(ref) : undefined;
    if (id && brand) brandByCashId.set(id, brand);
  });
  l1.forEach((r) => {
    r.brand = brandByCrmKey.get(norm(r.leftId)) || r.entity || "—";
  });
  l2.forEach((r) => {
    r.brand = brandByCashId.get(r.leftId) || r.entity || "—";
  });
}

export function runReconciliation(
  crm: Dataset | null,
  cashier: Dataset | null,
  psps: PspConfig[],
  pspData: Record<string, Dataset>,
  nowIso: string,
): ReconResult {
  const l1Rows = crm && cashier ? reconcileLayer1(crm, cashier) : [];
  const l2Rows = cashier ? reconcileLayer2(cashier, psps, pspData) : [];
  enrichBrands(crm, cashier, l1Rows, l2Rows);
  const severity = (s: ReconRow["status"]) =>
    s === "status" ? 0 : s.startsWith("unmatched") ? 1 : s === "amount" ? 2 : 5;
  const sorter = (a: ReconRow, b: ReconRow) => severity(a.status) - severity(b.status);
  l1Rows.sort(sorter);
  l2Rows.sort(sorter);
  const all = [...l1Rows, ...l2Rows];
  const exceptions = all.filter((r) => r.status !== "matched");
  return {
    layer1: { rows: l1Rows, stats: computeStats(l1Rows) },
    layer2: { rows: l2Rows, stats: computeStats(l2Rows) },
    byPsp: groupBy(l2Rows, (r) => r.psp || "Unrouted"),
    byBrand: groupBy(all, (r) => r.brand),
    byEntity: groupBy(all, (r) => r.entity),
    matrix: buildMatrix(l2Rows),
    exceptions,
    ranAt: nowIso,
  };
}
