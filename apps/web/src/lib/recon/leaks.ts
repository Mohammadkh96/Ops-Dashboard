// Completeness / leak audit.
//
// The two reconciliation layers only report on rows they managed to consider.
// A cashier row that no pass ever touched — because it was skipped by a filter,
// carried no routing information, or never reached a final state — simply is
// not in the output. That is the dangerous kind of missing: the totals look
// clean because the row was never counted, so "97% matched" can sit on top of a
// completed payment nobody reconciled.
//
// This pass closes the books. Every cashier row is accounted for: either it
// surfaced in Layer 1 or Layer 2, or it appears here saying why it did not.
// The count is arithmetic, not judgement — surfaced + dropped must equal the
// row count of the file.

import { parseMoney } from "./money";
import { CASHIER_MAP } from "./registry";
import type { Dataset, MatchStatus, ReconRow, Row } from "./types";

const up = (v: unknown) => String(v ?? "").toUpperCase().trim();

function cell(row: Row, spec: string | undefined): string {
  if (!spec) return "";
  for (const c of spec.split(",").map((x) => x.trim())) {
    const v = row[c];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

/**
 * Whether a provider fault leaves the outcome genuinely unknown.
 *
 * The distinction the V15 script settled: a malfunction or timeout on a row
 * that DID reach a final state is the stated reason for that state, not
 * evidence the state is unreliable. "3.03 Acquirer Malfunction" on a payment
 * Paymaxis marks Declined means the acquirer broke and the payment therefore
 * declined — that is a complete story. Flagging it as uncertain turns every
 * acquirer outage into a pile of critical breaks.
 *
 * Uncertainty is the unsettled case: the fault happened and no side ever said
 * how it ended.
 */
export function isUncertainOutcome(state: string, errorCode: string): boolean {
  const st = up(state);
  const ec = up(errorCode);

  // A server-level fault is uncertain whatever the row claims: the process that
  // would have written the outcome is the thing that broke.
  const faulted =
    st.includes("ERROR") ||
    ec.includes("INTERNAL SERVER") ||
    ec.includes("ILLEGAL WORKFLOW") ||
    ec.includes("EXCEPTION");
  if (faulted) return true;

  const settled =
    st.includes("DECLIN") ||
    st.includes("CANCEL") ||
    st.includes("COMPLETED") ||
    st.includes("SUCCESS");
  return !settled && (ec.includes("MALFUNCTION") || ec.includes("TIMEOUT"));
}

export type LeakRow = ReconRow & {
  /** Why this row needs a human even though no layer produced a verdict. */
  audit: string;
  errorCode: string;
};

export type LeakAudit = {
  rows: LeakRow[];
  /** Cashier rows the two layers did consider. */
  surfaced: number;
  /** Cashier rows no layer considered. */
  dropped: number;
  total: number;
  /** surfaced + dropped === total. False means this audit itself is wrong. */
  balanced: boolean;
  /** Rows that reached the layers but carry a provider fault worth reading. */
  flagged: number;
};

type Classified = {
  status: MatchStatus;
  priority: string;
  audit: string;
  note: string;
};

/** Why a cashier row never reached either layer, and how much that matters. */
function classifyDropped(state: string, errorCode: string, routed: boolean): Classified {
  const su = up(state);

  if (isUncertainOutcome(state, errorCode))
    return {
      status: "needs-review",
      priority: "P1",
      audit: "Provider fault, outcome never confirmed",
      note: "A provider error left this payment without a final state, and no layer produced a verdict. Confirm with the provider whether money moved.",
    };

  if (su === "COMPLETED" || su.includes("SUCCESS") || su.includes("APPROVED"))
    return {
      status: "unmatched-cashier",
      priority: "P1",
      audit: "Completed but never reconciled",
      note: "Money moved and no reconciliation row was produced for it. This is a genuine gap, not a classification question.",
    };

  if (su.includes("AWAIT"))
    return {
      status: "needs-review",
      priority: "P2",
      audit: "Never settled — waiting on a callback",
      note: "Still awaiting a provider callback, so no layer could reach a verdict.",
    };

  if (su.includes("RECONCIL"))
    return {
      status: "needs-review",
      priority: "P2",
      audit: "Never settled — provider still matching",
      note: "The provider had not finished matching this payment, so no layer could reach a verdict.",
    };

  if (
    su.includes("DECLIN") || su.includes("CANCEL") || su.includes("REJECT") ||
    su.includes("EXPIRE") || su.includes("VOID")
  )
    return {
      status: "agreed-decline",
      priority: "P6",
      audit: "",
      note: "Declined with no counterpart to compare against. No money moved, so it is reported for completeness only.",
    };

  if (!routed)
    return {
      status: "incomplete",
      priority: "P7",
      audit: "Cancelled before reaching a provider",
      note: "No provider or terminal was ever assigned, so there was nothing to reconcile against.",
    };

  return {
    status: "needs-review",
    priority: "P3",
    audit: "Not surfaced — state not recognised",
    note: "This state matches no known vocabulary, so no layer could classify it. Add it to the PSP's synonyms or check the export.",
  };
}

/**
 * @param surfacedIds Cashier row ids that appear in Layer 1 or Layer 2.
 */
export function auditCompleteness(
  cashier: Dataset,
  surfacedIds: ReadonlySet<string>,
): LeakAudit {
  const rows: LeakRow[] = [];
  let surfaced = 0;
  let dropped = 0;
  let flagged = 0;

  const idSpec = CASHIER_MAP.idCols.join(",");

  cashier.rows.forEach((c, i) => {
    const id = cell(c, idSpec) || `row-${i + 1}`;
    const state = cell(c, CASHIER_MAP.statusCol);
    const errorCode = cell(c, "Error Code,External Result Code");
    const provider = cell(c, "Provider");
    const terminal = cell(c, "Terminal");
    const shop = cell(c, "Shop");
    const amount = cell(c, CASHIER_MAP.amountCol);

    if (surfacedIds.has(id)) {
      surfaced++;
      // It was reconciled, but a provider fault on it is still worth reading —
      // reported as a flag rather than re-opening a settled verdict.
      if (isUncertainOutcome(state, errorCode)) flagged++;
      return;
    }

    dropped++;
    const v = classifyDropped(state, errorCode, Boolean(provider || terminal));

    rows.push({
      status: v.status,
      priority: v.priority,
      entity: /_sl/i.test(shop) ? "Saint Lucia" : "Mauritius",
      brand: "",
      psp: provider || terminal || "",
      matchKey: "Not considered by either layer",
      leftId: id,
      leftAmount: parseMoney(amount),
      leftCurrency: cell(c, CASHIER_MAP.currencyCol),
      leftStatus: state,
      rightId: "",
      rightAmount: null,
      rightCurrency: "",
      rightStatus: "",
      diff: null,
      note: v.note,
      caseKey: `leak|${id}|${v.status}`,
      audit: v.audit,
      errorCode,
    });
  });

  return {
    rows,
    surfaced,
    dropped,
    total: cashier.rows.length,
    balanced: surfaced + dropped === cashier.rows.length,
    flagged,
  };
}
