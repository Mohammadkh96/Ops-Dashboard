"use client";

import { useEffect, useState } from "react";

import { API_URL, isDemoMode } from "@/lib/api";
import type { QueueItem, QueueState } from "@/lib/dashboard";

/** One real-time event pushed from the API (or simulated in demo mode). */
export type LiveTick = {
  ts: string;
  seq: number;
  queueItem: QueueItem;
  metrics: { successRate: number; volumeDelta: number };
};

/** Response shape of `GET /dashboard/feed`. */
type FeedResponse = {
  events: LiveTick[];
  cursor: string | null;
  live: boolean;
  simulated: boolean;
};

/**
 * How the feed reaches the browser.
 *
 * `poll` is the default because it works on every host, serverless included. SSE
 * needs a process that stays alive to hold the connection open, which a
 * serverless function cannot do, so it is opt-in for deployments that have one.
 */
const TRANSPORT = process.env.NEXT_PUBLIC_LIVE_TRANSPORT === "sse" ? "sse" : "poll";
const POLL_MS = Math.max(1000, Number(process.env.NEXT_PUBLIC_LIVE_POLL_MS ?? 4000));

const TYPES = ["Deposit", "Withdrawal", "KYC Review", "Ticket"] as const;

/** Builds a synthetic tick — used for demo-mode simulation (mirrors the API shape). */
function makeTick(seq: number): LiveTick {
  const type = TYPES[seq % TYPES.length];
  const isMoney = type === "Deposit" || type === "Withdrawal";
  const prefix = type === "KYC Review" ? "KYC" : type === "Ticket" ? "TC" : "TX";
  const status: QueueState =
    type === "Ticket"
      ? "escalated"
      : type === "KYC Review"
        ? "pending"
        : isMoney && Math.random() > 0.7
          ? "review"
          : "processing";
  return {
    ts: new Date().toISOString(),
    seq,
    queueItem: {
      id: `${prefix}-${88000 + Math.floor(Math.random() * 9999)}`,
      type,
      client: `Client #${10000 + Math.floor(Math.random() * 89999)}`,
      amount: isMoney ? `$${(Math.floor(Math.random() * 90) * 100 + 200).toLocaleString()}` : "—",
      status,
    },
    metrics: {
      successRate: Number((97.8 + (Math.random() - 0.5) * 0.6).toFixed(1)),
      volumeDelta: Number((Math.random() * 0.04).toFixed(3)),
    },
  };
}

/**
 * Streams live operational events.
 *
 * Three modes: demo (no API configured — simulates in the browser), polling
 * (`GET /dashboard/feed`, cursor-based so nothing is missed or repeated), and
 * SSE (`/dashboard/stream`, push, requires an always-on API host).
 *
 * Returns the accumulated recent queue items (newest first), the latest tick,
 * and whether the feed is connected.
 */
export function useLiveFeed(maxItems = 5) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [lastTick, setLastTick] = useState<LiveTick | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let active = true;
    const push = (tick: LiveTick) => {
      if (!active) return;
      setItems((prev) => [tick.queueItem, ...prev].slice(0, maxItems));
      setLastTick(tick);
      setConnected(true);
    };

    if (isDemoMode) {
      let seq = 0;
      const kick = setTimeout(() => push(makeTick(seq++)), 700);
      const timer = setInterval(() => push(makeTick(seq++)), 4000);
      return () => {
        active = false;
        clearTimeout(kick);
        clearInterval(timer);
      };
    }

    if (TRANSPORT === "sse") {
      const source = new EventSource(`${API_URL}/dashboard/stream`);
      source.onmessage = (e) => {
        try {
          push(JSON.parse(e.data) as LiveTick);
        } catch {
          /* ignore malformed frame */
        }
      };
      source.onerror = () => {
        if (active) setConnected(false);
      };
      return () => {
        active = false;
        source.close();
      };
    }

    // Polling. Chained timeouts rather than setInterval so a slow response can
    // never stack overlapping requests — the next poll is scheduled only once
    // the previous one has finished.
    let cursor: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();

    const poll = async () => {
      try {
        const url = new URL(`${API_URL}/dashboard/feed`);
        if (cursor) url.searchParams.set("since", cursor);
        const res = await fetch(url, { signal: abort.signal });
        if (!res.ok) throw new Error(`feed ${res.status}`);
        const data = (await res.json()) as FeedResponse;
        // Advance only when the server sends a cursor; on an empty poll it
        // echoes the current one back so our place is never lost.
        cursor = data.cursor ?? cursor;
        // Ascending order, and push() prepends, so the newest ends up first.
        for (const ev of data.events) push(ev);
        // An empty poll still means the API answered — the feed is connected
        // even when nothing has happened.
        if (active) setConnected(true);
      } catch (e) {
        if (active && (e as Error).name !== "AbortError") setConnected(false);
      } finally {
        if (active) timer = setTimeout(() => void poll(), POLL_MS);
      }
    };
    void poll();

    return () => {
      active = false;
      abort.abort();
      if (timer) clearTimeout(timer);
    };
  }, [maxItems]);

  return { items, lastTick, connected };
}
