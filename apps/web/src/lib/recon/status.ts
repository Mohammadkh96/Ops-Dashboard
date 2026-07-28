// Three-state status classification.
//
// The key insight ported from the V12 Apps Script: a leg is not simply
// "active or failed". An in-flight state (Awaiting Webhook, Reconciliation,
// Checkout, Match2pay NEW, ForumPay Pending, a timeout) is NEITHER. Treating
// those as failures manufactures fake status mismatches; treating them as
// successes hides real ones. They must be outvoted by the settled legs, and
// a decline sitting next to an unresolved leg is not a confirmed decline.

import type { PspConfig } from "./types";

export type StatusClass = "ACTIVE" | "FAILED" | "PENDING" | "MISSING";

const up = (v: unknown) => String(v ?? "").toUpperCase().trim();

/** Non-final states: no verdict yet. Checked before the keyword lists. */
const PENDING_EXACT = [
  "AWAITING WEBHOOK", "AWAITING_WEBHOOK", "RECONCILIATION", "CHECKOUT",
  "NEW", "PENDING", "PROCESSING", "INITIATED", "CREATED",
  "TIMEOUT", "TIMED OUT", "TIMED_OUT",
];

const FAILED_KEYWORDS = [
  "CANCEL", "DECLINE", "FAIL", "REJECT", "EXPIRE", "ERROR",
  "CHARGEBACK", "REVERSED", "VOID", "ABORT",
];

const ACTIVE_KEYWORDS = [
  "APPROVED", "APPROVE", "COMPLETED", "COMPLETE", "SUCCESS", "SETTLED",
  "SETTLE", "CONFIRMED", "CONFIRM", "PAID", "PROCESSED", "CAPTURED",
  "AUTHORIZED", "AUTHORISED", "PAYMENT_OUT", "PAYMENT",
  // Crypto processors commonly report a settled transfer as "finished".
  "FINISHED",
];

/**
 * PSP vocabularies that collide with the generic keywords and must win.
 * Keyed by a substring of the system name so "Paystrax SL" still matches.
 */
function systemOverride(s: string, system: string): StatusClass | null {
  const sys = up(system);
  if (sys.includes("PAYSTRAX")) {
    if (s === "ACK") return "ACTIVE";
    if (s === "NOK") return "FAILED";
  }
  if (sys.includes("MATCH2PAY") || sys.includes("MATCHTRADE")) {
    if (s === "DONE") return "ACTIVE";
    if (s === "NEW" || s === "PENDING") return "PENDING";
  }
  if (sys.includes("VIRTUALPAY")) {
    if (s === "1") return "ACTIVE";
    if (s === "4") return "FAILED";
  }
  if (sys.includes("RAPYD")) {
    if (s.includes("REFUND") || s.includes("REVERSAL")) return "FAILED";
    if (s.includes("PAYMENT")) return "ACTIVE";
  }
  return null;
}

/**
 * Classifies a raw status string into one of four states.
 * `system` selects a PSP vocabulary; `cfg` adds user-configured synonyms.
 */
export function classifyStatus(status: string, system = "", cfg?: PspConfig): StatusClass {
  const s = up(status);
  if (!s) return "MISSING";

  const override = systemOverride(s, system || cfg?.label || "");
  if (override) return override;

  if (PENDING_EXACT.includes(s)) return "PENDING";

  // User-configured synonyms beat the generic keyword lists.
  if (cfg?.failedStatuses?.some((k) => up(k) && (s === up(k) || s.includes(up(k))))) return "FAILED";
  if (cfg?.activeStatuses?.some((k) => up(k) && (s === up(k) || s.includes(up(k))))) return "ACTIVE";

  if (FAILED_KEYWORDS.some((k) => s.includes(k))) return "FAILED";
  if (ACTIVE_KEYWORDS.some((k) => s.includes(k))) return "ACTIVE";

  // Unknown / non-final vocabulary is in-flight, not a verdict.
  return "PENDING";
}

export const isActiveClass = (status: string, system = "", cfg?: PspConfig) =>
  classifyStatus(status, system, cfg) === "ACTIVE";
export const isFailedClass = (status: string, system = "", cfg?: PspConfig) =>
  classifyStatus(status, system, cfg) === "FAILED";
