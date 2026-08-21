// Layer 1 — CRM ↔ Cashier, ported from the Apps Script.
//
// Five passes, in this order and for these reasons:
//
//   A. Deposits      family matching, settled successes first
//   B. Withdrawals   several CRM legs aggregated against one Paymaxis gross row
//   C. Internal      transfers: out of scope, not a problem
//   D. Other types   surfaced only when not already failed
//   E. Leftover      cashier rows nothing claimed
//
// The withdrawal pass is the one that is easy to get wrong. The CRM books a
// withdrawal as separate legs — the net amount and the commission/fee — while
// Paymaxis books one gross row. Comparing leg-by-leg reports a mismatch on
// every single withdrawal; the legs have to be summed first.

import type { Row } from "../types";
import {
  ENTITY, cashierAmountShopBase, cashierCurrency, entityFromBrand, entityFromShop,
  normalizeKey, num, round, v,
} from "./values";
import {
  bothFailed, isAmbiguousStatus, isFailedStatus, isStatusMismatch,
} from "./status";
import {
  buildDepositFamilies, cashierDepositKeys, crmDepositKeys, crmProcessingPriority,
  indexByFamily, pickBestCashierForCrm, pickCashier,
} from "./families";

/** One Layer-1 result row, mirroring the script's 22-column RECON1 layout. */
export type L1Row = {
  matchStatus: string;
  entity: string;
  matchKey: string;
  crmCustomer: string;
  crmAmount: number | null;
  crmCurrency: string;
  crmStatus: string;
  crmType: string;
  crmOrderNo: string;
  crmPspTxId: string;
  crmBrand: string;
  crmDate: string;
  cashierId: string;
  cashierAmount: number | null;
  cashierCurrency: string;
  cashierState: string;
  cashierType: string;
  cashierReference: string;
  cashierProvider: string;
  cashierShop: string;
  amountDifference: number | null;
  notes: string;
};

const crmTypeOf = (r: Row) => String(v(r, "TransactionType", "Transaction Type")).toUpperCase();

function crmOnlyRow(
  matchStatus: string, r: Row, typeLabel: string, matchKey: string, note: string,
): L1Row {
  return {
    matchStatus,
    entity: entityFromBrand(v(r, "Brand Title", "Brand")),
    matchKey,
    crmCustomer: normalizeKey(v(r, "Customer No")),
    crmAmount: num(v(r, "Amount")),
    crmCurrency: v(r, "Currency"),
    crmStatus: v(r, "TransactionStatus Name", "Status"),
    crmType: typeLabel,
    crmOrderNo: v(r, "Order No", "PSP Order No"),
    crmPspTxId: v(r, "Psp Transaction ID", "PSP Transcaction ID"),
    crmBrand: v(r, "Brand Title", "Brand"),
    crmDate: v(r, "LastUpdated", "Last Updated", "CreatedOn", "Created On"),
    cashierId: "", cashierAmount: null, cashierCurrency: "", cashierState: "",
    cashierType: "", cashierReference: "", cashierProvider: "", cashierShop: "",
    amountDifference: null,
    notes: note,
  };
}

/**
 * The shared verdict ladder for a matched pair. Order is load-bearing:
 *
 *   both sides declined   → drop the row entirely (no money moved, not an issue)
 *   settled disagreement  → status mismatch, the most serious finding
 *   either side unsettled → needs review; agreement cannot be asserted yet
 *   amounts differ        → amount mismatch, unless the bases aren't comparable
 *   otherwise             → matched
 */
type Verdict = { status: string; note: string } | null;

