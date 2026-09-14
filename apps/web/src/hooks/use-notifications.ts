"use client";

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch, isDemoMode } from "@/lib/api";

/**
 * What the desk has been told, and the pass that tells them.
 *
 * TWO HALVES, and this is the attended one. The unattended pass rides on the
 * daily payment cron — an alerting schedule of its own would be an extra cron
 * entry, which this account's plan refuses at deployment without a failed build
 * to notice. This half runs while somebody actually has the dashboard open,
 * which is when an alert is most useful anyway: a condition that starts at
 * 10:40 is on screen by 10:45 rather than at three the following morning.
 *
 * Calling the run endpoint often is safe by design — a condition already
 * reported inside the cool-off moves a timestamp and sends nothing. That
 * property is what makes an interval acceptable at all.
 */

export type Notification = {
  id: string;
  signature: string;
  kind: string;
  severity: string;
  title: string;
  body: string[];
  /** Which half of the business raised it: "payments" or "kyc". */
  source: string;
  createdAt: string;
  /** Still true as of this moment — not when it was first raised. */
  lastSeenAt: string;
  emailed: boolean;
  /**
   * Why the email did not go, when it did not.
   *
   * Shown on the row rather than logged away: "the mailer is not configured"
   * is something a desk has to know about its own alerting, and an alert that
   * quietly never leaves the building is the failure this layer exists to
   * avoid.
   */
  emailError: string | null;
  readAt: string | null;
};

export type NotificationFeed = {
  unread: number;
  notifications: Notification[];
};

const EMPTY: NotificationFeed = { unread: 0, notifications: [] };

/** How often the open dashboard asks for a detection pass. */
const RUN_EVERY_MS = 5 * 60_000;

export function useNotifications() {
  const query = useQuery<NotificationFeed>({
    queryKey: ["notifications"],
    queryFn: () => apiFetch<NotificationFeed>("/notifications?limit=30"),
    enabled: !isDemoMode,
    refetchInterval: 60_000,
  });
  return { data: query.data ?? EMPTY, isError: query.isError };
}

/**
 * Ask for a detection pass on a timer, while this page is open.
 *
 * Runs once on mount as well as on the interval: somebody opening the
 * dashboard after an hour away should see what happened in that hour without
 * waiting five minutes for the first tick.
 */
export function useNotificationRuns() {
  const qc = useQueryClient();
  useEffect(() => {
    if (isDemoMode) return;
    let stopped = false;
    const run = async () => {
      try {
        await apiFetch("/notifications/run", { method: "POST" });
        if (!stopped) void qc.invalidateQueries({ queryKey: ["notifications"] });
      } catch {
        // A failed pass is not worth a message on screen: the next one is in
        // five minutes, and the feed still shows everything already recorded.
      }
    };
    void run();
    const t = setInterval(() => void run(), RUN_EVERY_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [qc]);
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { ids?: string[]; all?: boolean }) =>
      apiFetch("/notifications/read", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}
