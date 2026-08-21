import { parseMoney } from "@/lib/recon/money";
import { classifyStatus } from "@/lib/recon/status";
import { parseUtc, gap, formatDuration, speedBucket, computeTiming } from "@/lib/recon/timing";
import { isUncertainOutcome } from "@/lib/recon/leaks";

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name.padEnd(52)} got ${JSON.stringify(got)}${ok ? "" : "  want " + JSON.stringify(want)}`);
};

console.log("── money: the Paystrax European-decimal cases ──");
eq("600,00", parseMoney("600,00"), 600);
eq("1.500,00", parseMoney("1.500,00"), 1500);
eq("12.750,50", parseMoney("12.750,50"), 12750.5);
eq("1,500.00 (US)", parseMoney("1,500.00"), 1500);
eq("1.234.567,89", parseMoney("1.234.567,89"), 1234567.89);
eq("1,234 (grouped, no decimals)", parseMoney("1,234"), 1234);
eq("600", parseMoney("600"), 600);
eq("(1.234,00) accounting negative", parseMoney("(1.234,00)"), -1234);
eq("empty", parseMoney(""), 0);

console.log("\n── status: PSP vocabularies ──");
eq("Paystrax ACK", classifyStatus("ACK", "Paystrax SL"), "ACTIVE");
eq("Paystrax NOK", classifyStatus("NOK", "Paystrax SL"), "FAILED");
eq("Match2pay DONE", classifyStatus("DONE", "Match2pay SL"), "ACTIVE");
eq("Match2pay NEW", classifyStatus("NEW", "Match2pay SL"), "PENDING");
eq("VirtualPay 1", classifyStatus("1", "VirtualPay"), "ACTIVE");
eq("VirtualPay 4 (was wrongly FAILED)", classifyStatus("4", "VirtualPay"), "ACTIVE");
eq("VirtualPay 0", classifyStatus("0", "VirtualPay"), "FAILED");
eq("VirtualPay 2", classifyStatus("2", "VirtualPay"), "PENDING");
eq("Awaiting Webhook is in-flight", classifyStatus("Awaiting Webhook", "Cashier"), "PENDING");
eq("Reconciliation is in-flight", classifyStatus("Reconciliation", "Cashier"), "PENDING");
eq("Checkout is in-flight", classifyStatus("Checkout", "Cashier"), "PENDING");
eq("Completed", classifyStatus("Completed", "Cashier"), "ACTIVE");
eq("Declined", classifyStatus("Declined", "Cashier"), "FAILED");

console.log("\n── provider faults: settled vs unsettled ──");
eq("declined + acquirer malfunction = certain", isUncertainOutcome("Declined", "3.03 Acquirer Malfunction"), false);
eq("awaiting + malfunction = uncertain", isUncertainOutcome("Awaiting Webhook", "3.03 Acquirer Malfunction"), true);
eq("error state = uncertain", isUncertainOutcome("Error", ""), true);
eq("completed clean = certain", isUncertainOutcome("Completed", ""), false);

console.log("\n── timing: UTC forcing and sanity bounds ──");
eq("naive read as UTC", parseUtc("2026-08-06 00:01:37")?.toISOString(), "2026-08-06T00:01:37.000Z");
eq("explicit Z honoured", parseUtc("2026-08-06T00:01:37Z")?.toISOString(), "2026-08-06T00:01:37.000Z");
eq("CRM DD/MM/YYYY", parseUtc("06/08/2026 10:30")?.toISOString(), "2026-08-06T10:30:00.000Z");
eq("spreadsheet serial refused", parseUtc("46234"), null);
eq("year 46234 refused", parseUtc("46234-01-01"), null);
eq("gap 90m", gap("2026-08-06 00:00:00", "2026-08-06 01:30:00"), 5400000);
eq("format 90m", formatDuration(5400000), "1h 30m");
eq("format 2d3h", formatDuration(2 * 86400000 + 3 * 3600000), "2d 3h");
eq("format null", formatDuration(null), "—");
eq("speed >24h", speedBucket(25 * 3600000), "very-slow");
eq("speed 5m", speedBucket(5 * 60000), "fast");

const t = computeTiming({
  crmRequested: "2026-08-06 00:00:00",
  crmProcessed: "2026-08-06 00:05:00",
  cashierCreated: "2026-08-06 00:06:00",
  cashierFinalized: "2026-08-07 06:00:00",
  pspRequested: "2026-08-06 00:07:00",
  pspConfirmed: "2026-08-06 00:20:00",
});
eq("total mins", t.totalMins, 1800);
eq("slow flag", t.slow, true);
eq("settle stage", formatDuration(t.stages[2].ms), "1d 5h");
eq("psp confirm stage", formatDuration(t.stages[4].ms), "13m");

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
