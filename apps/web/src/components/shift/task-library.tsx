"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { PRIORITIES, SHIFT_NAMES, type TaskTemplate } from "./types";

const field =
  "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent-blue";
const label = "text-[10px] font-medium uppercase tracking-wider text-muted";

const blank = (): Partial<TaskTemplate> => ({
  title: "",
  howTo: "",
  category: "Operations",
  appliesTo: "All Shifts",
  priority: "Medium",
  active: true,
});

/**
 * The standing work, owned by whoever runs the desk.
 *
 * This is the manager's real lever: a shift starts with whatever is in here,
 * so changing it changes what every future shift is measured against. Agents
 * read it — it is what they work from — but only a manager writes it, because
 * a checklist anybody can quietly shorten is not a checklist.
 *
 * "How to check" is the part that matters and the part usually left out. A
 * task that says "check the withdrawals queue" is an instruction to somebody
 * who already knows how; the sentence underneath is what makes it work at 3am
 * for the person who does not.
 */
export function TaskLibrary() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Partial<TaskTemplate> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const library = useQuery({
    queryKey: ["shift-library"],
    queryFn: () => apiFetch<TaskTemplate[]>("/shifts/library"),
  });

  const done = () => {
    setEditing(null);
    setError(null);
    void queryClient.invalidateQueries({ queryKey: ["shift-library"] });
  };

  const save = useMutation({
    mutationFn: (t: Partial<TaskTemplate>) =>
      apiFetch<TaskTemplate[]>("/shifts/library", {
        method: "POST",
        body: JSON.stringify(t),
      }),
    onSuccess: done,
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  const retire = useMutation({
    mutationFn: (id: string) =>
      apiFetch<TaskTemplate[]>(`/shifts/library/${id}`, { method: "DELETE" }),
    onSuccess: done,
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  const items = library.data ?? [];
  const live = items.filter((t) => t.active);
  const retired = items.filter((t) => !t.active);

  return (
    <div className="flex flex-col gap-4">
      {editing ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">
              {editing.id ? "Edit task" : "New standing task"}
            </span>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="text-muted hover:text-foreground"
              aria-label="Cancel"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <label className="flex flex-col gap-1">
            <span className={label}>Task</span>
            <input
              value={editing.title ?? ""}
              onChange={(e) => setEditing({ ...editing, title: e.target.value })}
              placeholder="e.g. Check withdrawals pending over an hour"
              className={field}
              autoFocus
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={label}>How to check it</span>
            <textarea
              value={editing.howTo ?? ""}
              onChange={(e) => setEditing({ ...editing, howTo: e.target.value })}
              rows={2}
              placeholder="Where to look and what counts as wrong. Written for whoever is on at 3am."
              className={field}
            />
          </label>
          <div className="grid grid-cols-3 gap-2">
            <label className="flex flex-col gap-1">
              <span className={label}>Shift</span>
              <select
                value={editing.appliesTo ?? "All Shifts"}
                onChange={(e) => setEditing({ ...editing, appliesTo: e.target.value })}
                className={field}
              >
                <option>All Shifts</option>
                {SHIFT_NAMES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={label}>Category</span>
              <input
                value={editing.category ?? ""}
                onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                className={field}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={label}>Priority</span>
              <select
                value={editing.priority ?? "Medium"}
                onChange={(e) => setEditing({ ...editing, priority: e.target.value })}
                className={field}
              >
                {PRIORITIES.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
          </div>
          <Button
            size="sm"
            onClick={() => save.mutate(editing)}
            disabled={save.isPending || !editing.title?.trim()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      ) : (
        <Button variant="secondary" size="sm" onClick={() => setEditing(blank())}>
          <Plus className="size-3.5" />
          Add a standing task
        </Button>
      )}

      {error ? (
        <p className="rounded-lg border border-accent-red/25 bg-accent-red-soft px-3 py-2 text-xs text-accent-red">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        {live.map((t) => (
          <div key={t.id} className="flex flex-col gap-1 rounded-lg border border-border bg-card p-3">
            <div className="flex items-start justify-between gap-2">
              <span className="text-sm">{t.title}</span>
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  onClick={() => setEditing(t)}
                  className="text-muted hover:text-foreground"
                  aria-label="Edit"
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => retire.mutate(t.id)}
                  className="text-muted hover:text-accent-red"
                  aria-label="Retire"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            </div>
            {t.howTo ? (
              <span className="text-xs text-muted-foreground">{t.howTo}</span>
            ) : (
              <span className="text-xs italic text-muted">
                No instructions — the person on nights will have to guess.
              </span>
            )}
            <span className="text-[11px] text-muted">
              {t.appliesTo} · {t.category} · {t.priority}
            </span>
          </div>
        ))}
        {!live.length && !library.isLoading ? (
          <p className="py-6 text-center text-sm text-muted">
            Nothing standing yet. A shift will start with an empty board.
          </p>
        ) : null}
      </div>

      {retired.length ? (
        <div className="flex flex-col gap-1.5">
          {/* Retired rather than deleted: shifts that ran these still point at
              them, and a task dropped from the library is still part of what
              happened last week. */}
          <span className={label}>Retired</span>
          {retired.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs text-muted"
            >
              <span className="truncate line-through">{t.title}</span>
              <button
                type="button"
                onClick={() => save.mutate({ ...t, active: true })}
                className="shrink-0 underline underline-offset-2 hover:text-foreground"
              >
                Restore
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
