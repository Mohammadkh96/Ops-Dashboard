// The unified master — one row per transaction, CRM → Paymaxis → PSP.
//
// This is the part that makes the system accurate rather than merely thorough.
// The two layers each see half the picture; joining them on the cashier row and
// judging all three legs together is what distinguishes:
//
//   · a real conflict          (one system settled success, another failure)
//   · an unconfirmed decline   (a failure beside a leg that never answered)
//   · a clean agreed decline   (everyone settled, everyone declined)
//   · an abandoned attempt     (nothing settled and the CRM never booked it)
//
// Collapsing any of those into the others is what produces either a queue full
// of noise or a queue missing the one row that mattered.

import type { PspConfig, Row } from "../types";
import {
  cashierAmountShopBase, cashierCurrency, entityFromBrand, entityFromShop,
  extractJson, num, round, v,
} from "./values";
import { masterClass, type MasterClass } from "./status";
import { reconcileCrmVsCashier, type L1Row } from "./layer1";
import { reconcileCashierVsPsps, type L2Row } from "./layer2";
import { buildExceptions, type ExceptionRow } from "./exceptions";
import { computeTiming, type TransactionTiming } from "../timing";

export type Priority = "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7";

export const PRIORITY_RANK: Record<string, number> = {
  P1: 1, P2: 2, P3: 3, P4: 4, P5: 5, P6: 6, P7: 7,
};

/** One flat row: the whole chain, one verdict, everything needed to act. */
export type OneRow = {
  priority: Priority;
  status: string;
  /** Ops workflow, preserved across runs by caseKey. */
  resolution: string;
  owner: string;
  opsNotes: string;

  entity: string;
  chain: string;
  txType: string;
  customer: string;

  crmStatus: string;
  crmAmount: number | null;
  crmCurrency: string;
  crmId: string;
  crmDate: string;

  cashierId: string;
  cashierState: string;
  cashierAmount: number | null;
  cashierCurrency: string;
  provider: string;
  shop: string;
  cashierDate: string;

  pspName: string;
  pspStatus: string;
  pspAmount: number | null;
  pspCurrency: string;
  pspId: string;
  pspDate: string;

  l1diff: number | null;
  l2diff: number | null;
  exposure: number;

  timing?: TransactionTiming;

  audit: string;
  errorCode: string;
  action: string;
  matchKeys: string;
  notes: string;
  caseKey: string;
};

type CombineInput = {
  hasCRM: boolean; hasCash: boolean; hasPSP: boolean;
  crm: MasterClass; cash: MasterClass; psp: MasterClass;
  l1diff: number; l2diff: number;
  pspExpected: boolean; crmExpected: boolean;
};

/**
 * `_muCombine_`
 *
 * CRM and the PSP are sources of truth; the cashier row is the router. A PENDING
 * cashier leg is outvoted by settled legs. Declines are trusted; successes must
 * be corroborated by two systems or by a completed cashier row.
 *
 * The branch order below is the logic — reordering it changes verdicts.
 */
