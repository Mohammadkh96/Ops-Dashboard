"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/* ------------------------------------------------------------------ */
/* Shared themed tooltip                                              */
/* ------------------------------------------------------------------ */

type TooltipEntry = { name: string; value: number; color: string };

type ChartTooltipProps = {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
  unit?: string;
};

function ChartTooltip({ active, payload, label, unit = "" }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 shadow-[var(--shadow-pop)]">
      {label ? <p className="mb-1 text-[11px] font-medium text-muted">{label}</p> : null}
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2 text-xs">
          <span className="size-2 rounded-full" style={{ background: p.color }} />
          <span className="capitalize text-muted-foreground">{p.name}</span>
          <span className="tnum ml-auto font-medium text-foreground">
            {p.value}
            {unit}
          </span>
        </div>
      ))}
    </div>
  );
}

const cursorLine = {
  stroke: "var(--border-strong)",
  strokeWidth: 1,
  strokeDasharray: "4 4",
} as const;

const cursorFill = { fill: "var(--border)", fillOpacity: 0.35 } as const;

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex items-center gap-4">
      {items.map((s) => (
        <div key={s.label} className="flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
          <span className="text-xs text-muted-foreground">{s.label}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 1. Payment success rate — area, single series (blue)              */
/* ------------------------------------------------------------------ */

export type SuccessPoint = { label: string; rate: number };

export function SuccessRateChart({ data }: { data: SuccessPoint[] }) {
  return (
    <Card className="glass card-seam h-full">
      <CardHeader>
        <CardTitle>Payment success rate</CardTitle>
      </CardHeader>
      <CardContent className="h-72 pt-2">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
            <defs>
              <linearGradient id="fill-success" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent-blue)" stopOpacity={0.32} />
                <stop offset="100%" stopColor="var(--accent-blue)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="label"
              stroke="var(--muted)"
              tick={{ fill: "var(--muted)", fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              domain={[90, 100]}
              stroke="var(--muted)"
              tick={{ fill: "var(--muted)", fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<ChartTooltip unit="%" />} cursor={cursorLine} />
            <Area
              type="monotone"
              dataKey="rate"
              name="Success"
              stroke="var(--accent-blue)"
              fill="url(#fill-success)"
              strokeWidth={2}
              activeDot={{ r: 4, strokeWidth: 0 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* 2. Approvals vs Declines — grouped bar, two series (blue+magenta) */
/* ------------------------------------------------------------------ */

export type ApprovalPoint = { label: string; approvals: number; declines: number };

const APPROVAL_SERIES = [
  { label: "Approvals", color: "var(--accent-blue)" },
  { label: "Declines", color: "var(--accent-magenta)" },
];

export function ApprovalsDeclinesChart({ data }: { data: ApprovalPoint[] }) {
  return (
    <Card className="glass card-seam h-full">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Approvals vs Declines</CardTitle>
        <Legend items={APPROVAL_SERIES} />
      </CardHeader>
      <CardContent className="h-72 pt-2">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }} barGap={4}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="label"
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
            <Tooltip content={<ChartTooltip />} cursor={cursorFill} />
            <Bar dataKey="approvals" name="Approvals" fill="var(--accent-blue)" radius={[3, 3, 0, 0]} />
            <Bar dataKey="declines" name="Declines" fill="var(--accent-magenta)" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* 3. Gateway performance — horizontal bar, single series (blue)     */
/* ------------------------------------------------------------------ */

export type GatewayPoint = { gateway: string; rate: number };

export function GatewayPerformanceChart({ data }: { data: GatewayPoint[] }) {
  return (
    <Card className="glass card-seam h-full">
      <CardHeader>
        <CardTitle>Gateway performance</CardTitle>
      </CardHeader>
      <CardContent className="h-72 pt-2">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 4, right: 12, left: 8, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
            <XAxis
              type="number"
              domain={[0, 100]}
              stroke="var(--muted)"
              tick={{ fill: "var(--muted)", fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="gateway"
              width={72}
              stroke="var(--muted)"
              tick={{ fill: "var(--muted)", fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<ChartTooltip unit="%" />} cursor={cursorFill} />
            <Bar dataKey="rate" name="Success rate" fill="var(--accent-blue)" radius={[0, 3, 3, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* 4. Volume by country — bar, single series (purple)                */
/* ------------------------------------------------------------------ */

export type CountryPoint = { country: string; volume: number };

export function VolumeByCountryChart({ data }: { data: CountryPoint[] }) {
  return (
    <Card className="glass card-seam h-full">
      <CardHeader>
        <CardTitle>Volume by country</CardTitle>
      </CardHeader>
      <CardContent className="h-72 pt-2">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="country"
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
            <Tooltip content={<ChartTooltip unit="M" />} cursor={cursorFill} />
            <Bar dataKey="volume" name="Volume" fill="var(--accent-purple)" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
