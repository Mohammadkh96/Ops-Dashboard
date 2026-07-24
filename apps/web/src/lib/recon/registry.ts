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
export const DEFAULT_PSPS: PspConfig[] = [
  {
    id: "paystrax",
    label: "Paystrax",
    entity: "All",
    fields: {
      idCols: ["UniqueId", "TransactionId"],
      amountCol: "Debit,Credit",
      currencyCol: "Currency",
      statusCol: "Result",
      typeCol: "PaymentType",
      dateCol: "RequestTimestamp",
    },
    activeStatuses: ["APPROVED", "OK", "SUCCESS"],
    failedStatuses: ["DECLINED", "ERROR"],
    amountTolerance: 0.05,
    dateWindowMins: 180,
    depositTypes: ["DB"],
    withdrawalTypes: ["CD", "RF"],
    routeMatch: ["paystrax"],
    builtin: true,
  },
  {
    id: "forumpay",
    label: "ForumPay",
    entity: "All",
    fields: {
      idCols: ["payment id", "pos id", "reference no"],
      amountCol: "invoice amount,original invoice amount",
      currencyCol: "invoice currency",
      statusCol: "confirmed",
      typeCol: "type",
      dateCol: "confirmed",
    },
    activeStatuses: ["true", "1", "yes", "confirmed"],
    failedStatuses: ["false", "0", "no"],
    amountTolerance: 0.05,
    dateWindowMins: 240,
    depositTypes: ["SELL"],
    withdrawalTypes: ["BUY"],
    routeMatch: ["forumpay"],
    builtin: true,
  },
  {
    id: "match2pay",
    label: "Match2pay",
    entity: "All",
    fields: {
      idCols: ["Payment ID"],
      amountCol: "Final amount,Transaction amount",
      currencyCol: "Final currency",
      statusCol: "Status",
      typeCol: "Type",
      dateCol: "Created",
    },
    activeStatuses: ["COMPLETED", "SUCCESS", "APPROVED"],
    failedStatuses: ["DECLINED", "CANCELLED"],
    amountTolerance: 0.05,
    dateWindowMins: 4320,
    routeMatch: ["match2pay"],
    builtin: true,
  },
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
    label: "VirtualPay",
    entity: "All",
    fields: {
      idCols: ["Transaction Number"],
      amountCol: "Amount",
      currencyCol: "Currency",
      statusCol: "Status",
      typeCol: "Payment Type",
      dateCol: "Date - Time",
    },
    activeStatuses: ["SUCCESS", "COMPLETED", "APPROVED"],
    failedStatuses: ["FAILED", "DECLINED"],
    amountTolerance: 0.5,
    dateWindowMins: 240,
    routeMatch: ["virtualpay"],
    builtin: true,
  },
  // ── Providers seen in the live cashier data but whose settlement export
  // formats aren't yet confirmed. Routing is wired up via routeMatch; the
  // column mappings below are sensible starters — verify/adjust them against
  // the real export in the PSP Registry after the first upload. ──
  {
    id: "matchtrade",
    label: "MatchTrade",
    entity: "All",
    fields: {
      idCols: ["Reference", "Transaction ID", "Payment ID"],
      amountCol: "Amount",
      currencyCol: "Currency",
      statusCol: "Status",
      typeCol: "Type",
      dateCol: "Date",
    },
    activeStatuses: ["COMPLETED", "SUCCESS", "APPROVED", "DONE"],
    failedStatuses: ["FAILED", "DECLINED", "CANCELLED", "REJECTED"],
    amountTolerance: 0.05,
    dateWindowMins: 4320,
    routeMatch: ["matchtrade"],
    builtin: true,
  },
  {
    id: "paymaxis",
    label: "Paymaxis",
    entity: "All",
    fields: {
      idCols: ["Reference Id", "Payment Id", "Merchant Reference"],
      amountCol: "Amount",
      currencyCol: "Currency",
      statusCol: "State",
      typeCol: "Payment Type",
      dateCol: "Created At",
    },
    activeStatuses: ["COMPLETED", "SUCCESS", "APPROVED"],
    failedStatuses: ["FAILED", "DECLINED", "CANCELLED"],
    amountTolerance: 0.05,
    dateWindowMins: 4320,
    routeMatch: ["paymaxis"],
    builtin: true,
  },
  {
    id: "heropayments",
    label: "Hero Payments",
    entity: "All",
    fields: {
      idCols: ["Transaction ID", "Reference"],
      amountCol: "Amount",
      currencyCol: "Currency",
      statusCol: "Status",
      typeCol: "Type",
      dateCol: "Date",
    },
    activeStatuses: ["COMPLETED", "SUCCESS", "APPROVED"],
    failedStatuses: ["FAILED", "DECLINED"],
    amountTolerance: 0.05,
    dateWindowMins: 4320,
    routeMatch: ["heropayments", "hero"],
    builtin: true,
  },
  {
    id: "limepay",
    label: "LimePay",
    entity: "All",
    fields: {
      idCols: ["Transaction ID", "Reference"],
      amountCol: "Amount",
      currencyCol: "Currency",
      statusCol: "Status",
      typeCol: "Type",
      dateCol: "Date",
    },
    activeStatuses: ["COMPLETED", "SUCCESS", "APPROVED"],
    failedStatuses: ["FAILED", "DECLINED"],
    amountTolerance: 0.05,
    dateWindowMins: 4320,
    routeMatch: ["limepay", "lime"],
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
