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