export function combine(o: CombineInput): { status: string; priority: Priority } {
  const crm = o.hasCRM ? o.crm : "MISSING";
  const psp = o.hasPSP ? o.psp : "MISSING";
  const cash = o.hasCash ? o.cash : "MISSING";

  const l1Bad = o.hasCRM && o.hasCash && Math.abs(o.l1diff) >= 1;
  const l2Bad = o.hasCash && o.hasPSP && Math.abs(o.l2diff) > 0.05;
  const amtOK = !l1Bad && !l2Bad;

  const okOrAmt = (): { status: string; priority: Priority } => {
    if (amtOK) return { status: "✅ Reconciled", priority: "P5" };
    if (l1Bad) return { status: "⚠️ Amount Mismatch (CRM↔Cash)", priority: "P2" };
    return { status: "⚠️ Amount Mismatch (Cash↔PSP)", priority: "P2" };
  };

  const legs = [crm, psp, cash].filter((c) => c !== "MISSING");
  const active = legs.filter((c) => c === "ACTIVE").length;
  const failed = legs.filter((c) => c === "FAILED").length;
  const pending = legs.filter((c) => c === "PENDING").length;

  // 1 — something succeeded AND something failed: a genuine conflict.
  if (active > 0 && failed > 0) return { status: "⚠️ Status Mismatch", priority: "P1" };

  // 1b — a settled failure beside an UNRESOLVED leg is not a confirmed decline.
  // The unresolved leg never returned a definitive answer, so a human must
  // confirm no money moved before the chain is treated as declined.
  if (active === 0 && failed > 0 && pending > 0)
    return { status: "⚠️ Needs Review (unconfirmed vs decline)", priority: "P3" };

  // 2 — every non-missing leg failed: clean decline, folded out of the queue.
  if (active === 0 && failed > 0) return { status: "⏭️ Agreed Decline", priority: "P6" };

  // 3 — nothing settled at all.
  if (active === 0 && failed === 0) {
    // Nothing approved, nothing declined, no CRM booking: the platform never
    // recorded it and no money was confirmed to move. A false or abandoned
    // attempt, not a discrepancy.
    if (!o.hasCRM) return { status: "⏭️ Incomplete", priority: "P7" };
    return { status: "⚠️ Needs Review", priority: "P3" };
  }

  // 4 — some success, no failure. Confirm it.
  if (cash === "ACTIVE") {
    if (o.crmExpected && !o.hasCRM) return { status: "❌ Missing in CRM", priority: "P1" };
    if (o.pspExpected && !o.hasPSP) return { status: "❌ Missing in PSP", priority: "P2" };
    // "Pending legs are outvoted" was written for a pending CASHIER leg, where
    // the cashier is only the router. CRM and PSP are sources of truth: if
    // either never reached a final status while money moved, the cashier's
    // ACTIVE verdict cannot ratify it on their behalf.
    if (crm === "PENDING") return { status: "⚠️ Needs Review (CRM not final)", priority: "P2" };
    if (psp === "PENDING") return { status: "⚠️ Needs Review (PSP not final)", priority: "P3" };
    return okOrAmt();
  }

  if (active >= 2) return okOrAmt();

  return { status: "⚠️ Needs Review", priority: "P3" };
}

/**
 * `_oneIsError_` — whether a provider fault leaves the outcome unknown.
 *
 * A malfunction or timeout on a row that DID settle is the stated reason for
 * that state, not evidence it is unreliable: "3.03 Acquirer Malfunction" on a
 * Declined payment means the acquirer broke and the payment therefore declined.
 * Treating it as uncertain flagged every acquirer outage as a critical break —
 * 120 rows on the VirtualPay block alone.
 */
export function isUncertain(state: unknown, errorCode: unknown): boolean {
  const st = String(state ?? "").toUpperCase();
  const ec = String(errorCode ?? "").toUpperCase();

  const faulted =
    st.includes("ERROR") ||
    ec.includes("INTERNAL SERVER") ||
    ec.includes("ILLEGAL WORKFLOW") ||
    ec.includes("EXCEPTION");
  if (faulted) return true;

  const settled =
    st.includes("DECLIN") || st.includes("CANCEL") ||
    st.includes("COMPLETED") || st.includes("SUCCESS");
  return !settled && (ec.includes("MALFUNCTION") || ec.includes("TIMEOUT"));
}

/** `_oneExposure_` — the money actually at risk in this finding. */
function exposureOf(o: OneRow): number {
  const s = o.status;
  if (s.includes("Amount Mismatch (CRM↔Cash)")) return round(Math.abs(num(o.l1diff)));
  if (s.includes("Amount Mismatch (Cash↔PSP)")) return round(Math.abs(num(o.l2diff)));
  if (s.includes("Amount Mismatch"))
    return round(Math.max(Math.abs(num(o.l1diff)), Math.abs(num(o.l2diff))));
  return round(
    Math.max(Math.abs(num(o.crmAmount)), Math.abs(num(o.cashierAmount)), Math.abs(num(o.pspAmount))),
  );
}