function verdictFor(
  crmStatus: string, cashierState: string, diff: number,
  crmRow: Row, cashierRow: Row, cashCurrency: string, baseNote: string,
): Verdict {
  if (bothFailed(crmStatus, "CRM", cashierState, "Cashier")) return null;

  const join = (extra: string) => (baseNote ? `${baseNote} | ${extra}` : extra);

  if (isStatusMismatch(crmStatus, "CRM", cashierState, "Cashier")) {
    return {
      status: "⚠️ Status Mismatch",
      note: join(`CRM: ${crmStatus || "unknown"} vs Cashier: ${cashierState || "unknown"}`),
    };
  }

  if (isAmbiguousStatus(crmStatus, "CRM") || isAmbiguousStatus(cashierState, "Cashier")) {
    return {
      status: "⚠️ Needs Review",
      note: join(
        "At least one side has a non-final or unclassified status: " +
          `CRM=${crmStatus || "unknown"}, Cashier=${cashierState || "unknown"}`,
      ),
    };
  }

  if (Math.abs(diff) >= 1) {
    // Only unusable when this row genuinely has no shop-base figure. A differing
    // currency LABEL is not by itself a reason to withhold the verdict, because
    // the amount was already normalised to the shop base.
    const hasShopBase = String(v(cashierRow, "Amount in Shop Base Currency")).trim() !== "";
    const crmCur = String(v(crmRow, "Currency")).toUpperCase();
    const cashCur = String(cashCurrency).toUpperCase();
    if (!hasShopBase && crmCur && cashCur && crmCur !== cashCur) {
      return {
        status: "⚠️ Needs Review",
        note: join(
          `No shop-base amount on this Cashier row and the currency basis differs (CRM ${crmCur} ` +
            `vs Cashier ${cashCur}), so these amounts are not comparable. Raw difference: ${diff}`,
        ),
      };
    }
    return { status: "⚠️ Amount Mismatch", note: join(`Difference: ${diff}`) };
  }

  return { status: "✅ Matched", note: baseNote };
}

