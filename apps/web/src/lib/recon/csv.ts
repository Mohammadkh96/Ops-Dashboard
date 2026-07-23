import type { Dataset, Row } from "./types";

// Minimal, dependency-free CSV/TSV parser. Handles quoted fields, escaped
// quotes ("") and embedded newlines. Auto-detects the delimiter from the
// header line (comma, tab or semicolon).

function detectDelimiter(headerLine: string): string {
  const counts: Record<string, number> = {
    ",": (headerLine.match(/,/g) || []).length,
    "\t": (headerLine.match(/\t/g) || []).length,
    ";": (headerLine.match(/;/g) || []).length,
  };
  let best = ",";
  let max = -1;
  for (const [d, n] of Object.entries(counts)) {
    if (n > max) {
      max = n;
      best = d;
    }
  }
  return best;
}

function parseRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      pushField();
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // trailing field/row
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

function cleanHeader(v: string): string {
  return String(v || "")
    .replace(/^﻿/, "")
    .replace(/^["']+|["']+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseCsv(text: string): Dataset {
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  const delimiter = detectDelimiter(firstLine);
  const grid = parseRows(text, delimiter).filter((r) => r.some((c) => String(c).trim() !== ""));
  if (grid.length === 0) return { headers: [], rows: [], fileName: "" };

  const headers = grid[0].map(cleanHeader);
  const rows: Row[] = grid.slice(1).map((cells) => {
    const obj: Row = {};
    headers.forEach((h, idx) => {
      obj[h] = String(cells[idx] ?? "").trim();
    });
    return obj;
  });
  return { headers, rows, fileName: "" };
}
