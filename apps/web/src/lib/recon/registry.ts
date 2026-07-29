import type { FieldMap, PspConfig } from "./types";

// ── Fixed source mappings (CRM + Cashier are the two anchors) ──
// These mirror the columns the V10/V11 Apps Script reads. PSPs, by contrast,
// are fully config-driven (see DEFAULT_PSPS + user-added configs).

export const CRM_MAP: FieldMap & { entityCol: string } = {
  idCols: ["Psp Transaction ID", "Merchant Trn Ref", "Order No", "Withdrawal Psp Transaction ID"],
  amountCol: "Amount",
  currencyCol: "Currency",
  statusCol: "TransactionStatus Name",
  typeCol: "TransactionType",
  dateCol: "LastUpdated",
  entityCol: "Brand Title",
};

export const CASHIER_MAP: FieldMap & { entityCol: string } = {
  idCols: ["ID", "External Id", "Reference ID", "Customer Reference ID"],
  amountCol: "Amount,Amount in Shop Base Currency",
  currencyCol: "Currency",
  statusCol: "State",
  typeCol: "Type",
  dateCol: "Finalized",
  entityCol: "Shop",
};

// ── Built-in PSP registry (seed). Users can edit/remove these and add their own. ──
//
// Paystrax, ForumPay and Match2pay settle SEPARATELY per entity, so each has
// its own config and therefore its own upload slot — mirroring the production
// import catalog (Paystrax_SL / Paystrax_MU, ...). Rapyd, Beem and VirtualPay
// are shared across entities ("All"). VirtualPay refunds arrive as a distinct
// report, so they are a distinct source.
//
// Routing is entity-aware: a cashier row's Shop decides whether it goes to the
// Saint Lucia or the Mauritius config (see routePsp in engine.ts).

const PAYSTRAX_FIELDS: FieldMap = {
  idCols: ["UniqueId", "TransactionId"],
  amountCol: "Debit,Credit",
  currencyCol: "Currency",
  statusCol: "Result",
  typeCol: "PaymentType",
  dateCol: "RequestTimestamp",
};

const FORUMPAY_FIELDS: FieldMap = {
  idCols: ["payment id", "pos id", "reference no"],
  amountCol: "invoice amount,original invoice amount",
  currencyCol: "invoice currency",
  statusCol: "confirmed",
  typeCol: "type",
  // Event date: when it settled, else when it was cancelled, else created.
  dateCol: "confirmed,cancelled,date",
};

const MATCH2PAY_FIELDS: FieldMap = {
  idCols: ["Payment ID"],
  amountCol: "Final amount,Transaction amount",
  currencyCol: "Final currency",
  statusCol: "Status",
  typeCol: "Type",
  dateCol: "Created",
};

