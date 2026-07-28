// Config-driven reconciliation engine — types.
//
// The whole point: a PSP is *data*, not code. Adding a PSP means adding a
// PspConfig (via the UI); the generic engine reads the config to parse, match
// and classify. No engine code changes when PSPs are added or removed.

export type Row = Record<string, string>;

export type Dataset = {
  headers: string[];
  rows: Row[];
  fileName: string;
};

/** How to read the meaningful fields out of a source file's columns. */
export type FieldMap = {
  /** Candidate columns that hold the matching key(s). First non-empty wins. */
  idCols: string[];
  /** Amount column(s), comma-separated fallbacks allowed (e.g. "Debit,Credit"). */
  amountCol: string;
  currencyCol?: string;
  statusCol?: string;
  typeCol?: string;
  dateCol?: string;
};

/** A single PSP definition. This is the unit users add/remove/edit. */
export type PspConfig = {
  id: string;
  label: string;
  /** "All" or a specific entity label (matched against the cashier shop). */
  entity: string;
  fields: FieldMap;
  /** Extra status synonyms treated as active/failed on top of the built-in keywords. */
  activeStatuses: string[];
  failedStatuses: string[];
  /** Amounts within this absolute tolerance count as matched. */
  amountTolerance: number;
  /** Fuzzy fallback: max minutes between cashier and PSP timestamps. */
  dateWindowMins: number;
  /** Optional type synonyms so a deposit cashier row won't match a withdrawal PSP row. */
  depositTypes?: string[];
  withdrawalTypes?: string[];
  /**
   * Provider/Terminal substrings that route a cashier row to this PSP. Cashier
   * exports often suffix the provider (e.g. "ForumPay_NDP", "MatchTrade_NDP"),
   * so an explicit alias list is more reliable than matching on id/label.
   * Falls back to [id, label] when omitted.
   */
  routeMatch?: string[];
  /** Built-in PSPs ship with the app; user-added ones are false/undefined. */
  builtin?: boolean;
};

export type SourceKind = "crm" | "cashier" | "psp";

export type MatchStatus =
  | "matched"
  | "amount"
  | "status"
  | "needs-review"
  | "unmatched-cashier"
  | "unmatched-psp"
  | "unmatched-crm"
  // ⏭️ informational — excluded from exceptions and match rates
  | "out-of-scope" // internal transfers: no cashier/PSP counterpart exists
  | "agreed-decline" // every settled leg declined; no money moved
  | "incomplete" // never settled, never booked — abandoned attempt
  | "not-reconciled"; // the PSP's settlement file was not uploaded

export type ReconRow = {
  status: MatchStatus;
  /** P1 (act now) → P7 (informational). Drives Action-Center ordering. */
  priority: string;
  entity: string;
  brand: string;
  psp?: string;
  matchKey: string;
  leftId: string; // CRM ref (L1) or cashier id (L2)
  leftAmount: number | null;
  leftCurrency: string;
  leftStatus: string;
  rightId: string; // cashier id (L1) or PSP id (L2)
  rightAmount: number | null;
  rightCurrency: string;
  rightStatus: string;
  diff: number | null;
  note: string;
};

export type LayerStats = {
  total: number;
  matched: number;
  amount: number;
  status: number;
  unmatched: number;
  matchRate: number;
  matchedAmount: number;
  exposure: number;
};

/** A grouped breakdown along any dimension (PSP, brand, entity/cashier). */
export type Breakdown = {
  key: string;
  matched: number;
  amount: number;
  status: number;
  unmatched: number;
  total: number;
  matchRate: number;
  exposure: number;
};

export type MatrixCell = { matched: number; total: number; rate: number; exposure: number };

/** Brand × PSP grid of match health (Layer 2). */
export type ReconMatrix = {
  brands: string[];
  psps: string[];
  cells: Record<string, Record<string, MatrixCell>>;
};

export type ReconOptions = {
  amountTolAbs?: number; // absolute $ tolerance for Layer-1 amount match (default 1)
  amountTolPct?: number; // additional % tolerance (fee/commission netting)
  dateFrom?: string; // ISO/date string — restrict both sources to this window
  dateTo?: string;
};

export type ReconResult = {
  layer1: { rows: ReconRow[]; stats: LayerStats };
  layer2: { rows: ReconRow[]; stats: LayerStats };
  byPsp: Breakdown[];
  byBrand: Breakdown[];
  byEntity: Breakdown[];
  matrix: ReconMatrix;
  exceptions: ReconRow[];
  matched: ReconRow[];
  ranAt: string;
};
