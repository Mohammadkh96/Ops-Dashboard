"use client";

import type { ReactNode } from "react";
import { Inbox } from "lucide-react";

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
}: {
  columns: Column<T>[];
  rows: T[];
  getRowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  empty?: string;
}) {
  return (
    <Card className="glass card-seam overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
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
            {rows.length === 0 ? (
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
              rows.map((row, i) => (
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
    </Card>
  );
}
