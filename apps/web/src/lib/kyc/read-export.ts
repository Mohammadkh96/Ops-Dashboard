import type { Row } from "@/lib/recon/types";

/**
 * A KYC provider's export, reduced to what the dashboard needs.
 *
 * WHAT IS DELIBERATELY THROWN AWAY, here in the browser, before any request is
 * made: names, dates of birth, gender, email, phone, tax ids, passport and
 * document numbers, issuing authorities, full addresses, device ids. A real
 * export carries all of it and none of it is needed to know who is verified.
 * A KYC record should not travel further than the job requires, and the job
 * requires an id, an account reference and a verdict.
 *
 * It also solves the size problem by accident and completely: a 200MB export
 * becomes a few hundred KB of ten columns, which is why this reads the file
 * where it already is rather than uploading it.
 */

export type VerificationRow = {
  verificationId: string;
  applicantId: string | null;
  externalApplicantId: string | null;
  status: string;
  at: string | null;
  form: string | null;
  method: string | null;
  declineReasons: string[];
  priceEur: number | null;
  processingMin: number | null;
};

export type DetectedColumns = {
  verificationId: string | null;
  applicantId: string | null;
  externalApplicantId: string | null;
  status: string | null;
  at: string | null;
  form: string | null;
  method: string | null;
  declineReasons: string | null;
  priceEur: string | null;
  processingMin: string | null;
};

/**
 * Header hints, exact match first and then substring.
 *
 * ORDER MATTERS between the two applicant columns, and getting it wrong is
 * silent. "External applicant ID" CONTAINS "applicant id", so a substring pass
 * that looks for the applicant first claims the external column and the join
 * key is then read as the provider's own id — an import that stores everything
 * and links nothing. External is therefore resolved first and its header is
 * withheld from the second search.
 */
const HINTS: Record<keyof DetectedColumns, string[]> = {
  verificationId: ["verification id", "verification_id", "verification"],
  externalApplicantId: [
    "external applicant id",
    "external_applicant_id",
    "external id",
    "client id",
    "reference",
  ],
  applicantId: ["applicant id", "applicant_id", "applicant"],
  status: ["status", "state", "result"],
  at: ["date", "created", "created at", "timestamp", "when"],
  form: ["form"],
  method: ["method", "check type"],
  declineReasons: ["decline reasons", "decline_reasons", "reasons", "reason"],
  priceEur: ["price (€)", "price", "cost"],
  processingMin: ["processing time (min.)", "processing time", "duration"],
};

function pick(headers: string[], hints: string[], taken: Set<string>) {
  const free = headers.filter((h) => !taken.has(h));
  const lower = free.map((h) => h.trim().toLowerCase());
  for (const hint of hints) {
    const i = lower.indexOf(hint);
    if (i >= 0) return free[i];
  }
  for (const hint of hints) {
    const i = lower.findIndex((h) => h.includes(hint));
    if (i >= 0) return free[i];
  }
  return null;
}

export function detectColumns(headers: string[]): DetectedColumns {
  const taken = new Set<string>();
  const out = {} as DetectedColumns;
  // External before applicant — see the note on HINTS. The rest in any order.
  const order: (keyof DetectedColumns)[] = [
    "verificationId",
    "externalApplicantId",
    "applicantId",
    "status",
    "at",
    "form",
    "method",
    "declineReasons",
    "priceEur",
    "processingMin",
  ];
  for (const key of order) {
    const found = pick(headers, HINTS[key], taken);
    out[key] = found;
    if (found) taken.add(found);
  }
  return out;
}

/**
 * A date from a column that holds more than one format.
 *
 * The real export mixes them WITHIN a single column: `5/1/2001` sits beside
 * `14-09-1997` in the same date-of-birth field, because a spreadsheet reformats
 * whatever it recognises and leaves the rest as text. The `Date` column itself
 * is month-first — `11/13/2025` can only be November — so a slashed date is
 * read US-style and a dashed one day-first, which is what produced them.
 *
 * Returns null rather than guessing. A verification with an unreadable date is
 * still a verification; it just cannot be ordered, and the import says so.
 */
export function readDate(value: unknown): string | null {
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const s = String(value ?? "").trim();
  if (!s) return null;

  const dashed = /^(\d{1,2})-(\d{1,2})-(\d{4})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s);
  if (dashed) {
    const [, d, m, y, hh, mm] = dashed;
    const at = Date.UTC(+y, +m - 1, +d, hh ? +hh : 0, mm ? +mm : 0);
    return Number.isNaN(at) ? null : new Date(at).toISOString();
  }
  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s);
  if (slashed) {
    const [, m, d, y, hh, mm] = slashed;
    const at = Date.UTC(+y, +m - 1, +d, hh ? +hh : 0, mm ? +mm : 0);
    return Number.isNaN(at) ? null : new Date(at).toISOString();
  }
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = String(value ?? "").trim().replace(/,(?=\d{3}\b)/g, "");
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function readVerifications(
  rows: Row[],
  override?: Partial<DetectedColumns>,
): {
  rows: VerificationRow[];
  columns: DetectedColumns;
  unusable: number;
  undated: number;
} {
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const columns = { ...detectColumns(headers), ...override };

  const get = (row: Row, col: string | null) =>
    col ? String(row[col] ?? "").trim() : "";

  const out: VerificationRow[] = [];
  let unusable = 0;
  let undated = 0;
  for (const row of rows) {
    const verificationId = get(row, columns.verificationId);
    if (!verificationId) {
      unusable++;
      continue;
    }
    const at = columns.at ? readDate(row[columns.at]) : null;
    if (!at) undated++;
    out.push({
      verificationId,
      applicantId: get(row, columns.applicantId) || null,
      externalApplicantId: get(row, columns.externalApplicantId) || null,
      status: get(row, columns.status),
      at,
      form: get(row, columns.form) || null,
      method: get(row, columns.method) || null,
      // Several at once, routinely: "Wrong name, Other, Expired document".
      declineReasons: get(row, columns.declineReasons)
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean),
      priceEur: columns.priceEur ? readNumber(row[columns.priceEur]) : null,
      processingMin: columns.processingMin
        ? readNumber(row[columns.processingMin])
        : null,
    });
  }
  return { rows: out, columns, unusable, undated };
}
