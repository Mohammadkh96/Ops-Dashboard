import { CASHIER_MAP, CRM_MAP } from "./registry";
import { classifyStatus, type StatusClass } from "./status";
import { buildFamilies, uniqueKeys, normKey, type Families } from "./families";
import { combineVerdict, isInformational, priorityOf } from "./verdict";
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
  const s = String(v).trim();
  // DD.MM.YY[YY] [HH:MM[:SS]] — used by crypto PSP exports and rejected
  // outright by the native parser. Only the DOT separator is handled here:
  // slash dates stay with the native parser because DD/MM vs MM/DD is
  // genuinely ambiguous and guessing would silently corrupt existing sources.
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = new Date(year, Number(m[2]) - 1, Number(m[1]),
      Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  const d = new Date(s);
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
    // ⏭️ informational rows (out of scope, agreed decline, incomplete, PSP file
    // not uploaded) are excluded from the denominator so the match rate
    // measures reconciliation quality, not data volume.
    if (isInformational(r.status)) return;
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

// Route a cashier Provider/Terminal string to a PSP config. Cashier exports
// suffix providers (e.g. "ForumPay_NDP", "MatchTrade_NDP"), so we strip "_ndp"
// and non-alphanumerics, then match against each PSP's routeMatch aliases
// (falling back to id/label).
const canonProvider = (s: string) => s.toLowerCase().replace(/_ndp\b/g, "").replace(/[^a-z0-9]/g, "");
/**
 * Routes a cashier Provider/Terminal string to a PSP config.
 *
 * Entity matters: Paystrax, ForumPay and Match2pay settle separately per
 * entity, so several configs share the same provider aliases and the cashier
 * row's entity (from its Shop) decides which one owns the row. An exact entity
 * match wins, then an "All" config, then anything that matched — so a
 * single-config setup still works.
 */
function routePsp(providerText: string, psps: PspConfig[], entity = ""): PspConfig | null {
  const r = canonProvider(providerText);
  if (!r) return null;
  const hits = psps.filter((p) => {
    const aliases = p.routeMatch?.length ? p.routeMatch : [p.id, p.label];
    return aliases.some((a) => a && r.includes(canonProvider(a)));
  });
  if (!hits.length) return null;
  return (
    (entity && hits.find((p) => p.entity === entity)) ||
    hits.find((p) => p.entity === "All") ||
    hits[0]
  );
}

/**
 * PSP readiness, computed from the cashier file alone (before Layer 2 runs).
 * Lists each Provider seen, its row count, the PSP config it routes to (if
 * any), and whether that PSP's settlement file has been uploaded. Lets the UI
 * tell the user exactly what to upload to switch Layer 2 on.
 */
export function providerCoverage(
  cashier: Dataset | null,
  psps: PspConfig[],
  pspData: Record<string, Dataset>,
): { provider: string; entity: string; count: number; psp: string | null; hasFile: boolean }[] {
  if (!cashier) return [];
  // Group by provider AND entity, because the same provider settles through a
  // different config (and therefore a different file) per entity.
  const counts = new Map<string, { provider: string; entity: string; count: number }>();
  cashier.rows.forEach((c) => {
    const t = firstVal(c, [CASHIER_MAP.typeCol ?? ""]);
    if (t && !/deposit|withdraw|refund/i.test(t)) return; // payment rows only
    const provider = firstVal(c, ["Provider"]) || firstVal(c, ["Terminal"]) || "(unrouted)";
    const entity = entityFromShop(firstVal(c, [CASHIER_MAP.entityCol]));
    const k = `${provider}|${entity}`;
    const e = counts.get(k) ?? { provider, entity, count: 0 };
    e.count++;
    counts.set(k, e);
  });
  return [...counts.values()]
    .sort((a, b) => b.count - a.count)
    .map(({ provider, entity, count }) => {
      const p = provider === "(unrouted)" ? null : routePsp(provider, psps, entity);
      return {
        provider,
        entity,
        count,
        psp: p?.label ?? null,
        hasFile: !!(p && pspData[p.id]?.rows.length),
      };
    });
}

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

// The CRM books in the shop's base currency, so Layer 1 must compare against
// "Amount in Shop Base Currency" and fall back to the transaction amount only
// when it is blank. Layer 2 keeps using the transaction amount, which is the
// basis the PSPs settle and report in.
function cashAmountShopBase(c: Row): number {
  const sb = num(firstVal(c, ["Amount in Shop Base Currency"]));
  return sb || num(fieldVal(c, CASHIER_MAP.amountCol));
}

// Identifier sets used to build payment families (see families.ts).
const crmFamilyKeys = (cr: Row, kind: Kind) =>
  uniqueKeys(
    kind === "withdrawal"
      ? [firstVal(cr, ["Withdrawal Psp Transaction ID"]), firstVal(cr, ["Withdrawal Merchant ID"])]
      : [firstVal(cr, ["Psp Transaction ID"]), firstVal(cr, ["Order No"]), firstVal(cr, ["Merchant Trn Ref"])],
  );
const cashFamilyKeys = (c: Row) =>
  uniqueKeys([firstVal(c, ["Reference ID"]), firstVal(c, ["ID"]), firstVal(c, ["External Id"])]);

// ═══════════════════════════════════════════════════════════
//  LAYER 1 — CRM ↔ CASHIER (unique hash first, then customer ref)
// ═══════════════════════════════════════════════════════════
function reconcileLayer1(crm: Dataset, cashier: Dataset, tolAbs: number, tolPct: number): ReconRow[] {
  const rows: ReconRow[] = [];
  const usedCash = new Set<number>();
  const matchedCrm = new Set<number>();

  const crmKindOf = (cr: Row): Kind => kindFromType(firstVal(cr, [CRM_MAP.typeCol ?? ""]));
  const cashKindOf = (c: Row): Kind => kindFromType(firstVal(c, [CASHIER_MAP.typeCol ?? ""]));

  // Which CRM rows are in scope (deposits & withdrawals only). Internal
  // transfers are book movements with no cashier/PSP leg — they are recorded
  // as Out of Scope rather than silently dropped, so the numbers are auditable
  // without inflating the exception queue.
  const scope: number[] = [];
  const outOfScope: number[] = [];
  crm.rows.forEach((cr, i) => {
    if (crmKindOf(cr)) scope.push(i);
    else if (/internal transfer/i.test(firstVal(cr, [CRM_MAP.typeCol ?? ""]))) outOfScope.push(i);
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
  // Higher score wins. Weights mirror the production Apps Script: a directly
  // shared key dominates, then status agreement, then how close the amounts and
  // timestamps are. Scoring beats "first hit" because a customer's retries all
  // share keys and only one of them is the real counterpart.
  const scorePair = (cr: Row, c: Row): number => {
    let pts = 0;
    const crmAmt = num(fieldVal(cr, CRM_MAP.amountCol));
    const cashAmt = cashAmountShopBase(c);
    const crmC = classifyStatus(firstVal(cr, [CRM_MAP.statusCol ?? ""]), "CRM");
    const cashC = classifyStatus(firstVal(c, [CASHIER_MAP.statusCol ?? ""]), "Cashier");
    const kind = crmKindOf(cr);

    const shared = crmFamilyKeys(cr, kind).some((k) => cashFamilyKeys(c).includes(k));
    if (shared) pts += 5000;

    const crmCust = uniqueKeys([firstVal(cr, ["Customer No"]), firstVal(cr, ["TradingAccount"]), firstVal(cr, ["Email"])]);
    const cashCust = uniqueKeys([
      firstVal(c, ["Customer Account Number"]), firstVal(c, ["Customer Reference ID"]), firstVal(c, ["Customer Email"]),
    ]);
    if (crmCust.some((k) => cashCust.includes(k))) pts += 700;

    if (crmC === "ACTIVE" && cashC === "ACTIVE") pts += 3000;
    else if (crmC === "FAILED" && cashC === "FAILED") pts += 2800;
    else if ((crmC === "ACTIVE" && cashC === "FAILED") || (crmC === "FAILED" && cashC === "ACTIVE")) pts -= 1500;

    const amtDiff = Math.abs(crmAmt - cashAmt);
    if (amtDiff < 0.01) pts += 1200;
    else if (amtDiff < 1) pts += 900;
    else if (amtDiff <= 5) pts += 600;
    else if (amtDiff <= 20) pts += 250;
    else pts -= Math.min(500, amtDiff);

    const mins = minutesBetween(
      firstVal(cr, ["LastUpdated", "CreatedOn"]),
      firstVal(c, ["Finalized", "Updated", "Created"]),
    );
    if (mins <= 60) pts += 350;
    else if (mins <= 1440) pts += 200;
    else if (mins <= 10080) pts += 75;

    return pts;
  };

  const pickBest = (cashIdx: number, cand: Set<number>, requireAmount: boolean): number => {
    const c = cashier.rows[cashIdx];
    const cashAmt = cashAmountShopBase(c);
    let best = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    cand.forEach((ci) => {
      if (matchedCrm.has(ci)) return;
      const cr = crm.rows[ci];
      const crmAmt = num(fieldVal(cr, CRM_MAP.amountCol));
      const amtDiff = Math.abs(crmAmt - cashAmt);
      if (requireAmount) {
        const tol = Math.max(tolAbs, (Math.abs(crmAmt) * tolPct) / 100);
        if (amtDiff > tol) return; // reference + differing amount ≠ same transaction
      }
      const score = scorePair(cr, c);
      if (score > bestScore) {
        bestScore = score;
        best = ci;
      }
    });
    return best;
  };

  // Keys are namespaced by kind ("deposit"\0key / "withdrawal"\0key) so a
  // deposit can only ever match a deposit and a withdrawal/refund a withdrawal.
  const nk = (kind: Kind, key: string) => `${kind} ${key}`;

  const runPass = (which: "hash" | "ref", via: string, requireAmount: boolean) => {
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
      const best = pickBest(cashIdx, cand, requireAmount);
      if (best >= 0) {
        usedCash.add(cashIdx);
        matchedCrm.add(best);
        pairs.push({ crmIdx: best, cashIdx, via });
      }
    });
  };

  // Order matters — most confident first, so a greedy fuzzy pair can't steal a
  // row that belongs to a cleaner match:
  //  1. hash 1:1 (unique transaction id; amount gap is a real discrepancy)
  //  2. reference 1:1 but only when the amount also agrees (confident)
  //  3. aggregation/netting (N CRM legs ↔ M cashier rows summing to the same total)
  //  4. reference 1:1 fallback, amount gap allowed → surfaces genuine single-leg
  //     amount discrepancies as one "amount" exception instead of two unmatched
  runPass("hash", "Txn hash", false);
  runPass("ref", "Customer ref", true);
  aggregatePass();
  runPass("ref", "Customer ref", false);

  // Classify matched pairs through the combined verdict engine, so a pending
  // leg is never mistaken for a pass or a fail.
  pairs.forEach(({ crmIdx, cashIdx, via }) => {
    const cr = crm.rows[crmIdx];
    const c = cashier.rows[cashIdx];
    const crmAmt = num(fieldVal(cr, CRM_MAP.amountCol));
    const crmStatus = firstVal(cr, [CRM_MAP.statusCol ?? ""]);
    const entity = entityFromBrand(firstVal(cr, [CRM_MAP.entityCol]));
    const cashAmt = cashAmountShopBase(c);
    const cashState = firstVal(c, [CASHIER_MAP.statusCol ?? ""]);
    const diff = round(crmAmt - cashAmt);
    const tol = Math.max(tolAbs, (Math.abs(crmAmt) * tolPct) / 100);

    const v = combineVerdict({
      crm: classifyStatus(crmStatus, "CRM"),
      cash: classifyStatus(cashState, "Cashier"),
      psp: "MISSING",
      hasCRM: true,
      hasCash: true,
      hasPSP: false,
      l1diff: diff,
      l2diff: 0,
      tolL1: tol,
      tolL2: Number.POSITIVE_INFINITY,
      crmExpected: true,
      pspExpected: false,
    });

    let note = v.status === "matched" ? `Matched on ${via}` : v.reason;
    // A hash is a unique transaction id, so an amount gap on it is a real
    // discrepancy. A customer reference is reused across a customer's
    // deposits, so flag those for verification.
    if (v.status === "amount" && via === "Customer ref")
      note += " — matched on customer reference, verify (may be different transactions)";

    rows.push(mkRow(v.status, entity, undefined, via, displayKey(cr),
      crmAmt, firstVal(cr, [CRM_MAP.currencyCol ?? ""]), crmStatus,
      firstVal(c, CASHIER_MAP.idCols), cashAmt, firstVal(c, [CASHIER_MAP.currencyCol ?? ""]),
      cashState, diff, note, v.priority));
  });

  // ── Aggregation / netting pass ─────────────────────────────────────────
  // Some flows are booked as ONE cashier movement but SEVERAL CRM legs sharing
  // the same transaction reference (or vice-versa) — e.g. a $122.99 withdrawal
  // recorded in the CRM as $31.02 + $91.97. The 1:1 passes can't pair those, so
  // they'd surface as N+M separate exceptions. Here we group the still-unmatched
  // rows by shared transaction key (kind-namespaced) and, when the totals on
  // each side reconcile within tolerance, net them into a single matched line.
  // Only transaction-level keys are used (the customer-level key was dropped),
  // so rows sharing a key genuinely belong to the same movement.
  function aggregatePass() {
    const grp = new Map<string, { crm: Set<number>; cash: Set<number> }>();
    const bucket = (kk: string) => {
      const g = grp.get(kk) ?? { crm: new Set<number>(), cash: new Set<number>() };
      grp.set(kk, g);
      return g;
    };
    scope.forEach((ci) => {
      if (matchedCrm.has(ci)) return;
      const cr = crm.rows[ci];
      if (isFailed(firstVal(cr, [CRM_MAP.statusCol ?? ""]))) return;
      const kind = crmKindOf(cr);
      const s = keysByShape(cr, crmKeyCols(kind));
      [...s.hash, ...s.ref].forEach((k) => bucket(nk(kind, k)).crm.add(ci));
    });
    cashier.rows.forEach((c, ci) => {
      if (usedCash.has(ci)) return;
      const kind = cashKindOf(c);
      if (!kind || isFailed(firstVal(c, [CASHIER_MAP.statusCol ?? ""]))) return;
      const s = keysByShape(c, CASH_KEYS);
      [...s.hash, ...s.ref].forEach((k) => bucket(nk(kind, k)).cash.add(ci));
    });
    grp.forEach((g) => {
      const crmIdxs = [...g.crm].filter((i) => !matchedCrm.has(i));
      const cashIdxs = [...g.cash].filter((i) => !usedCash.has(i));
      if (!crmIdxs.length || !cashIdxs.length) return;
      if (crmIdxs.length === 1 && cashIdxs.length === 1) return; // pure 1:1 belongs to the 1:1 passes
      const crmSum = round(crmIdxs.reduce((s, i) => s + num(fieldVal(crm.rows[i], CRM_MAP.amountCol)), 0));
      const cashSum = round(cashIdxs.reduce((s, i) => s + cashAmountShopBase(cashier.rows[i]), 0));
      const tol = Math.max(tolAbs, (Math.abs(cashSum) * tolPct) / 100);
      if (Math.abs(crmSum - cashSum) > tol) return; // totals don't reconcile → leave for unmatched reporting
      crmIdxs.forEach((i) => matchedCrm.add(i));
      cashIdxs.forEach((i) => usedCash.add(i));
      const cr0 = crm.rows[crmIdxs[0]];
      const c0 = cashier.rows[cashIdxs[0]];
      rows.push(mkRow("matched", entityFromBrand(firstVal(cr0, [CRM_MAP.entityCol])), undefined,
        "Aggregated", `${crmIdxs.length}× ${displayKey(cr0)}`, crmSum,
        firstVal(cr0, [CRM_MAP.currencyCol ?? ""]), firstVal(cr0, [CRM_MAP.statusCol ?? ""]),
        `${cashIdxs.length}× ${firstVal(c0, CASHIER_MAP.idCols)}`, cashSum,
        firstVal(c0, [CASHIER_MAP.currencyCol ?? ""]), firstVal(c0, [CASHIER_MAP.statusCol ?? ""]),
        round(crmSum - cashSum),
        `Netted ${crmIdxs.length} CRM ↔ ${cashIdxs.length} Cashier on ${displayKey(cr0)} (Σ ${crmSum})`));
    });
  }

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
    // A settled decline with no counterpart is an agreed decline, not a break.
    // A PENDING leg is NOT a decline, so it still surfaces below.
    if (classifyStatus(crmStatus, "CRM") === "FAILED") return;
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
    const cashClass = classifyStatus(cashState, "Cashier");
    if (cashClass === "FAILED") return;
    const kind = cashKindOf(c);
    // A refund is money returning to the customer; the CRM books it as a
    // withdrawal, but a refund with no CRM leg is not automatically a break.
    const isRefund = /refund/i.test(firstVal(c, [CASHIER_MAP.typeCol ?? ""]));
    const shapes = keysByShape(c, CASH_KEYS);
    const shared = [...shapes.hash, ...shapes.ref].some((k) => crmKeysAll.has(nk(kind, k)));
    // Only a COMPLETED cashier row with no CRM record is a P1 gap — money left
    // the account and the platform has no record of it. A row that never
    // settled AND was never booked in the CRM is an abandoned attempt, not a
    // discrepancy: nothing was approved, nothing was declined, and no money is
    // confirmed to have moved. It is recorded but folded out of the queue.
    const status: ReconRow["status"] = cashClass === "ACTIVE" ? "unmatched-cashier" : "incomplete";
    const reason =
      cashClass !== "ACTIVE"
        ? `Never settled (${cashState || "unknown"}) and never booked in the CRM — abandoned attempt`
        : shared
          ? "Key exists in CRM but amount/status didn't match — likely a different transaction reusing the reference"
          : isRefund
            ? "Completed refund with no CRM withdrawal — verify it was authorised"
            : "In Cashier, no CRM payment with matching key (key-not-found)";
    rows.push(mkRow(status, entityFromShop(firstVal(c, [CASHIER_MAP.entityCol])),
      undefined, "", "", null, "", "", firstVal(c, CASHIER_MAP.idCols),
      cashAmountShopBase(c), firstVal(c, [CASHIER_MAP.currencyCol ?? ""]),
      cashState, null, reason));
  });

  // Internal transfers — recorded, but out of scope for payment reconciliation.
  outOfScope.forEach((crmIdx) => {
    const cr = crm.rows[crmIdx];
    rows.push(mkRow("out-of-scope", entityFromBrand(firstVal(cr, [CRM_MAP.entityCol])), undefined,
      "", displayKey(cr), num(fieldVal(cr, CRM_MAP.amountCol)),
      firstVal(cr, [CRM_MAP.currencyCol ?? ""]), firstVal(cr, [CRM_MAP.statusCol ?? ""]),
      "", null, "", "", null,
      "Internal transfer to/from a trading account — an internal book movement with no cashier or PSP counterpart"));
  });

  // ── Blind-spot exceptions ───────────────────────────────────────────────
  // The 1:1 grid can only report on pairs it formed. These are the cases it
  // structurally cannot see: a whole family of cashier attempts that all
  // failed while the CRM says approved. Anchored on payment families so a
  // successful retry anywhere in the chain correctly suppresses the flag.
  rows.push(...familyBlindSpots(crm, cashier, scope, crmKindOf, cashKindOf));

  return rows;
}

