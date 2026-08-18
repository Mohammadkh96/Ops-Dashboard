"use client";

import { useState } from "react";
import { CalendarRange } from "lucide-react";

import { cn } from "@/lib/utils";
import { RANGE_PRESETS, useTimeRange } from "@/lib/time-range";

/**
 * The window selector. Lives in the top bar, so it is present on every screen
 * and always describes what is currently on it.
 */
export function RangePicker() {
  const { value, set, label } = useTimeRange();
  const [customOpen, setCustomOpen] = useState(false);
  // Held locally until Apply: refetching on every keystroke of a half-typed
  // date would fire a request for a window nobody asked for.
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  return (
    <div className="relative flex items-center gap-1 rounded-lg border border-border bg-card p-0.5">
      {RANGE_PRESETS.map((p) => {
        const active = value.kind === "preset" && value.key === p.key;
        return (
          <button
            key={p.key}
            onClick={() => {
              setCustomOpen(false);
              set({ kind: "preset", key: p.key });
            }}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              active
                ? "bg-accent-blue text-white"
                : "text-muted hover:text-foreground",
            )}
          >
            {p.label}
          </button>
        );
      })}

      <button
        onClick={() => setCustomOpen((o) => !o)}
        title={value.kind === "custom" ? label : "Custom range"}
        className={cn(
          "flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
          value.kind === "custom"
            ? "bg-accent-blue text-white"
            : "text-muted hover:text-foreground",
        )}
      >
        <CalendarRange className="size-3.5" />
      </button>

      {customOpen ? (
        <div className="absolute right-0 top-full z-50 mt-2 flex w-72 flex-col gap-3 rounded-xl border border-border bg-surface p-3 shadow-xl">
          <span className="text-xs font-medium text-muted-foreground">
            Custom range
          </span>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted">From</span>
            <input
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="h-8 rounded-md border border-border bg-card px-2 text-xs outline-none focus:border-border-strong"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted">To</span>
            <input
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-8 rounded-md border border-border bg-card px-2 text-xs outline-none focus:border-border-strong"
            />
          </label>
          <button
            disabled={!from || !to}
            onClick={() => {
              // datetime-local has no timezone; the browser's own offset is the
              // right reading, since the operator typed a local wall-clock time.
              set({
                kind: "custom",
                from: new Date(from).toISOString(),
                to: new Date(to).toISOString(),
              });
              setCustomOpen(false);
            }}
            className="rounded-md bg-accent-blue px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            Apply
          </button>
        </div>
      ) : null}
    </div>
  );
}