export function reconcileCrmVsCashier(crm: Row[], cashier: Row[]): L1Row[] {
  const rows: L1Row[] = [];
  const usedCashierIds = new Set<string>();

  const crmDeposits = crm.filter((r) => crmTypeOf(r).includes("DEPOSIT"));
  const crmWithdrawals = crm.filter((r) => crmTypeOf(r).includes("WITHDRAW"));
  const crmInternal = crm.filter((r) => crmTypeOf(r).includes("INTERNAL TRANSFER"));
  const crmOther = crm.filter((r) => {
    const t = crmTypeOf(r);
    return !t.includes("DEPOSIT") && !t.includes("WITHDRAW") && !t.includes("INTERNAL TRANSFER");
  });

  const cashierDeposits = cashier.filter((r) => String(v(r, "Type")).toUpperCase().includes("DEPOSIT"));
  const families = buildDepositFamilies(crmDeposits, cashierDeposits);
  const cashierByFamily = indexByFamily(cashierDeposits, families, cashierDepositKeys);

  const cashierByRef = new Map<string, Row[]>();
  cashier.forEach((row) => {
    const ref = normalizeKey(v(row, "Reference ID"));
    if (!ref) return;
    const list = cashierByRef.get(ref) ?? [];
    list.push(row);
    cashierByRef.set(ref, list);
  });

  // ── PASS A — deposits ──
  const ordered = [...crmDeposits].sort((a, b) => crmProcessingPriority(a) - crmProcessingPriority(b));

  ordered.forEach((crmRow) => {
    const crmAmt = num(v(crmRow, "Amount"));
    const crmType = crmTypeOf(crmRow);
    const crmStatus = v(crmRow, "TransactionStatus Name", "Status");
    const brand = v(crmRow, "Brand Title", "Brand");
    const entity = entityFromBrand(brand);

    const depositKeys = crmDepositKeys(crmRow);
    const crmCustomer = normalizeKey(v(crmRow, "Customer No"));

    // Nothing to match on and no money: not a transaction worth reporting.
    if (!crmCustomer && !depositKeys.length && crmAmt === 0) return;

    const familyId = families.idForKeys(depositKeys);
    const candidates = familyId ? (cashierByFamily.get(familyId) ?? []) : [];
    const cashierRow = pickBestCashierForCrm(candidates, usedCashierIds, crmRow, entity, crmType);

    let matchKey = "";
    let note = "";

    if (cashierRow) {
      const cashierKeys = cashierDepositKeys(cashierRow);
      const direct = depositKeys.find((k) => cashierKeys.includes(k));
      const familyKeys = families.keysFor(depositKeys);
      matchKey = direct
        ? `Direct deposit key: ${direct}`
        : `Linked deposit family: ${familyKeys.slice(0, 3).join(" ↔ ")}`;
      note =
        "Checked CRM PSP Transaction ID, Order No and Merchant Trn Ref against Cashier " +
        "Reference ID and Cashier ID. Linked aliases are supported for retry, " +
        "underpayment and overpayment flows.";
      usedCashierIds.add(v(cashierRow, "ID"));
    }

    const cashAmt = cashierRow ? cashierAmountShopBase(cashierRow) : null;
    const cashCur = cashierRow ? cashierCurrency(cashierRow) : "";
    const diff = cashierRow && cashAmt !== null ? round(crmAmt - cashAmt) : null;

    let status: string;
    if (!cashierRow) {
      // A failed CRM deposit with no cashier row is an attempt that never
      // reached the provider. Nothing to reconcile.
      if (isFailedStatus(crmStatus, "CRM")) return;
      status = "❌ Unmatched CRM";
    } else {
      const verdict = verdictFor(
        crmStatus, v(cashierRow, "State"), diff ?? 0, crmRow, cashierRow, cashCur, note,
      );
      if (!verdict) return;
      status = verdict.status;
      note = verdict.note;
    }

    rows.push({
      matchStatus: status, entity, matchKey,
      crmCustomer, crmAmount: crmAmt, crmCurrency: v(crmRow, "Currency"),
      crmStatus, crmType,
      crmOrderNo: v(crmRow, "Order No", "PSP Order No"),
      crmPspTxId: v(crmRow, "Psp Transaction ID", "PSP Transcaction ID"),
      crmBrand: brand,
      crmDate: v(crmRow, "LastUpdated", "Last Updated", "CreatedOn", "Created On"),
      cashierId: cashierRow ? v(cashierRow, "ID") : "",
      cashierAmount: cashAmt,
      cashierCurrency: cashCur,
      cashierState: cashierRow ? v(cashierRow, "State") : "",
      cashierType: cashierRow ? v(cashierRow, "Type") : "",
      cashierReference: cashierRow ? v(cashierRow, "Reference ID") : "",
      cashierProvider: cashierRow ? v(cashierRow, "Provider") : "",
      cashierShop: cashierRow ? v(cashierRow, "Shop") : "",
      amountDifference: diff,
      notes: note,
    });
  });

  // ── PASS B — withdrawals, aggregated ──
  const withdrawalGroups = new Map<string, Row[]>();
  const withdrawalsNoKey: Row[] = [];
  crmWithdrawals.forEach((r) => {
    const k = normalizeKey(v(r, "Withdrawal Psp Transaction ID"));
    if (!k) {
      withdrawalsNoKey.push(r);
      return;
    }
    const list = withdrawalGroups.get(k) ?? [];
    list.push(r);
    withdrawalGroups.set(k, list);
  });

  withdrawalGroups.forEach((legs, key) => {
    // Status, date and customer come from a representative leg — the settled one
    // if there is one, since the fee leg can carry a different status.
    const primary = [...legs].sort((a, b) => crmProcessingPriority(a) - crmProcessingPriority(b))[0];

    const crmSum = round(legs.reduce((s, r) => s + num(v(r, "Amount")), 0));
    const crmStatus = v(primary, "TransactionStatus Name", "Status");
    const brand = v(primary, "Brand Title", "Brand");
    const entity = entityFromBrand(brand);

    const candidates = cashierByRef.get(key) ?? [];
    const cashierRow = pickCashier(candidates, usedCashierIds, entity, "WITHDRAWAL");
    if (cashierRow) usedCashierIds.add(v(cashierRow, "ID"));

    const legText = legs.map((r) => num(v(r, "Amount")).toFixed(2)).join(" + ");
    const matchKey = "Withdrawal PSP Tx ID → Cashier Reference ID";
    let note =
      legs.length > 1
        ? `Aggregated ${legs.length} CRM withdrawal legs (${legText}) against one Cashier gross ` +
          "row. CRM books net + commission/fee separately; Paymaxis books the gross."
        : "Matched by CRM Withdrawal PSP Transaction ID = Cashier Reference ID.";

    const cashAmt = cashierRow ? cashierAmountShopBase(cashierRow) : null;
    const cashCur = cashierRow ? cashierCurrency(cashierRow) : "";
    const diff = cashierRow && cashAmt !== null ? round(crmSum - cashAmt) : null;

    let status: string;
    if (!cashierRow) {
      if (isFailedStatus(crmStatus, "CRM")) return;
      status = "❌ Unmatched CRM";
    } else {
      const verdict = verdictFor(
        crmStatus, v(cashierRow, "State"), diff ?? 0, primary, cashierRow, cashCur, note,
      );
      if (!verdict) return;
      status = verdict.status;
      note = verdict.note;
    }

    rows.push({
      matchStatus: status, entity, matchKey,
      crmCustomer: normalizeKey(v(primary, "Customer No")),
      crmAmount: crmSum, crmCurrency: v(primary, "Currency"),
      crmStatus, crmType: "WITHDRAWAL",
      crmOrderNo: v(primary, "Order No", "PSP Order No"),
      crmPspTxId: v(primary, "Psp Transaction ID", "PSP Transcaction ID"),
      crmBrand: brand,
      crmDate: v(primary, "LastUpdated", "Last Updated", "CreatedOn", "Created On"),
      cashierId: cashierRow ? v(cashierRow, "ID") : "",
      cashierAmount: cashAmt,
      cashierCurrency: cashCur,
      cashierState: cashierRow ? v(cashierRow, "State") : "",
      cashierType: cashierRow ? v(cashierRow, "Type") : "",
      cashierReference: cashierRow ? v(cashierRow, "Reference ID") : "",
      cashierProvider: cashierRow ? v(cashierRow, "Provider") : "",
      cashierShop: cashierRow ? v(cashierRow, "Shop") : "",
      amountDifference: diff,
      notes: note,
    });
  });

  // A withdrawal with no PSP transaction id cannot be linked at all.
  withdrawalsNoKey.forEach((r) => {
    if (isFailedStatus(v(r, "TransactionStatus Name", "Status"), "CRM")) return;
    rows.push(
      crmOnlyRow(
        "❌ Unmatched CRM", r, "WITHDRAWAL",
        "No Withdrawal PSP Tx ID on CRM row",
        "CRM withdrawal has no Withdrawal PSP Transaction ID, so it cannot be linked to a Cashier row.",
      ),
    );
  });

  // ── PASS C — internal transfers ──
  crmInternal.forEach((r) => {
    rows.push(
      crmOnlyRow(
        "⏭️ Out of Scope", r, v(r, "TransactionType", "Transaction Type"),
        "Internal transfer — no Paymaxis leg",
        "Internal Transfer to/from Trading Account. This is an internal book movement with no " +
          "cashier/PSP counterpart, so it is excluded from match rates and the action queue.",
      ),
    );
  });

  // ── PASS D — any other CRM type ──
  crmOther.forEach((r) => {
    if (isFailedStatus(v(r, "TransactionStatus Name", "Status"), "CRM")) return;
    rows.push(
      crmOnlyRow(
        "❌ Unmatched CRM", r, v(r, "TransactionType", "Transaction Type"), "",
        "Unrecognised CRM transaction type with no cashier match.",
      ),
    );
  });

  // ── PASS E — leftover cashier rows ──
  cashier.forEach((row) => {
    const id = v(row, "ID");
    if (usedCashierIds.has(id)) return;

    const provider = String(v(row, "Provider")).trim();
    const terminal = String(v(row, "Terminal")).trim();
    const state = v(row, "State");

    // A declined leftover moved no money; a row with no routing never reached a
    // provider. Neither is a reconciliation break. Both are still accounted for
    // by the completeness audit.
    if (isFailedStatus(state, "Cashier") || (!provider && !terminal)) return;

    rows.push({
      matchStatus: "❌ Unmatched Cashier",
      entity: entityFromShop(v(row, "Shop")),
      matchKey: "",
      crmCustomer: "", crmAmount: null, crmCurrency: "", crmStatus: "", crmType: "",
      crmOrderNo: "", crmPspTxId: "", crmBrand: "", crmDate: "",
      cashierId: id,
      cashierAmount: cashierAmountShopBase(row),
      cashierCurrency: cashierCurrency(row),
      cashierState: state,
      cashierType: v(row, "Type"),
      cashierReference: v(row, "Reference ID"),
      cashierProvider: provider,
      cashierShop: v(row, "Shop"),
      amountDifference: null,
      notes: "In Cashier but not in CRM",
    });
  });

  return rows;
}

export { ENTITY };
