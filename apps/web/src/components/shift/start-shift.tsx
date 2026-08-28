"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { HandoverView, useHandover } from "./handover-view";
import {
  SHIFT_NAMES,
  type ActiveShift,
  type PreviousShift,
  type Shift,
  type TeamMember,
} from "./types";

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
  // Whether the outgoing agent's handover has been read. Starts false and is
  // only ever set by the button under the document — see the note on the
  // handover step below for why it is not simply skipped.
  const [acknowledged, setAcknowledged] = useState(false);

  const active = useQuery({
    queryKey: ["shift-active"],
    queryFn: () => apiFetch<ActiveShift>("/shifts/active"),
  });
  const previous = useQuery({
    queryKey: ["shift-previous"],
    queryFn: () => apiFetch<PreviousShift>("/shifts/previous"),
  });
  const prev = previous.data?.shift ?? null;
  // The same request HandoverView makes, deduped by react-query. Asked here
  // only so the button can say something true: a document that failed to build
  // must not be acknowledged as read.
  const handover = useHandover(prev?.id ?? null);
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

  // Whoever closed the last shift is who this one is taking over from. Offered
  // rather than imposed, and only when it matches somebody on the team — the
  // same shape as the shift name above, which is suggested by the clock and
  // overridable because the clock is not always right about what this is.
  const suggestedFrom =
    prev?.endedBy && (team.data ?? []).some((m) => m.name === prev.endedBy)
      ? prev.endedBy
      : "";
  const from = takenOverFrom || suggestedFrom;

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
          takenOverFrom: from.trim() || undefined,
          startNotes: startNotes.trim() || undefined,
          // Only when it is true. The server checks it against the shift that
          // actually closed last and drops it otherwise, so this is a claim
          // being made rather than a fact being asserted.
          readHandoverOf: acknowledged && prev ? prev.id : undefined,
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

  // ── step one: read what you are walking into ────────────────────────────
  //
  // The handover used to go out only by email, which nobody can prove was read
  // — and the person who most needs it is the one just sitting down, before
  // they have opened an inbox. Putting it here makes reading it part of
  // starting, and records that it happened.
  //
  // Not blocking when there is nothing to read (the first shift of all) and not
  // blocking when the document cannot be built: somebody has to take the desk
  // either way, and a dashboard that will not let them is a dashboard they work
  // around. What it will not do is record a read that did not happen.
  if (previous.isLoading) {
    return (
      <p className="py-8 text-center text-sm text-muted">
        Looking for the last handover…
      </p>
    );
  }

  if (prev && !acknowledged) {
    const broken = handover.isError;
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">
            {prev.name} shift closed
            {prev.endedAtLocal ? ` at ${prev.endedAtLocal}` : ""}
            {prev.endedBy ? ` by ${prev.endedBy}` : ""}
          </span>
          <span className="text-xs text-muted">
            {carriedForward(prev)}
          </span>
        </div>

        {broken ? (
          <p className="rounded-lg border border-accent-orange/25 bg-accent-orange-soft px-3 py-2 text-xs text-accent-orange">
            The handover could not be built just now: {String(handover.error)}.
            You can still take the desk — it will be recorded as not read, which
            is the truth, and it stays readable from the shift history.
          </p>
        ) : (
          <HandoverView shiftId={prev.id} height="64vh" />
        )}

        <div className="flex flex-wrap gap-2">
          {broken ? (
            <Button variant="secondary" onClick={() => start.mutate()}>
              Take the desk without it
            </Button>
          ) : (
            <Button
              onClick={() => setAcknowledged(true)}
              disabled={!handover.data}
            >
              {handover.data ? "I've read this — continue" : "Loading…"}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {prev && acknowledged ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-accent-green/25 bg-accent-green-soft px-3 py-2 text-xs text-accent-green">
          <span>
            {prev.name} handover read{prev.endedBy ? ` — from ${prev.endedBy}` : ""}.
          </span>
          <button
            type="button"
            onClick={() => setAcknowledged(false)}
            className="underline underline-offset-2"
          >
            Read it again
          </button>
        </div>
      ) : null}

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
          value={from}
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
        {suggestedFrom && !takenOverFrom ? (
          <span className="text-[11px] text-muted">
            {suggestedFrom} closed the last shift — change it if somebody else
            actually handed over to you.
          </span>
        ) : null}
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

/**
 * What the last shift is leaving behind, in one line.
 *
 * Said before the document loads, because "nothing outstanding" and "4 tasks
 * still open" are very different shifts to be walking into and the reader
 * should know which one this is before they start reading.
 */
function carriedForward(prev: NonNullable<PreviousShift["shift"]>): string {
  const parts: string[] = [];
  if (prev.openTasks)
    parts.push(`${prev.openTasks} task${prev.openTasks === 1 ? "" : "s"} still open`);
  if (prev.tickets)
    parts.push(`${prev.tickets} ticket${prev.tickets === 1 ? "" : "s"} carried over`);
  if (prev.hasNotes) parts.push("notes for you");
  return parts.length
    ? `Carrying forward: ${parts.join(", ")}.`
    : "Nothing flagged as outstanding — read it anyway, that is the point.";
}

/** Exported for the end-of-shift form, which shows the opening balances back. */
export function openingBalances(shift: Shift): [string, number][] {
  return Object.entries(shift.startBalances ?? {});
}
