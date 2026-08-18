"use client";

import { HealthScoreCard } from "@/components/dashboard/health-score";
import { TodayMetricCards, PerformanceMetrics } from "@/components/dashboard/metric-cards";
import { PendingWorkCard } from "@/components/dashboard/pending-work";
import { CriticalAlertsCard } from "@/components/dashboard/critical-alerts";
import { SystemStatusCard } from "@/components/dashboard/system-status";
import { VolumeChartCard } from "@/components/dashboard/volume-chart";
import { LiveQueueCard } from "@/components/dashboard/live-queue";
import { TeamPanelCard } from "@/components/dashboard/team-panel";
import { Reveal } from "@/components/ui/reveal";
import { LiveDot } from "@/components/ui/live-dot";
import { useDashboardSummary } from "@/hooks/use-dashboard";
import { useLiveFeed } from "@/hooks/use-live-feed";
import { useAuth } from "@/lib/auth";

function greeting(hour: number) {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function tickTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function DashboardView() {
  const { data, isDemo, isError } = useDashboardSummary();
  const { items: liveItems, lastTick, connected } = useLiveFeed();
  const { user } = useAuth();

  const now = new Date();
  const rawName = (user?.email ?? "mohammad@tradin.com").split("@")[0].split(/[._-]/)[0];
  const displayName = rawName.charAt(0).toUpperCase() + rawName.slice(1);
  const dateLabel = now.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const statusLabel = isError
    ? "API unreachable — showing demo data"
    : lastTick
      ? `${isDemo ? "Demo" : "Live"} · updated ${tickTime(lastTick.ts)}`
      : isDemo
        ? "Demo data"
        : "Live · connecting…";

  // Live items stream in ahead of the seeded queue; cap the visible rows.
  //
  // Deduped by id, keeping the streamed copy: both lists are built from the
  // same payments, so a payment already in the summary's queue arrived again
  // through the feed and was rendered twice — the same id, sometimes under two
  // different statuses, which reads as a duplicate or a contradiction.
  const seenRows = new Set<string>();
  const queueRows = [...liveItems, ...data.liveQueue]
    .filter((r) => !seenRows.has(r.id) && seenRows.add(r.id))
    .slice(0, 6);
  const feedOnline = connected && !isError;

  return (
    <div className="flex flex-col gap-6">
      <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-accent-blue-soft/50 via-card/40 to-card/20 px-6 py-5">
        <div
          className="pointer-events-none absolute -right-16 -top-16 size-56 rounded-full opacity-40 blur-3xl"
          style={{ background: "radial-gradient(circle, var(--accent-blue), transparent 70%)" }}
        />
        <div className="relative flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted">
              {dateLabel}
            </span>
            <h1 className="text-2xl font-semibold tracking-tight">
              {greeting(now.getHours())}, {displayName}
            </h1>
            <p className="text-sm text-muted-foreground">
              How healthy is Operations right now — and what needs your attention.
            </p>
          </div>
          <span className="flex items-center gap-2 rounded-full border border-border bg-card/70 px-3 py-1.5 backdrop-blur">
            <LiveDot tone={isError ? "orange" : feedOnline ? "green" : "blue"} />
            <span className="text-xs text-muted-foreground">{statusLabel}</span>
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[22rem_1fr]">
        <Reveal className="h-full">
          <HealthScoreCard health={data.health} />
        </Reveal>
        <TodayMetricCards metrics={data.today} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Reveal>
          <CriticalAlertsCard alerts={data.alerts} />
        </Reveal>
        <Reveal>
          <PendingWorkCard items={data.pendingWork} />
        </Reveal>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Reveal className="xl:col-span-2">
          <VolumeChartCard series={data.volumeSeries} />
        </Reveal>
        <Reveal className="h-full">
          <PerformanceMetrics metrics={data.performance} />
        </Reveal>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Reveal className="xl:col-span-2">
          <LiveQueueCard rows={queueRows} newestId={lastTick?.queueItem.id} />
        </Reveal>
        <Reveal>
          <SystemStatusCard items={data.systemStatus} />
        </Reveal>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Reveal>
          <TeamPanelCard team={data.team} />
        </Reveal>
      </div>
    </div>
  );
}
