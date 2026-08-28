"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Plus, Radio } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { PageHeader } from "@/components/ui/page-header";
import { StatTileRow, type Stat } from "@/components/ui/stat-tile";
import { StatusBadge } from "@/components/ui/status-badge";
import { Drawer } from "@/components/ui/drawer";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { apiFetch, isDemoMode } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  CategoryChips,
  CategoryPicker,
  categoryClass,
} from "@/components/incidents/category-picker";
import { staggerContainer, fadeUp } from "@/lib/motion";
import { incidents as demoIncidents, type IncidentSeverity } from "@/lib/modules";

/**
 * Incidents, from the only two sources that are real.
 *
 * DETECTED rows are conditions the payment data is reporting right now — a
 * provider that has stopped settling, a decline rate above its own baseline,
 * payments with no final state, the feed going quiet. They carry the numbers
 * that produced them and disappear when the condition clears.
 *
 * DECLARED rows are incidents somebody opened. Declaring a detection copies its
 * evidence, because the condition is transient and an hour later there would be
 * nothing left to check the decision against.
 *
 * This page used to list four invented incidents. On an operations screen that
 * is worse than an empty page: it teaches whoever is on the desk to ignore the
 * one place a real outage would appear.
 */

type Incident = {
  id: string;
  /** Database id for a declared incident; the signature for a detected one. */
  key: string;
  source: "detected" | "declared";
  title: string;
  severity: IncidentSeverity;
  status: string;
  owner: string;
  impact: string;
  rootCause?: string;
  resolution?: string;
  /** What kind of thing this is. Always present, empty for a detection. */
  categories?: { id: string; name: string; slug: string; tone: string }[];
  evidence?: string[];
  /** The payments the incident is about — see DetectionSample on the API. */
  samples?: {
    reference: string;
    customer: string | null;
    psp: string | null;
    type: string | null;
    amount: number;
    currency: string | null;
    state: string | null;
    at: string;
    ageMins: number;
  }[];
  sampleTotal?: number;
  psp?: string | null;
  openedAt: string;
  timeline: { time: string; text: string }[];
};

const SEVERITY: Record<IncidentSeverity, { color: string; label: string }> = {
  critical: { color: "var(--accent-red)", label: "SEV-1 Critical" },
  high: { color: "var(--accent-red)", label: "SEV-2 High" },
  medium: { color: "var(--accent-orange)", label: "SEV-3 Medium" },
  low: { color: "var(--accent-blue)", label: "SEV-4 Low" },
};

