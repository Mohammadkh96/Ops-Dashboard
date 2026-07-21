import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { pendingWork } from "@/lib/mock-dashboard";
import { cn } from "@/lib/utils";

const toneClasses: Record<string, string> = {
  blue: "text-accent-blue bg-accent-blue-soft",
  purple: "text-accent-purple bg-accent-purple-soft",
  red: "text-accent-red bg-accent-red-soft",
  orange: "text-accent-orange bg-accent-orange-soft",
};

export function PendingWorkCard() {
  return (
    <Card className="glass card-seam h-full">
      <CardHeader>
        <CardTitle>Pending Work</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {pendingWork.map((item) => (
          <Link
            key={item.label}
            href={item.href}
            className="group flex items-center justify-between rounded-lg border border-border px-3.5 py-3 transition-colors hover:border-border-strong hover:bg-card-hover"
          >
            <div className="flex items-center gap-3">
              <span
                className={cn(
                  "flex size-8 items-center justify-center rounded-lg text-sm font-semibold",
                  toneClasses[item.tone],
                )}
              >
                {item.value}
              </span>
              <span className="text-sm text-muted-foreground group-hover:text-foreground">
                {item.label}
              </span>
            </div>
            <ChevronRight className="size-4 text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}
