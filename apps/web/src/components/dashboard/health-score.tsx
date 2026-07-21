import { TrendingUp } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { operationalHealth } from "@/lib/mock-dashboard";

export function HealthScoreCard() {
  const { score, label, trend } = operationalHealth;
  const circumference = 2 * Math.PI * 42;
  const offset = circumference - (score / 100) * circumference;

  return (
    <Card className="glass">
      <CardContent className="flex items-center gap-6 pt-5">
        <div className="relative flex size-24 shrink-0 items-center justify-center">
          <svg className="size-24 -rotate-90" viewBox="0 0 96 96">
            <circle cx="48" cy="48" r="42" fill="none" stroke="var(--border)" strokeWidth="7" />
            <circle
              cx="48"
              cy="48"
              r="42"
              fill="none"
              stroke="var(--accent-green)"
              strokeWidth="7"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
            />
          </svg>
          <span className="absolute text-xl font-semibold">{score}</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wider text-muted">
            Operational Health
          </span>
          <span className="text-2xl font-semibold text-foreground">{label}</span>
          <div className="flex items-center gap-1 text-xs text-accent-green">
            <TrendingUp className="size-3.5" />
            <span>+{trend} pts vs yesterday</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
