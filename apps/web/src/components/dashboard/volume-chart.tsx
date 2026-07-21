"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { volumeSeries } from "@/lib/mock-dashboard";

const SERIES = [
  { key: "deposits", label: "Deposits", color: "var(--accent-blue)" },
  { key: "withdrawals", label: "Withdrawals", color: "var(--accent-magenta)" },
] as const;

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 shadow-[var(--shadow-pop)]">
      <p className="mb-1 text-[11px] font-medium text-muted">{label}</p>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2 text-xs">
          <span className="size-2 rounded-full" style={{ background: p.color }} />
          <span className="capitalize text-muted-foreground">{p.name}</span>
          <span className="tnum ml-auto font-medium text-foreground">${p.value}K</span>
        </div>
      ))}
    </div>
  );
}

export function VolumeChartCard() {
  return (
    <Card className="glass card-seam h-full">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Deposits vs Withdrawals — Today</CardTitle>
        <div className="flex items-center gap-4">
          {SERIES.map((s) => (
            <div key={s.key} className="flex items-center gap-1.5">
              <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
              <span className="text-xs text-muted-foreground">{s.label}</span>
            </div>
          ))}
        </div>
      </CardHeader>
      <CardContent className="h-72 pt-2">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={volumeSeries} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
            <defs>
              <linearGradient id="fill-deposits" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent-blue)" stopOpacity={0.32} />
                <stop offset="100%" stopColor="var(--accent-blue)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="fill-withdrawals" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent-magenta)" stopOpacity={0.28} />
                <stop offset="100%" stopColor="var(--accent-magenta)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="time"
              stroke="var(--muted)"
              tick={{ fill: "var(--muted)", fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              stroke="var(--muted)"
              tick={{ fill: "var(--muted)", fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              content={<ChartTooltip />}
              cursor={{ stroke: "var(--border-strong)", strokeWidth: 1, strokeDasharray: "4 4" }}
            />
            <Area
              type="monotone"
              dataKey="deposits"
              stroke="var(--accent-blue)"
              fill="url(#fill-deposits)"
              strokeWidth={2}
              activeDot={{ r: 4, strokeWidth: 0 }}
            />
            <Area
              type="monotone"
              dataKey="withdrawals"
              stroke="var(--accent-magenta)"
              fill="url(#fill-withdrawals)"
              strokeWidth={2}
              activeDot={{ r: 4, strokeWidth: 0 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
