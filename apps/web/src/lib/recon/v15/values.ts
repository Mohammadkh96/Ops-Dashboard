// Value primitives, ported from the Tradin V10–V15 Apps Script.
//
// This directory is a faithful port of that script: same decisions, same order,
// same edge cases, function names kept close to the originals so the two can be
// read side by side. Where the script's comments record a lesson learned, the
// lesson is carried over with it — those comments are the specification.
//
// Only the substrate differs. The script reads a spreadsheet; this reads parsed
// files. Nothing about how a transaction is judged changes.

import type { Row } from "../types";

/** `_cleanValue` — strips the quote armour spreadsheet exports add. */
export function cleanValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(/^'+|'+$/g, "").replace(/^"+|"+$/g, "").trim();
}

/**
 * `_v(row, ...keys)` — first key that holds a value, case-insensitively.
 *
 * Provider exports disagree with their own documentation about column names, so
 * every read goes through a candidate list rather than a fixed name.
 */
export function v(row: Row | null | undefined, ...keys: string[]): string {
  if (!row) return "";
  for (const k of keys) {
    const direct = row[k];
    if (direct !== undefined && direct !== null && String(direct) !== "") return cleanValue(direct);
    const lower = k.toLowerCase();
    for (const [rk, rv] of Object.entries(row)) {
      if (rk.toLowerCase() === lower && rv !== undefined && rv !== null && String(rv) !== "") {
        return cleanValue(rv);
      }
    }
  }
  return "";
}

/**
 * `_numSmart_` — locale-agnostic money.
 *
 * Paystrax exports European decimals ("1.500,00"). The script's original `_num`
 * read that as 1.5, so a 1,500 payment compared as 1.50 and Layer 2 reported a
 * mismatch of nearly the whole transaction; small amounts parsed correctly by
 * luck, which is why it stayed hidden. When both separators appear the
 * rightmost is the decimal point.
 */
export function num(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  let s = String(value).trim().replace(/^'+|'+$/g, "").replace(/^"+|"+$/g, "").replace(/\s/g, "");
  if (!s) return 0;

  const negative = /^-/.test(s) || /^\(.*\)$/.test(s);
  s = s.replace(/[^0-9.,]/g, "");
  if (!s) return 0;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");

  if (lastComma > -1 && lastDot > -1) {
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma > -1) {
    const parts = s.split(",");
    s = parts.length === 2 && parts[1].length === 2 ? `${parts[0]}.${parts[1]}` : s.replace(/,/g, "");
  }

  const n = parseFloat(s);
  if (isNaN(n)) return 0;
  return negative ? -Math.abs(n) : n;
}

export const round = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * `_normalizeDepositKey_` — an identifier reduced to something comparable, or
 * empty when the value is one of the many ways an export says "nothing".
 *
 * The placeholder list matters: without it "NULL" becomes a key that joins
 * every unrelated row carrying the same placeholder into one family.
 */
const INVALID_KEYS = new Set([
  "NULL", "UNDEFINED", "NAN", "N/A", "NA", "NONE", "-", "0",
]);

export function normalizeKey(value: unknown): string {
  const key = String(value ?? "")
    .replace(/^'+|'+$/g, "")
    .replace(/^"+|"+$/g, "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  if (!key) return "";
  return INVALID_KEYS.has(key) ? "" : key;
}

/** `_uniqueDepositKeys_` — de-duplicated, placeholder-free, order preserved. */
export function uniqueKeys(values: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values ?? []) {
    const key = normalizeKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** `_arraysShareValue_` */
export function sharesValue(a: string[], b: string[]): boolean {
  const lookup = new Set(a ?? []);
  return (b ?? []).some((x) => lookup.has(x));
}

/**
 * `_tParseUTC_` — a provider timestamp as an instant in UTC.
 *
 * Every source logs UTC but only some say so: Match2pay writes "…Z", the CRM
 * and Paymaxis write a naive "2026-08-06 00:01:37". Reading the naive form with
 * the platform parser applies the VIEWER's timezone, so the same payment
 * measured in two offices produced different gaps — and the poller's watermark,
 * compared against these values, silently stopped advancing.
 *
 * Bounded to 2000–2100 so a spreadsheet serial ("46234") is refused instead of
 * parsing as the year 46234 and producing a -16,115,743-day difference.
 */
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function inRange(d: Date): Date | null {
  if (isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  return y >= 2000 && y <= 2100 ? d : null;
}

export function parseUtc(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return inRange(value);
  const s = String(value).trim();
  if (!s) return null;

  // DD/MM/YYYY [HH:mm[:ss]] — the CRM export.
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    return inRange(
      new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))),
    );
  }

  // DD Mon YYYY [HH:mm[:ss]]
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) {
    return inRange(
      new Date(
        Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)),
      ),
    );
  }

  // DD.MM.YY[YY] — crypto exports.
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return inRange(
      new Date(Date.UTC(year, +m[2] - 1, +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))),
    );
  }

  // ISO with an explicit zone: honour it.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s) && /(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    return inRange(new Date(s));
  }
  // ISO without one: read as UTC, not as local.
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return inRange(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0))));

  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return inRange(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));

  // A bare number is a spreadsheet serial, not a date.
  if (/^\d+$/.test(s)) return null;

  return inRange(new Date(s));
}

