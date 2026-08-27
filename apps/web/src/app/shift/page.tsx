"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  Mail,
  Check,
  ClipboardList,
  LogIn,
  Play,
  Plus,
  Square,
  Users,
} from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import { StatTileRow, type Stat } from "@/components/ui/stat-tile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { useToast } from "@/components/ui/toast";
import { apiFetch, isDemoMode } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { StartShiftForm } from "@/components/shift/start-shift";
import { EndShiftForm } from "@/components/shift/end-shift";
import { TaskLibrary } from "@/components/shift/task-library";
import { HandoverView } from "@/components/shift/handover-view";
import type { ActiveShift, ShiftReport, ShiftTask } from "@/components/shift/types";

const MANAGER_ROLES = ["ADMIN", "OPERATIONS_MANAGER"];

const money = (n: number) =>
  n.toLocaleString(undefined, { maximumFractionDigits: 0 });

/** How long the shift has been running, in words. */
function elapsed(fromIso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(fromIso)) / 60000));
  const h = Math.floor(mins / 60);
  return h ? `${h}h ${mins % 60}m` : `${mins}m`;
}

/**
 * The shift desk: who is on, what is left to do, and the handover.
 *
 * One shift is open at a time and everybody on duty joins it. That is not a
 * simplification — it is how the desk works. Three people covering the same
 * hours are one shift with three pairs of hands, and giving each of them their
 * own "shift" would mean every figure had to ask which one it belonged to.
 *
 * The numbers on this page are read from the payments themselves over the
 * shift's own window. Nobody uploads anything at the end of a shift to make
 * them appear.
 */
