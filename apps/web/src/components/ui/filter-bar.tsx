"use client";

import { Search } from "lucide-react";

import { cn } from "@/lib/utils";

export type FilterOption = { label: string; value: string };

export function FilterBar({
  search,
  onSearch,
  searchPlaceholder = "Search…",
  filters = [],
  children,
}: {
  search?: string;
  onSearch?: (v: string) => void;
  searchPlaceholder?: string;
  filters?: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    options: FilterOption[];
  }[];
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {onSearch ? (
        <div className="relative min-w-[220px] flex-1 max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input
            value={search ?? ""}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={searchPlaceholder}
            className="h-9 w-full rounded-lg border border-border bg-card pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted focus:border-border-strong"
          />
        </div>
      ) : null}

      {filters.map((f) => (
        <div key={f.label} className="relative">
          <select
            value={f.value}
            onChange={(e) => f.onChange(e.target.value)}
            className={cn(
              "h-9 cursor-pointer appearance-none rounded-lg border border-border bg-card pl-3 pr-8 text-sm outline-none transition-colors hover:border-border-strong focus:border-border-strong",
              f.value ? "text-foreground" : "text-muted",
            )}
          >
            <option value="">{f.label}</option>
            {f.options.map((o) => (
              <option key={o.value} value={o.value} className="bg-card text-foreground">
                {o.label}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted">▾</span>
        </div>
      ))}

      {children}
    </div>
  );
}
