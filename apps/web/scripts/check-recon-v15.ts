// Verifies the ported V15 pipeline against the behaviours the Apps Script's own
// comments identify as the ones it had to get right. Each case is a rule from
// the script, not a guess about what the code does.

import { buildReconOne } from "@/lib/recon/v15/master";
import { reconcileCrmVsCashier } from "@/lib/recon/v15/layer1";
import { combine } from "@/lib/recon/v15/master";
import { isActiveStatus, isFailedStatus, isAmbiguousStatus, bothFailed, masterClass } from "@/lib/recon/v15/status";
import { buildDepositFamilies, crmDepositKeys, cashierDepositKeys } from "@/lib/recon/v15/families";
import { num, normalizeKey, cashierAmountShopBase, cashierAmount, normalizeTxType } from "@/lib/recon/v15/values";
import { DEFAULT_PSPS } from "@/lib/recon/registry";
import type { Row } from "@/lib/recon/types";

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name.padEnd(56)} ${JSON.stringify(got)}${ok ? "" : " != " + JSON.stringify(want)}`);
};
const section = (s: string) => console.log(`\n── ${s} ──`);

section("money: the Paystrax European-decimal defect");
eq("600,00", num("600,00"), 600);
eq("1.500,00 (was 1.5)", num("1.500,00"), 1500);
eq("12.750,50", num("12.750,50"), 12750.5);
eq("1,500.00 US", num("1,500.00"), 1500);

section("placeholder keys must not join unrelated rows");
["NULL", "undefined", "NaN", "N/A", "NONE", "-", "0", ""].forEach((k) =>
  eq(`"${k}" is not a key`, normalizeKey(k), ""),
);
eq("a real key survives", normalizeKey(" cu52405_178 "), "CU52405_178");

section("provider vocabularies");
eq("Paystrax ACK active", isActiveStatus("ACK", "Paystrax SL"), true);
eq("Paystrax NOK failed", isFailedStatus("NOK", "Paystrax SL"), true);
eq("Match2pay DONE active", isActiveStatus("DONE", "Match2pay SL"), true);
eq("Match2pay NEW not active", isActiveStatus("NEW", "Match2pay SL"), false);
eq("VirtualPay 1 active", isActiveStatus("1", "VirtualPay"), true);
eq("VirtualPay 4 active", isActiveStatus("4", "VirtualPay"), true);
eq("VirtualPay 0 failed", isFailedStatus("0", "VirtualPay"), true);
eq("VirtualPay 2 neither", isAmbiguousStatus("2", "VirtualPay"), true);
eq("Rapyd REFUND not active", isActiveStatus("REFUND", "Rapyd"), false);
eq("no system: ACK is ambiguous", isAmbiguousStatus("ACK", ""), true);

section("agreement can only be asserted between two final states");
eq("both declined = agreed", bothFailed("Declined", "CRM", "NOK", "Paystrax SL"), true);
eq("declined vs unmapped = NOT agreed", bothFailed("Declined", "CRM", "WEIRD", "Paystrax SL"), false);

section("master four-state view");
eq("Awaiting Webhook is PENDING here", masterClass("Awaiting Webhook", "Cashier"), "PENDING");
eq("...but FAILED to the layers", isFailedStatus("Awaiting Webhook", "Cashier"), true);
eq("Reconciliation PENDING", masterClass("Reconciliation", "Cashier"), "PENDING");
eq("unmapped code PENDING", masterClass("BANANA", "Cashier"), "PENDING");

section("the combine engine");
const C = (o: Partial<Parameters<typeof combine>[0]>) =>
  combine({
    hasCRM: true, hasCash: true, hasPSP: true,
    crm: "ACTIVE", cash: "ACTIVE", psp: "ACTIVE",
    l1diff: 0, l2diff: 0, pspExpected: true, crmExpected: true, ...o,
  });
eq("success + failure = P1 conflict", C({ psp: "FAILED" }).priority, "P1");
eq("failure + unresolved = needs review", C({ crm: "FAILED", cash: "PENDING", psp: "MISSING", hasPSP: false }).status, "⚠️ Needs Review (unconfirmed vs decline)");
eq("all failed = agreed decline", C({ crm: "FAILED", cash: "FAILED", psp: "FAILED" }).status, "⏭️ Agreed Decline");
eq("nothing settled, no CRM = incomplete", C({ hasCRM: false, crm: "MISSING", cash: "PENDING", psp: "PENDING" }).status, "⏭️ Incomplete");
eq("nothing settled, CRM booked = review", C({ crm: "PENDING", cash: "PENDING", psp: "PENDING" }).status, "⚠️ Needs Review");
eq("cashier paid, no CRM = missing in CRM", C({ hasCRM: false, crm: "MISSING" }).status, "❌ Missing in CRM");
eq("cashier paid, no PSP = missing in PSP", C({ hasPSP: false, psp: "MISSING" }).status, "❌ Missing in PSP");
eq("cashier paid, CRM not final", C({ crm: "PENDING" }).status, "⚠️ Needs Review (CRM not final)");
eq("cashier paid, PSP not final", C({ psp: "PENDING" }).status, "⚠️ Needs Review (PSP not final)");
eq("all agree = reconciled", C({}).status, "✅ Reconciled");
eq("L1 amount gap", C({ l1diff: 5 }).status, "⚠️ Amount Mismatch (CRM↔Cash)");
eq("L2 amount gap", C({ l2diff: 0.5 }).status, "⚠️ Amount Mismatch (Cash↔PSP)");
eq("under L1 tolerance is fine", C({ l1diff: 0.5 }).status, "✅ Reconciled");

section("deposit identifier families");
const famCrm: Row[] = [{ "Psp Transaction ID": "PSP-1", "Order No": "ORD-1", "Merchant Trn Ref": "" }];
const famCash: Row[] = [{ "Reference ID": "ORD-1", ID: "CASH-1" }];
const fams = buildDepositFamilies(famCrm, famCash);
eq("CRM and cashier land in one family",
  fams.idForKeys(crmDepositKeys(famCrm[0])) === fams.idForKeys(cashierDepositKeys(famCash[0])), true);
eq("family exposes the whole alias chain",
  fams.keysFor(crmDepositKeys(famCrm[0])).sort(), ["CASH-1", "ORD-1", "PSP-1"]);

section("amount bases: shop-base for L1, transaction for L2");
const dual: Row = { Amount: "100.00", "Amount in Shop Base Currency": "85.64" };
eq("L1 uses shop base", cashierAmountShopBase(dual), 85.64);
eq("L2 uses transaction", cashierAmount(dual), 100);
eq("L1 falls back when shop base blank", cashierAmountShopBase({ Amount: "42" }), 42);

section("ForumPay type inversion");
eq("SELL is a deposit", normalizeTxType("SELL", "ForumPay"), "DEPOSIT");
eq("BUY is a withdrawal", normalizeTxType("BUY", "ForumPay"), "WITHDRAWAL");
eq("Paystrax DB deposit", normalizeTxType("DB", "Paystrax"), "DEPOSIT");
eq("Paystrax RF withdrawal", normalizeTxType("RF", "Paystrax"), "WITHDRAWAL");

section("withdrawal legs aggregate against one gross row");
const wCrm: Row[] = [
  { "Withdrawal Psp Transaction ID": "W1", TransactionType: "WITHDRAWAL", "TransactionStatus Name": "Approved",
    Amount: "241.30", Currency: "USD", "Brand Title": "Tradin Global", LastUpdated: "2026-08-06 10:00:00", "Customer No": "CU1" },
  { "Withdrawal Psp Transaction ID": "W1", TransactionType: "WITHDRAWAL", "TransactionStatus Name": "Approved",
    Amount: "8.70", Currency: "USD", "Brand Title": "Tradin Global", LastUpdated: "2026-08-06 10:00:00", "Customer No": "CU1" },
];
const wCash: Row[] = [
  { ID: "CW1", Type: "WITHDRAWAL", State: "Completed", Amount: "250.00", Currency: "USD",
    "Reference ID": "W1", Shop: "Cashier_Tradin_SL", Provider: "ForumPay", Created: "2026-08-06 10:01:00", Finalized: "2026-08-06 10:05:00" },
];
const wRows = reconcileCrmVsCashier(wCrm, wCash);
const wr = wRows.find((r) => r.cashierId === "CW1");
eq("two legs summed to the gross", wr?.crmAmount, 250);
eq("aggregated withdrawal matches", wr?.matchStatus, "✅ Matched");
eq("one row, not two", wRows.filter((r) => r.crmType === "WITHDRAWAL").length, 1);
eq("note explains the netting", wr?.notes.includes("Aggregated 2 CRM withdrawal legs"), true);

section("the CRM↔Cashier blind spot V10 was written for");
const bsCrm: Row[] = [
  { "Psp Transaction ID": "D1", TransactionType: "DEPOSIT", "TransactionStatus Name": "Approved",
    Amount: "100.00", Currency: "USD", "Brand Title": "Tradin Global", LastUpdated: "2026-08-06 09:00:00", "Customer No": "CU9" },
];
const bsCash: Row[] = [
  { ID: "X1", Type: "DEPOSIT", State: "Declined", Amount: "100.00", Currency: "USD",
    "Reference ID": "D1", Shop: "Cashier_Tradin_SL", Provider: "Paystrax", Created: "2026-08-06 09:00:00", Finalized: "2026-08-06 09:01:00" },
];
const bs = buildReconOne(bsCrm, bsCash, DEFAULT_PSPS, {}, new Set());
const conflict = bs.rows.find((r) => r.status.includes("Status Mismatch"));
eq("approved in CRM, declined in Paymaxis = P1", conflict?.priority, "P1");
eq("exposure is the money at risk", conflict?.exposure, 100);
eq("and it carries an action", Boolean(conflict?.action), true);

section("a settled decline agreed by both sides is not an issue");
const okCrm: Row[] = [
  { "Psp Transaction ID": "D2", TransactionType: "DEPOSIT", "TransactionStatus Name": "Declined",
    Amount: "50.00", Currency: "USD", "Brand Title": "Tradin", LastUpdated: "2026-08-06 09:00:00", "Customer No": "CU8" },
];
const okCash: Row[] = [
  { ID: "X2", Type: "DEPOSIT", State: "Declined", Amount: "50.00", Currency: "USD",
    "Reference ID": "D2", Shop: "Cashier_Tradin_MU", Provider: "Paystrax", Created: "2026-08-06 09:00:00", Finalized: "2026-08-06 09:01:00" },
];
const okRun = buildReconOne(okCrm, okCash, DEFAULT_PSPS, {}, new Set());
eq("no P1/P2/P3 raised", okRun.kpis.p1 + okRun.kpis.p2 + okRun.kpis.p3, 0);
eq("books still balance", okRun.completeness.balanced, true);

section("completeness: every cashier row accounted for");
const cCash: Row[] = [
  { ID: "K1", Type: "DEPOSIT", State: "Completed", Amount: "900.00", Currency: "USD",
    "Reference ID": "NOPE", Shop: "Cashier_Tradin_SL", Provider: "Paystrax", Created: "2026-08-06 01:00:00", Finalized: "2026-08-06 01:02:00" },
  { ID: "K2", Type: "DEPOSIT", State: "Declined", Amount: "10.00", Currency: "USD",
    "Reference ID": "NOPE2", Shop: "Cashier_Tradin_SL", Provider: "Paystrax", Created: "2026-08-06 02:00:00", Finalized: "2026-08-06 02:01:00",
    "Error Code": "3.03 Acquirer Malfunction" },
  { ID: "K3", Type: "DEPOSIT", State: "Awaiting Webhook", Amount: "20.00", Currency: "USD",
    "Reference ID": "NOPE3", Shop: "Cashier_Tradin_SL", Provider: "", Terminal: "", Created: "2026-08-06 03:00:00" },
];
const cRun = buildReconOne([], cCash, DEFAULT_PSPS, {}, new Set());
eq("surfaced + dropped = file rows", cRun.completeness.surfaced + cRun.completeness.dropped, 3);
eq("balanced", cRun.completeness.balanced, true);
const k2 = cRun.rows.find((r) => r.cashierId === "K2");
eq("declined + malfunction is NOT critical", k2?.priority, "P6");
const k1 = cRun.rows.find((r) => r.cashierId === "K1");
eq("completed but unreconciled IS critical", k1?.priority, "P1");
eq("...and says so", k1?.audit, "Real gap — money moved, no recon row");

section("a PSP file that was not uploaded is not the data's fault");
const nrCash: Row[] = [
  { ID: "N1", Type: "DEPOSIT", State: "Completed", Amount: "70.00", Currency: "USD",
    "Reference ID": "R9", Shop: "Cashier_Tradin_SL", Provider: "Paystrax", Terminal: "Paystrax_SL",
    Created: "2026-08-06 01:00:00", Finalized: "2026-08-06 01:02:00" },
];
const paystraxSl = DEFAULT_PSPS.find((p) => p.id === "paystrax_sl");
const nrCrm: Row[] = [
  { "Psp Transaction ID": "N1", TransactionType: "DEPOSIT", "TransactionStatus Name": "Approved",
    Amount: "70.00", Currency: "USD", "Brand Title": "Tradin Global", LastUpdated: "2026-08-06 01:00:00", "Customer No": "CU7" },
];
const nrData = { [paystraxSl!.id]: [{ UniqueId: "unrelated" } as Row] };

// CRM and Paymaxis agree but the provider file is absent: never claim a missing
// PSP record, and never claim the chain is verified either.
const nrRun = buildReconOne(nrCrm, nrCash, DEFAULT_PSPS, nrData, new Set());
const n1 = nrRun.rows.find((r) => r.cashierId === "N1");
eq("not blamed as Missing in PSP", n1?.status.includes("Missing in PSP"), false);
eq("reported Not Reconciled", n1?.status, "⏭️ Not Reconciled");
eq("excluded from the match rate", nrRun.kpis.inScope, 0);
eq("and says why", n1?.notes.includes("was not uploaded for this period"), true);

// The same row with no CRM booking is still a P1: that finding does not depend
// on the provider file.
const nrRun2 = buildReconOne([], nrCash, DEFAULT_PSPS, nrData, new Set());
eq("a real CRM gap survives", nrRun2.rows.find((r) => r.cashierId === "N1")?.status, "❌ Missing in CRM");

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
