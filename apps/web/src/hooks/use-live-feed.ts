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
 * Streams live operational events. In live mode it opens an SSE connection to
 * the API's `/dashboard/stream`; in demo mode it simulates the same shape on a
 * timer so the dashboard feels alive on the standalone preview too.
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
  }, [maxItems]);

  return { items, lastTick, connected };
}
