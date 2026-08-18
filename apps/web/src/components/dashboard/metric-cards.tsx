"use client";

import { motion } from "framer-motion";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { Sparkline } from "@/components/ui/sparkline";
import { Progress } from "@/components/ui/progress";
import { formatKpi, type KpiMetric, type PerfMetric, type Tone } from "@/lib/dashboard";
import { staggerContainer, fadeUp } from "@/lib/motion";

const toneVar: Record<Tone, string> = {
  blue: "var(--accent-blue)",
  green: "var(--accent-green)",
  magenta: "var(--accent-magenta)",
  purple: "var(--accent-purple)",
  red: "var(--accent-red)",
  orange: "var(--accent-orange)",
};

export function TodayMetricCards({ metrics }: { metrics: KpiMetric[] }) {
  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      className="grid h-full grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
    >
      {metrics.map((m) => (
        <motion.div key={m.key} variants={fadeUp}>
          <Card className="glass card-seam hover-lift group h-full">
            <CardContent className="flex flex-col gap-3 pt-5">
              <div className="flex items-start justify-between">
                <span className="text-xs font-medium uppercase tracking-wider text-muted">
                  {m.label}
                </span>
                <Sparkline data={m.spark} stroke={toneVar[m.tone]} fill={toneVar[m.tone]} />
              </div>
              <AnimatedNumber
                value={m.value}
                format={formatKpi(m)}
                className="tnum text-2xl font-semibold tracking-tight"
              />
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
                <span className="tnum">{m.change}</span>
                <span className="text-muted">vs yesterday</span>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      ))}
    </motion.div>
  );
}

const perfTone = (label: string) =>
  label === "Decline Rate" || label === "Refund Rate"
    ? "bg-accent-orange"
    : "bg-accent-green";

export function PerformanceMetrics({ metrics }: { metrics: PerfMetric[] }) {
  return (
    <Card className="glass card-seam h-full">
      <CardContent className="flex flex-col gap-5 pt-5">
        <span className="text-xs font-medium uppercase tracking-wider text-muted">
          Today&apos;s Performance
        </span>
        <div className="flex flex-col gap-4">
          {metrics.map((m) => {
            // Counts are not percentages. Everything here used to render as
            // "N%" over a progress bar, so 207 settled payments displayed as
            // "207.0%" on a bar sitting at full — a number that cannot be read
            // as anything true.
            const isCount = m.unit === "count";
            return (
              <div key={m.label} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{m.label}</span>
                  <AnimatedNumber
                    value={m.value}
                    format={(n) =>
                      isCount ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : `${n.toFixed(1)}%`
                    }
                    className="tnum font-medium text-foreground"
                  />
                </div>
                {/* A bar needs a 0–100 scale to mean anything. */}
                {isCount ? null : (
                  <Progress value={m.value} indicatorClassName={perfTone(m.label)} />
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
