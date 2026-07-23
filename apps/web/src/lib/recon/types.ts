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
  /** Built-in PSPs ship with the app; user-added ones are false/undefined. */
  builtin?: boolean;
};

export type SourceKind = "crm" | "cashier" | "psp";

export type MatchStatus =
  | "matched"
  | "amount"
  | "status"
  | "unmatched-cashier"
  | "unmatched-psp"
  | "unmatched-crm";

export type ReconRow = {
  status: MatchStatus;
  entity: string;
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

export type PspBreakdown = {
  psp: string;
  matched: number;
  amount: number;
  status: number;
  unmatched: number;
  total: number;
  matchRate: number;
};

export type ReconResult = {
  layer1: { rows: ReconRow[]; stats: LayerStats };
  layer2: { rows: ReconRow[]; stats: LayerStats };
  byPsp: PspBreakdown[];
  exceptions: ReconRow[];
  ranAt: string;
};
