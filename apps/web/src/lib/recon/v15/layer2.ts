// Layer 2 — Cashier ↔ PSP, ported from the Apps Script.
//
// Two passes, and the order is the whole design:
//
//   Pass 1  EXACT. An identifier the cashier holds equals an identifier the PSP
//           holds. Certain, so it runs first and consumes the row.
//   Pass 2  FUZZY. Only what Pass 1 could not place, matched on amount + time
//           and — where the files carry one — a customer identifier.
//
// A fuzzy match without an identifier is a guess. The script says so plainly
// about Paystrax: with Email dropped from the export and ShopperId shipped
// empty, amount+time alone would pair two customers who happened to pay the
// same figure inside the window. That is why blind matching is a flag that
// defaults to off, and why those rows are reported unmatched instead — the
// correct outcome, not a defect.

import type { PspConfig, Row } from "../types";
import {
  cashierAmount, cashierCurrency, diffDays, diffMinutes, entityFromShop,
  extractJson, normalizeKey, num, round, typesMatch, v,
} from "./values";
import { bothFailed, isAmbiguousStatus, isFailedStatus, isStatusMismatch } from "./status";

/**
 * Paystrax fuzzy matching needs a customer identifier present in BOTH files.
 * Turning this on pairs on amount and time ALONE — two customers paying the same
 * figure inside the window will be matched to each other. Leave it off unless
 * reconciling a low-volume period by hand.
 */
export const PAYSTRAX_ALLOW_BLIND_FUZZY = false;
const PAYSTRAX_BLIND_WINDOW_MINS = 15;

export type L2Row = {
  matchStatus: string;
  entity: string;
  pspName: string;
  matchKey: string;
  cashierId: string;
  cashierAmount: number | null;
  cashierCurrency: string;
  cashierState: string;
  cashierType: string;
  cashierProvider: string;
  cashierShop: string;
  cashierDate: string;
  pspTxId: string;
  pspAmount: number | null;
  pspCurrency: string;
  pspStatus: string;
  pspType: string;
  pspDate: string;
  amountDifference: number | null;
  notes: string;
};

const field = (row: Row, spec: string | undefined): string => {
  if (!spec) return "";
  return v(row, ...spec.split(",").map((x) => x.trim()));
};

/** A PSP row's status, honouring exports that record a timestamp not a word. */
function pspStatusOf(row: Row, cfg: PspConfig): string {
  const sw = cfg.statusWhenSet;
  if (sw) {
    if (sw.active && field(row, sw.active)) return "Confirmed";
    if (sw.failed && field(row, sw.failed)) return "Cancelled";
    return "Pending";
  }
  return field(row, cfg.fields.statusCol);
}

const pspAmountOf = (row: Row, cfg: PspConfig) => num(field(row, cfg.fields.amountCol));
const pspIdOf = (row: Row, cfg: PspConfig) =>
  v(row, ...cfg.fields.idCols) || field(row, cfg.fields.idCols[0]);

/** Every id column value, so one row is reachable by any of its identifiers. */
function indexPsp(rows: Row[], cfg: PspConfig): Map<string, Row[]> {
  const idx = new Map<string, Row[]>();
  rows.forEach((row) => {
    cfg.fields.idCols.forEach((col) => {
      const key = normalizeKey(v(row, col));
      if (!key) return;
      const list = idx.get(key) ?? [];
      list.push(row);
      idx.set(key, list);
    });
  });
  return idx;
}

/** `routePsp` — provider/terminal text decides which config owns a row. */
function routePsp(providerText: string, psps: PspConfig[], entity: string): PspConfig | null {
  const t = providerText.toLowerCase();
  const candidates = psps.filter((p) => {
    const aliases = (p.routeMatch?.length ? p.routeMatch : [p.id, p.label]).map((x) =>
      String(x).toLowerCase(),
    );
    return aliases.some((a) => a && t.includes(a));
  });
  if (!candidates.length) return null;
  return (
    candidates.find((p) => p.entity === entity) ??
    candidates.find((p) => p.entity === "All") ??
    candidates[0]
  );
}

type Match = { cfg: PspConfig; row: Row; key: string; matchKey: string; note: string };

