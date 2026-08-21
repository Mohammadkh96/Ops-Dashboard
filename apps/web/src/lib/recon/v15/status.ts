// Status classification, ported from the Apps Script.
//
// The script carries TWO layers of classification and they are not
// interchangeable:
//
//   _isActiveStatus / _isFailedStatus / _isAmbiguousStatus
//       Per-system vocabularies plus keyword lists. "Ambiguous" means neither
//       list claimed it — used by the layers to refuse a verdict.
//
//   _muClass_
//       The master's four-state view: ACTIVE / FAILED / PENDING / MISSING. It
//       recognises explicit in-flight states FIRST, and treats an unknown
//       vocabulary as PENDING rather than as a verdict, so an unmapped code
//       gets outvoted by the settled legs instead of ratifying a chain.
//
// Both are needed. Collapsing them loses the distinction between "this failed"
// and "nobody has said yet", which is what the whole verdict engine turns on.

const up = (v: unknown) => String(v ?? "").toUpperCase().trim();

const ACTIVE_KEYWORDS = [
  "APPROVED", "APPROVE", "COMPLETED", "COMPLETE", "SUCCESS", "SUCCESSFUL",
  "SETTLED", "SETTLE", "CONFIRMED", "CONFIRM", "PAID", "PAY", "PROCESSED",
  "PROCESS", "CAPTURED", "CAPTURE", "AUTHORIZED", "AUTHORISED",
  "PAYMENT_OUT", "PAYMENT",
];

const FAILED_KEYWORDS = [
  "CANCEL", "CANCELLED", "CANCELED", "DECLINE", "DECLINED", "FAIL", "FAILED",
  "FAILURE", "REJECT", "REJECTED", "EXPIRE", "EXPIRED", "ERROR", "CHARGEBACK",
  "REVERSED", "VOID", "VOIDED", "ABORT", "ABORTED",
  "AWAITING WEBHOOK", "AWAITING_WEBHOOK",
];

/**
 * `_isActiveStatus(statusValue, system)`
 *
 * `system` is optional and defaults to the generic lists, so a call site that
 * omits it is unchanged rather than silently altered — but every provider
 * vocabulary then skips its branch and reaches the keyword lists, where it
 * matches nothing and reads as ambiguous.
 */
export function isActiveStatus(statusValue: unknown, system = ""): boolean {
  // A numeric 0 must survive this: it is VirtualPay's decline code, and plain
  // falsiness checks swallow it.
  const s = up(statusValue);
  if (!s) return false;
  const sys = String(system ?? "");

  // ── PSP-specific vocabularies ──
  if (sys.includes("Paystrax")) {
    if (s === "ACK") return true;
    if (s === "NOK") return false;
  }
  if (sys.includes("Match2pay")) {
    if (s === "DONE") return true;
    if (s === "NEW" || s === "PENDING") return false;
  }
  if (sys.includes("VirtualPay")) {
    // 1 and 4 are both successes; 0 and 2 are not.
    if (s === "1" || s === "4") return true;
    if (s === "0" || s === "2") return false;
  }
  if (system === "Rapyd") {
    if (s.includes("REFUND") || s.includes("REVERSAL")) return false;
    if (s.includes("PAYMENT")) return true;
  }

  return ACTIVE_KEYWORDS.some((kw) => s === kw || s.includes(kw));
}

/** `_isFailedStatus(statusValue, system)` */
export function isFailedStatus(statusValue: unknown, system = ""): boolean {
  const s = up(statusValue);
  if (!s) return false;
  const sys = String(system ?? "");

  if (sys.includes("Paystrax")) {
    if (s === "NOK") return true;
    if (s === "ACK") return false;
  }
  if (sys.includes("Match2pay")) {
    if (s === "DONE") return false;
  }
  if (sys.includes("VirtualPay")) {
    if (s === "0") return true;
    if (s === "1" || s === "4" || s === "2") return false;
  }

  return FAILED_KEYWORDS.some((kw) => s === kw || s.includes(kw));
}

/**
 * `_isAmbiguousStatus` — neither list claimed it, so no verdict is available.
 *
 * An empty value is ambiguous, not "fine": a blank status is the absence of an
 * answer.
 */
export function isAmbiguousStatus(statusValue: unknown, system = ""): boolean {
  const s = up(statusValue);
  // A blank status is the absence of an answer, not an answer.
  if (!s) return true;
  return !isFailedStatus(s, system) && !isActiveStatus(s, system);
}

/**
 * `_bothFailed` — an agreed decline, which is only assertable when BOTH sides
 * reached a recognised final state. An ambiguous leg blocks it.
 */
export function bothFailed(
  statusA: unknown, systemA: string,
  statusB: unknown, systemB: string,
): boolean {
  if (isAmbiguousStatus(statusA, systemA) || isAmbiguousStatus(statusB, systemB)) return false;
  return isFailedStatus(statusA, systemA) && isFailedStatus(statusB, systemB);
}

/** `_isStatusMismatch` — one side settled success, the other settled failure. */
export function isStatusMismatch(
  statusA: unknown, systemA: string,
  statusB: unknown, systemB: string,
): boolean {
  const aFailed = isFailedStatus(statusA, systemA);
  const bFailed = isFailedStatus(statusB, systemB);
  const aActive = isActiveStatus(statusA, systemA);
  const bActive = isActiveStatus(statusB, systemB);
  return (aActive && bFailed) || (aFailed && bActive);
}

// ── the master's four-state view ──

export type MasterClass = "ACTIVE" | "FAILED" | "PENDING" | "MISSING";

/**
 * `_muClass_`
 *
 * In-flight states must NOT count as pass or fail — they are outvoted by the
 * settled legs. Note that "AWAITING WEBHOOK" appears in the keyword failure
 * list above but is PENDING here, and that difference is deliberate: the layers
 * use it to exclude a row from netting, while the master must not let it
 * masquerade as a decline when deciding whether systems agree.
 */
const PENDING_EXACT = [
  "AWAITING WEBHOOK", "AWAITING_WEBHOOK", "RECONCILIATION", "CHECKOUT",
  "NEW", "PENDING", "PROCESSING", "INITIATED", "CREATED",
  "TIMEOUT", "TIMED OUT", "TIMED_OUT",
];

export function masterClass(text: unknown, system = ""): MasterClass {
  const s = up(text);
  if (!s) return "MISSING";
  if (PENDING_EXACT.includes(s)) return "PENDING";
  if (isFailedStatus(text, system)) return "FAILED";
  if (isActiveStatus(text, system)) return "ACTIVE";
  // Unknown / non-final vocabulary is in-flight, not a verdict.
  return "PENDING";
}
