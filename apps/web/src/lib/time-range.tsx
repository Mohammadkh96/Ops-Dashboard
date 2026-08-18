"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * The window every data view is showing.
 *
 * Held once for the whole app rather than per page: the same window follows you
 * from the dashboard to Deposits to Analytics, so figures on different screens
 * are always comparable. A per-page control would let two screens quietly
 * describe different periods, which is the kind of thing nobody notices until a
 * number has already been repeated in a meeting.
 */
export const RANGE_PRESETS = [
  { key: "1h", label: "1h" },
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "90d", label: "90d" },
] as const;

export type RangeKey = (typeof RANGE_PRESETS)[number]["key"];

export type TimeRangeValue =
  | { kind: "preset"; key: RangeKey }
  | { kind: "custom"; from: string; to: string };

type Ctx = {
  value: TimeRangeValue;
  set: (v: TimeRangeValue) => void;
  /** Query string fragment for the API, e.g. "range=7d" or "from=…&to=…". */
  query: string;
  /** Stable string for react-query keys, so changing the window refetches. */
  key: string;
  label: string;
};

const TimeRangeContext = createContext<Ctx | null>(null);
const STORAGE_KEY = "opsos.range";

function toQuery(v: TimeRangeValue): string {
  return v.kind === "preset"
    ? `range=${v.key}`
    : `from=${encodeURIComponent(v.from)}&to=${encodeURIComponent(v.to)}`;
}

function toLabel(v: TimeRangeValue): string {
  if (v.kind === "preset") {
    return RANGE_PRESETS.find((p) => p.key === v.key)?.label ?? v.key;
  }
  const d = (s: string) => s.slice(0, 16).replace("T", " ");
  return `${d(v.from)} → ${d(v.to)}`;
}

export function TimeRangeProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<TimeRangeValue>({ kind: "preset", key: "24h" });

  // Restored after mount rather than during render: reading localStorage while
  // rendering makes the server-rendered markup and the first client render
  // disagree, which React discards with a hydration error.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setValue(JSON.parse(raw) as TimeRangeValue);
    } catch {
      /* corrupt or unavailable storage: keep the default */
    }
  }, []);

  const set = useCallback((v: TimeRangeValue) => {
    setValue(v);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
    } catch {
      /* private mode: the choice just does not persist */
    }
  }, []);

  const ctx = useMemo<Ctx>(
    () => ({
      value,
      set,
      query: toQuery(value),
      key: toQuery(value),
      label: toLabel(value),
    }),
    [value, set],
  );

  return <TimeRangeContext.Provider value={ctx}>{children}</TimeRangeContext.Provider>;
}

export function useTimeRange(): Ctx {
  const ctx = useContext(TimeRangeContext);
  if (!ctx) throw new Error("useTimeRange must be used within TimeRangeProvider");
  return ctx;
}

/** Appends the window to an API path, respecting an existing query string. */
export function withRange(path: string, query: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${query}`;
}
