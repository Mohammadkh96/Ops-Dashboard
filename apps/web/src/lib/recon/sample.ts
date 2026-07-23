import type { Dataset, Row } from "./types";

// Small, self-consistent sample so the engine is demonstrable on the live demo
// URL without real exports. Produces a mix of matched / amount-mismatch /
// status-mismatch / unmatched outcomes across both layers.

function ds(headers: string[], data: string[][], fileName: string): Dataset {
  const rows: Row[] = data.map((cells) => {
    const o: Row = {};
    headers.forEach((h, i) => (o[h] = cells[i] ?? ""));
    return o;
  });
  return { headers, rows, fileName };
}

export function sampleCrm(): Dataset {
  const headers = ["Psp Transaction ID", "Order No", "TransactionType", "TransactionStatus Name", "Amount", "Currency", "Brand Title", "LastUpdated"];
  return ds(headers, [
    ["REF-1001", "O-1", "Deposit", "Approved", "500", "USD", "Tradin MU", "2026-07-20 10:01"],
    ["REF-1002", "O-2", "Deposit", "Approved", "250", "USD", "Tradin Global", "2026-07-20 11:01"],
    ["REF-1003", "O-3", "Withdrawal", "Approved", "1200", "USD", "Tradin MU", "2026-07-20 12:01"],
    ["REF-1004", "O-4", "Deposit", "Approved", "300", "USD", "Tradin MU", "2026-07-20 13:01"],
    ["REF-1006", "O-6", "Deposit", "Approved", "400", "USD", "Tradin MU", "2026-07-20 14:01"],
  ], "sample_crm.csv");
}

export function sampleCashier(): Dataset {
  const headers = ["ID", "External Id", "Reference ID", "Type", "State", "Amount", "Currency", "Shop", "Provider", "Terminal", "Finalized"];
  return ds(headers, [
    ["PMX1001", "PSX-9001", "REF-1001", "Deposit", "Completed", "500", "USD", "tradin_mu", "Paystrax", "paystrax_mu", "2026-07-20 10:00"],
    ["PMX1002", "FP-8001", "REF-1002", "Deposit", "Completed", "260", "USD", "tradin_sl", "ForumPay", "forumpay_sl", "2026-07-20 11:00"],
    ["PMX1003", "PSX-9003", "REF-1003", "Withdrawal", "Completed", "1200", "USD", "tradin_mu", "Paystrax", "paystrax_mu", "2026-07-20 12:00"],
    ["PMX1004", "PSX-9004", "REF-1004", "Deposit", "Declined", "300", "USD", "tradin_mu", "Paystrax", "paystrax_mu", "2026-07-20 13:00"],
    ["PMX1005", "VP-7001", "REF-1005", "Deposit", "Completed", "999", "USD", "tradin_sl", "VirtualPay", "virtualpay", "2026-07-20 15:00"],
  ], "sample_cashier.csv");
}

export function samplePaystrax(): Dataset {
  const headers = ["UniqueId", "TransactionId", "PaymentType", "Debit", "Credit", "Currency", "Result", "RequestTimestamp"];
  return ds(headers, [
    ["PSX-9001", "PMX1001", "DB", "500", "0", "USD", "APPROVED", "2026-07-20 10:00"],
    ["PSX-9003", "PMX1003", "CD", "1200", "0", "USD", "APPROVED", "2026-07-20 12:00"],
    ["PSX-9004", "PMX1004", "DB", "300", "0", "USD", "DECLINED", "2026-07-20 13:00"],
    ["PSX-9099", "PMXZZ", "DB", "750", "0", "USD", "APPROVED", "2026-07-20 16:00"],
  ], "sample_paystrax.csv");
}

export function sampleForumpay(): Dataset {
  const headers = ["payment id", "pos id", "reference no", "invoice amount", "invoice currency", "type", "confirmed", "cancelled", "date"];
  return ds(headers, [
    ["FP-8001", "", "", "250", "USD", "SELL", "true", "", "2026-07-20 11:00"],
  ], "sample_forumpay.csv");
}
