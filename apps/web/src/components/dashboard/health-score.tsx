"use client";

import { motion } from "framer-motion";
import { TrendingUp } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { AnimatedNumber } from "@/components/ui/animated-number";
import type { DashboardSummary } from "@/lib/dashboard";
import { easeOut } from "@/lib/motion";

export function HealthScoreCard({ health }: { health: DashboardSummary["health"] }) {
  const { score, label, trend } = health;
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;

  return (
    <Card className="glass card-seam h-full">
      <CardContent className="flex h-full items-center gap-6 pt-5">
        <div className="relative flex size-24 shrink-0 items-center justify-center">
          <svg className="size-24 -rotate-90" viewBox="0 0 96 96">
            <circle cx="48" cy="48" r={radius} fill="none" stroke="var(--border)" strokeWidth="7" />
            <motion.circle
              cx="48"
              cy="48"
              r={radius}
              fill="none"
              stroke="var(--accent-green)"
              strokeWidth="7"
              strokeLinecap="round"
              strokeDasharray={circumference}
              initial={{ strokeDashoffset: circumference }}
              animate={{ strokeDashoffset: offset }}
              transition={{ duration: 1.2, ease: easeOut, delay: 0.15 }}
              style={{ filter: "drop-shadow(0 0 6px color-mix(in srgb, var(--accent-green) 45%, transparent))" }}
            />
          </svg>
          <AnimatedNumber
            value={score}
            format={(n) => `${Math.round(n)}`}
            className="tnum absolute text-xl font-semibold"
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wider text-muted">
            Operational Health
          </span>
          <span className="text-2xl font-semibold text-foreground">{label}</span>
          <div className="flex items-center gap-1 text-xs text-accent-green">
            <TrendingUp className="size-3.5" />
            <span className="tnum">+{trend} pts vs yesterday</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
