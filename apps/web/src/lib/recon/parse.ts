import * as XLSX from "xlsx";

import { parseCsv } from "./csv";
import type { Dataset, Row } from "./types";

function cleanHeader(v: unknown): string {
  return String(v ?? "")
    .replace(/^﻿/, "")
    .replace(/^["']+|["']+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parses the first worksheet of an .xlsx/.xls file into a Dataset. */
async function parseXlsx(file: File): Promise<Dataset> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const first = wb.SheetNames[0];
  if (!first) return { headers: [], rows: [], fileName: file.name };
  const ws = wb.Sheets[first];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "", raw: false });
  const nonEmpty = grid.filter((r) => Array.isArray(r) && r.some((c) => String(c ?? "").trim() !== ""));
  if (nonEmpty.length === 0) return { headers: [], rows: [], fileName: file.name };
  const headers = (nonEmpty[0] as unknown[]).map(cleanHeader);
  const rows: Row[] = nonEmpty.slice(1).map((cells) => {
    const o: Row = {};
    headers.forEach((h, i) => {
      o[h] = String((cells as unknown[])[i] ?? "").trim();
    });
    return o;
  });
  return { headers, rows, fileName: file.name };
}

/** Parses any supported source file (CSV, TSV, TXT, XLS, XLSX) into a Dataset. */
export async function parseFile(file: File): Promise<Dataset> {
  const isExcel = /\.(xlsx|xls)$/i.test(file.name);
  if (isExcel) return parseXlsx(file);
  const text = await file.text();
  const ds = parseCsv(text);
  ds.fileName = file.name;
  return ds;
}
