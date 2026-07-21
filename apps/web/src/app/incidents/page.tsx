"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Plus } from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import { StatTileRow, type Stat } from "@/components/ui/stat-tile";
import { StatusBadge } from "@/components/ui/status-badge";
import { Drawer } from "@/components/ui/drawer";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { staggerContainer, fadeUp } from "@/lib/motion";
import { type Incident, type IncidentSeverity } from "@/lib/modules";
import { useIncidents } from "@/hooks/use-modules";

const SEVERITY: Record<IncidentSeverity, { color: string; label: string }> = {
  critical: { color: "var(--accent-red)", label: "SEV-1 Critical" },
  high: { color: "var(--accent-red)", label: "SEV-2 High" },
  medium: { color: "var(--accent-orange)", label: "SEV-3 Medium" },
  low: { color: "var(--accent-blue)", label: "SEV-4 Low" },
};

const isActive = (i: Incident) => i.status === "open" || i.status === "investigating";

export default function IncidentsPage() {
  const [selected, setSelected] = useState<Incident | null>(null);
  const { data: incidents } = useIncidents();
  const sev = selected ? SEVERITY[selected.severity] : null;
  const resolved = selected?.status === "resolved" || selected?.status === "closed";

  const stats: Stat[] = useMemo(
    () => [
      { label: "Active incidents", value: String(incidents.filter(isActive).length), tone: "red" },
      { label: "Critical (SEV-1)", value: String(incidents.filter((i) => i.severity === "critical").length), tone: "orange" },
      { label: "Investigating", value: String(incidents.filter((i) => i.status === "investigating").length), tone: "blue" },
      { label: "Resolved today", value: String(incidents.filter((i) => i.status === "resolved").length), tone: "green" },
    ],
    [incidents],
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Incidents"
        description="Severity, impact, ownership and resolution."
        actions={
          <Button size="sm">
            <Plus className="size-4" /> Declare incident
          </Button>
        }
      />

      <StatTileRow stats={stats} />

      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="flex flex-col gap-3"
      >
        {incidents.map((incident) => {
          const s = SEVERITY[incident.severity];
          return (
            <motion.div key={incident.id} variants={fadeUp}>
              <Card
                onClick={() => setSelected(incident)}
                className="cursor-pointer overflow-hidden transition-colors hover:border-border-strong"
              >
                <CardContent className="flex items-center gap-4 py-4 pl-0">
                  <span
                    className="h-12 w-1 shrink-0 rounded-full"
                    style={{ backgroundColor: s.color }}
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{incident.id}</span>
                      <span className="font-medium">{incident.title}</span>
                      <StatusBadge status={incident.status} />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span
                        className="text-xs font-medium uppercase tracking-wider"
                        style={{ color: s.color }}
                      >
                        {s.label}
                      </span>
                      <span className="text-muted-foreground text-sm">{incident.impact}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-sm text-muted-foreground">{incident.owner}</span>
                    <span className="tnum text-xs text-muted">{incident.openedAt}</span>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          );
        })}
      </motion.div>

      <Drawer
        open={selected !== null}
        onOpenChange={(o) => !o && setSelected(null)}
        title={selected?.title ?? ""}
        subtitle={selected ? `${selected.id} · ${selected.owner}` : ""}
        footer={
          selected ? (
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1">Add update</Button>
              {resolved ? (
                <Button variant="outline" className="flex-1">Reopen</Button>
              ) : (
                <Button className="flex-1">Resolve</Button>
              )}
            </div>
          ) : null
        }
      >
        {selected && sev ? (
          <div className="flex flex-col gap-5">
            <div className="flex items-center justify-between rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-3">
                <span className="size-2.5 rounded-full" style={{ backgroundColor: sev.color }} />
                <span className="font-medium" style={{ color: sev.color }}>{sev.label}</span>
              </div>
              <StatusBadge status={selected.status} />
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wider text-muted">Impact</span>
              <p className="text-sm text-muted-foreground">{selected.impact}</p>
            </div>

            {selected.rootCause ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium uppercase tracking-wider text-muted">Root cause</span>
                <p className="text-sm text-muted-foreground">{selected.rootCause}</p>
              </div>
            ) : null}

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs text-muted">Owner</dt>
                <dd>{selected.owner}</dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs text-muted">Opened</dt>
                <dd className="tnum">{selected.openedAt}</dd>
              </div>
            </dl>

            <div className="flex flex-col gap-3">
              <span className="text-xs font-medium uppercase tracking-wider text-muted">Timeline</span>
              <ol className="flex flex-col gap-3 border-l border-border pl-4">
                {selected.timeline.map((entry, i) => (
                  <li key={i} className="relative text-sm">
                    <span
                      className="absolute -left-[21px] top-1.5 size-2 rounded-full"
                      style={{ backgroundColor: sev.color }}
                    />
                    <div className="flex justify-between gap-3">
                      <span>{entry.text}</span>
                      <span className="tnum text-xs text-muted">{entry.time}</span>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