export default function ShiftPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  const [newTask, setNewTask] = useState("");
  const [showLibrary, setShowLibrary] = useState(false);
  // The shift that was just closed, so the handover can be read straight away
  // and a failed send is visible rather than assumed.
  const [closed, setClosed] = useState<ShiftReport | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  // Re-renders the elapsed clock without refetching anything.
  const [, setTick] = useState(0);

  const isManager = MANAGER_ROLES.includes(user?.role ?? "");

  const active = useQuery({
    queryKey: ["shift-active"],
    queryFn: () => apiFetch<ActiveShift>("/shifts/active"),
    enabled: !isDemoMode,
    refetchInterval: 60_000,
  });

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const shift = active.data?.shift ?? null;
  const joined = active.data?.joined ?? false;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["shift-active"] });

  const join = useMutation({
    mutationFn: () => apiFetch<ActiveShift>("/shifts/join", { method: "POST" }),
    onSuccess: () => {
      void invalidate();
      toast({ kind: "success", title: "You are on this shift" });
    },
    onError: (e: unknown) =>
      toast({ kind: "warning", title: "Could not join", description: String(e) }),
  });

  const setTaskStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      apiFetch<ActiveShift>(`/shifts/tasks/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => void invalidate(),
    onError: (e: unknown) =>
      toast({ kind: "warning", title: "Could not update the task", description: String(e) }),
  });

  const addTask = useMutation({
    mutationFn: (title: string) =>
      apiFetch<ActiveShift>("/shifts/tasks", {
        method: "POST",
        body: JSON.stringify({ title }),
      }),
    onSuccess: () => {
      setNewTask("");
      setAddingTask(false);
      void invalidate();
    },
    onError: (e: unknown) =>
      toast({ kind: "warning", title: "Could not add the task", description: String(e) }),
  });

  // The shift's own figures, read from the payments over its window. Nobody
  // uploads anything to make these appear, and nobody can type them wrong.
  const report = useQuery({
    queryKey: ["shift-report", shift?.id],
    queryFn: () => apiFetch<ShiftReport>(`/shifts/${shift?.id}`),
    enabled: !isDemoMode && !!shift?.id,
    refetchInterval: 120_000,
  });
  const fin = report.data?.financials;

  const tasks = useMemo<ShiftTask[]>(() => shift?.tasks ?? [], [shift]);
  const open = tasks.filter((t) => t.status !== "Done");
  const done = tasks.filter((t) => t.status === "Done");

  const stats: Stat[] = shift
    ? [
        {
          label: "Deposits",
          value: fin ? `${money(fin.deposits.amount)}` : "—",
          tone: "green",
        },
        {
          label: "Withdrawals",
          value: fin ? `${money(fin.withdrawals.amount)}` : "—",
          tone: "orange",
        },
        {
          label: fin?.successRate === null ? "Approved" : "Approved rate",
          value: fin?.successRate === null || fin === undefined
            ? "—"
            : `${fin.successRate}%`,
        },
        // Four, not five: the elapsed time is already on the line above, and a
        // fifth tile wraps onto its own row where it reads as a separate
        // section rather than the end of this one.
        { label: "Tasks left", value: String(open.length), tone: open.length ? "orange" : "green" },
      ]
    : [];

  if (isDemoMode) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Shift" description="The desk: who is on, what is left, and the handover." />
        <Card className="glass card-seam">
          <CardContent className="py-10 text-center text-sm text-muted">
            Shifts are recorded through the API and are not available in demo mode.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Shift"
        description="One shift is open at a time. Everybody on duty joins it."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {isManager ? (
              <Button variant="ghost" size="sm" onClick={() => setShowLibrary(true)}>
                <BookOpen className="size-3.5" />
                Task library
              </Button>
            ) : null}
            {!shift ? (
              <Button size="sm" onClick={() => setStarting(true)}>
                <Play className="size-3.5" />
                Start shift
              </Button>
            ) : joined ? (
              <Button size="sm" variant="destructive" onClick={() => setEnding(true)}>
                <Square className="size-3.5" />
                End shift &amp; hand over
              </Button>
            ) : (
              <Button size="sm" onClick={() => join.mutate()} disabled={join.isPending}>
                <LogIn className="size-3.5" />
                {join.isPending ? "Joining…" : "Join this shift"}
              </Button>
            )}
          </div>
        }
      />

      {active.isLoading ? (
        <Card className="glass card-seam">
          <CardContent className="py-10 text-center text-sm text-muted">
            Reading the desk…
          </CardContent>
        </Card>
      ) : null}

      {closed ? (
        <Card className="glass card-seam">
          <CardContent className="flex flex-col gap-3 py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-medium">
                {closed.shift.name} shift closed — {closed.shift.opsDay}, shift{" "}
                {closed.shift.slot}
              </span>
              <button
                type="button"
                onClick={() => setClosed(null)}
                className="text-xs text-muted underline underline-offset-2 hover:text-foreground"
              >
                Dismiss
              </button>
            </div>
            {/* Whether the email actually went is stated, never assumed. A
                dashboard that says "sent" when nothing left the building is
                worse than one that cannot send at all. */}
            <p
              className={cn(
                "rounded-lg border px-3 py-2 text-xs",
                closed.mail?.sent
                  ? "border-accent-green/25 bg-accent-green-soft text-accent-green"
                  : "border-accent-orange/25 bg-accent-orange-soft text-accent-orange",
              )}
            >
              {closed.mail?.sent
                ? `Handover emailed to ${closed.mail.to.length} ${closed.mail.to.length === 1 ? "person" : "people"}.`
                : `Handover not emailed. ${closed.mail?.reason ?? ""} It is recorded and readable here either way.`}
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="self-start"
              onClick={() => setReading(closed.shift.id)}
            >
              <Mail className="size-3.5" />
              Read the handover
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {!active.isLoading && !shift ? (
        <Card className="glass card-seam">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <span className="text-sm font-medium">No shift is open</span>
            <span className="max-w-md text-xs text-muted">
              Starting one records who took over from whom, the PSP balances you
              inherited, and the standing tasks for that shift. Everything logged
              until it is handed over belongs to it.
            </span>
            <Button onClick={() => setStarting(true)}>
              <Play className="size-3.5" />
              Start shift
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {shift ? (
        <>
          <Card className="glass card-seam">
            <CardContent className="flex flex-col gap-4 py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">
                    {shift.name} shift · opened by {shift.openedBy}
                    {shift.takenOverFrom ? ` · took over from ${shift.takenOverFrom}` : ""}
                  </span>
                  <span className="text-xs text-muted">
                    Started {shift.startedAtLocal} · running {elapsed(shift.startedAt)}
                  </span>
                </div>
                <span className="flex items-center gap-1.5 text-xs text-muted">
                  <Users className="size-3.5" />
                  {shift.participants.map((p) => p.name).join(", ")}
                </span>
              </div>
              {shift.startNotes ? (
                <p className="rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
                  {shift.startNotes}
                </p>
              ) : null}
              {!joined ? (
                <p className="rounded-lg border border-accent-orange/25 bg-accent-orange-soft px-3 py-2 text-xs text-accent-orange">
                  You are watching this shift, not on it. Join before you tick
                  anything off — every action is recorded against whoever took it.
                </p>
              ) : null}
            </CardContent>
          </Card>

          <StatTileRow stats={stats} />

          <Card className="glass card-seam">
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <ClipboardList className="size-4 text-muted" />
                Shift tasks
              </CardTitle>
              {joined ? (
                <Button variant="ghost" size="sm" onClick={() => setAddingTask((v) => !v)}>
                  <Plus className="size-3.5" />
                  Add
                </Button>
              ) : null}
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {addingTask ? (
                <div className="flex gap-2">
                  <input
                    value={newTask}
                    autoFocus
                    onChange={(e) => setNewTask(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newTask.trim()) addTask.mutate(newTask.trim());
                      if (e.key === "Escape") setAddingTask(false);
                    }}
                    placeholder="Something that came up this shift…"
                    className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm"
                  />
                  <Button
                    size="sm"
                    onClick={() => newTask.trim() && addTask.mutate(newTask.trim())}
                    disabled={addTask.isPending || !newTask.trim()}
                  >
                    Add
                  </Button>
                </div>
              ) : null}

              {!tasks.length ? (
                <p className="py-6 text-center text-sm text-muted">
                  No tasks on this shift.
                  {isManager
                    ? " Add standing ones to the task library and every future shift starts with them."
                    : ""}
                </p>
              ) : null}

              {[...open, ...done].map((t) => (
                <div
                  key={t.id}
                  className={cn(
                    "flex items-start gap-3 rounded-lg border border-border bg-card p-3",
                    t.status === "Done" && "opacity-55",
                  )}
                >
                  <button
                    type="button"
                    disabled={!joined || setTaskStatus.isPending}
                    onClick={() =>
                      setTaskStatus.mutate({
                        id: t.id,
                        status: t.status === "Done" ? "Pending" : "Done",
                      })
                    }
                    aria-label={t.status === "Done" ? "Mark not done" : "Mark done"}
                    className={cn(
                      "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border transition",
                      t.status === "Done"
                        ? "border-accent-green bg-accent-green/20 text-accent-green"
                        : "border-border hover:border-accent-blue",
                      !joined && "cursor-not-allowed opacity-50",
                    )}
                  >
                    {t.status === "Done" ? <Check className="size-3" /> : null}
                  </button>
                  <div className="flex flex-1 flex-col gap-0.5">
                    <span className={cn("text-sm", t.status === "Done" && "line-through")}>
                      {t.title}
                    </span>
                    {/* The instructions travel with the task. This is the whole
                        difference between a checklist and a runbook: what to do
                        is attached to the thing to do. */}
                    {t.howTo ? (
                      <span className="text-xs text-muted-foreground">{t.howTo}</span>
                    ) : null}
                    <span className="text-[11px] text-muted">
                      {t.category}
                      {t.completedBy ? ` · done by ${t.completedBy}` : ""}
                    </span>
                  </div>
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[10px] font-medium",
                      t.priority === "Critical" || t.priority === "High"
                        ? "bg-accent-red-soft text-accent-red"
                        : "bg-elevated text-muted",
                    )}
                  >
                    {t.priority}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      ) : null}

      <Drawer open={starting} onOpenChange={setStarting} title="Start shift">
        <StartShiftForm
          onDone={() => {
            setStarting(false);
            void invalidate();
          }}
        />
      </Drawer>

      <Drawer open={ending} onOpenChange={setEnding} title="End shift & hand over">
        {shift ? (
          <EndShiftForm
            shift={shift}
            canForce={isManager}
            onDone={(report) => {
              setEnding(false);
              setClosed(report);
              void invalidate();
            }}
          />
        ) : null}
      </Drawer>

      <Drawer open={showLibrary} onOpenChange={setShowLibrary} title="Task library">
        <TaskLibrary />
      </Drawer>

      <Drawer
        open={!!reading}
        onOpenChange={(o) => !o && setReading(null)}
        title="Shift handover"
      >
        {reading ? <HandoverView shiftId={reading} /> : null}
      </Drawer>
    </div>
  );
}
