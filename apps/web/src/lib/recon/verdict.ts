// Combined status engine — one verdict per transaction chain.
//
// Ported from the V12 unified master. CRM and the PSP are the sources of
// truth; the cashier row is the router. The rules, in order:
//
//   1.  something succeeded AND something failed        → real conflict (P1)
//   1b. a failure next to an UNRESOLVED leg             → not a confirmed
//       decline; a human must verify no money moved     → needs review (P3)
//   2.  every settled leg failed                        → agreed decline (out)
//   3.  nothing settled and the CRM never booked it     → incomplete (out)
//   4.  nothing settled but the CRM booked it           → needs review (P3)
//   5.  the router says completed                       → an expected
//       authoritative leg that is entirely absent is a real gap
//   6.  two independent systems confirm                 → reconciled
//   7.  one lone active leg, router in flight           → needs review

import type { MatchStatus } from "./types";
import type { StatusClass } from "./status";

export type Priority = "P1" | "P2" | "P3" | "P5" | "P6" | "P7";

export type Verdict = { status: MatchStatus; priority: Priority; reason: string };

export type VerdictInput = {
  crm: StatusClass;
  cash: StatusClass;
  psp: StatusClass;
  hasCRM: boolean;
  hasCash: boolean;
  hasPSP: boolean;
  /** CRM ↔ Cashier amount difference. */
  l1diff: number;
  /** Cashier ↔ PSP amount difference. */
  l2diff: number;
  tolL1: number;
  tolL2: number;
  /** Only deposits/withdrawals are booked in the CRM — refunds legitimately are not. */
  crmExpected: boolean;
  /** True only when the cashier row was actually routed to a PSP. */
  pspExpected: boolean;
};

export function combineVerdict(o: VerdictInput): Verdict {
  const crm = o.hasCRM ? o.crm : "MISSING";
  const psp = o.hasPSP ? o.psp : "MISSING";
  const cash = o.hasCash ? o.cash : "MISSING";

  const l1Bad = o.hasCRM && o.hasCash && Math.abs(o.l1diff) >= o.tolL1;
  const l2Bad = o.hasCash && o.hasPSP && Math.abs(o.l2diff) > o.tolL2;
  const amtOK = !l1Bad && !l2Bad;

  const okOrAmt = (): Verdict => {
    if (amtOK) return { status: "matched", priority: "P5", reason: "All present legs agree" };
    if (l1Bad)
      return { status: "amount", priority: "P2", reason: `CRM ↔ Cashier differ by ${round(o.l1diff)}` };
    return { status: "amount", priority: "P2", reason: `Cashier ↔ PSP differ by ${round(o.l2diff)}` };
  };

  const legs = [crm, psp, cash].filter((c) => c !== "MISSING");
  const active = legs.filter((c) => c === "ACTIVE").length;
  const failed = legs.filter((c) => c === "FAILED").length;
  const pending = legs.filter((c) => c === "PENDING").length;

  // 1 — genuine conflict: one system settled success, another settled failure.
  if (active > 0 && failed > 0)
    return { status: "status", priority: "P1", reason: "One system approved it while another declined it" };

  // 1b — a decline beside an unresolved leg is not a confirmed decline.
  if (active === 0 && failed > 0 && pending > 0)
    return {
      status: "needs-review",
      priority: "P3",
      reason: "Declined on one side but another leg never reached a final state — confirm no money moved",
    };

  // 2 — every settled leg failed and nothing is unresolved: clean decline.
  if (active === 0 && failed > 0)
    return { status: "agreed-decline", priority: "P6", reason: "All systems agree it was declined — no money moved" };

  // 3/4 — nothing has settled at all.
  if (active === 0 && failed === 0) {
    if (!o.hasCRM)
      return {
        status: "incomplete",
        priority: "P7",
        reason: "Never settled and never booked in the CRM — abandoned attempt, not a discrepancy",
      };
    return { status: "needs-review", priority: "P3", reason: "CRM booked it but no leg has reached a final state" };
  }

  // 5 — the router says completed, so an expected leg that is absent is a gap.
  if (cash === "ACTIVE") {
    if (o.crmExpected && !o.hasCRM)
      return { status: "unmatched-cashier", priority: "P1", reason: "Cashier completed it but the CRM has no record" };
    if (o.pspExpected && !o.hasPSP)
      return { status: "unmatched-psp", priority: "P2", reason: "Cashier completed it but the PSP has no record" };
    return okOrAmt();
  }

  // 6 — two independent systems confirm.
  if (active >= 2) return okOrAmt();

  // 7 — a lone active leg with the router still in flight.
  return { status: "needs-review", priority: "P3", reason: "Only one system confirms it; the cashier leg is unresolved" };
}

const round = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** ⏭️ statuses are informational: excluded from exceptions and match rates. */
export const INFORMATIONAL: ReadonlySet<MatchStatus> = new Set<MatchStatus>([
  "out-of-scope",
  "agreed-decline",
  "incomplete",
  "not-reconciled",
]);

export const isInformational = (s: MatchStatus) => INFORMATIONAL.has(s);

export function priorityOf(status: MatchStatus): Priority {
  switch (status) {
    case "status":
    case "unmatched-cashier":
      return "P1";
    case "amount":
    case "unmatched-psp":
    case "unmatched-crm":
      return "P2";
    case "needs-review":
      return "P3";
    case "matched":
      return "P5";
    case "out-of-scope":
    case "agreed-decline":
      return "P6";
    default:
      return "P7";
  }
}
