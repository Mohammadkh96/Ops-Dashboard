"use client";

import { motion } from "framer-motion";
import { Check } from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import { StatTileRow, type Stat } from "@/components/ui/stat-tile";
import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LiveDot } from "@/components/ui/live-dot";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { staggerContainer, fadeUp } from "@/lib/motion";
import { cn } from "@/lib/utils";
import {
  tickets,
  type Ticket,
  operators,
  type TicketPriority,
  type Presence,
  shiftChecklist,
} from "@/lib/modules";

const priorityVariant: Record<TicketPriority, "red" | "orange" | "blue" | "default"> = {
  urgent: "red",
  high: "orange",
  medium: "blue",
  low: "default",
};

const presenceDot: Record<Presence, string> = {
  online: "bg-accent-green",
  away: "bg-accent-orange",
  offline: "bg-muted",
};

const openTickets = tickets.filter((t) => t.status === "open" || t.status === "in_progress" || t.status === "escalated").length;
const slaBreaches = tickets.filter((t) => t.slaBreached).length;
const onlineCount = operators.filter((o) => o.presence === "online").length;
const avgHandle = operators.reduce((sum, o) => sum + o.avgHandleMin, 0) / operators.length;
const doneCount = shiftChecklist.filter((i) => i.done).length;

const stats: Stat[] = [
  { label: "Open tickets", value: String(openTickets), tone: "blue", spark: [7, 6, 8, 9, 7, 6, 5, openTickets] },
  { label: "SLA breaches", value: String(slaBreaches), tone: "red", delta: { text: "needs attention", positive: false } },
  { label: "Operators online", value: `${onlineCount} / ${operators.length}`, tone: "green", spark: [2, 3, 3, 4, 3, 3, 4, onlineCount] },
  { label: "Avg handle time", value: `${avgHandle.toFixed(1)}m`, tone: "purple", spark: [8.1, 7.6, 7.2, 7.0, 6.8, 7.1, 6.9, avgHandle] },
];

const columns: Column<Ticket>[] = [
  { key: "id", header: "ID", render: (t) => <span className="font-mono text-xs text-muted-foreground">{t.id}</span> },
  { key: "subject", header: "Subject", render: (t) => <span className="font-medium">{t.subject}</span> },
  { key: "client", header: "Client", render: (t) => <span className="text-muted-foreground">{t.client}</span> },
  {
    key: "priority",
    header: "Priority",
    render: (t) => (
      <Badge variant={priorityVariant[t.priority]}>
        {t.priority[0].toUpperCase() + t.priority.slice(1)}
      </Badge>
    ),
  },
  {
    key: "assignee",
    header: "Assignee",
    render: (t) =>
      t.assignee === "Unassigned" ? (
        <span className="text-muted">Unassigned</span>
      ) : (
        <span>{t.assignee}</span>
      ),
  },
  {
    key: "sla",
    header: "SLA",
    render: (t) => (
      <span className={cn("tnum", t.slaBreached ? "text-accent-red" : "text-muted-foreground")}>
        {t.slaRemaining}
      </span>
    ),
  },
  {
    key: "status",
    header: "Status",
    render: (t) => (
      <StatusBadge status={t.status} label={t.status === "in_progress" ? "In progress" : undefined} />
    ),
  },
];

export default function OperationsPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Operations"
        description="Team workload, tickets and shift handover."
        actions={<Button size="sm">End shift</Button>}
      />

      <StatTileRow stats={stats} />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-3 lg:col-span-2">
          <span className="text-xs font-medium uppercase tracking-wider text-muted">
            Live ticket queue
          </span>
          <DataTable
            columns={columns}
            rows={tickets}
            getRowKey={(t) => t.id}
            empty="No tickets in the queue."
          />
        </div>

        <div className="flex flex-col gap-4">
          <Card className="glass card-seam">
            <CardHeader>
              <CardTitle>Current Shift</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <LiveDot tone="green" />
                <span className="text-sm font-medium">Active · 3h 12m</span>
              </div>

              <ul className="flex flex-col gap-2.5">
                {shiftChecklist.map((item) => (
                  <li key={item.label} className="flex items-center gap-2.5 text-sm">
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-md border transition-colors",
                        item.done
                          ? "border-accent-green bg-accent-green text-white"
                          : "border-border",
                      )}
                    >
                      {item.done ? <Check className="size-3" strokeWidth={3} /> : null}
                    </span>
                    <span className={cn(item.done && "text-muted line-through")}>{item.label}</span>
                  </li>
                ))}
              </ul>

              <span className="text-xs text-muted">
                {doneCount} of {shiftChecklist.length} complete
              </span>
            </CardContent>
          </Card>

          <Card className="glass card-seam">
            <CardHeader>
              <CardTitle>Team online</CardTitle>
            </CardHeader>
            <CardContent>
              <motion.ul
                variants={staggerContainer}
                initial="hidden"
                animate="show"
                className="flex flex-col gap-3"
              >
                {operators.map((op) => (
                  <motion.li key={op.name} variants={fadeUp} className="flex items-center gap-3">
                    <div className="relative">
                      <Avatar>
                        <AvatarFallback>{op.initials}</AvatarFallback>
                      </Avatar>
                      <span
                        className={cn(
                          "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-card",
                          presenceDot[op.presence],
                        )}
                      />
                    </div>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium">{op.name}</span>
                      <span className="text-xs text-muted">{op.role}</span>
                    </div>
                    <span className="tnum ml-auto text-right text-xs text-muted-foreground">
                      {op.active} active · {op.handledToday} today
                    </span>
                  </motion.li>
                ))}
              </motion.ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
