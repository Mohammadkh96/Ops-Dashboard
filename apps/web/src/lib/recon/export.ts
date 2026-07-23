import type { ReconRow } from "./types";

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const HEADERS = [
  "Layer", "Status", "Entity", "Source", "Match Key",
  "Left ID", "Left Amount", "Left Currency", "Left Status",
  "Right ID", "Right Amount", "Right Currency", "Right Status",
  "Difference", "Note",
];

/** Serialises reconciliation rows to a CSV string. */
export function reconRowsToCsv(rows: ReconRow[]): string {
  const lines = [HEADERS.map(csvCell).join(",")];
  rows.forEach((r) => {
    lines.push(
      [
        r.psp ? "Layer 2" : "Layer 1",
        r.status,
        r.entity,
        r.psp ?? "CRM ↔ Cashier",
        r.matchKey,
        r.leftId,
        r.leftAmount ?? "",
        r.leftCurrency,
        r.leftStatus,
        r.rightId,
        r.rightAmount ?? "",
        r.rightCurrency,
        r.rightStatus,
        r.diff ?? "",
        r.note,
      ]
        .map(csvCell)
        .join(","),
    );
  });
  return lines.join("\n");
}

/** Triggers a browser download of `content` as `filename`. */
export function downloadText(filename: string, content: string, mime = "text/csv;charset=utf-8") {
  if (typeof document === "undefined") return;
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
