"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { SHIFT_NAMES, type ActiveShift, type Shift, type TeamMember } from "./types";

const field =
  "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent-blue";
const label =
  "text-[10px] font-medium uppercase tracking-wider text-muted";

/**
 * Taking over the desk.
 *
 * Three things get recorded and none of them are ceremony: which shift this
 * is, who handed it over, and what the PSP balances were at the moment it
 * changed hands. That last one is the only figure nobody can reconstruct
 * afterwards — a balance is a reading, not a total — and it is what the next
 * handover is measured against.
 */
export function StartShiftForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [takenOverFrom, setTakenOverFrom] = useState("");
  const [startNotes, setStartNotes] = useState("");
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const active = useQuery({
    queryKey: ["shift-active"],
    queryFn: () => apiFetch<ActiveShift>("/shifts/active"),
  });
  const team = useQuery({
    queryKey: ["shift-team"],
    queryFn: () => apiFetch<TeamMember[]>("/shifts/team"),
  });
  // The terminals that have actually taken a payment, rather than a list typed
  // into a config a year ago: a balance box for a PSP nobody routes through is
  // a box somebody has to decide to leave empty every single shift.
  const psps = useQuery({
    queryKey: ["shift-psps"],
    queryFn: () => apiFetch<{ terminals: { psp: string | null; terminal: string | null }[] }>(
      "/paymaxis/status",
    ),
  });

  const suggested = active.data?.suggestedName ?? "";
  const chosen = name || suggested;

  const pspNames = Array.from(
    new Set(
      (psps.data?.terminals ?? [])
        .map((t) => t.psp || t.terminal || "")
        .filter(Boolean),
    ),
  ).slice(0, 12);

  const start = useMutation({
    mutationFn: () =>
      apiFetch<ActiveShift>("/shifts/start", {
        method: "POST",
        body: JSON.stringify({
          name: chosen,
          takenOverFrom: takenOverFrom.trim() || undefined,
          startNotes: startNotes.trim() || undefined,
          balances: Object.fromEntries(
            Object.entries(balances)
              .map(([k, v]) => [k, Number(v)] as const)
              .filter(([, v]) => Number.isFinite(v) && v !== 0),
          ),
        }),
      }),
    onSuccess: onDone,
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <span className={label}>Which shift</span>
        <div className="flex flex-wrap gap-2">
          {SHIFT_NAMES.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setName(n)}
              className={`rounded-md border px-3 py-1.5 text-xs transition ${
                chosen === n
                  ? "border-accent-blue bg-accent-blue-soft text-accent-blue"
                  : "border-border text-muted hover:text-foreground"
              }`}
            >
              {n}
            </button>
          ))}
        </div>
        {suggested && !name ? (
          <span className="text-[11px] text-muted">
            {suggested} by the clock — change it if that is not what this is.
          </span>
        ) : null}
      </div>

      <label className="flex flex-col gap-1.5">
        <span className={label}>Taking over from</span>
        <select
          value={takenOverFrom}
          onChange={(e) => setTakenOverFrom(e.target.value)}
          className={field}
        >
          <option value="">— nobody / first of the day —</option>
          {(team.data ?? []).map((m) => (
            <option key={m.id} value={m.name}>
              {m.name}
            </option>
          ))}
        </select>
      </label>

      {pspNames.length ? (
        <div className="flex flex-col gap-1.5">
          <span className={label}>PSP balances at takeover</span>
          <span className="text-[11px] text-muted">
            The reading you inherited. Leave a box empty if you did not check it —
            an empty box is honest, a zero is a claim.
          </span>
          <div className="grid grid-cols-2 gap-2">
            {pspNames.map((p) => (
              <label key={p} className="flex flex-col gap-1">
                <span className="truncate text-[11px] text-muted" title={p}>
                  {p}
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  value={balances[p] ?? ""}
                  onChange={(e) =>
                    setBalances((b) => ({ ...b, [p]: e.target.value }))
                  }
                  placeholder="—"
                  className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm tabular-nums outline-none focus:border-accent-blue"
                />
              </label>
            ))}
          </div>
        </div>
      ) : null}

      <label className="flex flex-col gap-1.5">
        <span className={label}>Anything worth knowing at takeover</span>
        <textarea
          value={startNotes}
          onChange={(e) => setStartNotes(e.target.value)}
          rows={3}
          placeholder="What you were told when you sat down."
          className={field}
        />
      </label>

      {error ? (
        <p className="rounded-lg border border-accent-red/25 bg-accent-red-soft px-3 py-2 text-xs text-accent-red">
          {error}
        </p>
      ) : null}

      <Button onClick={() => start.mutate()} disabled={start.isPending}>
        {start.isPending ? "Starting…" : "Start shift"}
      </Button>
    </div>
  );
}

/** Exported for the end-of-shift form, which shows the opening balances back. */
export function openingBalances(shift: Shift): [string, number][] {
  return Object.entries(shift.startBalances ?? {});
}