/** `_oneAction_` — what to do about it, per finding. */
function actionFor(status: string): string {
  const s = status;
  if (s.startsWith("✅")) return "";
  if (s.includes("Status Mismatch"))
    return "Confirm the settled source of truth, then correct the wrong status or reverse the incorrect booking.";
  if (s.includes("Amount Mismatch"))
    return "Confirm currency basis, fees, partial capture or refund amount; adjust only against provider evidence.";
  if (s.includes("Missing in CRM"))
    return "Money moved with no CRM booking. Trace by reference and date, then book it or reverse the payment.";
  if (s.includes("Missing in Cashier"))
    return "CRM booked a movement with no Paymaxis leg. Verify with the provider before touching the balance.";
  if (s.includes("Missing in PSP"))
    return "Cashier settled but the PSP file has no leg. Re-pull that PSP export for the period, then re-run.";
  if (s.includes("Unmatched PSP"))
    return "PSP settled something the Cashier never recorded. Confirm routing and the settlement file.";
  if (s.includes("Dropped"))
    return "This Paymaxis row never entered the recon. Confirm its final state and whether money actually moved.";
  if (s.includes("Agreed Decline") || s.includes("Out of Scope") || s.includes("Incomplete") || s.includes("Not Reconciled"))
    return "No action — folded out of the queue by design.";
  return "Review the match key, transaction type, date and amount before classification.";
}

const blank = (): OneRow => ({
  priority: "P7", status: "", resolution: "Open", owner: "", opsNotes: "",
  entity: "", chain: "", txType: "", customer: "",
  crmStatus: "", crmAmount: null, crmCurrency: "", crmId: "", crmDate: "",
  cashierId: "", cashierState: "", cashierAmount: null, cashierCurrency: "",
  provider: "", shop: "", cashierDate: "",
  pspName: "", pspStatus: "", pspAmount: null, pspCurrency: "", pspId: "", pspDate: "",
  l1diff: null, l2diff: null, exposure: 0,
  audit: "", errorCode: "", action: "", matchKeys: "", notes: "", caseKey: "",
});

