"use client";

import { motion } from "framer-motion";

import { Card, CardContent } from "@/components/ui/card";
import { Sparkline } from "@/components/ui/sparkline";
import { fmtMoney, type Gateway } from "@/lib/modules";
import { useGateways } from "@/hooks/use-modules";
import { staggerContainer, fadeUp } from "@/lib/motion";

const statusMeta: Record<Gateway["status"], { dot: string; text: string; label: string; stroke: string }> = {
  operational: { dot: "bg-accent-green", text: "text-accent-green", label: "Operational", stroke: "var(--accent-green)" },
  degraded: { dot: "bg-accent-orange", text: "text-accent-orange", label: "Degraded", stroke: "var(--accent-orange)" },
  down: { dot: "bg-accent-red", text: "text-accent-red", label: "Offline", stroke: "var(--accent-red)" },
};

export function GatewayGrid() {
  const { data: gateways } = useGateways();
  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
    >
      {gateways.map((g) => {
        const m = statusMeta[g.status];
        return (
          <motion.div key={g.id} variants={fadeUp}>
            <Card className="glass card-seam h-full transition-colors hover:border-border-strong">
              <CardContent className="flex flex-col gap-4 pt-5">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="font-medium">{g.name}</span>
                    <span className={`flex items-center gap-1.5 text-xs ${m.text}`}>
                      <span className={`size-1.5 rounded-full ${m.dot}`} />
                      {m.label}
                    </span>
                  </div>
                  <Sparkline data={g.spark} stroke={m.stroke} fill={m.stroke} width={84} height={28} />
                </div>
                <div className="grid grid-cols-3 gap-2 border-t border-border pt-3 text-center">
                  <div className="flex flex-col">
                    <span className="tnum text-sm font-semibold">{g.successRate.toFixed(1)}%</span>
                    <span className="text-[11px] text-muted">Success</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="tnum text-sm font-semibold">{g.avgLatencyMs}ms</span>
                    <span className="text-[11px] text-muted">Latency</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="tnum text-sm font-semibold">{fmtMoney(g.todayVolume)}</span>
                    <span className="text-[11px] text-muted">Volume</span>
                  </div>
                </div>
                {g.webhookFailures > 0 ? (
                  <span className="rounded-lg border border-accent-red/20 bg-accent-red-soft px-2.5 py-1.5 text-xs text-accent-red">
                    {g.webhookFailures} webhook failure{g.webhookFailures > 1 ? "s" : ""} in last hour
                  </span>
                ) : null}
              </CardContent>
            </Card>
          </motion.div>
        );
      })}
    </motion.div>
  );
}
