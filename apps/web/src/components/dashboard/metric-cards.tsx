import { ArrowDownRight, ArrowUpRight } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { todayMetrics, performanceMetrics } from "@/lib/mock-dashboard";
import { Progress } from "@/components/ui/progress";

export function TodayMetricCards() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {todayMetrics.map((m) => (
        <Card key={m.label} className="glass">
          <CardContent className="flex flex-col gap-2 pt-5">
            <span className="text-xs font-medium uppercase tracking-wider text-muted">
              {m.label}
            </span>
            <span className="text-2xl font-semibold">{m.value}</span>
            <div
              className={`flex items-center gap-1 text-xs ${
                m.positive ? "text-accent-green" : "text-accent-red"
              }`}
            >
              {m.positive ? (
                <ArrowUpRight className="size-3.5" />
              ) : (
                <ArrowDownRight className="size-3.5" />
              )}
              <span>{m.change} vs yesterday</span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function PerformanceMetrics() {
  return (
    <Card className="glass">
      <CardContent className="flex flex-col gap-5 pt-5">
        <span className="text-xs font-medium uppercase tracking-wider text-muted">
          Today&apos;s Performance
        </span>
        <div className="flex flex-col gap-4">
          {performanceMetrics.map((m) => (
            <div key={m.label} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{m.label}</span>
                <span className="font-medium text-foreground">
                  {m.value}
                  {m.suffix}
                </span>
              </div>
              <Progress value={m.value} />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
