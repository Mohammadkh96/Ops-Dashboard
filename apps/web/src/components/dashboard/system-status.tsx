import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { systemStatus, type SystemStatus } from "@/lib/mock-dashboard";

const statusStyles: Record<SystemStatus, { dot: string; label: string; text: string }> = {
  operational: { dot: "bg-accent-green", label: "Operational", text: "text-accent-green" },
  degraded: { dot: "bg-accent-orange", label: "Degraded", text: "text-accent-orange" },
  down: { dot: "bg-accent-red", label: "Down", text: "text-accent-red" },
};

export function SystemStatusCard() {
  return (
    <Card className="glass card-seam h-full">
      <CardHeader>
        <CardTitle>System Status</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {systemStatus.map((system) => {
          const style = statusStyles[system.status];
          return (
            <div key={system.name} className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2.5">
                <span className={`size-2 rounded-full ${style.dot}`} />
                <span className="text-foreground">{system.name}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted">{system.latency}</span>
                <span className={`text-xs font-medium ${style.text}`}>{style.label}</span>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
