/**
 * Reading a CSV a provider's portal produced.
 *
 * Written out rather than pulled from a library because the whole job is one
 * function, and the parts that go wrong are the parts a naive `split(",")`
 * gets wrong — which is most files, once a customer's name contains a comma or
 * an address contains a newline.
 *
 * What it handles, because provider exports contain all of it:
 *   • quoted fields with commas inside them
 *   • doubled quotes as an escaped quote, "he said ""yes"""
 *   • newlines inside a quoted field
 *   • CRLF, which every export from a Windows tool has
 *   • a UTF-8 byte order mark, which Excel adds and which otherwise becomes
 *     part of the first column's NAME and quietly breaks its mapping
 */

/** One row per record, keyed by column heading. */
export type CsvRow = Record<string, string>;

export function parseCsv(text: string): CsvRow[] {
  const rows = parseRows(text);
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).flatMap((cells) => {
    // A trailing blank line is not a record. Exports end with one far more
    // often than not, and a row of empty strings imported as a transaction is
    // a phantom in the ledger.
    if (cells.every((c) => c.trim() === "")) return [];
    const row: CsvRow = {};
    headers.forEach((h, i) => {
      if (h) row[h] = (cells[i] ?? "").trim();
    });
    return [row];
  });
}

/** The grid of cells, before anything is called a heading. */
function parseRows(text: string): string[][] {
  // The BOM belongs to the file, not to the first column's name.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < input.length; i++) {
    const c = input[i];

    if (quoted) {
      if (c === '"') {
        // A doubled quote is one quote; a single one ends the field.
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += c;
      }
      continue;
    }

    if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      // Only a newline OUTSIDE quotes ends a row. CRLF counts once.
      if (c === "\r" && input[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += c;
    }
  }

  // Whatever was in hand when the file ran out is still a row, unless the file
  // ended cleanly on a newline.
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
