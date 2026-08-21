"use client";

import { useState } from "react";
import { Columns3, Check } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ColumnCatalogue } from "@/lib/columns";

/**
 * Chooses which of the provider's fields the table shows.
 *
 * Paymaxis records around seventy things about a payment and the table showed
 * nine of them, picked once by whoever built it. Which nine matter depends
 * entirely on the job: chasing a chargeback wants the card's issuing country,
 * chasing a crypto payout wants the destination address and network, and a
 * finance reconciliation wants the base-currency amounts. Rather than guess,
 * all of them are offered and the choice is remembered.
 *
 * Grouped in the provider's own order so a field is found where someone who
 * knows the Paymaxis console expects it to be.
 */
export function ColumnPicker({
  catalogue,
  visible,
  onChange,
  onReset,
  isCustom,
}: {
  catalogue: ColumnCatalogue;
  visible: string[];
  onChange: (keys: string[]) => void;
  onReset: () => void;
  isCustom: boolean;
}) {
  const [open, setOpen] = useState(false);
  const chosen = new Set(visible);

  const toggle = (key: string) => {
    // Order follows the catalogue, not the click sequence: a column added last
    // should land where its group is, not on the far right of the table.
    const next = new Set(chosen);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(catalogue.fields.filter((f) => next.has(f.key)).map((f) => f.key));
  };

  const groups = [...new Set(catalogue.fields.map((f) => f.group))];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs font-medium transition-colors hover:border-border-strong",
          isCustom ? "text-foreground" : "text-muted-foreground",
        )}
      >
        <Columns3 className="size-3.5" />
        Columns
        <span className="tnum text-muted">{visible.length}</span>
      </button>

      {open ? (
        <>
          {/* Click-away. A picker that only closes via its own button is a
              nuisance when the point is to open it, tick one field and read the
              table underneath. */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute right-0 top-full z-50 mt-2 flex max-h-[28rem] w-72 flex-col rounded-xl border border-border bg-surface shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="text-xs font-medium text-muted-foreground">
                Columns
              </span>
              <button
                type="button"
                onClick={onReset}
                className="text-[11px] text-muted transition-colors hover:text-foreground"
              >
                Reset
              </button>
            </div>

            <div className="overflow-y-auto p-1.5">
              {groups.map((g) => (
                <div key={g} className="mb-1.5">
                  <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted">
                    {catalogue.groups[g] ?? g}
                  </div>
                  {catalogue.fields
                    .filter((f) => f.group === g)
                    .map((f) => (
                      <button
                        key={f.key}
                        type="button"
                        onClick={() => toggle(f.key)}
                        title={
                          f.redacted
                            ? "Removed from the payload on ingest, so this column stays empty unless the API's redaction list is changed"
                            : undefined
                        }
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-card"
                      >
                        <span
                          className={cn(
                            "flex size-3.5 shrink-0 items-center justify-center rounded border",
                            chosen.has(f.key)
                              ? "border-accent-blue bg-accent-blue text-white"
                              : "border-border",
                          )}
                        >
                          {chosen.has(f.key) ? <Check className="size-2.5" /> : null}
                        </span>
                        <span className="flex-1 truncate">{f.label}</span>
                        {/* Said in the list rather than discovered later by
                            reading an empty column and assuming it is a bug. */}
                        {f.redacted ? (
                          <span className="shrink-0 text-[10px] text-muted">
                            redacted
                          </span>
                        ) : null}
                      </button>
                    ))}
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