/** `_muChainRow_` — join one cashier id's Layer-1 and Layer-2 rows. */
function chainRow(a: L1Row | undefined, b: L2Row | undefined, cashId: string): OneRow {
  const hasCRM = Boolean(a && String(a.crmStatus).trim());
  const pspName = b?.pspName ?? "";
  const hasPSP = Boolean(b && String(b.pspTxId).trim());

  const cashType = String(b?.cashierType ?? a?.cashierType ?? "").toUpperCase();
  const crmType = String(a?.crmType ?? "").toUpperCase();

  const crmStatus = hasCRM ? (a as L1Row).crmStatus : "";
  const cashState = b?.cashierState ?? a?.cashierState ?? "";
  const pspStatus = hasPSP ? (b as L2Row).pspStatus : "";

  const l1diff = a ? num(a.amountDifference) : 0;
  const l2diff = b ? num(b.amountDifference) : 0;

  // Layer 2 declares this when the provider's file was not uploaded for the
  // period. A leg cannot be EXPECTED from a file nobody supplied, so the chain
  // must not report a missing PSP record — that blames the data for an absent
  // upload, which is the mistake Layer 2's own note exists to avoid.
  const pspFileMissing = Boolean(b?.matchStatus.includes("Not Reconciled"));

  const pspExpected =
    Boolean(pspName) &&
    !pspName.startsWith("No PSP") &&
    pspName !== "Unknown PSP" &&
    !pspFileMissing;

  // V12.1: REFUND is CRM-required too. A refund present in Paymaxis and the PSP
  // but absent from CRM is a P1 exception, not an expected omission.
  const isRefund = cashType.includes("REFUND") || crmType.includes("REFUND");
  const crmExpected =
    cashType.includes("DEPOSIT") || cashType.includes("WITHDRAW") ||
    crmType.includes("DEPOSIT") || crmType.includes("WITHDRAW") ||
    isRefund;

  let verdict = combine({
    hasCRM, hasCash: true, hasPSP,
    crm: hasCRM ? masterClass(crmStatus, "CRM") : "MISSING",
    cash: masterClass(cashState, "Cashier"),
    psp: hasPSP ? masterClass(pspStatus, pspName) : "MISSING",
    l1diff, l2diff, pspExpected, crmExpected,
  });

  let missingFileNote = "";
  if (pspFileMissing && verdict.status.startsWith("✅")) {
    // CRM and Paymaxis agree, but a third of the chain was never examined.
    // Reporting it reconciled would claim a verification that did not happen,
    // so it is informational and excluded from the match rate. A genuine
    // CRM-to-Paymaxis finding is unaffected and keeps its own verdict.
    verdict = { status: "⏭️ Not Reconciled", priority: "P7" };
    missingFileNote =
      `The ${pspName} file was not uploaded for this period, so the provider leg was never ` +
      "checked. CRM and Paymaxis agree; end-to-end verification is still outstanding.";
  }

  const notes = [a?.notes, b?.notes, missingFileNote].filter(Boolean).join("  ||  ");

  return {
    ...blank(),
    priority: verdict.priority,
    status: verdict.status,
    entity: a?.entity || b?.entity || "",
    chain: `${hasCRM ? "CRM+" : ""}Cash${hasPSP ? "+PSP" : ""}`,
    txType: crmType || cashType,
    customer: a?.crmCustomer ?? "",
    crmStatus,
    crmAmount: hasCRM ? (a as L1Row).crmAmount : null,
    crmCurrency: a?.crmCurrency ?? "",
    crmId: a ? a.crmPspTxId || a.crmOrderNo : "",
    crmDate: a?.crmDate ?? "",
    cashierId: cashId,
    cashierState: cashState,
    cashierAmount: b?.cashierAmount ?? a?.cashierAmount ?? null,
    cashierCurrency: b?.cashierCurrency ?? a?.cashierCurrency ?? "",
    provider: b?.cashierProvider ?? a?.cashierProvider ?? "",
    shop: b?.cashierShop ?? a?.cashierShop ?? "",
    cashierDate: b?.cashierDate ?? "",
    pspName: hasPSP || pspExpected ? pspName : "",
    pspStatus,
    pspAmount: hasPSP ? (b as L2Row).pspAmount : null,
    pspCurrency: b?.pspCurrency ?? "",
    pspId: b?.pspTxId ?? "",
    pspDate: b?.pspDate ?? "",
    l1diff: hasCRM ? l1diff : null,
    l2diff: hasPSP ? l2diff : null,
    matchKeys: [a?.matchKey, b?.matchKey].filter(Boolean).join("  ||  "),
    notes:
      isRefund && !hasCRM
        ? [notes, "Refund exists in Paymaxis/PSP but is missing from CRM"].filter(Boolean).join("  ||  ")
        : notes,
  };
}

function crmOnlyRow(a: L1Row): OneRow {
  const outOfScope = a.matchStatus.startsWith("⏭️");
  return {
    ...blank(),
    priority: outOfScope ? "P6" : "P1",
    status: outOfScope ? "⏭️ Out of Scope" : "❌ Missing in Cashier",
    entity: a.entity,
    chain: "CRM only",
    txType: String(a.crmType).toUpperCase(),
    customer: a.crmCustomer,
    crmStatus: a.crmStatus, crmAmount: a.crmAmount, crmCurrency: a.crmCurrency,
    crmId: a.crmPspTxId || a.crmOrderNo, crmDate: a.crmDate,
    matchKeys: a.matchKey, notes: a.notes,
  };
}

