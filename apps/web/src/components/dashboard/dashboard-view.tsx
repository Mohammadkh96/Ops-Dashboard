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

export function DashboardView() {
  const { data, isDemo, isError } = useDashboardSummary();

  const statusLabel = isDemo
    ? "Demo data"
    : isError
      ? "API unreachable — showing demo data"
      : "Live · updated just now";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            How healthy is Operations right now — and what needs your attention.
          </p>
        </div>
        <span className="flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1.5">
          <LiveDot tone={isDemo || isError ? "orange" : "green"} />
          <span className="text-xs text-muted-foreground">{statusLabel}</span>
        </span>
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
          <LiveQueueCard rows={data.liveQueue} />
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
