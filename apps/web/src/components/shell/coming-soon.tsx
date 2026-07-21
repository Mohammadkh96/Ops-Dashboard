import type { LucideIcon } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export function ComingSoon({
  title,
  description,
  icon: Icon,
  phase,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  phase: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <Badge variant="purple">{phase}</Badge>
      </div>
      <Card className="glass">
        <CardContent className="flex flex-col items-center justify-center gap-3 py-20 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-accent-blue-soft">
            <Icon className="size-6 text-accent-blue" />
          </div>
          <p className="text-sm font-medium text-foreground">Module scaffolded, build in progress</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            This module is on the OpsOS roadmap. See ROADMAP.md for build order and status.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
