// CRM ↔ Cashier exceptions — the blind spot the formula grid cannot show.
//
// The deposit grid is anchored on the cashier row it matched. So a deposit that
// Paymaxis DECLINED but the CRM APPROVED can be invisible: the grid pairs the
// CRM row with some cashier attempt and reports on that pair, while the
// dangerous fact — that no attempt in the whole family ever succeeded — is a
// property of the family, not of any single pair.
//
// This pass asks the family-level question directly, and the mirror question on
// withdrawals: money left Paymaxis, does the CRM agree it should have?

import type { Row } from "../types";
import {
  cashierAmountShopBase, cashierCurrency, entityFromBrand, entityFromShop,
  num, parseUtc, round, v,
} from "./values";
import { isActiveStatus, isAmbiguousStatus, isFailedStatus } from "./status";
import {
  buildDepositFamilies, cashierDepositKeys, crmDepositKeys, indexByFamily,
  pickBestCashierForCrm,
} from "./families";

export type ExceptionRow = {
  matchStatus: string;
  entity: string;
  txType: string;
  reason: string;
  matchKey: string;
  cashierId: string;
  cashierAmount: number | null;
  cashierCurrency: string;
  cashierState: string;
  cashierShop: string;
  crmAmount: number | null;
  crmStatus: string;
  crmBrand: string;
  amountDifference: number | null;
  notes: string;
};

/** `_recon1DepositExceptions` */
export function depositExceptions(crm: Row[], cashier: Row[]): ExceptionRow[] {
  const out: ExceptionRow[] = [];

  const crmDeposits = crm.filter((r) =>
    String(v(r, "TransactionType", "Transaction Type")).toUpperCase().includes("DEPOSIT"),
  );
  const cashierDeposits = cashier.filter((r) =>
    String(v(r, "Type")).toUpperCase().includes("DEPOSIT"),
  );

  const families = buildDepositFamilies(crmDeposits, cashierDeposits);
  const crmByFamily = indexByFamily(crmDeposits, families, crmDepositKeys);
  const cashierByFamily = indexByFamily(cashierDeposits, families, cashierDepositKeys);

  crmByFamily.forEach((crmRows, familyId) => {
    const cashierRows = cashierByFamily.get(familyId) ?? [];

    const activeCrm = crmRows.filter((r) =>
      isActiveStatus(v(r, "TransactionStatus Name", "Status"), "CRM"),
    );
    if (!activeCrm.length) return;

    // A success ANYWHERE in the family means a declined retry is not a
    // family-level mismatch — the customer did eventually fund.
    const succeeded = cashierRows.filter((r) => isActiveStatus(v(r, "State"), "Cashier"));
    if (succeeded.length) return;

    const failed = cashierRows.filter((r) => isFailedStatus(v(r, "State"), "Cashier"));
    const unresolved = cashierRows.filter((r) => isAmbiguousStatus(v(r, "State"), "Cashier"));

    // The most recent active CRM row represents the family.
    const anchor = [...activeCrm].sort((a, b) => {
      const ta = parseUtc(v(a, "LastUpdated", "CreatedOn"))?.getTime() ?? 0;
      const tb = parseUtc(v(b, "LastUpdated", "CreatedOn"))?.getTime() ?? 0;
      return tb - ta;
    })[0];

    const crmAmount = num(v(anchor, "Amount"));
    const matchKey = families.keysFor(crmDepositKeys(anchor)).slice(0, 3).join(" ↔ ");
    const entity = entityFromBrand(v(anchor, "Brand Title", "Brand"));

    if (failed.length) {
      const pick =
        pickBestCashierForCrm(failed, new Set<string>(), anchor, entity, "DEPOSIT") ?? failed[0];
      const cashAmount = cashierAmountShopBase(pick);
      out.push({
        matchStatus: "⚠️ Status Mismatch",
        entity: entityFromShop(v(pick, "Shop")),
        txType: "DEPOSIT",
        reason: "Cashier failed / CRM active",
        matchKey,
        cashierId: v(pick, "ID"),
        cashierAmount: cashAmount,
        cashierCurrency: cashierCurrency(pick),
        cashierState: v(pick, "State"),
        cashierShop: v(pick, "Shop"),
        crmAmount,
        crmStatus: v(anchor, "TransactionStatus Name", "Status"),
        crmBrand: v(anchor, "Brand Title", "Brand"),
        amountDifference: round(crmAmount - cashAmount),
        notes:
          "CRM is active but every Cashier attempt in the linked PSP Transaction ID / Order No " +
          "family failed. No successful Cashier attempt was found.",
      });
      return;
    }

    if (unresolved.length) {
      const pick =
        pickBestCashierForCrm(unresolved, new Set<string>(), anchor, entity, "DEPOSIT") ??
        unresolved[0];
      const cashAmount = cashierAmountShopBase(pick);
      out.push({
        matchStatus: "⚠️ Needs Review",
        entity: entityFromShop(v(pick, "Shop")),
        txType: "DEPOSIT",
        reason: "Cashier unresolved / CRM active",
        matchKey,
        cashierId: v(pick, "ID"),
        cashierAmount: cashAmount,
        cashierCurrency: cashierCurrency(pick),
        cashierState: v(pick, "State"),
        cashierShop: v(pick, "Shop"),
        crmAmount,
        crmStatus: v(anchor, "TransactionStatus Name", "Status"),
        crmBrand: v(anchor, "Brand Title", "Brand"),
        amountDifference: round(crmAmount - cashAmount),
        notes:
          "CRM is active, but the linked Cashier attempt has not reached a recognised final status.",
      });
      return;
    }

    out.push({
      matchStatus: "❌ Missing in Cashier",
      entity,
      txType: "DEPOSIT",
      reason: "CRM active / no Cashier transaction",
      matchKey,
      cashierId: "", cashierAmount: null, cashierCurrency: "",
      cashierState: "Not in Cashier", cashierShop: "",
      crmAmount,
      crmStatus: v(anchor, "TransactionStatus Name", "Status"),
      crmBrand: v(anchor, "Brand Title", "Brand"),
      amountDifference: null,
      notes:
        "The active CRM deposit has no Cashier transaction linked through PSP Transaction ID, " +
        "Order No, Merchant Trn Ref, Cashier Reference ID or Cashier ID.",
    });
  });

  return out;
}

