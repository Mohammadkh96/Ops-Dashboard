import { runReconciliation } from "@/lib/recon/engine";
import { DEFAULT_PSPS } from "@/lib/recon/registry";
import type { Dataset } from "@/lib/recon/types";

const ds = (rows: Record<string, string>[]): Dataset => ({
  headers: rows.length ? Object.keys(rows[0]) : [],
  rows,
  fileName: "test.csv",
});

// Two reconcilable payments, plus three the layers cannot see:
//  · a COMPLETED row with no CRM/PSP counterpart      -> must be P1, money moved
//  · an Awaiting Webhook row                          -> never settled
//  · a Declined row with an acquirer malfunction       -> certain, not critical
const cashier = ds([
  { ID: "c1", Type: "DEPOSIT", State: "Completed", Amount: "1.500,00", Currency: "EUR",
    "Reference ID": "R1", Shop: "Cashier_Tradin_SL", Provider: "Paystrax", Terminal: "Paystrax_SL",
    Created: "2026-08-06 00:00:00", Finalized: "2026-08-06 00:05:00", "Error Code": "" },
  { ID: "c2", Type: "DEPOSIT", State: "Declined", Amount: "100,00", Currency: "EUR",
    "Reference ID": "R2", Shop: "Cashier_Tradin_SL", Provider: "Paystrax", Terminal: "Paystrax_SL",
    Created: "2026-08-06 01:00:00", Finalized: "2026-08-06 01:01:00", "Error Code": "3.03 Acquirer Malfunction" },
  { ID: "c3", Type: "DEPOSIT", State: "Completed", Amount: "750,00", Currency: "EUR",
    "Reference ID": "ORPHAN", Shop: "Cashier_Tradin_SL", Provider: "", Terminal: "",
    Created: "2026-08-06 02:00:00", Finalized: "2026-08-06 02:02:00", "Error Code": "" },
  { ID: "c4", Type: "DEPOSIT", State: "Awaiting Webhook", Amount: "200,00", Currency: "EUR",
    "Reference ID": "ORPHAN2", Shop: "Cashier_Tradin_SL", Provider: "ForumPay", Terminal: "ForumPay_SL",
    Created: "2026-08-06 03:00:00", Finalized: "", "Error Code": "" },
  { ID: "c5", Type: "DEPOSIT", State: "Declined", Amount: "50,00", Currency: "EUR",
    "Reference ID": "ORPHAN3", Shop: "Cashier_Tradin_SL", Provider: "ForumPay", Terminal: "ForumPay_SL",
    Created: "2026-08-06 04:00:00", Finalized: "2026-08-06 04:01:00", "Error Code": "3.03 Acquirer Malfunction" },
]);

const crm = ds([
  { "Psp Transaction ID": "c1", "Order No": "", "Merchant Trn Ref": "R1", TransactionType: "DEPOSIT",
    "TransactionStatus Name": "Approved", Amount: "1500.00", Currency: "EUR",
    "Brand Title": "Tradin Global", LastUpdated: "2026-08-06 00:00:00", "Customer No": "CU1" },
  { "Psp Transaction ID": "c2", "Order No": "", "Merchant Trn Ref": "R2", TransactionType: "DEPOSIT",
    "TransactionStatus Name": "Declined", Amount: "100.00", Currency: "EUR",
    "Brand Title": "Tradin Global", LastUpdated: "2026-08-06 01:00:00", "Customer No": "CU2" },
]);

const r = runReconciliation(crm, cashier, DEFAULT_PSPS, {}, new Date("2026-08-21T00:00:00Z").toISOString());

let fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${n.padEnd(50)} got ${JSON.stringify(got)}${ok ? "" : "  want " + JSON.stringify(want)}`);
};

const c = r.completeness;
console.log("completeness:", JSON.stringify({ total: c.total, surfaced: c.surfaced, dropped: c.dropped, balanced: c.balanced }));
eq("books balance", c.balanced, true);
eq("total = file rows", c.total, 5);
eq("surfaced + dropped = total", c.surfaced + c.dropped, c.total);

// Layer 1's leftover pass already reports completed and in-flight cashier rows
// with no counterpart, so those are surfaced, not dropped. What it does not
// report is a declined leftover — benign, but it must still be accounted for.
const l1ById = new Map(r.layer1.rows.filter((x) => x.rightId).map((x) => [x.rightId, x]));
eq("c3 completed, nothing to match = P1", l1ById.get("c3")?.priority, "P1");
eq("c3 amount parsed European", l1ById.get("c3")?.rightAmount, 750);

const byId = new Map(c.rows.map((x) => [x.leftId, x]));
eq("c5 accounted for by the audit", Boolean(byId.get("c5")), true);
eq("c5 declined+malfunction is NOT critical", byId.get("c5")?.priority, "P6");
eq("c5 amount parsed European", byId.get("c5")?.leftAmount, 50);

// The €1,500 payment must reconcile: it only does if the money parser is right.
const l1 = r.layer1.rows.find((x) => x.rightId === "c1");
eq("c1 cashier amount", l1?.rightAmount, 1500);
eq("c1 reconciled (was a 1498.5 mismatch)", l1?.status, "matched");

// A both-declined pair is agreed, not an exception.
eq("c2 agreed decline", r.layer1.rows.find((x) => x.rightId === "c2")?.status, "agreed-decline");

// Dropped rows must reach the queue, or they are hidden again.
// A declined leftover is informational, so it is accounted for without being
// pushed into the action queue as noise.
eq("benign leftover not queued", r.exceptions.filter((x) => x.leftId === "c5").length, 0);
eq("the real gap IS queued", r.exceptions.filter((x) => x.rightId === "c3").length, 1);

// Timing must reach the rows, or the module is dead weight.
const timed = r.layer1.rows.find((x) => x.rightId === "c1");
eq("c1 timing measured", timed?.timing?.totalMins, 5);
eq("c1 not slow", timed?.timing?.slow, false);
eq("c1 speed bucket", timed?.timing?.speed, "fast");

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