/** Minutes as something a person reads at a glance. */
function fmtAge(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ${mins % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const isActive = (i: Incident) => i.status === "open" || i.status === "investigating";

/** Demo mode has no API; the bundled incidents are labelled as the sample they are. */
const DEMO: Incident[] = demoIncidents.map((i) => ({
  ...i,
  key: i.id,
  source: "declared" as const,
  evidence: [],
}));

export default function IncidentsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [declaring, setDeclaring] = useState(false);
  const [form, setForm] = useState({ title: "", severity: "medium", impact: "" });
  // Kept apart from `form` because it is a list rather than a field, and
  // because it is also what a detection is tagged with on its own declare
  // button — where there is no form at all.
  const [categories, setCategories] = useState<string[]>([]);
  // Null while the incident's own categories are being shown as they are; an
  // array once somebody has changed them and not yet saved. The distinction
  // matters — an empty array is "remove every category", which is a real thing
  // to want and must not be confused with "not editing".
  const [retag, setRetag] = useState<string[] | null>(null);
  /** Narrow the list to one category. Null is everything. */
  const [filter, setFilter] = useState<string | null>(null);
  const [note, setNote] = useState("");
  // A toast disappears before it can be read, let alone acted on. The reason a
  // write failed stays until the next attempt.
  const [failure, setFailure] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["incidents"],
    queryFn: () => apiFetch<Incident[]>("/incidents"),
    enabled: !isDemoMode,
    // A condition can clear between refreshes; an ops screen showing an outage
    // that ended twenty minutes ago is its own small incident.
    refetchInterval: 30_000,
  });

  // In live mode an error shows as an error. Falling back to the sample list
  // would put four fictional outages on screen at the exact moment the API is
  // in trouble.
  // Memoised because three separate useMemos below take it as a dependency: a
  // fresh array on every render made all of them recompute on every render,
  // which is the whole reason they exist.
  const incidents = useMemo<Incident[]>(
    () => (isDemoMode ? DEMO : (data ?? [])),
    [data],
  );
  const selected = incidents.find((i) => i.key === selectedKey) ?? null;
  const sev = selected ? SEVERITY[selected.severity] : null;
  const resolved = selected?.status === "resolved" || selected?.status === "closed";

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["incidents"] });

  const declare = useMutation({
    mutationFn: (body: {
      title?: string;
      severity?: string;
      impact?: string;
      signature?: string;
      categories?: string[];
    }) => apiFetch("/incidents", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      void refresh();
      setDeclaring(false);
      setFailure(null);
      setForm({ title: "", severity: "medium", impact: "" });
      setCategories([]);
      void queryClient.invalidateQueries({ queryKey: ["incident-categories"] });
      toast({ title: "Incident declared" });
    },
    onError: (e) => {
      const detail = e instanceof Error ? e.message : String(e);
      setFailure(detail);
      toast({ title: "Could not declare", description: detail });
    },
  });

  const saveTags = useMutation({
    mutationFn: ({ key, categories: names }: { key: string; categories: string[] }) =>
      apiFetch(`/incidents/${encodeURIComponent(key)}/categories`, {
        method: "PUT",
        body: JSON.stringify({ categories: names }),
      }),
    onSuccess: () => {
      setRetag(null);
      setFailure(null);
      void refresh();
      void queryClient.invalidateQueries({ queryKey: ["incident-categories"] });
      toast({ title: "Categories saved" });
    },
    onError: (e) => {
      const detail = e instanceof Error ? e.message : String(e);
      setFailure(detail);
      toast({ title: "Could not save the categories", description: detail });
    },
  });

  const update = useMutation({
    mutationFn: ({ key, ...body }: { key: string; status?: string; note?: string; resolution?: string }) =>
      apiFetch(`/incidents/${encodeURIComponent(key)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void refresh();
      setNote("");
      setFailure(null);
      toast({ title: "Incident updated" });
    },
    onError: (e) => {
      const detail = e instanceof Error ? e.message : String(e);
      setFailure(detail);
      toast({ title: "Could not update", description: detail });
    },
  });

  // The categories actually in use on what is on screen, rather than every
  // category that exists. A filter row offering twelve chips where eleven
  // return nothing is a row people learn to skip.
  const inUse = useMemo(() => {
    const seen = new Map<string, { name: string; tone: string; count: number }>();
    for (const i of incidents) {
      for (const c of i.categories ?? []) {
        const at = seen.get(c.slug);
        if (at) at.count++;
        else seen.set(c.slug, { name: c.name, tone: c.tone, count: 1 });
      }
    }
    return [...seen.entries()]
      .map(([slug, v]) => ({ slug, ...v }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [incidents]);

  const shown = useMemo(
    () =>
      filter
        ? incidents.filter((i) => (i.categories ?? []).some((c) => c.slug === filter))
        : incidents,
    [incidents, filter],
  );

  const stats: Stat[] = useMemo(() => {
    const active = incidents.filter(isActive);
    return [
      { label: "Active incidents", value: String(active.length), tone: active.length ? "red" : "green" },
      {
        label: "Critical (SEV-1)",
        value: String(active.filter((i) => i.severity === "critical").length),
        tone: active.some((i) => i.severity === "critical") ? "red" : "green",
      },
      {
        label: "Detected, not declared",
        value: String(incidents.filter((i) => i.source === "detected").length),
        tone: incidents.some((i) => i.source === "detected") ? "orange" : "green",
      },
      {
        label: "Resolved",
        value: String(incidents.filter((i) => i.status === "resolved" || i.status === "closed").length),
        tone: "blue",
      },
    ];
  }, [incidents]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Incidents"
        description="Detected from live payment data, and declared by the desk."
        actions={
          <Button size="sm" onClick={() => setDeclaring(true)} disabled={isDemoMode}>
            <Plus className="size-4" /> Declare incident
          </Button>
        }
      />

      <StatTileRow stats={stats} />

      {failure ? (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-accent-red/25 bg-accent-red-soft px-3 py-2 text-xs text-accent-red">
          <span>
            <span className="font-medium">The last action failed.</span> {failure}
          </span>
          <button
            type="button"
            onClick={() => setFailure(null)}
            className="shrink-0 underline underline-offset-2"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {isError ? (
        <p className="rounded-lg border border-accent-red/25 bg-accent-red-soft px-3 py-2 text-xs text-accent-red">
          The incident feed could not be read from the API, so this page is showing
          nothing rather than something invented. Anything happening right now is not
          on this screen.
        </p>
      ) : null}

      {inUse.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setFilter(null)}
            className={cn(
              "rounded border px-2 py-0.5 text-[11px] transition",
              filter === null
                ? "border-accent-blue/30 bg-accent-blue-soft text-accent-blue"
                : "border-border text-muted hover:text-foreground",
            )}
          >
            All {incidents.length}
          </button>
          {inUse.map((c) => (
            <button
              key={c.slug}
              type="button"
              onClick={() => setFilter(filter === c.slug ? null : c.slug)}
              className={cn(
                "rounded border px-2 py-0.5 text-[11px] transition",
                filter === c.slug
                  ? categoryClass(c.tone)
                  : "border-border text-muted hover:text-foreground",
              )}
            >
              {c.name} {c.count}
            </button>
          ))}
        </div>
      ) : null}

      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="flex flex-col gap-3"
      >
        {shown.map((incident) => {
          const s = SEVERITY[incident.severity];
          return (
            <motion.div key={incident.key} variants={fadeUp}>
              <Card
                onClick={() => setSelectedKey(incident.key)}
                className="hover-lift cursor-pointer overflow-hidden"
              >
                <CardContent className="flex items-center gap-4 py-4 pl-0">
                  <span
                    className="h-12 w-1 shrink-0 rounded-full"
                    style={{ backgroundColor: s.color }}
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {incident.source === "detected" ? (
                        <span className="flex items-center gap-1 rounded bg-accent-orange-soft px-1.5 py-0.5 text-[11px] font-medium text-accent-orange">
                          <Radio className="size-3" /> Detected
                        </span>
                      ) : (
                        <span className="font-mono text-xs text-muted-foreground">{incident.id}</span>
                      )}
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
                    <CategoryChips categories={incident.categories ?? []} />
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-sm text-muted-foreground">
                      {incident.source === "detected" ? "From payment data" : incident.owner}
                    </span>
                    <span className="tnum text-xs text-muted">{incident.openedAt}</span>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          );
        })}
      </motion.div>

      {/* An empty page has to say what it means, or it reads as broken. */}
      {!incidents.length && !isLoading && !isError ? (
        <Card className="glass card-seam">
          <CardContent className="flex flex-col gap-2 py-8 text-center">
            <span className="text-sm font-medium">Nothing wrong right now</span>
            <span className="text-sm text-muted-foreground">
              Watching the live payment data for a provider that stops settling, a
              decline rate above its own baseline, payments left without a final
              state, and the feed going quiet. Anything that trips appears here with
              the numbers behind it.
            </span>
          </CardContent>
        </Card>
      ) : null}

      {isLoading ? <p className="text-sm text-muted">Reading incidents…</p> : null}

      {/* ── Declare ─────────────────────────────────────────────────────── */}
      <Drawer
        open={declaring}
        onOpenChange={(o) => !o && setDeclaring(false)}
        title="Declare incident"
        subtitle="Opens a record the team can work and resolve"
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setDeclaring(false)}>
              Cancel
            </Button>
            <Button
              className="flex-1"
              disabled={!form.title.trim() || declare.isPending}
              onClick={() => declare.mutate({ ...form, categories })}
            >
              {declare.isPending ? "Declaring…" : "Declare"}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wider text-muted">What is wrong</span>
            <input
              autoFocus
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="ForumPay deposits failing"
              className="h-10 rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-border-strong"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wider text-muted">Severity</span>
            <select
              value={form.severity}
              onChange={(e) => setForm({ ...form, severity: e.target.value })}
              className="h-10 cursor-pointer rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-border-strong"
            >
              <option value="critical">SEV-1 Critical — money is not moving</option>
              <option value="high">SEV-2 High — significant degradation</option>
              <option value="medium">SEV-3 Medium — contained</option>
              <option value="low">SEV-4 Low — minor</option>
            </select>
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wider text-muted">
              Category
            </span>
            {/* Optional on purpose. At 3am the declaration is what matters and
                a required field is one more thing between a person and the
                record; the category is how this gets found again next month,
                which can also be added afterwards from the detail panel. */}
            <CategoryPicker value={categories} onChange={setCategories} />
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wider text-muted">Impact</span>
            <textarea
              value={form.impact}
              onChange={(e) => setForm({ ...form, impact: e.target.value })}
              rows={3}
              placeholder="Who is affected and how — the thing the next person needs to know first."
              className="rounded-lg border border-border bg-card p-3 text-sm outline-none focus:border-border-strong"
            />
          </label>
        </div>
      </Drawer>

      {/* ── One incident ────────────────────────────────────────────────── */}
      <Drawer
        open={selected !== null}
        onOpenChange={(o) => !o && setSelectedKey(null)}
        title={selected?.title ?? ""}
        subtitle={
          selected
            ? selected.source === "detected"
              ? "Detected from payment data"
              : `${selected.id} · ${selected.owner}`
            : ""
        }
        footer={
          selected ? (
            selected.source === "detected" ? (
              <Button
                className="w-full"
                disabled={declare.isPending || isDemoMode}
                onClick={() =>
                  declare.mutate({ signature: selected.key, categories })
                }
              >
                {declare.isPending ? "Declaring…" : "Declare this incident"}
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  className="flex-1"
                  disabled={!note.trim() || update.isPending}
                  onClick={() => update.mutate({ key: selected.key, note })}
                >
                  Add update
                </Button>
                {resolved ? (
                  <Button
                    variant="outline"
                    className="flex-1"
                    disabled={update.isPending}
                    onClick={() => update.mutate({ key: selected.key, status: "open", note: note || undefined })}
                  >
                    Reopen
                  </Button>
                ) : (
                  <>
                    {selected.status === "open" ? (
                      <Button
                        variant="outline"
                        className="flex-1"
                        disabled={update.isPending}
                        onClick={() => update.mutate({ key: selected.key, status: "investigating", note: note || undefined })}
                      >
                        Investigating
                      </Button>
                    ) : null}
                    <Button
                      className="flex-1"
                      disabled={update.isPending}
                      onClick={() =>
                        update.mutate({
                          key: selected.key,
                          status: "resolved",
                          resolution: note || undefined,
                        })
                      }
                    >
                      Resolve
                    </Button>
                  </>
                )}
              </div>
            )
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

            {/* The numbers behind the call. Without them a detection is an
                assertion, and the second time it is wrong nobody looks again. */}
            {selected.evidence?.length ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium uppercase tracking-wider text-muted">
                  Evidence
                </span>
                <ul className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3">
                  {selected.evidence.map((e, i) => (
                    <li key={i} className="text-sm text-muted-foreground">
                      {e}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* The payments themselves. A count raises an incident; these are
                what it takes to work one — the references to quote to the
                provider and the customers who are waiting. */}
            {selected.samples?.length ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium uppercase tracking-wider text-muted">
                  Payments affected
                  {selected.sampleTotal && selected.sampleTotal > selected.samples.length
                    ? ` — showing ${selected.samples.length} of ${selected.sampleTotal}`
                    : ` — ${selected.samples.length}`}
                </span>
                <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-surface/95 text-left text-muted">
                      <tr>
                        <th className="px-2.5 py-2 font-medium">Reference</th>
                        <th className="px-2.5 py-2 font-medium">Client</th>
                        <th className="px-2.5 py-2 font-medium">PSP</th>
                        <th className="px-2.5 py-2 text-right font-medium">Amount</th>
                        <th className="px-2.5 py-2 font-medium">State</th>
                        <th className="px-2.5 py-2 text-right font-medium">Age</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.samples.map((p) => (
                        <tr key={p.reference} className="border-t border-border/60">
                          <td className="px-2.5 py-1.5 font-mono">{p.reference}</td>
                          <td className="px-2.5 py-1.5 text-muted-foreground">{p.customer ?? "—"}</td>
                          <td className="px-2.5 py-1.5 text-muted-foreground">{p.psp ?? "—"}</td>
                          <td className="tnum px-2.5 py-1.5 text-right">
                            {p.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}{" "}
                            {p.currency ?? ""}
                          </td>
                          <td className="px-2.5 py-1.5 text-muted-foreground">{p.state ?? "—"}</td>
                          <td className="tnum px-2.5 py-1.5 text-right text-muted">{fmtAge(p.ageMins)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(
                      selected.samples!.map((p) => p.reference).join("\n"),
                    );
                    toast({ title: `${selected.samples!.length} reference(s) copied` });
                  }}
                  className="self-start text-[11px] text-muted underline underline-offset-2 hover:text-foreground"
                >
                  Copy references
                </button>
              </div>
            ) : null}

            {selected.rootCause ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium uppercase tracking-wider text-muted">Root cause</span>
                <p className="text-sm text-muted-foreground">{selected.rootCause}</p>
              </div>
            ) : null}

            {selected.resolution ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium uppercase tracking-wider text-muted">Resolution</span>
                <p className="text-sm text-muted-foreground">{selected.resolution}</p>
              </div>
            ) : null}

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs text-muted">Owner</dt>
                <dd>{selected.source === "detected" ? "Not declared" : selected.owner}</dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs text-muted">
                  {selected.source === "detected" ? "Condition since" : "Opened"}
                </dt>
                <dd className="tnum">{selected.openedAt}</dd>
              </div>
            </dl>

            {/* Re-taggable after the fact, and that is the common case: what
                kind of thing an incident was is often only clear once it is
                over. A category chosen during the outage is a first guess. */}
            {selected.source === "declared" ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium uppercase tracking-wider text-muted">
                  Category
                </span>
                <CategoryPicker
                  value={retag ?? (selected.categories ?? []).map((c) => c.name)}
                  onChange={setRetag}
                  disabled={saveTags.isPending}
                />
                {retag ? (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={saveTags.isPending}
                      onClick={() =>
                        saveTags.mutate({ key: selected.key, categories: retag })
                      }
                    >
                      {saveTags.isPending ? "Saving…" : "Save categories"}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setRetag(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {selected.source === "declared" ? (
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium uppercase tracking-wider text-muted">
                  Add to the timeline
                </span>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  placeholder="What you just did or found. Attached to Add update, or to Resolve as the resolution."
                  className="rounded-lg border border-border bg-card p-3 text-sm outline-none focus:border-border-strong"
                />
              </label>
            ) : null}

            {selected.timeline.length ? (
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
            ) : null}
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
