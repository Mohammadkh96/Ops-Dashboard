"use client";

import type { ReactNode } from "react";
import { motion } from "framer-motion";

import { Card, CardContent } from "@/components/ui/card";
import { Sparkline } from "@/components/ui/sparkline";
import { staggerContainer, fadeUp } from "@/lib/motion";
import { cn } from "@/lib/utils";

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
          <Card className="glass card-seam h-full">
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
              <span className="tnum text-2xl font-semibold tracking-tight">{s.value}</span>
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