/**
 * `_recon1WithdrawalExceptions` — the mirror case, and the most serious finding
 * this system produces: money left Paymaxis while the CRM says it was declined.
 */
export function withdrawalExceptions(crm: Row[], cashier: Row[]): ExceptionRow[] {
  const out: ExceptionRow[] = [];

  const crmWd = crm.filter((r) =>
    String(v(r, "TransactionType", "Transaction Type")).toUpperCase().includes("WITHDRAW"),
  );
  const cashWd = cashier.filter((r) => String(v(r, "Type")).toUpperCase().includes("WITHDRAW"));

  const crmByKey = new Map<string, Row[]>();
  crmWd.forEach((r) => {
    const x = String(v(r, "Withdrawal Psp Transaction ID")).trim();
    if (!x) return;
    const list = crmByKey.get(x) ?? [];
    list.push(r);
    crmByKey.set(x, list);
  });

  cashWd.forEach((c) => {
    // Only rows where money actually left.
    if (String(v(c, "State")).trim() !== "Completed") return;

    const ref = String(v(c, "Reference ID")).trim();
    const crmMatches = crmByKey.get(ref) ?? [];

    const crmActive = crmMatches.find((x) =>
      isActiveStatus(v(x, "TransactionStatus Name", "Status"), "CRM"),
    );
    if (crmActive) return; // reconciled fine

    const cashAmount = cashierAmountShopBase(c);
    const crmFailed = crmMatches.find((x) =>
      isFailedStatus(v(x, "TransactionStatus Name", "Status"), "CRM"),
    );

    if (crmFailed) {
      const crmAmount = num(v(crmFailed, "Amount"));
      out.push({
        matchStatus: "⚠️ Status Mismatch",
        entity: entityFromShop(v(c, "Shop")),
        txType: "WITHDRAWAL",
        reason: "Cashier paid / CRM failed",
        matchKey: ref,
        cashierId: v(c, "ID"),
        cashierAmount: cashAmount,
        cashierCurrency: v(c, "Currency"),
        cashierState: "Completed",
        cashierShop: v(c, "Shop"),
        crmAmount,
        crmStatus: v(crmFailed, "TransactionStatus Name", "Status"),
        crmBrand: v(crmFailed, "Brand Title", "Brand"),
        amountDifference: round(crmAmount - cashAmount),
        notes:
          "PAID on Paymaxis but CRM marks it DECLINED/failed — money left, CRM disagrees. " +
          "High priority.",
      });
      return;
    }

    if (!crmMatches.length) {
      out.push({
        matchStatus: "❌ Missing in CRM",
        entity: entityFromShop(v(c, "Shop")),
        txType: "WITHDRAWAL",
        reason: "Cashier paid / no CRM record",
        matchKey: ref,
        cashierId: v(c, "ID"),
        cashierAmount: cashAmount,
        cashierCurrency: v(c, "Currency"),
        cashierState: "Completed",
        cashierShop: v(c, "Shop"),
        crmAmount: null, crmStatus: "", crmBrand: "",
        amountDifference: null,
        notes:
          "Completed withdrawal on Paymaxis with no CRM match. Verify it was authorised.",
      });
    }
  });

  return out;
}

/** `buildRecon1Exceptions` */
export function buildExceptions(crm: Row[], cashier: Row[]): ExceptionRow[] {
  return [...depositExceptions(crm, cashier), ...withdrawalExceptions(crm, cashier)];
}