export const dateMs = (value: unknown): number | null => {
  const d = parseUtc(value);
  return d ? d.getTime() : null;
};

/** `_dateDiffMinutes` — Infinity when either side is unusable, so a missing
 *  timestamp can never satisfy a time window. */
export function diffMinutes(a: unknown, b: unknown): number {
  const x = dateMs(a);
  const y = dateMs(b);
  if (x === null || y === null) return Number.POSITIVE_INFINITY;
  return Math.abs(x - y) / 60000;
}

export function diffDays(a: unknown, b: unknown): number {
  const x = dateMs(a);
  const y = dateMs(b);
  if (x === null || y === null) return Number.POSITIVE_INFINITY;
  return Math.abs(x - y) / 86400000;
}

/** `_extractJsonValue` — one key out of a JSON string column. */
export function extractJson(text: unknown, key: string): string {
  try {
    let s = String(text ?? "").trim();
    if (!s || s === "NaN" || s === "nan") return "";
    if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).replace(/""/g, '"');
    const obj = JSON.parse(s) as Record<string, unknown>;
    const val = obj?.[key];
    return val !== undefined && val !== null ? String(val).trim() : "";
  } catch {
    return "";
  }
}

// ── entities ──
export const ENTITY = { MU: "Mauritius", SL: "Saint Lucia" } as const;

/** `_entityFromBrand` — "global" in the brand means the Saint Lucia book. */
export function entityFromBrand(brand: unknown): string {
  return String(brand ?? "").toLowerCase().includes("global") ? ENTITY.SL : ENTITY.MU;
}

/** `_entityFromCashierShop` — the _SL suffix is the jurisdiction marker. */
export function entityFromShop(shop: unknown): string {
  return /_sl/i.test(String(shop ?? "")) ? ENTITY.SL : ENTITY.MU;
}

export function shopMatchesEntity(shop: unknown, entity: string): boolean {
  return entityFromShop(shop) === entity;
}

// ── transaction types ──
export const TX_DEPOSIT = "DEPOSIT";
export const TX_WITHDRAWAL = "WITHDRAWAL";

/**
 * `_normalizeTxType` — a provider's word for a direction.
 *
 * ForumPay inverts the intuition: SELL is the customer selling crypto to us, so
 * it is a deposit; BUY is a payout. Paystrax uses DB / CD / RF.
 */
export function normalizeTxType(type: unknown, source: string): string {
  const t = String(type ?? "").toUpperCase();
  if (source === "ForumPay") {
    if (t === "BUY") return TX_WITHDRAWAL;
    if (t === "SELL") return TX_DEPOSIT;
  }
  if (source === "Paystrax") {
    if (t === "DB") return TX_DEPOSIT;
    if (t === "CD" || t === "RF") return TX_WITHDRAWAL;
  }
  if (t.includes("DEPOSIT")) return TX_DEPOSIT;
  if (t.includes("WITHDRAW") || t.includes("REFUND")) return TX_WITHDRAWAL;
  return "";
}

/** `_typesMatch` — unknown on either side is permissive, not a rejection. */
export function typesMatch(crmType: unknown, pspType: unknown, pspSource: string): boolean {
  const a = normalizeTxType(crmType, "CRM");
  const b = normalizeTxType(pspType, pspSource);
  if (!a || !b) return true;
  return a === b;
}

// ── cashier amount bases ──
//
// Two different bases, and using the wrong one manufactures mismatches:
//
//   Layer 1 (CRM ↔ Cashier) compares against what the CRM records, which is the
//   shop base currency.
//   Layer 2 (Cashier ↔ PSP) compares against what the provider reports, which
//   is the transaction currency.

/** `_cashierAmountShopBase` — for Layer 1 and the exceptions engine. */
export function cashierAmountShopBase(r: Row): number {
  const sb = num(v(r, "Amount in Shop Base Currency"));
  if (sb) return sb;
  return num(v(r, "Amount"));
}

/**
 * `_cashierGetAmount` — for Layer 2.
 *
 * Note from the script: 'Customer Amount' is denominated in Customer Currency
 * and is blank on 100% of rows in the raw export, so preferring it risked
 * comparing two different currencies. Transaction 'Amount' first.
 */
export function cashierAmount(r: Row): number {
  const amt = num(v(r, "Amount"));
  if (amt) return amt;
  return num(v(r, "Customer Amount"));
}

export function cashierCurrency(r: Row): string {
  return v(r, "Customer Currency") || v(r, "Currency");
}
