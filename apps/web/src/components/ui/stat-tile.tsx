"use client";

import type { ReactNode } from "react";
import { motion } from "framer-motion";

import { Card, CardContent } from "@/components/ui/card";
import { Sparkline } from "@/components/ui/sparkline";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { staggerContainer, fadeUp } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * Splits a formatted stat like "$4.82M" or "5 / 6" into a leading prefix,
 * the first numeric run, and a trailing suffix so the number can count up
 * while the surrounding text stays fixed. Returns null when there's no number.
 */
function StatValue({ value }: { value: string }) {
  const match = value.match(/[\d,]*\.?\d+/);
  if (!match || match.index === undefined) {
    return <span className="tnum text-2xl font-semibold tracking-tight">{value}</span>;
  }
  const raw = match[0];
  const num = parseFloat(raw.replace(/,/g, ""));
  const decimals = raw.includes(".") ? raw.split(".")[1].length : 0;
  const hasThousands = raw.includes(",");
  const prefix = value.slice(0, match.index);
  const suffix = value.slice(match.index + raw.length);
  return (
    <span className="tnum text-2xl font-semibold tracking-tight">
      {prefix}
      <AnimatedNumber
        value={num}
        format={(n) =>
          n.toLocaleString(undefined, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
            useGrouping: hasThousands,
          })
        }
      />
      {suffix}
    </span>
  );
}

export type Stat = {
  label: string;
  value: string;
  delta?: { text: string; positive: boolean };
  tone?: "blue" | "green" | "magenta" | "purple" | "orange" | "red";
  spark?: number[];
  icon?: ReactNode;
};

const toneVar: Record<NonNullable<Stat["tone"]>, string> = {
  blue: "var(--accent-blue)",
  green: "var(--accent-green)",
  magenta: "var(--accent-magenta)",
  purple: "var(--accent-purple)",
  orange: "var(--accent-orange)",
  red: "var(--accent-red)",
};

export function StatTileRow({ stats, className }: { stats: Stat[]; className?: string }) {
  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4", className)}
    >
      {stats.map((s) => (
        <motion.div key={s.label} variants={fadeUp}>
          <Card className="glass hover-lift relative h-full overflow-hidden">
            <span
              className="absolute inset-x-0 top-0 h-0.5"
              style={{
                background: `linear-gradient(90deg, transparent, ${toneVar[s.tone ?? "blue"]}, transparent)`,
                opacity: 0.7,
              }}
            />
            <CardContent className="flex flex-col gap-3 pt-5">
              <div className="flex items-start justify-between">
                <span className="text-xs font-medium uppercase tracking-wider text-muted">
                  {s.label}
                </span>
                {s.spark ? (
                  <Sparkline data={s.spark} stroke={toneVar[s.tone ?? "blue"]} fill={toneVar[s.tone ?? "blue"]} />
                ) : s.icon ? (
                  <span className="text-muted">{s.icon}</span>
                ) : null}
              </div>
              <StatValue value={s.value} />
              {s.delta ? (
                <span
                  className={cn(
                    "tnum text-xs",
                    s.delta.positive ? "text-accent-green" : "text-accent-red",
                  )}
                >
                  {s.delta.text}
                </span>
              ) : null}
            </CardContent>
          </Card>
        </motion.div>
      ))}
    </motion.div>
  );
}
