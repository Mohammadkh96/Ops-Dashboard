"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, X } from "lucide-react";

import { apiFetch, isDemoMode } from "@/lib/api";
import { cn } from "@/lib/utils";

export type IncidentCategory = {
  id: string;
  name: string;
  slug: string;
  tone: string;
  active?: boolean;
  createdBy?: string | null;
  uses?: number;
};

/**
 * The tone name a category carries, turned into the two colours a chip needs.
 *
 * A fixed map rather than a template string: Tailwind reads class names out of
 * the source at build time, so `bg-accent-${tone}-soft` compiles to a class that
 * exists nowhere in the stylesheet and the chip renders with no colour at all.
 */
const TONE: Record<string, string> = {
  blue: "border-accent-blue/25 bg-accent-blue-soft text-accent-blue",
  green: "border-accent-green/25 bg-accent-green-soft text-accent-green",
  orange: "border-accent-orange/25 bg-accent-orange-soft text-accent-orange",
  red: "border-accent-red/25 bg-accent-red-soft text-accent-red",
  magenta: "border-accent-magenta/25 bg-accent-magenta-soft text-accent-magenta",
  purple: "border-accent-purple/25 bg-accent-purple-soft text-accent-purple",
};

export function categoryClass(tone: string | undefined): string {
  return TONE[tone ?? ""] ?? "border-border bg-elevated text-muted-foreground";
}

/** Everything on offer, most-used first — the server does that ordering. */
export function useCategories() {
  return useQuery({
    queryKey: ["incident-categories"],
    queryFn: () => apiFetch<IncidentCategory[]>("/incident-categories"),
    enabled: !isDemoMode,
    staleTime: 5 * 60_000,
  });
}

/** A read-only row of chips, for the list and the detail panel. */
export function CategoryChips({
  categories,
  className,
}: {
  categories: { id?: string; name: string; tone?: string }[];
  className?: string;
}) {
  if (!categories.length) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {categories.map((c) => (
        <span
          key={c.id ?? c.name}
          className={cn(
            "rounded border px-1.5 py-0.5 text-[10px] font-medium",
            categoryClass(c.tone),
          )}
        >
          {c.name}
        </span>
      ))}
    </div>
  );
}

/**
 * Choosing what kind of thing an incident is, and naming a new kind.
 *
 * Selection is by NAME rather than id, because the whole point is that a name
 * can be typed here that does not exist yet. The server resolves names to
 * categories — creating one if it has to — so an abandoned declaration does not
 * leave a category behind, which is what "create it first, then attach it"
 * would do every time somebody changed their mind.
 *
 * Adding one is not a manager privilege. The person who finds a new kind of
 * problem is the agent it happened to, at the moment it happened; making them
 * ask for a category is how everything ends up filed under "Other".
 */
export function CategoryPicker({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (names: string[]) => void;
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const categories = useCategories();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const chosen = useMemo(
    () => new Set(value.map((v) => v.toLowerCase())),
    [value],
  );

  const create = useMutation({
    mutationFn: (name: string) =>
      apiFetch<IncidentCategory>("/incident-categories", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: (created) => {
      setDraft("");
      setError(null);
      if (!chosen.has(created.name.toLowerCase())) {
        onChange([...value, created.name]);
      }
      void queryClient.invalidateQueries({ queryKey: ["incident-categories"] });
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
  });

  const toggle = (name: string) => {
    if (disabled) return;
    setError(null);
    onChange(
      chosen.has(name.toLowerCase())
        ? value.filter((v) => v.toLowerCase() !== name.toLowerCase())
        : [...value, name],
    );
  };

  const known = categories.data ?? [];
  const typed = draft.trim();
  // Whether what is being typed already exists, compared the way the server
  // compares it. Without this, typing "psp outage" beside an existing "PSP
  // outage" offers an "Add" button that quietly selects the existing one — the
  // right outcome, reached in a way that looks like a bug.
  const matches = known.filter((c) =>
    c.name.toLowerCase().includes(typed.toLowerCase()),
  );
  const exact = known.find(
    (c) => c.name.toLowerCase() === typed.toLowerCase(),
  );
  const canAdd = typed.length > 0 && !exact;

  const submitDraft = () => {
    if (!typed) return;
    if (exact) {
      toggle(exact.name);
      setDraft("");
      return;
    }
    create.mutate(typed);
  };

  return (
    <div className="flex flex-col gap-2">
      {value.length ? (
        <div className="flex flex-wrap gap-1">
          {value.map((name) => {
            const meta = known.find(
              (c) => c.name.toLowerCase() === name.toLowerCase(),
            );
            return (
              <button
                key={name}
                type="button"
                onClick={() => toggle(name)}
                disabled={disabled}
                className={cn(
                  "flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium transition",
                  categoryClass(meta?.tone),
                )}
              >
                {name}
                <X className="size-3 opacity-60" />
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="flex gap-1.5">
        <input
          value={draft}
          disabled={disabled}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitDraft();
            }
          }}
          placeholder="Search, or type a new one…"
          className="h-9 flex-1 rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-border-strong"
        />
        {canAdd ? (
          <button
            type="button"
            onClick={submitDraft}
            disabled={disabled || create.isPending}
            className="flex items-center gap-1 rounded-lg border border-accent-blue/30 bg-accent-blue-soft px-2.5 text-xs font-medium text-accent-blue transition hover:bg-accent-blue/15"
          >
            <Plus className="size-3.5" />
            {create.isPending ? "Adding…" : `Add "${typed}"`}
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="rounded-lg border border-accent-red/25 bg-accent-red-soft px-2.5 py-1.5 text-[11px] text-accent-red">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-1">
        {matches.slice(0, 24).map((c) => {
          const on = chosen.has(c.name.toLowerCase());
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => toggle(c.name)}
              disabled={disabled}
              className={cn(
                "flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition",
                on
                  ? categoryClass(c.tone)
                  : "border-border text-muted hover:text-foreground",
              )}
            >
              {on ? <Check className="size-3" /> : null}
              {c.name}
            </button>
          );
        })}
        {categories.isLoading ? (
          <span className="text-[11px] text-muted">Loading categories…</span>
        ) : null}
        {!categories.isLoading && !matches.length && !typed ? (
          <span className="text-[11px] text-muted">
            No categories yet — type one above.
          </span>
        ) : null}
      </div>
    </div>
  );
}