function pspOnlyRow(b: L2Row): OneRow {
  return {
    ...blank(),
    priority: "P2",
    status: "❌ Unmatched PSP",
    entity: b.entity,
    chain: "PSP only",
    txType: String(b.pspType).toUpperCase(),
    pspName: b.pspName, pspStatus: b.pspStatus, pspAmount: b.pspAmount,
    pspCurrency: b.pspCurrency, pspId: b.pspTxId, pspDate: b.pspDate,
    matchKeys: b.matchKey, notes: b.notes,
  };
}

function exceptionRow(ex: ExceptionRow): OneRow {
  let priority: Priority;
  if (ex.matchStatus.includes("Status Mismatch")) priority = "P1";
  else if (ex.matchStatus.includes("Missing in CRM") || ex.matchStatus.includes("Missing in Cashier"))
    priority = "P1";
  else if (ex.matchStatus.includes("Needs Review")) priority = "P3";
  else priority = "P2";

  return {
    ...blank(),
    priority,
    status: ex.matchStatus,
    entity: ex.entity,
    chain: "Exception (L1)",
    txType: ex.txType,
    crmStatus: ex.crmStatus, crmAmount: ex.crmAmount,
    cashierId: ex.cashierId, cashierState: ex.cashierState,
    cashierAmount: ex.cashierAmount, cashierCurrency: ex.cashierCurrency,
    shop: ex.cashierShop,
    l1diff: ex.amountDifference,
    matchKeys: ex.matchKey,
    notes: `Exception engine · ${ex.reason} — ${ex.notes}`,
  };
}

export type ReconOne = {
  rows: OneRow[];
  /** Cashier rows accounted for: surfaced + dropped must equal the file. */
  completeness: { total: number; surfaced: number; dropped: number; balanced: boolean };
  kpis: {
    p1: number; p2: number; p3: number; p4: number;
    reconciled: number; inScope: number; skipped: number;
    dropped: number; audit: number; slow: number;
    exposure: number; matchRate: number;
  };
};

/**
 * `buildReconOne` — the whole pipeline.
 *
 * @param uploaded PSP config ids whose file was provided for this period. A PSP
 *   without one cannot be matched, and its rows are reported "Not Reconciled"
 *   rather than blamed as unmatched.
 */
