import { CASHIER_MAP, CRM_MAP } from "./registry";
import type {
  Breakdown,
  Dataset,
  FieldMap,
  LayerStats,
  MatrixCell,
  PspConfig,
  ReconMatrix,
  ReconOptions,
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

// A transaction key is either a UNIQUE per-transaction hash (long hex — it
// lives in different CRM columns for deposits vs withdrawals) or a REUSABLE
// customer reference (e.g. CU570_1783945765743, shared across a customer's
// retries). We route each candidate value by SHAPE, not by column, and always
// match the unique hash first so a cancelled retry can't steal a match.
// Key columns depend on the transaction KIND, because deposits and withdrawals
// live in different columns and must never cross-match. A CRM withdrawal row
// carries its PARENT deposit's reference in "Psp Transaction ID" and the
// deposit's hash in "Merchant Trn Ref"; the withdrawal's own identifiers are in
// the Withdrawal* columns. Using the wrong columns makes withdrawals collide
// with their parent deposit (and with each other).
const CRM_KEYS_DEPOSIT = ["Psp Transaction ID", "Merchant Trn Ref", "Order No"];
const CRM_KEYS_WITHDRAWAL = ["Withdrawal Psp Transaction ID", "Withdrawal Merchant ID"];
// "Customer Reference ID" (e.g. "CU47099") is customer-level, not transaction-
// level, so it is deliberately excluded: it would link unrelated transactions
// belonging to the same customer.
const CASH_KEYS = ["ID", "External Id", "Reference ID"];
const crmKeyCols = (kind: Kind) => (kind === "withdrawal" ? CRM_KEYS_WITHDRAWAL : CRM_KEYS_DEPOSIT);
const isHashKey = (v: string) => /^[0-9a-f]{16,}$/i.test(v);

function keysByShape(row: Row, cols: string[]): { hash: string[]; ref: string[] } {
  const hash: string[] = [];
  const ref: string[] = [];
  cols.forEach((col) => {
    const raw = firstVal(row, [col]);
    if (!raw) return;
    (isHashKey(raw) ? hash : ref).push(norm(raw));
  });
  return { hash, ref };
}

// ═══════════════════════════════════════════════════════════
//  LAYER 1 — CRM ↔ CASHIER (unique hash first, then customer ref)
// ═══════════════════════════════════════════════════════════
function reconcileLayer1(crm: Dataset, cashier: Dataset, tolAbs: number, tolPct: number): ReconRow[] {
  const rows: ReconRow[] = [];
  const usedCash = new Set<number>();
  const matchedCrm = new Set<number>();

  const crmKindOf = (cr: Row): Kind => kindFromType(firstVal(cr, [CRM_MAP.typeCol ?? ""]));
  const cashKindOf = (c: Row): Kind => kindFromType(firstVal(c, [CASHIER_MAP.typeCol ?? ""]));

  // Which CRM rows are in scope (deposits & withdrawals only; internal
  // transfers and other noise are excluded).
  const scope: number[] = [];
  crm.rows.forEach((cr, i) => {
    if (crmKindOf(cr)) scope.push(i);
  });

  // Show the identifier that actually keyed the row (withdrawal ref for
  // withdrawals, deposit ref for deposits) rather than the parent reference.
  const displayKey = (cr: Row) => firstVal(cr, crmKeyCols(crmKindOf(cr))) || firstVal(cr, CRM_KEYS_DEPOSIT);

  const pairs: Array<{ crmIdx: number; cashIdx: number; via: string }> = [];

  // Even the "unique" hash is shared between a cancelled attempt and its
  // approved retry, so BOTH passes are cashier-driven best-match: for each
  // cashier row, among the CRM rows sharing a key, pick the one whose status
  // and amount agree best. Hash keys are tried before customer references.
  // requireAmount: a hash is a unique transaction id, so an amount gap on a
  // hash match is a real discrepancy worth reporting. A customer reference is
  // NOT a transaction id (one customer reuses it across many deposits), so we
  // only trust a reference pair when the amount also agrees — otherwise we'd
  // be pairing two unrelated transactions and calling the gap a "mismatch".
  const pickBest = (cashIdx: number, cand: Set<number>, requireAmount: boolean): number => {
    const c = cashier.rows[cashIdx];
    const cashAmt = num(fieldVal(c, CASHIER_MAP.amountCol));
    const cashState = firstVal(c, [CASHIER_MAP.statusCol ?? ""]);
    let best = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    cand.forEach((ci) => {
      if (matchedCrm.has(ci)) return;
      const cr = crm.rows[ci];
      const crmAmt = num(fieldVal(cr, CRM_MAP.amountCol));
      const crmStatus = firstVal(cr, [CRM_MAP.statusCol ?? ""]);
      const amtDiff = Math.abs(crmAmt - cashAmt);
      if (requireAmount) {
        const tol = Math.max(tolAbs, (Math.abs(crmAmt) * tolPct) / 100);
        if (amtDiff > tol) return; // reference + differing amount ≠ same transaction
      }
      const statusAgree =
        (isActive(crmStatus) && isActive(cashState)) || (isFailed(crmStatus) && isFailed(cashState));
      const score = (statusAgree ? 0 : 1_000_000) + amtDiff;
      if (score < bestScore) {
        bestScore = score;
        best = ci;
      }
    });
    return best;
  };

  // Keys are namespaced by kind ("deposit"\0key / "withdrawal"\0key) so a
  // deposit can only ever match a deposit and a withdrawal/refund a withdrawal.
  const nk = (kind: Kind, key: string) => `${kind} ${key}`;

  const runPass = (which: "hash" | "ref", via: string) => {
    const crmIndex = new Map<string, number[]>();
    scope.forEach((crmIdx) => {
      if (matchedCrm.has(crmIdx)) return;
      const kind = crmKindOf(crm.rows[crmIdx]);
      keysByShape(crm.rows[crmIdx], crmKeyCols(kind))[which].forEach((k) => {
        const kk = nk(kind, k);
        const arr = crmIndex.get(kk) ?? [];
        arr.push(crmIdx);
        crmIndex.set(kk, arr);
      });
    });
    cashier.rows.forEach((c, cashIdx) => {
      if (usedCash.has(cashIdx)) return;
      const kind = cashKindOf(c);
      if (!kind) return; // only reconcile deposit/withdrawal/refund cashier rows
      const cand = new Set<number>();
      keysByShape(c, CASH_KEYS)[which].forEach((k) => {
        (crmIndex.get(nk(kind, k)) ?? []).forEach((ci) => {
          if (!matchedCrm.has(ci)) cand.add(ci);
        });
      });
      if (!cand.size) return;
      const best = pickBest(cashIdx, cand, false);
      if (best >= 0) {
        usedCash.add(cashIdx);
        matchedCrm.add(best);
        pairs.push({ crmIdx: best, cashIdx, via });
      }
    });
  };

  runPass("hash", "Txn hash"); // Pass 1 — unique transaction hash
  runPass("ref", "Customer ref"); // Pass 2 — reusable customer reference

  // Classify matched pairs
  pairs.forEach(({ crmIdx, cashIdx, via }) => {
    const cr = crm.rows[crmIdx];
    const c = cashier.rows[cashIdx];
    const crmAmt = num(fieldVal(cr, CRM_MAP.amountCol));
    const crmStatus = firstVal(cr, [CRM_MAP.statusCol ?? ""]);
    const entity = entityFromBrand(firstVal(cr, [CRM_MAP.entityCol]));
    const cashAmt = num(fieldVal(c, CASHIER_MAP.amountCol));
    const cashState = firstVal(c, [CASHIER_MAP.statusCol ?? ""]);
    const diff = round(crmAmt - cashAmt);
    const tol = Math.max(tolAbs, (Math.abs(crmAmt) * tolPct) / 100);

    if (isFailed(crmStatus) && isFailed(cashState)) return; // both failed → not a discrepancy
    let status: ReconRow["status"] = "matched";
    let note = `Matched on ${via}`;
    if ((isActive(crmStatus) && isFailed(cashState)) || (isFailed(crmStatus) && isActive(cashState))) {
      status = "status";
      note = `CRM: ${crmStatus || "?"} vs Cashier: ${cashState || "?"}`;
    } else if (Math.abs(diff) > tol) {
      status = "amount";
      note = `Amount diff ${diff}${tolPct ? ` (tol ${tolPct}%)` : ""}`;
      // A unique hash is a true same-transaction match, so its amount gap is a
      // real discrepancy. A customer reference is reused across deposits, so an
      // amount gap there may just mean two different transactions share a ref.
      if (via === "Customer ref") note += " — matched on customer reference, verify (may be different transactions)";
    }
    rows.push(mkRow(status, entity, undefined, via, displayKey(cr),
      crmAmt, firstVal(cr, [CRM_MAP.currencyCol ?? ""]), crmStatus,
      firstVal(c, CASHIER_MAP.idCols), cashAmt, firstVal(c, [CASHIER_MAP.currencyCol ?? ""]),
      cashState, diff, note));
  });

  // Key sets present on each side — used to explain *why* a row is unmatched:
  // a shared key with no pair means the amount/status didn't line up (a likely
  // different transaction reusing the reference), which is distinct from a key
  // that simply doesn't exist on the other side.
  const cashKeysAll = new Set<string>();
  cashier.rows.forEach((c) => {
    const kind = cashKindOf(c);
    if (!kind) return;
    const s = keysByShape(c, CASH_KEYS);
    [...s.hash, ...s.ref].forEach((k) => cashKeysAll.add(nk(kind, k)));
  });
  const crmKeysAll = new Set<string>();
  scope.forEach((crmIdx) => {
    const kind = crmKindOf(crm.rows[crmIdx]);
    const s = keysByShape(crm.rows[crmIdx], crmKeyCols(kind));
    [...s.hash, ...s.ref].forEach((k) => crmKeysAll.add(nk(kind, k)));
  });

  // Unmatched CRM (payment rows only) — with a reason
  scope.forEach((crmIdx) => {
    if (matchedCrm.has(crmIdx)) return;
    const cr = crm.rows[crmIdx];
    const crmStatus = firstVal(cr, [CRM_MAP.statusCol ?? ""]);
    if (isFailed(crmStatus)) return; // failed & unmatched → expected noise
    const kind = crmKindOf(cr);
    const shapes = keysByShape(cr, crmKeyCols(kind));
    const anyKey = shapes.hash.length + shapes.ref.length > 0;
    const shared = [...shapes.hash, ...shapes.ref].some((k) => cashKeysAll.has(nk(kind, k)));
    const reason = !anyKey
      ? "CRM record has no usable key (no-key)"
      : shared
        ? "Key exists in Cashier but amount/status didn't match — likely a different transaction reusing the reference"
        : "No cashier row with a matching key (key-not-found)";
    rows.push(mkRow("unmatched-crm", entityFromBrand(firstVal(cr, [CRM_MAP.entityCol])), undefined,
      "", displayKey(cr), num(fieldVal(cr, CRM_MAP.amountCol)),
      firstVal(cr, [CRM_MAP.currencyCol ?? ""]), crmStatus, "", null, "", "", null, reason));
  });

  // Unmatched cashier
  cashier.rows.forEach((c, i) => {
    if (usedCash.has(i)) return;
    const cashState = firstVal(c, [CASHIER_MAP.statusCol ?? ""]);
    if (isFailed(cashState)) return;
    const kind = cashKindOf(c);
    const shapes = keysByShape(c, CASH_KEYS);
    const shared = [...shapes.hash, ...shapes.ref].some((k) => crmKeysAll.has(nk(kind, k)));
    rows.push(mkRow("unmatched-cashier", entityFromShop(firstVal(c, [CASHIER_MAP.entityCol])),
      undefined, "", "", null, "", "", firstVal(c, CASHIER_MAP.idCols),
      num(fieldVal(c, CASHIER_MAP.amountCol)), firstVal(c, [CASHIER_MAP.currencyCol ?? ""]),
      cashState, null, shared
        ? "Key exists in CRM but amount/status didn't match — likely a different transaction reusing the reference"
        : "In Cashier, no CRM payment with matching key (key-not-found)"));
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
  // Learn shop -> brand from the cashier rows we *could* link to a CRM brand,
  // plus a cashier-id -> shop map. This lets unmatched-cashier rows (which have
  // no CRM counterpart) still get a real brand from their own shop instead of
  // being mislabelled with the jurisdiction/entity name.
  const brandByShop = new Map<string, string>();
  const shopByCashId = new Map<string, string>();
  const brandByCashId = new Map<string, string>();
  cashier?.rows.forEach((c) => {
    const id = firstVal(c, ["ID"]);
    const shop = firstVal(c, ["Shop"]);
    const ref = norm(firstVal(c, ["Reference ID"]));
    const brand = ref ? brandByCrmKey.get(ref) : undefined;
    if (id && shop) shopByCashId.set(id, shop);
    if (id && brand) brandByCashId.set(id, brand);
    if (shop && brand && !brandByShop.has(shop)) brandByShop.set(shop, brand);
  });
  const shopBrand = (cashId: string) => brandByShop.get(shopByCashId.get(cashId) ?? "");
  l1.forEach((r) => {
    // leftId = CRM ref, rightId = cashier id. Prefer the CRM brand; otherwise
    // fall back to the brand of the cashier row's shop — never the entity.
    r.brand = brandByCrmKey.get(norm(r.leftId)) || shopBrand(r.rightId) || "—";
  });
  l2.forEach((r) => {
    r.brand = brandByCashId.get(r.leftId) || shopBrand(r.leftId) || "—";
  });
}

/** Restricts a dataset to rows whose date column falls within [from, to]. */
function filterByDate(ds: Dataset, dateCols: string[], from: string, to: string): Dataset {
  if (!from && !to) return ds;
  const fromT = from ? new Date(from).getTime() : -Infinity;
  const toT = to ? new Date(to + "T23:59:59").getTime() : Infinity;
  const rows = ds.rows.filter((r) => {
    const t = toDate(firstVal(r, dateCols));
    if (t === null) return true; // undated rows kept (can't exclude what we can't parse)
    return t >= fromT && t <= toT;
  });
  return { ...ds, rows };
}

export function runReconciliation(
  crm: Dataset | null,
  cashier: Dataset | null,
  psps: PspConfig[],
  pspData: Record<string, Dataset>,
  nowIso: string,
  opts: ReconOptions = {},
): ReconResult {
  const tolAbs = opts.amountTolAbs ?? 1;
  const tolPct = opts.amountTolPct ?? 0;
  const from = opts.dateFrom ?? "";
  const to = opts.dateTo ?? "";
  const crmF = crm ? filterByDate(crm, ["LastUpdated", "CreatedOn"], from, to) : crm;
  const cashierF = cashier ? filterByDate(cashier, ["Finalized", "Created"], from, to) : cashier;

  const l1Rows = crmF && cashierF ? reconcileLayer1(crmF, cashierF, tolAbs, tolPct) : [];
  // Layer 2 only runs when at least one PSP file is present — otherwise every
  // cashier row would be reported "unmatched" purely for lack of PSP data.
  const hasPspData = Object.values(pspData).some((d) => d && d.rows.length > 0);
  const l2Rows = cashierF && hasPspData ? reconcileLayer2(cashierF, psps, pspData) : [];
  enrichBrands(crmF, cashierF, l1Rows, l2Rows);
  const severity = (s: ReconRow["status"]) =>
    s === "status" ? 0 : s.startsWith("unmatched") ? 1 : s === "amount" ? 2 : 5;
  const sorter = (a: ReconRow, b: ReconRow) => severity(a.status) - severity(b.status);
  l1Rows.sort(sorter);
  l2Rows.sort(sorter);
  const all = [...l1Rows, ...l2Rows];
  const exceptions = all.filter((r) => r.status !== "matched");
  const matched = all.filter((r) => r.status === "matched");
  return {
    layer1: { rows: l1Rows, stats: computeStats(l1Rows) },
    layer2: { rows: l2Rows, stats: computeStats(l2Rows) },
    byPsp: groupBy(l2Rows, (r) => r.psp || "Unrouted"),
    byBrand: groupBy(all, (r) => r.brand),
    byEntity: groupBy(all, (r) => r.entity),
    matrix: buildMatrix(l2Rows),
    exceptions,
    matched,
    ranAt: nowIso,
  };
}
