// Deposit identifier families and cashier selection — ported from V11.1.
//
// A deposit is not identified by one field. The CRM knows it by a PSP
// Transaction ID, an Order No and a Merchant Trn Ref; Paymaxis knows it by a
// Reference ID and its own ID. Retries, underpayments and overpayments produce
// several rows that share SOME of those identifiers but not all.
//
// Matching on any single field therefore misses legitimate pairs. The union-find
// below links every identifier that ever appeared together into one family, so a
// CRM row and a cashier row match when they are connected through ANY chain of
// shared identifiers — not only when they happen to share the field someone
// picked.

import type { Row } from "../types";
import {
  cashierAmountShopBase, diffMinutes, normalizeKey, num, parseUtc,
  sharesValue, shopMatchesEntity, typesMatch, uniqueKeys, v,
} from "./values";
import { isActiveStatus, isAmbiguousStatus, isFailedStatus, isStatusMismatch } from "./status";

/** `_crmDepKeys` */
export function crmDepositKeys(r: Row): string[] {
  return uniqueKeys([
    v(r, "Psp Transaction ID", "PSP Transcaction ID"),
    v(r, "Order No", "PSP Order No"),
    v(r, "Merchant Trn Ref", "Reference ID"),
  ]);
}

/** `_cashDepKeys` */
export function cashierDepositKeys(r: Row): string[] {
  return uniqueKeys([v(r, "Reference ID"), v(r, "ID")]);
}

/** `_crmCustomerKeys_` */
export function crmCustomerKeys(r: Row): string[] {
  return uniqueKeys([v(r, "Customer No"), v(r, "TradingAccount"), v(r, "Email")]);
}

/** `_cashierCustomerKeys_` */
export function cashierCustomerKeys(r: Row): string[] {
  return uniqueKeys([
    v(r, "Customer Account Number"),
    v(r, "Customer Reference ID"),
    v(r, "Customer Email"),
  ]);
}

export type Families = {
  /** The family a set of keys belongs to. */
  idForKeys: (keys: string[]) => string;
  /** Every key linked to the given ones, for explaining a match. */
  keysFor: (keys: string[]) => string[];
};

/** `_buildDepositFamilies_` — union-find over both sides' identifiers. */
export function buildDepositFamilies(crmRows: Row[], cashierRows: Row[]): Families {
  const parent = new Map<string, string>();
  const rank = new Map<string, number>();

  const add = (key: string) => {
    if (!key) return;
    if (!parent.has(key)) {
      parent.set(key, key);
      rank.set(key, 0);
    }
  };

  const find = (key: string): string => {
    add(key);
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    // Path compression, iterative: a long chain would otherwise recurse once
    // per link and these files run to hundreds of thousands of rows.
    let walk = key;
    while (parent.get(walk) !== root) {
      const next = parent.get(walk) as string;
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };

  const union = (a: string, b: string) => {
    if (!a || !b) return;
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const rka = rank.get(ra) ?? 0;
    const rkb = rank.get(rb) ?? 0;
    if (rka < rkb) parent.set(ra, rb);
    else if (rka > rkb) parent.set(rb, ra);
    else {
      parent.set(rb, ra);
      rank.set(ra, rka + 1);
    }
  };

  const connect = (keys: string[]) => {
    const ks = uniqueKeys(keys);
    if (!ks.length) return;
    ks.forEach(add);
    for (let i = 1; i < ks.length; i++) union(ks[0], ks[i]);
  };

  (crmRows ?? []).forEach((row) => connect(crmDepositKeys(row)));
  (cashierRows ?? []).forEach((row) => connect(cashierDepositKeys(row)));

  const membersByRoot = () => {
    const out = new Map<string, string[]>();
    for (const key of parent.keys()) {
      const root = find(key);
      const list = out.get(root) ?? [];
      list.push(key);
      out.set(root, list);
    }
    return out;
  };

  return {
    idForKeys(keys: string[]): string {
      const ks = uniqueKeys(keys);
      for (const k of ks) if (parent.has(k)) return find(k);
      return ks.length ? ks[0] : "";
    },
    keysFor(keys: string[]): string[] {
      const ks = uniqueKeys(keys);
      const found = new Set<string>();
      const members = membersByRoot();
      ks.forEach((key) => {
        if (parent.has(key)) {
          (members.get(find(key)) ?? []).forEach((m) => found.add(m));
        } else {
          found.add(key);
        }
      });
      return [...found];
    },
  };
}

/** `_indexRowsByDepositFamily_` */
export function indexByFamily(
  rows: Row[],
  families: Families,
  keyFn: (r: Row) => string[],
): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  (rows ?? []).forEach((row) => {
    const id = families.idForKeys(keyFn(row));
    if (!id) return;
    const list = out.get(id) ?? [];
    list.push(row);
    out.set(id, list);
  });
  return out;
}