/**
 * Family-level status conflicts. For each linked family of identifiers, if the
 * CRM has an ACTIVE row but NO cashier attempt in that family succeeded, that
 * is a real discrepancy the pairwise grid misses (it would have matched the
 * CRM row to one failed attempt and reported a single mismatch, or nothing).
 */
function familyBlindSpots(
  crm: Dataset,
  cashier: Dataset,
  scope: number[],
  crmKindOf: (r: Row) => Kind,
  cashKindOf: (r: Row) => Kind,
): ReconRow[] {
  const out: ReconRow[] = [];
  const groups: string[][] = [];
  scope.forEach((i) => groups.push(crmFamilyKeys(crm.rows[i], crmKindOf(crm.rows[i]))));
  cashier.rows.forEach((c) => {
    if (cashKindOf(c)) groups.push(cashFamilyKeys(c));
  });
  const fam: Families = buildFamilies(groups);

  const crmByFam = new Map<string, number[]>();
  scope.forEach((i) => {
    const id = fam.idForKeys(crmFamilyKeys(crm.rows[i], crmKindOf(crm.rows[i])));
    if (!id) return;
    const arr = crmByFam.get(id) ?? [];
    arr.push(i);
    crmByFam.set(id, arr);
  });
  const cashByFam = new Map<string, Row[]>();
  cashier.rows.forEach((c) => {
    if (!cashKindOf(c)) return;
    const id = fam.idForKeys(cashFamilyKeys(c));
    if (!id) return;
    const arr = cashByFam.get(id) ?? [];
    arr.push(c);
    cashByFam.set(id, arr);
  });

  crmByFam.forEach((crmIdxs, id) => {
    const cashRows = cashByFam.get(id) ?? [];
    if (!cashRows.length) return; // no cashier leg at all — already reported as unmatched
    const activeCrm = crmIdxs
      .map((i) => crm.rows[i])
      .filter((r) => classifyStatus(firstVal(r, [CRM_MAP.statusCol ?? ""]), "CRM") === "ACTIVE");
    if (!activeCrm.length) return;
    // A success anywhere in the family means the retry chain settled fine.
    const anySuccess = cashRows.some(
      (c) => classifyStatus(firstVal(c, [CASHIER_MAP.statusCol ?? ""]), "Cashier") === "ACTIVE",
    );
    if (anySuccess) return;
    const failed = cashRows.filter(
      (c) => classifyStatus(firstVal(c, [CASHIER_MAP.statusCol ?? ""]), "Cashier") === "FAILED",
    );
    if (!failed.length) return; // all unresolved — covered by needs-review above
    const cr = activeCrm[0];
    const c = failed[0];
    const crmAmt = num(fieldVal(cr, CRM_MAP.amountCol));
    const cashAmt = cashAmountShopBase(c);
    out.push(mkRow("status", entityFromShop(firstVal(c, [CASHIER_MAP.entityCol])), undefined,
      `Family: ${fam.keysFor(crmFamilyKeys(cr, crmKindOf(cr))).slice(0, 3).join(" ↔ ")}`,
      firstVal(cr, CRM_MAP.idCols), crmAmt, firstVal(cr, [CRM_MAP.currencyCol ?? ""]),
      firstVal(cr, [CRM_MAP.statusCol ?? ""]), firstVal(c, CASHIER_MAP.idCols), cashAmt,
      firstVal(c, [CASHIER_MAP.currencyCol ?? ""]), firstVal(c, [CASHIER_MAP.statusCol ?? ""]),
      round(crmAmt - cashAmt),
      `CRM is approved but every cashier attempt in this linked family failed (${cashRows.length} attempt(s), none successful)`,
      "P1"));
  });

  return out;
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

  // Which PSP does a cashier row route to? The row's entity picks the correct
  // per-entity config (see routePsp).
  const routeToPsp = (c: Row): PspConfig | null =>
    routePsp(
      `${firstVal(c, ["Provider"])} ${firstVal(c, ["Terminal"])}`,
      psps,
      entityFromShop(firstVal(c, [CASHIER_MAP.entityCol])),
    );

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
      const cashClass = classifyStatus(cashState, "Cashier");
      const routed = !!(firstVal(c, ["Provider"]) || firstVal(c, ["Terminal"]));
      if (cashClass === "FAILED" && routed) return; // failed at a known PSP → expected noise
      // A row with no Provider and no Terminal never reached a PSP, so there is
      // no PSP leg to reconcile it against. Cancelled/declined before routing is
      // recorded but not an exception. A COMPLETED row that never routed is
      // genuinely odd, so that one stays in the queue.
      if (!routed && cashClass !== "ACTIVE") {
        rows.push(mkRow("out-of-scope", entity, undefined, "", cashId, cashAmt,
          firstVal(c, [CASHIER_MAP.currencyCol ?? ""]), cashState, "", null, "", "", null,
          `Never routed to a PSP (${cashState || "not final"} before routing) — no PSP leg exists`));
        return;
      }
      // The row routes to a known PSP but that PSP's settlement file was never
      // uploaded. That is missing input, not a reconciliation break — flagging
      // it as unmatched would blame the data for the operator's omission.
      const routedButNoFile = cfg && !(pspData[cfg.id]?.rows.length);
      if (routedButNoFile) {
        rows.push(mkRow("not-reconciled", entity, cfg.label, "", cashId, cashAmt,
          firstVal(c, [CASHIER_MAP.currencyCol ?? ""]), cashState, "", null, "", "", null,
          `The ${cfg.label} settlement file was not uploaded — excluded from PSP matching and KPIs`));
        return;
      }
      rows.push(mkRow("unmatched-cashier", entity, pspName, "", cashId, cashAmt,
        firstVal(c, [CASHIER_MAP.currencyCol ?? ""]), cashState, "", null, "", "", null,
        "In Cashier, no PSP match"));
      return;
    }

    usedPsp[matched.id].add(rowIndexOf[matched.id].get(matchRow)!);
    const pspAmt = num(fieldVal(matchRow, matched.fields.amountCol));
    const pspStatus = fieldVal(matchRow, matched.fields.statusCol);
    const diff = round(cashAmt - pspAmt);

    const v = combineVerdict({
      crm: "MISSING",
      cash: classifyStatus(cashState, "Cashier"),
      psp: classifyStatus(pspStatus, matched.label, matched),
      hasCRM: false,
      hasCash: true,
      hasPSP: true,
      l1diff: 0,
      l2diff: diff,
      tolL1: Number.POSITIVE_INFINITY,
      tolL2: matched.amountTolerance,
      crmExpected: false,
      pspExpected: true,
    });
    const note = v.status === "matched" ? matchKey : `${v.reason} — ${matchKey}`;

    rows.push(mkRow(v.status, entity, matched.label, matchKey, cashId, cashAmt,
      firstVal(c, [CASHIER_MAP.currencyCol ?? ""]), cashState,
      fieldVal(matchRow, matched.fields.idCols[0]), pspAmt,
      fieldVal(matchRow, matched.fields.currencyCol), pspStatus, diff, note, v.priority));
  });

  // PSP rows never matched to a cashier row
  psps.forEach((p) => {
    const ds = pspData[p.id];
    if (!ds) return;
    ds.rows.forEach((pr, i) => {
      if (usedPsp[p.id].has(i)) return;
      const st = fieldVal(pr, p.fields.statusCol);
      if (classifyStatus(st, p.label, p) === "FAILED") return;
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
  diff: number | null, note: string, priority?: string,
): ReconRow {
  return { status, priority: priority ?? priorityOf(status), entity, brand: "", psp, matchKey,
    leftId, leftAmount, leftCurrency, leftStatus,
    rightId, rightAmount, rightCurrency, rightStatus, diff, note,
    caseKey: [psp || "L1", entity, leftId, rightId, status].map((x) => String(x ?? "").trim()).join("|") };
}

/** Generic dimensional breakdown (PSP, brand, entity — driven by the key fn). */
function groupBy(rows: ReconRow[], keyOf: (r: ReconRow) => string): Breakdown[] {
  const m = new Map<string, Breakdown>();
  rows.forEach((r) => {
    if (isInformational(r.status)) return; // ⏭️ rows never move a match rate
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
  // Sort by priority (P1 first), then by money at risk — the Action-Center
  // ordering: what to work on now, biggest exposure first.
  const exposureOf = (r: ReconRow) =>
    Math.max(Math.abs(r.diff ?? 0), Math.abs(r.leftAmount ?? 0), Math.abs(r.rightAmount ?? 0));
  const sorter = (a: ReconRow, b: ReconRow) =>
    a.priority.localeCompare(b.priority) || exposureOf(b) - exposureOf(a);
  l1Rows.sort(sorter);
  l2Rows.sort(sorter);
  const all = [...l1Rows, ...l2Rows];
  const exceptions = all.filter((r) => r.status !== "matched" && !isInformational(r.status));
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
