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

export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            How healthy is Operations right now — and what needs your attention.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1.5">
          <LiveDot tone="green" />
          <span className="text-xs text-muted-foreground">Live · updated just now</span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[22rem_1fr]">
        <Reveal className="h-full">
          <HealthScoreCard />
        </Reveal>
        <TodayMetricCards />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Reveal>
          <CriticalAlertsCard />
        </Reveal>
        <Reveal>
          <PendingWorkCard />
        </Reveal>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Reveal className="xl:col-span-2">
          <VolumeChartCard />
        </Reveal>
        <Reveal className="h-full">
          <PerformanceMetrics />
        </Reveal>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Reveal className="xl:col-span-2">
          <LiveQueueCard />
        </Reveal>
        <Reveal>
          <SystemStatusCard />
        </Reveal>
      </div>

      <Reveal>
        <TeamPanelCard />
      </Reveal>
    </div>
  );
}
