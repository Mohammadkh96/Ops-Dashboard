"use client";

import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { apiFetch, isDemoMode } from "@/lib/api";

export type FieldSpec = {
  key: string;
  label: string;
  group: string;
  table?: boolean;
  align?: "right";
  /** Stripped on ingest, so always empty unless the API's redaction list changes. */
  redacted?: boolean;
};

export type ColumnCatalogue = {
  groups: Record<string, string>;
  fields: FieldSpec[];
};

const STORAGE_KEY = "opsos.columns";

/**
 * Which columns exist, fetched from the API rather than restated here.
 *
 * A second copy in the frontend would drift the first time a field was added,
 * and the failure is quiet: a column that renders as permanently empty because
 * its key no longer matches anything the API sends.
 */
export function useColumnCatalogue() {
  return useQuery({
    queryKey: ["transaction-columns"],
    queryFn: () => apiFetch<ColumnCatalogue>("/transactions/columns"),
    enabled: !isDemoMode,
    // The catalogue changes when the API is redeployed, not while someone is
    // looking at a table.
    staleTime: 60 * 60_000,
  });
}

/**
 * The reader's chosen columns, remembered between visits.
 *
 * Held per browser rather than per account: it is a view preference, and
 * shipping it to the server would mean a write on every checkbox. Stored as the
 * explicit list rather than a diff from the defaults, so a change to what is
 * shown out of the box never silently rearranges a table someone has already
 * set up the way they want it.
 */
export function useVisibleColumns(catalogue: ColumnCatalogue | undefined) {
  const [chosen, setChosen] = useState<string[] | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setChosen(JSON.parse(raw) as string[]);
    } catch {
      /* unavailable or corrupt storage: fall back to the defaults */
    }
  }, []);

  const set = useCallback((keys: string[]) => {
    setChosen(keys);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
    } catch {
      /* private mode: the choice just does not persist */
    }
  }, []);

  const defaults = (catalogue?.fields ?? [])
    .filter((f) => f.table)
    .map((f) => f.key);

  // A stored list can name a field that no longer exists; filtering against the
  // catalogue keeps a removed field from rendering as a blank column forever.
  const known = new Set((catalogue?.fields ?? []).map((f) => f.key));
  const visible = (chosen ?? defaults).filter((k) => known.has(k));

  const reset = useCallback(() => {
    setChosen(null);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* nothing to clear */
    }
  }, []);

  return {
    visible: visible.length ? visible : defaults,
    isCustom: chosen !== null,
    set,
    reset,
  };
}

/** Renders any catalogued value as text — the CSV and the tooltip both need it. */
export function fieldText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}
