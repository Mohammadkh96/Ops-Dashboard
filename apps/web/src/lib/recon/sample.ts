import type { Dataset, Row } from "./types";

// Rich, self-consistent sample across several brands and PSPs so the per-brand
// analytics + Brand×PSP matrix are meaningful on the live demo URL. Produces a
// spread of matched / amount-mismatch / status-mismatch / unmatched outcomes.

function ds(headers: string[], data: string[][], fileName: string): Dataset {
  const rows: Row[] = data.map((cells) => {
    const o: Row = {};
    headers.forEach((h, i) => (o[h] = cells[i] ?? ""));
    return o;
  });
  return { headers, rows, fileName };
}

export function sampleCrm(): Dataset {
  const h = ["Psp Transaction ID", "Order No", "TransactionType", "TransactionStatus Name", "Amount", "Currency", "Brand Title", "LastUpdated"];
  return ds(h, [
    ["REF-1001", "O-1", "Deposit", "Approved", "500", "USD", "Tradin MU", "2026-07-20 10:01"],
    ["REF-1002", "O-2", "Deposit", "Approved", "250", "USD", "Tradin Global", "2026-07-20 11:01"],
    ["REF-1003", "O-3", "Withdrawal", "Approved", "1200", "USD", "Tradin MU", "2026-07-20 12:01"],
    ["REF-1004", "O-4", "Deposit", "Approved", "300", "USD", "Tradin Prime", "2026-07-20 13:01"],
    ["REF-1006", "O-6", "Deposit", "Approved", "400", "USD", "Tradin MU", "2026-07-20 14:01"],
    ["REF-1007", "O-7", "Deposit", "Approved", "750", "USD", "Tradin Global", "2026-07-20 15:01"],
    ["REF-1008", "O-8", "Deposit", "Approved", "1500", "USD", "Tradin Prime", "2026-07-20 16:01"],
    ["REF-1009", "O-9", "Withdrawal", "Approved", "2200", "USD", "Tradin VIP", "2026-07-20 17:01"],
    ["REF-1010", "O-10", "Deposit", "Declined", "640", "USD", "Tradin Global", "2026-07-20 18:01"],
  ], "sample_crm.csv");
}

export function sampleCashier(): Dataset {
  const h = ["ID", "External Id", "Reference ID", "Type", "State", "Amount", "Currency", "Shop", "Provider", "Terminal", "Finalized"];
  return ds(h, [
    ["PMX1001", "PSX-9001", "REF-1001", "Deposit", "Completed", "500", "USD", "tradin_mu", "Paystrax", "paystrax_mu", "2026-07-20 10:00"],
    ["PMX1002", "FP-8001", "REF-1002", "Deposit", "Completed", "260", "USD", "tradin_sl", "ForumPay", "forumpay_sl", "2026-07-20 11:00"],
    ["PMX1003", "PSX-9003", "REF-1003", "Withdrawal", "Completed", "1200", "USD", "tradin_mu", "Paystrax", "paystrax_mu", "2026-07-20 12:00"],
    ["PMX1004", "PSX-9004", "REF-1004", "Deposit", "Declined", "300", "USD", "tradin_mu", "Paystrax", "paystrax_mu", "2026-07-20 13:00"],
    ["PMX1005", "VP-7001", "REF-1005", "Deposit", "Completed", "999", "USD", "tradin_sl", "VirtualPay", "virtualpay", "2026-07-20 15:00"],
    ["PMX1007", "M2P-5001", "REF-1007", "Deposit", "Completed", "750", "USD", "tradin_sl", "Match2pay", "match2pay_sl", "2026-07-20 15:00"],
    ["PMX1008", "RPD-3001", "REF-1008", "Deposit", "Completed", "1500", "USD", "tradin_mu", "Rapyd", "rapyd_mu", "2026-07-20 16:00"],
    ["PMX1009", "FP-8009", "REF-1009", "Withdrawal", "Completed", "2200", "USD", "tradin_sl", "ForumPay", "forumpay_sl", "2026-07-20 17:00"],
    ["PMX1010", "M2P-5010", "REF-1010", "Deposit", "Completed", "640", "USD", "tradin_sl", "Match2pay", "match2pay_sl", "2026-07-20 18:00"],
  ], "sample_cashier.csv");
}

export function samplePaystrax(): Dataset {
  const h = ["UniqueId", "TransactionId", "PaymentType", "Debit", "Credit", "Currency", "Result", "RequestTimestamp"];
  return ds(h, [
    ["PSX-9001", "PMX1001", "DB", "500", "0", "USD", "APPROVED", "2026-07-20 10:00"],
    ["PSX-9003", "PMX1003", "CD", "1200", "0", "USD", "APPROVED", "2026-07-20 12:00"],
    ["PSX-9004", "PMX1004", "DB", "300", "0", "USD", "DECLINED", "2026-07-20 13:00"],
    ["PSX-9099", "PMXZZ", "DB", "750", "0", "USD", "APPROVED", "2026-07-20 19:00"],
  ], "sample_paystrax.csv");
}

export function sampleForumpay(): Dataset {
  const h = ["payment id", "pos id", "reference no", "invoice amount", "invoice currency", "type", "confirmed", "cancelled", "date"];
  return ds(h, [
    ["FP-8001", "", "", "250", "USD", "SELL", "true", "", "2026-07-20 11:00"],
    ["FP-8009", "", "", "2200", "USD", "BUY", "true", "", "2026-07-20 17:00"],
  ], "sample_forumpay.csv");
}

export function sampleMatch2pay(): Dataset {
  const h = ["Created", "Modified", "Payment ID", "Status", "Type", "Final amount", "Final currency"];
  return ds(h, [
    ["2026-07-20 15:00", "2026-07-20 15:02", "M2P-5001", "COMPLETED", "DEPOSIT", "750", "USD"],
    ["2026-07-20 18:00", "2026-07-20 18:03", "M2P-5010", "COMPLETED", "DEPOSIT", "640", "USD"],
  ], "sample_match2pay.csv");
}

export function sampleRapyd(): Dataset {
  const h = ["Transaction Type", "Rapyd Reference ID", "Merchant Reference ID", "Presentment Amount", "Presentment Currency", "Action Created At"];
  return ds(h, [
    ["PAYMENT", "RPD-A-3001", "RPD-3001", "1500", "USD", "2026-07-20 16:00"],
  ], "sample_rapyd.csv");
}