export const DEFAULT_PSPS: PspConfig[] = [
  // ── ForumPay (crypto) — per entity ──
  {
    id: "forumpay_sl",
    label: "ForumPay — Saint Lucia",
    entity: "Saint Lucia",
    fields: { ...FORUMPAY_FIELDS },
    activeStatuses: ["true", "1", "yes", "confirmed"],
    failedStatuses: ["false", "0", "no", "cancelled"],
    // ForumPay records datetimes, not status words: a value in `confirmed`
    // means settled, a value in `cancelled` means cancelled, neither = pending.
    statusWhenSet: { active: "confirmed", failed: "cancelled" },
    amountTolerance: 0.05,
    dateWindowMins: 240,
    depositTypes: ["SELL"],
    withdrawalTypes: ["BUY"],
    routeMatch: ["forumpay", "forum", "crypto"],
    builtin: true,
  },
  {
    id: "forumpay_mu",
    label: "ForumPay — Mauritius",
    entity: "Mauritius",
    fields: { ...FORUMPAY_FIELDS },
    activeStatuses: ["true", "1", "yes", "confirmed"],
    failedStatuses: ["false", "0", "no", "cancelled"],
    // ForumPay records datetimes, not status words: a value in `confirmed`
    // means settled, a value in `cancelled` means cancelled, neither = pending.
    statusWhenSet: { active: "confirmed", failed: "cancelled" },
    amountTolerance: 0.05,
    dateWindowMins: 240,
    depositTypes: ["SELL"],
    withdrawalTypes: ["BUY"],
    routeMatch: ["forumpay", "forum", "crypto"],
    builtin: true,
  },
  // ── Match2pay — per entity. The cashier reports this provider as
  //    "MatchTrade_NDP" (terminal "MT_..."), so those are routing aliases. ──
  {
    id: "match2pay_sl",
    label: "Match2pay — Saint Lucia",
    entity: "Saint Lucia",
    fields: { ...MATCH2PAY_FIELDS },
    activeStatuses: ["DONE", "COMPLETED", "SUCCESS", "APPROVED"],
    failedStatuses: ["DECLINED", "CANCELLED", "REJECTED"],
    amountTolerance: 0.05,
    dateWindowMins: 4320,
    routeMatch: ["match2pay", "matchtrade", "mt"],
    builtin: true,
  },
  {
    id: "match2pay_mu",
    label: "Match2pay — Mauritius",
    entity: "Mauritius",
    fields: { ...MATCH2PAY_FIELDS },
    activeStatuses: ["DONE", "COMPLETED", "SUCCESS", "APPROVED"],
    failedStatuses: ["DECLINED", "CANCELLED", "REJECTED"],
    amountTolerance: 0.05,
    dateWindowMins: 4320,
    routeMatch: ["match2pay", "matchtrade", "mt"],
    builtin: true,
  },
  // ── Paystrax (cards) — per entity ──
  {
    id: "paystrax_sl",
    label: "Paystrax — Saint Lucia",
    entity: "Saint Lucia",
    fields: { ...PAYSTRAX_FIELDS },
    activeStatuses: ["ACK", "APPROVED", "OK", "SUCCESS"],
    failedStatuses: ["NOK", "DECLINED", "ERROR"],
    amountTolerance: 0.05,
    dateWindowMins: 180,
    depositTypes: ["DB"],
    withdrawalTypes: ["CD", "RF"],
    routeMatch: ["paystrax"],
    builtin: true,
  },
  {
    id: "paystrax_mu",
    label: "Paystrax — Mauritius",
    entity: "Mauritius",
    fields: { ...PAYSTRAX_FIELDS },
    activeStatuses: ["ACK", "APPROVED", "OK", "SUCCESS"],
    failedStatuses: ["NOK", "DECLINED", "ERROR"],
    amountTolerance: 0.05,
    dateWindowMins: 180,
    depositTypes: ["DB"],
    withdrawalTypes: ["CD", "RF"],
    routeMatch: ["paystrax"],
    builtin: true,
  },
  // ── Shared across entities ──
  {
    id: "rapyd",
    label: "Rapyd",
    entity: "All",
    fields: {
      idCols: ["Merchant Reference ID", "Rapyd Reference ID"],
      amountCol: "Presentment Amount",
      currencyCol: "Presentment Currency",
      statusCol: "Transaction Type",
      typeCol: "Transaction Type",
      dateCol: "Action Created At",
    },
    activeStatuses: ["PAYMENT"],
    failedStatuses: ["REFUND", "REVERSAL"],
    amountTolerance: 0.05,
    dateWindowMins: 7200,
    routeMatch: ["rapyd"],
    builtin: true,
  },
  {
    id: "beem",
    label: "Beem",
    entity: "All",
    fields: {
      idCols: ["Transaction ID"],
      amountCol: "Display Actual Amount,Paid Amount",
      currencyCol: "Display Currency,Paid Amount Currency",
      statusCol: "Payment Status",
      typeCol: "Transaction Type",
      dateCol: "Date Created",
    },
    activeStatuses: ["COMPLETED", "SUCCESS", "PAYMENT_OUT"],
    failedStatuses: ["FAILED"],
    amountTolerance: 0.05,
    dateWindowMins: 4320,
    routeMatch: ["beem"],
    builtin: true,
  },
  {
    id: "virtualpay",
    label: "VirtualPay — Transactions",
    entity: "All",
    fields: {
      idCols: ["Transaction Number"],
      amountCol: "Amount",
      currencyCol: "Currency",
      statusCol: "Status",
      typeCol: "Payment Type",
      dateCol: "Date - Time",
    },
    activeStatuses: ["1", "SUCCESS", "COMPLETED", "APPROVED"],
    failedStatuses: ["4", "FAILED", "DECLINED"],
    amountTolerance: 0.5,
    dateWindowMins: 240,
    routeMatch: ["virtualpay"],
    builtin: true,
  },
  {
    // Refunds are a separate VirtualPay report keyed on REF ID; a refund is a
    // withdrawal-side flow, so it must never match a deposit.
    id: "virtualpay_refunds",
    label: "VirtualPay — Refunds",
    entity: "All",
    fields: {
      idCols: ["REF ID", "Transaction Number"],
      amountCol: "Refund Amount",
      currencyCol: "Currency",
      statusCol: "Refund Status",
      typeCol: "",
      dateCol: "Refund Completion Date,Transaction Date",
    },
    activeStatuses: ["SUCCESS", "COMPLETED"],
    failedStatuses: ["FAILED", "DECLINED", "REJECTED"],
    amountTolerance: 0.5,
    dateWindowMins: 7200,
    withdrawalTypes: ["Refund"],
    routeMatch: ["virtualpay"],
    builtin: true,
  },
  {
    // Crypto processor (provider "Heropayments", terminal "HP_Tradin"). Its
    // Order ID is the cashier's transaction ID, so exact matching works. Amounts
    // are compared in the account currency (USD) — NOT the crypto or USDT
    // columns, which differ by the conversion rate and the network fee. Status
    // "finished" means settled; dates arrive as DD.MM.YY.
    id: "heropayments",
    label: "Hero Payments",
    entity: "All",
    fields: {
      idCols: ["Order ID", "Transaction ID", "Internal ID"],
      amountCol: "Client amount (account),Client amount (USDT)",
      currencyCol: "Account currency",
      statusCol: "Status",
      typeCol: "Transaction type",
      dateCol: "Date (GMT+0),Last update",
    },
    activeStatuses: ["finished"],
    failedStatuses: ["cancelled", "canceled", "failed", "expired", "error", "rejected", "declined"],
    amountTolerance: 0.05,
    dateWindowMins: 4320,
    depositTypes: ["deposit"],
    withdrawalTypes: ["withdrawal"],
    routeMatch: ["heropayments", "hero", "hptradin"],
    builtin: true,
  },
];

