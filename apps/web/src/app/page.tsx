import { HealthScoreCard } from "@/components/dashboard/health-score";
import { TodayMetricCards, PerformanceMetrics } from "@/components/dashboard/metric-cards";
import { PendingWorkCard } from "@/components/dashboard/pending-work";
import { CriticalAlertsCard } from "@/components/dashboard/critical-alerts";
import { SystemStatusCard } from "@/components/dashboard/system-status";
import { VolumeChartCard } from "@/components/dashboard/volume-chart";
import { LiveQueueCard } from "@/components/dashboard/live-queue";
import { TeamPanelCard } from "@/components/dashboard/team-panel";

export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          How healthy is Operations right now — and what needs your attention.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[22rem_1fr]">
        <HealthScoreCard />
        <TodayMetricCards />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CriticalAlertsCard />
        <PendingWorkCard />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <VolumeChartCard />
        </div>
        <PerformanceMetrics />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <LiveQueueCard />
        </div>
        <div className="flex flex-col gap-4">
          <SystemStatusCard />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TeamPanelCard />
      </div>
    </div>
  );
}
