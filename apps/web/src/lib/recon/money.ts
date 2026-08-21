/**
 * Locale-agnostic money parsing, shared by every pass.
 *
 * Paystrax exports European decimals — "600,00", "1.500,00" — while most other
 * providers use "1,500.00". The rule that resolves both without knowing the
 * source: when BOTH separators appear, the RIGHTMOST one is the decimal point.
 * A lone comma is a decimal point only when exactly two digits follow it, which
 * distinguishes "600,00" from a thousands-grouped "1,234".
 *
 * The previous rule ("a comma with no dot is the decimal, otherwise strip
 * commas") read "1.500,00" as 1.5, so a €1,500 payment was compared as €1.50
 * and Layer 2 reported a mismatch of nearly the whole transaction. Small
 * amounts parsed correctly by luck, so nothing looked wrong until a four-figure
 * payment arrived.
 *
 * Lives in its own module because the layers and the completeness audit must
 * agree on an amount to the cent — if they disagree, reconciled and dropped
 * totals stop tying out to the source file.
 */
export function parseMoney(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  let s = String(v).trim().replace(/["']/g, "").replace(/\s/g, "");
  if (!s) return 0;

  // Accounting exports write a debit as "(1.234,00)".
  const negative = /^-/.test(s) || /^\(.*\)$/.test(s);

  s = s.replace(/[^0-9.,]/g, "");
  if (!s) return 0;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");

  if (lastComma > -1 && lastDot > -1) {
    s =
      lastComma > lastDot
        ? s.replace(/\./g, "").replace(",", ".") // 1.500,00 → 1500.00
        : s.replace(/,/g, ""); // 1,500.00 → 1500.00
  } else if (lastComma > -1) {
    const parts = s.split(",");
    s =
      parts.length === 2 && parts[1].length === 2
        ? `${parts[0]}.${parts[1]}` // 600,00 → 600.00
        : s.replace(/,/g, ""); // 1,234 → 1234
  }
  // Dots only, or no separator: already canonical.

  const n = parseFloat(s);
  if (isNaN(n)) return 0;
  return negative ? -Math.abs(n) : n;
}
