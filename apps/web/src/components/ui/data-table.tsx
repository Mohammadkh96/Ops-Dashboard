"use client";

import { useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Inbox } from "lucide-react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type Column<T> = {
  key: string;
  header: string;
  align?: "left" | "right";
  className?: string;
  render: (row: T) => ReactNode;
};

export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  onRowClick,
  empty = "No records found.",
  pageSize,
  loading = false,
}: {
  columns: Column<T>[];
  rows: T[];
  getRowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  empty?: string;
  pageSize?: number;
  loading?: boolean;
}) {
  const [page, setPage] = useState(0);

  const paginated = pageSize != null && rows.length > pageSize;
  const pageCount = paginated ? Math.ceil(rows.length / pageSize) : 1;
  const current = Math.min(page, pageCount - 1); // clamp during render (survives filtering)
  const visible = paginated ? rows.slice(current * pageSize, current * pageSize + pageSize) : rows;
  const from = rows.length === 0 ? 0 : current * (pageSize ?? rows.length) + 1;
  const to = paginated ? Math.min(rows.length, from + pageSize - 1) : rows.length;

  return (
    <Card className="glass card-seam overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface/40">
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={cn(
                    "px-5 py-3 text-xs font-medium uppercase tracking-wider text-muted",
                    c.align === "right" ? "text-right" : "text-left",
                    c.className,
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: pageSize ?? 6 }).map((_, r) => (
                <tr key={`sk-${r}`} className="border-b border-border/50 last:border-0">
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cn("px-5 py-3.5", c.align === "right" ? "text-right" : "text-left")}
                    >
                      <span
                        className={cn(
                          "skeleton block h-3.5 rounded",
                          c.align === "right" ? "ml-auto" : "",
                        )}
                        style={{ width: `${45 + ((r * 7 + c.key.length * 11) % 45)}%` }}
                      />
                    </td>
                  ))}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-5 py-16">
                  <div className="flex flex-col items-center justify-center gap-3 text-center">
                    <span className="flex size-11 items-center justify-center rounded-xl border border-border bg-card text-muted">
                      <Inbox className="size-5" />
                    </span>
                    <span className="text-sm text-muted-foreground">{empty}</span>
                  </div>
                </td>
              </tr>
            ) : (
              visible.map((row, i) => (
                <tr
                  key={getRowKey(row, i)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    "border-b border-border/50 transition-colors last:border-0",
                    onRowClick && "cursor-pointer hover:bg-card-hover",
                  )}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cn(
                        "px-5 py-3.5",
                        c.align === "right" ? "text-right" : "text-left",
                        c.className,
                      )}
                    >
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {paginated ? (
        <div className="flex items-center justify-between border-t border-border px-5 py-3">
          <span className="tnum text-xs text-muted">
            {from}–{to} of {rows.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage(Math.max(0, current - 1))}
              disabled={current === 0}
              className="flex size-8 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-card-hover disabled:pointer-events-none disabled:opacity-40"
              aria-label="Previous page"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="tnum px-2 text-xs text-muted-foreground">
              {current + 1} / {pageCount}
            </span>
            <button
              type="button"
              onClick={() => setPage(Math.min(pageCount - 1, current + 1))}
              disabled={current >= pageCount - 1}
              className="flex size-8 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-card-hover disabled:pointer-events-none disabled:opacity-40"
              aria-label="Next page"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