export function buildReconOne(
  crm: Row[],
  cashier: Row[],
  psps: PspConfig[],
  pspData: Record<string, Row[]>,
  uploaded: ReadonlySet<string>,
  priorWorkflow: Map<string, { resolution: string; owner: string; opsNotes: string }> = new Map(),
): ReconOne {
  const l1 = crm.length && cashier.length ? reconcileCrmVsCashier(crm, cashier) : [];
  const anyPspData = psps.some((p) => (pspData[p.id] ?? []).length > 0);
  const l2 = cashier.length && anyPspData ? reconcileCashierVsPsps(cashier, psps, pspData, uploaded) : [];

  const l1ByCash = new Map<string, L1Row>();
  const l1CrmOnly: L1Row[] = [];
  l1.forEach((r) => {
    if (r.cashierId) l1ByCash.set(r.cashierId, r);
    else l1CrmOnly.push(r);
  });

  const l2ByCash = new Map<string, L2Row>();
  const l2PspOnly: L2Row[] = [];
  l2.forEach((r) => {
    if (r.cashierId) l2ByCash.set(r.cashierId, r);
    else l2PspOnly.push(r);
  });

  const ids = new Set<string>([...l1ByCash.keys(), ...l2ByCash.keys()]);
  const rows: OneRow[] = [];
  ids.forEach((id) => rows.push(chainRow(l1ByCash.get(id), l2ByCash.get(id), id)));
  l1CrmOnly.forEach((a) => rows.push(crmOnlyRow(a)));
  l2PspOnly.forEach((b) => rows.push(pspOnlyRow(b)));

  // Exceptions, de-duplicated against an identical cashier-id + status already
  // present. A DIFFERENT status on the same id is kept: it is a second finding.
  const seen = new Set(rows.map((r) => `${r.cashierId}|${r.status}`));
  buildExceptions(crm, cashier).forEach((ex) => {
    const key = `${ex.cashierId}|${ex.matchStatus}`;
    if (ex.cashierId && seen.has(key)) return;
    seen.add(key);
    rows.push(exceptionRow(ex));
  });

  // ── completeness: every cashier row accounted for ──
  const surfacedIds = new Set<string>([...l1ByCash.keys(), ...l2ByCash.keys()]);
  const cashById = new Map<string, Row>();
  cashier.forEach((r) => {
    const id = v(r, "ID");
    if (id) cashById.set(id, r);
  });

  // Annotate rows that DID surface with the provider error code.
  rows.forEach((r) => {
    const raw = r.cashierId ? cashById.get(r.cashierId) : undefined;
    if (!raw) return;
    const ec = v(raw, "Error Code") || v(raw, "External Result Code");
    r.errorCode = ec;
    if (isUncertain(v(raw, "State"), ec)) r.audit = "Provider error — outcome uncertain";
  });

  let dropped = 0;
  cashier.forEach((r) => {
    const id = v(r, "ID");
    if (!id || surfacedIds.has(id)) return;
    dropped++;

    const state = v(r, "State");
    const ec = v(r, "Error Code") || v(r, "External Result Code");
    const su = state.toUpperCase();
    const routed = Boolean(String(v(r, "Provider")).trim() || String(v(r, "Terminal")).trim());

    let status: string;
    let priority: Priority;
    let audit: string;
    if (isUncertain(state, ec)) {
      status = "❌ Dropped · Provider Error"; priority = "P1";
      audit = "Provider error — outcome uncertain";
    } else if (su === "COMPLETED" || su.includes("SUCCESS") || su.includes("APPROVED")) {
      status = "❌ Dropped · Completed but Not Reconciled"; priority = "P1";
      audit = "Real gap — money moved, no recon row";
    } else if (su.includes("AWAIT")) {
      status = "⚠️ Dropped · Awaiting Webhook"; priority = "P2";
      audit = "Never settled — dropped from recon";
    } else if (su.includes("RECONCIL")) {
      status = "⚠️ Dropped · In Reconciliation"; priority = "P2";
      audit = "Never settled — dropped from recon";
    } else if (
      su.includes("DECLIN") || su.includes("CANCEL") || su.includes("REJECT") ||
      su.includes("EXPIRE") || su.includes("VOID")
    ) {
      status = "⏭️ Dropped · Agreed Decline"; priority = "P6"; audit = "";
    } else if (!routed) {
      status = "⚠️ Dropped · Never Routed to a PSP"; priority = "P3";
      audit = "Cancelled before routing";
    } else {
      status = "⚠️ Dropped · Unclassified State"; priority = "P3";
      audit = "Not surfaced — unclassified state";
    }

    // A dropped row still knows which key WOULD have matched it. Surfacing that
    // is what lets a human verify the join by hand against the provider export —
    // and it belongs in Match Keys, not in PSP Tx ID, or the chain would claim a
    // PSP leg that does not exist.
    const refs = v(r, "External Refs");
    const hintKey =
      extractJson(refs, "authenticateRequestId") || extractJson(refs, "requestId") ||
      extractJson(refs, "webhookPaymentId") || extractJson(refs, "paymentId") ||
      v(r, "External Id");

    rows.push({
      ...blank(),
      priority, status, audit, errorCode: ec,
      entity: entityFromShop(v(r, "Shop")),
      chain: "Cash only (dropped)",
      txType: String(v(r, "Type")).toUpperCase(),
      customer: v(r, "Customer Account Number"),
      cashierId: id, cashierState: state,
      cashierAmount: cashierAmountShopBase(r),
      cashierCurrency: cashierCurrency(r),
      provider: v(r, "Provider"), shop: v(r, "Shop"),
      cashierDate: v(r, "Finalized", "Updated", "Created"),
      matchKeys: hintKey
        ? `Not in either grid · key from External Refs: ${hintKey}`
        : "Not in either grid · no PSP key on this Paymaxis row",
      notes:
        "Paymaxis row absent from both recon grids. Confirm the final state and whether money moved.",
    });
  });

  // ── timing, exposure, action, case key ──
  const crmByKey = new Map<string, Row>();
  crm.forEach((r) => {
    [
      v(r, "Psp Transaction ID", "PSP Transcaction ID"),
      v(r, "Order No"),
      v(r, "Withdrawal Psp Transaction ID"),
    ].forEach((k) => {
      if (k && !crmByKey.has(k)) crmByKey.set(k, r);
    });
  });

  const keyCount = new Map<string, number>();
  rows.forEach((o) => {
    const crmRow = o.crmId ? crmByKey.get(o.crmId) : undefined;
    const cashRow = o.cashierId ? cashById.get(o.cashierId) : undefined;

    o.timing = computeTiming({
      crmRequested: crmRow ? v(crmRow, "CreatedOn", "Created On") : "",
      crmProcessed: crmRow ? v(crmRow, "LastUpdated", "Last Updated") : "",
      cashierCreated: cashRow ? v(cashRow, "Created") : "",
      cashierFinalized: cashRow ? v(cashRow, "Finalized", "Updated") : "",
      pspRequested: o.pspDate,
      pspConfirmed: o.pspDate,
    });
    if (o.timing.slow && !o.audit) o.audit = "Took longer than 24h end to end";

    o.exposure = exposureOf(o);
    o.action = actionFor(o.status);

    // A clean row carrying a provider fault still deserves eyes, without being
    // promoted above a real break.
    if (o.audit.startsWith("Provider error") && PRIORITY_RANK[o.priority] >= 5) o.priority = "P4";

    const id = o.cashierId || o.pspId || o.crmId || o.customer;
    const base = [o.entity, o.txType, id].map((x) => String(x ?? "").trim()).join("|");
    const n = (keyCount.get(base) ?? 0) + 1;
    keyCount.set(base, n);
    o.caseKey = n > 1 ? `${base}#${n}` : base;

    const prior = priorWorkflow.get(o.caseKey);
    if (prior) {
      o.resolution = prior.resolution || "Open";
      o.owner = prior.owner || "";
      o.opsNotes = prior.opsNotes || "";
    }
  });

  rows.sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      b.exposure - a.exposure ||
      String(a.cashierId).localeCompare(String(b.cashierId)),
  );

  const kpis = {
    p1: 0, p2: 0, p3: 0, p4: 0,
    reconciled: 0, inScope: 0, skipped: 0,
    dropped, audit: 0, slow: 0, exposure: 0, matchRate: 0,
  };
  rows.forEach((o) => {
    if (o.status.startsWith("✅")) kpis.reconciled++;
    if (o.status.startsWith("⏭️")) kpis.skipped++;
    else kpis.inScope++;
    if (o.audit) kpis.audit++;
    if (o.timing?.slow) kpis.slow++;
    if (o.priority === "P1") { kpis.p1++; kpis.exposure += o.exposure; }
    else if (o.priority === "P2") { kpis.p2++; kpis.exposure += o.exposure; }
    else if (o.priority === "P3") { kpis.p3++; kpis.exposure += o.exposure; }
    else if (o.priority === "P4") { kpis.p4++; kpis.exposure += o.exposure; }
  });
  kpis.exposure = round(kpis.exposure);
  kpis.matchRate = kpis.inScope > 0 ? Math.round((kpis.reconciled / kpis.inScope) * 100) : 0;

  return {
    rows,
    completeness: {
      total: cashier.length,
      surfaced: surfacedIds.size,
      dropped,
      balanced: surfacedIds.size + dropped === cashier.length,
    },
    kpis,
  };
}

export { entityFromBrand };