export function reconcileCashierVsPsps(
  cashier: Row[],
  psps: PspConfig[],
  pspData: Record<string, Row[]>,
  /** Configs whose file was uploaded for this period. Others cannot be matched. */
  uploaded: ReadonlySet<string>,
): L2Row[] {
  // Only payment-bearing rows participate.
  const scope = cashier.filter((r) => {
    const t = v(r, "Type").toLowerCase();
    return t.includes("deposit") || t.includes("withdraw") || t.includes("refund");
  });

  const indexes = new Map<string, Map<string, Row[]>>();
  const used = new Map<string, Set<string>>();
  psps.forEach((p) => {
    indexes.set(p.id, indexPsp(pspData[p.id] ?? [], p));
    used.set(p.id, new Set<string>());
  });

  const cashierById = new Map<string, Row>();
  cashier.forEach((r) => {
    const id = v(r, "ID");
    if (id) cashierById.set(id, r);
  });

  /**
   * `_vpayTxKeyForCashier_` — a refund carries no provider key of its own, so it
   * inherits one from the parent deposit, walking up at most three links.
   */
  const vpayKeyFor = (row: Row, depth = 0): string => {
    if (!row || depth > 3) return "";
    const refs = v(row, "External Refs");
    const key = extractJson(refs, "authenticateRequestId") || extractJson(refs, "requestId");
    if (key) return key;
    const parent = v(row, "Parent Payment Id");
    const parentRow = parent ? cashierById.get(parent) : undefined;
    return parentRow ? vpayKeyFor(parentRow, depth + 1) : "";
  };

  const matches = new Map<number, Match>();

  const claim = (cfg: PspConfig, row: Row, matchKey: string, note: string): Match | null => {
    const key = normalizeKey(pspIdOf(row, cfg));
    const set = used.get(cfg.id) as Set<string>;
    if (!key || set.has(key)) return null;
    set.add(key);
    return { cfg, row, key, matchKey, note };
  };

  // ── PASS 1 — exact ──
  scope.forEach((c, i) => {
    const cashId = v(c, "ID");
    const extId = v(c, "External Id");
    const refs = v(c, "External Refs");
    const cashType = v(c, "Type");
    const isRefund = cashType.toLowerCase().includes("refund");
    const entity = entityFromShop(v(c, "Shop"));

    // Candidate identifiers the cashier row can be known by, in the script's
    // order of confidence.
    const candidates: Array<{ value: string; label: string }> = [
      { value: extId, label: "External Id" },
      { value: cashId, label: "Cashier ID" },
      { value: extractJson(refs, "webhookPaymentId"), label: "webhookPaymentId" },
      { value: extractJson(refs, "requestId"), label: "requestId" },
      { value: extractJson(refs, "authenticateRequestId"), label: "authenticateRequestId" },
    ].filter((x) => x.value);

    // Prefer the PSP this row was routed to; fall back to any, because an
    // exact identifier match is evidence regardless of routing text.
    const routed = routePsp(`${v(c, "Provider")} ${v(c, "Terminal")}`, psps, entity);
    const order = routed ? [routed, ...psps.filter((p) => p.id !== routed.id)] : psps;

    for (const cfg of order) {
      if (!uploaded.has(cfg.id)) continue;
      const idx = indexes.get(cfg.id);
      if (!idx) continue;

      // VirtualPay refunds are keyed by the PARENT deposit's provider key, and
      // one deposit can carry several partial refunds against the same number —
      // so the leg is chosen by amount, not by first-available.
      if (isRefund && cfg.id.startsWith("virtualpay")) {
        const key = normalizeKey(vpayKeyFor(c));
        const rows = key ? (idx.get(key) ?? []) : [];
        const want = cashierAmount(c);
        const set = used.get(cfg.id) as Set<string>;
        const byAmount = rows.find(
          (r) =>
            !set.has(normalizeKey(pspIdOf(r, cfg))) &&
            Math.abs(pspAmountOf(r, cfg) - want) <= 0.05,
        );
        const anyFree = rows.find((r) => !set.has(normalizeKey(pspIdOf(r, cfg))));
        const picked = byAmount ?? anyFree;
        if (picked) {
          const m = claim(
            cfg, picked,
            "Exact: VP Tx# (via Parent Payment Id) = Refund Report Transaction Number",
            "Exact — refund leg chosen by amount",
          );
          if (m) {
            matches.set(i, m);
            return;
          }
        }
        continue;
      }

      for (const cand of candidates) {
        const rows = idx.get(normalizeKey(cand.value)) ?? [];
        if (!rows.length) continue;
        const set = used.get(cfg.id) as Set<string>;
        const picked =
          rows.find(
            (r) =>
              !set.has(normalizeKey(pspIdOf(r, cfg))) &&
              typesMatch(cashType, field(r, cfg.fields.typeCol), cfg.label),
          ) ?? rows.find((r) => !set.has(normalizeKey(pspIdOf(r, cfg))));
        if (!picked) continue;
        const m = claim(cfg, picked, `Exact: ${cand.label} = ${cfg.label} id`, "Exact");
        if (m) {
          matches.set(i, m);
          return;
        }
      }
    }
  });

  // ── PASS 2 — fuzzy fallback, routed rows only ──
  scope.forEach((c, i) => {
    if (matches.has(i)) return;

    const entity = entityFromShop(v(c, "Shop"));
    const routeText = `${v(c, "Provider")} ${v(c, "Terminal")}`;
    const cfg = routePsp(routeText, psps, entity);
    if (!cfg || !uploaded.has(cfg.id)) return;

    const rows = pspData[cfg.id] ?? [];
    if (!rows.length) return;

    const cashType = v(c, "Type");
    const want = cashierAmount(c);
    const cashDate = v(c, "Finalized", "Updated", "Created");
    const cashEmail = v(c, "Customer Email").toLowerCase();
    const cashCustomer = normalizeKey(v(c, "Customer Reference ID"));
    const set = used.get(cfg.id) as Set<string>;

    const isPaystrax = /paystrax/i.test(cfg.label);
    const isForum = /forum/i.test(cfg.label);
    const isMatch2pay = /match2pay/i.test(cfg.label);
    const window = cfg.dateWindowMins || 240;

    let best: Row | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    rows.forEach((r) => {
      const key = normalizeKey(pspIdOf(r, cfg));
      if (!key || set.has(key)) return;
      if (!typesMatch(cashType, field(r, cfg.fields.typeCol), cfg.label)) return;

      const amtDiff = Math.abs(pspAmountOf(r, cfg) - want);
      const pspEmail = v(r, "Email").toLowerCase();
      const pspShopper = normalizeKey(v(r, "ShopperId", "payer id"));

      let identified = false;
      if (cashEmail && pspEmail) identified = pspEmail === cashEmail;
      else if (cashCustomer && pspShopper) identified = pspShopper === cashCustomer;

      // Match2pay settles on a daily cycle, so it is compared in days.
      const timeDiff = isMatch2pay
        ? diffDays(cashDate, field(r, cfg.fields.dateCol))
        : diffMinutes(cashDate, field(r, cfg.fields.dateCol));
      const timeLimit = isMatch2pay ? 3 : window;

      if (identified) {
        if (amtDiff <= Math.max(cfg.amountTolerance, 0.5) && timeDiff <= timeLimit) {
          const s = amtDiff + timeDiff / 1000 - 100; // identity outweighs everything
          if (s < bestScore) {
            best = r;
            bestScore = s;
          }
        }
        return;
      }

      // No shared identifier. Paystrax refuses to guess unless explicitly told
      // to; the others accept a tight amount+time match.
      if (isPaystrax) {
        if (!PAYSTRAX_ALLOW_BLIND_FUZZY) return;
        if (amtDiff < 0.01 && timeDiff <= PAYSTRAX_BLIND_WINDOW_MINS) {
          const s = 100 + timeDiff / 1000;
          if (s < bestScore) {
            best = r;
            bestScore = s;
          }
        }
        return;
      }

      const tolerance = isForum ? 2 : cfg.amountTolerance;
      if (amtDiff <= tolerance && timeDiff <= timeLimit) {
        const s = amtDiff * 100 + timeDiff / 60;
        if (s < bestScore) {
          best = r;
          bestScore = s;
        }
      }
    });

    if (best) {
      const m = claim(
        cfg, best,
        identityLabel(cashEmail, cashCustomer, isPaystrax),
        "Fallback",
      );
      if (m) matches.set(i, m);
    }
  });

  // ── PASS 3 — build the rows ──
  const out: L2Row[] = [];

  scope.forEach((c, i) => {
    const entity = entityFromShop(v(c, "Shop"));
    const cashId = v(c, "ID");
    const cashAmt = cashierAmount(c);
    const cashCur = cashierCurrency(c);
    const cashState = v(c, "State");
    const cashType = v(c, "Type");
    const provider = v(c, "Provider");
    const terminal = v(c, "Terminal");
    const m = matches.get(i);

    const base = {
      entity,
      cashierId: cashId,
      cashierAmount: cashAmt,
      cashierCurrency: cashCur,
      cashierState: cashState,
      cashierType: cashType,
      cashierProvider: provider,
      cashierShop: v(c, "Shop"),
      cashierDate: v(c, "Finalized", "Updated", "Created"),
    };

    if (!m) {
      const routed = routePsp(`${provider} ${terminal}`, psps, entity);

      if (!provider && !terminal) {
        // Never routed: nothing exists to reconcile against.
        out.push({
          ...base, matchStatus: "⏭️ Out of Scope", pspName: "No PSP (Cancelled/Declined)",
          matchKey: "", pspTxId: "", pspAmount: null, pspCurrency: "", pspStatus: "",
          pspType: "", pspDate: "", amountDifference: null,
          notes: "Empty Provider and Terminal — cancelled before routing.",
        });
        return;
      }

      if (routed && !uploaded.has(routed.id)) {
        // The provider's file is missing, so this row was never eligible. Saying
        // "unmatched" would blame the data for an upload that never happened.
        out.push({
          ...base, matchStatus: "⏭️ Not Reconciled", pspName: routed.label, matchKey: "",
          pspTxId: "", pspAmount: null, pspCurrency: "", pspStatus: "", pspType: "",
          pspDate: "", amountDifference: null,
          notes:
            `The ${routed.label} source file was not uploaded for this period. This transaction ` +
            "was excluded from PSP matching and from the match rate.",
        });
        return;
      }

      // Routed, file present, still nothing: a declined row here moved no money.
      if (isFailedStatus(cashState, "Cashier")) return;

      out.push({
        ...base, matchStatus: "❌ Unmatched Cashier",
        pspName: routed?.label ?? "Unknown PSP", matchKey: "",
        pspTxId: "", pspAmount: null, pspCurrency: "", pspStatus: "", pspType: "",
        pspDate: "", amountDifference: null,
        notes: routed
          ? "No matching row in the provider file."
          : `Provider/Terminal not recognised: ${provider}/${terminal}`,
      });
      return;
    }

    const pspStatus = pspStatusOf(m.row, m.cfg);
    const pspAmt = pspAmountOf(m.row, m.cfg);
    const diff = round(cashAmt - pspAmt);
    let status: string;
    let note = m.note;

    if (bothFailed(cashState, "Cashier", pspStatus, m.cfg.label)) {
      // Kept visible rather than deleted: discarding it made the row vanish from
      // the grid and reappear in the leak pass as "dropped" with no PSP leg, so
      // the provider row count stopped tying out.
      status = "⏭️ Agreed Decline";
      note = `${note} | Both sides declined — Cashier: ${cashState || "unknown"}, PSP: ${pspStatus || "unknown"}. No money moved.`;
    } else if (isStatusMismatch(cashState, "Cashier", pspStatus, m.cfg.label)) {
      status = "⚠️ Status Mismatch";
      note = `${note} | Cashier: ${cashState || "unknown"} vs PSP: ${pspStatus || "unknown"}`;
    } else if (
      isAmbiguousStatus(cashState, "Cashier") || isAmbiguousStatus(pspStatus, m.cfg.label)
    ) {
      // Without this branch an unmapped code with a clean amount reports as
      // Matched — agreement asserted where neither side gave a final answer.
      status = "⚠️ Needs Review";
      note = `${note} | Non-final or unrecognised status — Cashier: ${cashState || "unknown"} vs PSP: ${pspStatus || "unknown"}`;
    } else if (Math.abs(diff) > m.cfg.amountTolerance) {
      status = "⚠️ Amount Mismatch";
      note = `${note} | Diff: ${diff}`;
    } else {
      status = "✅ Matched";
    }

    out.push({
      ...base,
      matchStatus: status,
      pspName: m.cfg.label,
      matchKey: m.matchKey,
      pspTxId: pspIdOf(m.row, m.cfg),
      pspAmount: pspAmt,
      pspCurrency: field(m.row, m.cfg.fields.currencyCol),
      pspStatus,
      pspType: field(m.row, m.cfg.fields.typeCol),
      pspDate: field(m.row, m.cfg.fields.dateCol),
      amountDifference: diff,
      notes: note,
    });
  });

  // ── PSP rows never matched to a cashier row ──
  psps.forEach((cfg) => {
    if (!uploaded.has(cfg.id)) return;
    const set = used.get(cfg.id) as Set<string>;
    (pspData[cfg.id] ?? []).forEach((r) => {
      const key = normalizeKey(pspIdOf(r, cfg));
      if (!key || set.has(key)) return;
      const status = pspStatusOf(r, cfg);
      // A declined provider row with no cashier counterpart moved no money.
      if (isFailedStatus(status, cfg.label)) return;
      out.push({
        matchStatus: "❌ Unmatched PSP",
        entity: cfg.entity === "All" ? "" : cfg.entity,
        pspName: cfg.label,
        matchKey: "",
        cashierId: "", cashierAmount: null, cashierCurrency: "", cashierState: "",
        cashierType: "", cashierProvider: "", cashierShop: "", cashierDate: "",
        pspTxId: pspIdOf(r, cfg),
        pspAmount: pspAmountOf(r, cfg),
        pspCurrency: field(r, cfg.fields.currencyCol),
        pspStatus: status,
        pspType: field(r, cfg.fields.typeCol),
        pspDate: field(r, cfg.fields.dateCol),
        amountDifference: null,
        notes: `In ${cfg.label} but not in Cashier`,
      });
    });
  });

  return out;
}

function identityLabel(email: string, customer: string, isPaystrax: boolean): string {
  if (email) return "Fallback: email + amount + time";
  if (customer) return "Fallback: customer ref + amount + time";
  return isPaystrax ? "Fallback: amount + time (blind)" : "Fallback: amount + time";
}
