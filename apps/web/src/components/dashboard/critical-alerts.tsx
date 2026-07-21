import { AlertTriangle, AlertOctagon, Info } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { AlertItem } from "@/lib/dashboard";

const severityConfig = {
  critical: { icon: AlertOctagon, badge: "red" as const, label: "Critical" },
  warning: { icon: AlertTriangle, badge: "orange" as const, label: "Warning" },
  info: { icon: Info, badge: "blue" as const, label: "Info" },
};

export function CriticalAlertsCard({ alerts }: { alerts: AlertItem[] }) {
  return (
    <Card className="glass card-seam h-full">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Critical Alerts</CardTitle>
        <Badge variant="red">{alerts.length} active</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
        {alerts.map((alert) => {
          const config = severityConfig[alert.severity];
          const Icon = config.icon;
          return (
            <div
              key={alert.id}
              className="flex items-start gap-3 rounded-lg border border-border px-3.5 py-3 transition-colors hover:border-border-strong"
            >
              <Icon
                className={`mt-0.5 size-4 shrink-0 ${
                  alert.severity === "critical"
                    ? "text-accent-red"
                    : alert.severity === "warning"
                      ? "text-accent-orange"
                      : "text-accent-blue"
                }`}
              />
              <div className="flex flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">{alert.title}</span>
                <span className="text-xs text-muted-foreground">{alert.detail}</span>
              </div>
              <span className="whitespace-nowrap text-xs text-muted">{alert.time}</span>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