const STORAGE_KEY = "opsos.recon.psps";

export function loadPsps(): PspConfig[] {
  if (typeof window === "undefined") return DEFAULT_PSPS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PSPS;
    const parsed = JSON.parse(raw) as PspConfig[];
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_PSPS;
    return parsed;
  } catch {
    return DEFAULT_PSPS;
  }
}

export function savePsps(psps: PspConfig[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(psps));
  } catch {
    /* storage unavailable */
  }
}

export function resetPsps() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Validates that a PSP's configured columns actually exist in an uploaded
 * file's headers. Returns the list of missing columns (empty = all present).
 */
export function missingColumns(cfg: PspConfig, headers: string[]): string[] {
  const have = new Set(headers.map((h) => h.toLowerCase().trim()));
  const missing: string[] = [];
  const need = (spec: string | undefined, labelName: string) => {
    if (!spec) return;
    const any = spec.split(",").map((s) => s.trim()).filter(Boolean);
    if (any.length && !any.some((c) => have.has(c.toLowerCase()))) missing.push(labelName);
  };
  // at least one id column must be present
  if (cfg.fields.idCols.length && !cfg.fields.idCols.some((c) => have.has(c.toLowerCase()))) {
    missing.push("match key");
  }
  need(cfg.fields.amountCol, "amount");
  need(cfg.fields.statusCol, "status");
  return missing;
}

export type UploadTarget = { key: string; label: string; group: string };

/** Every slot a file can be assigned to, grouped for the picker. */
export function uploadTargets(psps: PspConfig[]): UploadTarget[] {
  return [
    { key: "crm", label: "CRM export", group: "Core" },
    { key: "cashier", label: "Cashier / Paymaxis", group: "Core" },
    ...psps.map((p) => ({ key: p.id, label: p.label, group: "PSP" })),
  ];
}

const CORE_SIGNATURES: Record<string, string[]> = {
  crm: ["TransactionType", "TransactionStatus Name", "Brand Title", "Psp Transaction ID", "Merchant Trn Ref"],
  cashier: ["ID", "State", "Reference ID", "Shop", "Provider", "External Id"],
};

/**
 * Guesses which source an uploaded file is, from its headers.
 *
 * Returns EVERY target that ties for the best score, because per-entity
 * configs are genuinely indistinguishable by header alone — a ForumPay Saint
 * Lucia export and a ForumPay Mauritius export have identical columns. The
 * format can be detected; the entity cannot, so the operator picks it.
 */
export function detectTargets(headers: string[], psps: PspConfig[]): { keys: string[]; label: string } {
  const have = new Set(headers.map((h) => h.toLowerCase().trim()));
  const score = (cols: (string | undefined)[]) => {
    const uniq = [
      ...new Set(
        cols.flatMap((c) => (c ?? "").split(",")).map((c) => c.trim().toLowerCase()).filter(Boolean),
      ),
    ];
    if (!uniq.length) return 0;
    return uniq.filter((c) => have.has(c)).length / uniq.length;
  };

  const cands: { key: string; label: string; s: number }[] = [];
  Object.entries(CORE_SIGNATURES).forEach(([k, cols]) =>
    cands.push({ key: k, label: k === "crm" ? "CRM export" : "Cashier / Paymaxis", s: score(cols) }),
  );
  psps.forEach((p) =>
    cands.push({
      key: p.id,
      label: p.label,
      s: score([...p.fields.idCols, p.fields.amountCol, p.fields.statusCol]),
    }),
  );

  const best = Math.max(0, ...cands.map((c) => c.s));
  if (best < 0.6) return { keys: [], label: "" };
  const winners = cands.filter((c) => c.s === best);
  // Strip the entity suffix so "ForumPay — Saint Lucia" reads as "ForumPay".
  return { keys: winners.map((c) => c.key), label: winners[0].label.split(" — ")[0] };
}

export function emptyPsp(): PspConfig {
  return {
    id: "",
    label: "",
    entity: "All",
    fields: { idCols: [], amountCol: "", currencyCol: "", statusCol: "", typeCol: "", dateCol: "" },
    activeStatuses: [],
    failedStatuses: [],
    amountTolerance: 0.05,
    dateWindowMins: 240,
    builtin: false,
  };
}
