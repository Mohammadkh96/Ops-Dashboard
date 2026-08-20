"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { apiFetch, isDemoMode } from "@/lib/api";
import { cn } from "@/lib/utils";

type Refresh = {
  ran: boolean;
  lastRunAt: string | null;
  /** When data last actually arrived, which is not the same as when a pull was
   * last attempted — a rejected key attempts every minute and arrives never. */
  lastOkAt: string | null;
  configured: boolean;
  error: string | null;
};

/** How often an open tab asks the API to pull. The API enforces its own floor,
 * so this is a request cadence, not a guarantee of an upstream call. */
const ASK_EVERY_MS = 60_000;

/** Past this, what is on screen is old enough that saying so matters more than
 * the number itself. */
const STALE_AFTER_MS = 10 * 60_000;

function ago(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m ago`;
}

/**
 * Says how current the figures on screen are, and pulls if they are not.
 *
 * On a serverless host nothing polls: the process is gone between requests, and
 * a Hobby-plan cron fires once a day, so the dashboard can silently show
 * yesterday's payments with no indication that it is doing so. An open tab is
 * the one thing reliably running, so it drives the pull — and reports the age of
 * what it is showing either way, because a stale number presented as current is
 * worse than an obviously stale one.
 */
export function SyncStatus() {
  const queryClient = useQueryClient();
  const [lastOkAt, setLastOkAt] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  const [failed, setFailed] = useState(false);
  const [upstreamError, setUpstreamError] = useState<string | null>(null);
  // Re-renders on a tick so "2m ago" does not sit there reading "12s ago".
  const [, setNow] = useState(0);

  const refresh = useMutation({
    // `force` distinguishes a person pressing the button from the background
    // poll, and the API gives it a shorter floor accordingly.
    mutationFn: (opts: { force: boolean }) =>
      apiFetch<Refresh>("/paymaxis/refresh", {
        method: "POST",
        body: JSON.stringify({ force: opts.force }),
      }),
    onSuccess: (data, opts) => {
      setFailed(false);
      setLastOkAt(data.lastOkAt);
      setConfigured(data.configured);
      setUpstreamError(data.error);
      // On a background poll, only when something was actually pulled:
      // refetching every view on a rate-limited no-op would reload the whole
      // dashboard for nothing. On a press, always — somebody asked to see
      // current data, and a button that visibly does nothing reads as broken.
      if (data.ran || opts.force) void queryClient.invalidateQueries();
    },
    onError: () => setFailed(true),
  });

  useEffect(() => {
    if (isDemoMode) return;
    const ask = () => {
      if (document.visibilityState === "visible") refresh.mutate({ force: false });
    };
    ask();
    const poll = setInterval(ask, ASK_EVERY_MS);
    // A tab left open overnight should pull the moment it is looked at again,
    // rather than waiting out the remainder of its interval.
    document.addEventListener("visibilitychange", ask);
    const tick = setInterval(() => setNow((n) => n + 1), 15_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", ask);
    };
    // refresh.mutate is stable; re-running this on every render would restart
    // the interval forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isDemoMode) return null;

  const age = lastOkAt ? Date.now() - Date.parse(lastOkAt) : null;
  const stale = age !== null && age > STALE_AFTER_MS;

  // Order matters: an unconfigured or failing sync is the reason the age is
  // what it is, so it is what the badge should say. Reporting the age alone
  // would let "Synced 3h ago" sit there looking like a slow day rather than a
  // rejected key.
  const label = !configured
    ? "Paymaxis not configured"
    : failed
      ? "Sync unreachable"
      : upstreamError
        ? lastOkAt
          ? `Sync failing · data ${ago(lastOkAt)}`
          : "Sync failing"
        : lastOkAt
          ? `Synced ${ago(lastOkAt)}`
          : "Never synced";

  const tone =
    !configured || failed || upstreamError || stale || !lastOkAt
      ? "text-accent-orange"
      : "text-muted";

  return (
    <button
      onClick={() => refresh.mutate({ force: true })}
      disabled={refresh.isPending}
      aria-label="Refresh payment data"
      // The upstream error verbatim: "key rejected" and "host unreachable" call
      // for different people to be woken up.
      title={
        !configured
          ? "PAYMAXIS_SHOPS is not set on the API, so it holds no credentials to read with"
          : (upstreamError ?? "Fetch new payments from Paymaxis now")
      }
      className={cn(
        "flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-[11px] font-medium transition-colors hover:border-border-strong hover:text-foreground",
        tone,
      )}
    >
      <RefreshCw
        className={cn("size-3.5", refresh.isPending && "animate-spin")}
      />
      {/* The label is the age; while a pull is in flight it says so, because a
          spinner over an unchanged "Synced 4m ago" looks like nothing happened. */}
      <span className="whitespace-nowrap">
        {refresh.isPending ? "Refreshing…" : label}
      </span>
    </button>
  );
}