/**
 * `_crmProcessingPriority_` — settled successes are matched first.
 *
 * Order matters because each cashier row can only be consumed once: if a failed
 * retry claimed the cashier row first, the successful attempt would be left
 * looking unmatched.
 */
export function crmProcessingPriority(row: Row): number {
  const status = v(row, "TransactionStatus Name", "Status");
  if (isActiveStatus(status, "CRM")) return 1;
  if (isAmbiguousStatus(status, "CRM")) return 2;
  if (isFailedStatus(status, "CRM")) return 3;
  return 4;
}

/**
 * `_pickBestCashierForCrm_` — which cashier row in the family is this CRM row.
 *
 * Filters first (entity + type, then type alone, then status compatibility),
 * then scores what remains. The score weights are the script's: a directly
 * shared identifier dominates everything, then status agreement, then how close
 * the amount is, then how close in time. A status CONFLICT is penalised rather
 * than excluded, so a genuine mismatch is still reported instead of being
 * silently paired with an unrelated row.
 */
export function pickBestCashierForCrm(
  candidates: Row[],
  usedCashierIds: Set<string>,
  crmRow: Row,
  entity: string,
  crmType: string,
): Row | null {
  let available = (candidates ?? []).filter((c) => !usedCashierIds.has(v(c, "ID")));
  if (!available.length) return null;

  const exact = available.filter(
    (c) => shopMatchesEntity(v(c, "Shop"), entity) && typesMatch(crmType, v(c, "Type"), "Cashier"),
  );
  if (exact.length) {
    available = exact;
  } else {
    const sameType = available.filter((c) => typesMatch(crmType, v(c, "Type"), "Cashier"));
    if (sameType.length) available = sameType;
  }

  const crmStatus = v(crmRow, "TransactionStatus Name", "Status");
  const crmIsActive = isActiveStatus(crmStatus, "CRM");
  const crmIsFailed = isFailedStatus(crmStatus, "CRM");

  const statusCompatible = available.filter((c) => {
    const cs = v(c, "State");
    return (
      (crmIsActive && isActiveStatus(cs, "Cashier")) ||
      (crmIsFailed && isFailedStatus(cs, "Cashier"))
    );
  });
  if (statusCompatible.length) available = statusCompatible;

  const crmAmount = num(v(crmRow, "Amount"));
  const crmDate = v(crmRow, "LastUpdated", "Last Updated", "CreatedOn", "Created On");
  const crmKeys = crmDepositKeys(crmRow);
  const crmCustomer = crmCustomerKeys(crmRow);

  const score = (c: Row): number => {
    let points = 0;
    const cs = v(c, "State");

    if (sharesValue(crmKeys, cashierDepositKeys(c))) points += 5000;
    if (sharesValue(crmCustomer, cashierCustomerKeys(c))) points += 700;

    if (crmIsActive && isActiveStatus(cs, "Cashier")) points += 3000;
    else if (crmIsFailed && isFailedStatus(cs, "Cashier")) points += 2800;
    else if (isStatusMismatch(crmStatus, "CRM", cs, "Cashier")) points -= 1500;

    const amountDiff = Math.abs(crmAmount - cashierAmountShopBase(c));
    if (amountDiff < 0.01) points += 1200;
    else if (amountDiff < 1) points += 900;
    else if (amountDiff <= 5) points += 600;
    else if (amountDiff <= 20) points += 250;
    else points -= Math.min(500, amountDiff);

    const minutes = diffMinutes(crmDate, v(c, "Finalized", "Updated", "Created"));
    if (minutes <= 60) points += 350;
    else if (minutes <= 1440) points += 200;
    else if (minutes <= 10080) points += 75;

    return points;
  };

  const sorted = [...available].sort((a, b) => {
    const d = score(b) - score(a);
    if (d !== 0) return d;
    // Deterministic tie-break: newest first, then by id, so two runs over the
    // same files always pair the same rows.
    const ta = parseUtc(v(a, "Finalized", "Updated", "Created"))?.getTime() ?? 0;
    const tb = parseUtc(v(b, "Finalized", "Updated", "Created"))?.getTime() ?? 0;
    if (ta !== tb) return tb - ta;
    return String(v(a, "ID")).localeCompare(String(v(b, "ID")));
  });

  return sorted[0] ?? null;
}

/**
 * `_pickCashier` — the simpler selection used for withdrawals, where the key is
 * exact and only entity/type disambiguate.
 */
export function pickCashier(
  candidates: Row[],
  usedCashierIds: Set<string>,
  entity: string,
  crmType: string,
): Row | null {
  const free = (candidates ?? []).filter((c) => !usedCashierIds.has(v(c, "ID")));
  return (
    free.find(
      (r) => shopMatchesEntity(v(r, "Shop"), entity) && typesMatch(crmType, v(r, "Type"), "Cashier"),
    ) ??
    free.find((r) => typesMatch(crmType, v(r, "Type"), "Cashier")) ??
    free[0] ??
    null
  );
}

export { normalizeKey };
