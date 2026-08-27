"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import type { Shift, ShiftReport, ShiftTicket, TeamMember } from "./types";

const field =
  "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent-blue";
const label = "text-[10px] font-medium uppercase tracking-wider text-muted";

type KycEntity = {
  registered: string;
  approved: string;
  rejected: string;
  pending: string;
  reasons: string;
};

const emptyKyc = (): KycEntity => ({
  registered: "",
  approved: "",
  rejected: "",
  pending: "",
  reasons: "",
});

const num = (s: string) => (s.trim() === "" ? null : Number(s) || 0);

function KycBlock({
  title,
  value,
  onChange,
}: {
  title: string;
  value: KycEntity;
  onChange: (v: KycEntity) => void;
}) {
  const box = (k: keyof KycEntity, l: string) => (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] text-muted">{l}</span>
      <input
        type="number"
        min={0}
        value={value[k]}
        onChange={(e) => onChange({ ...value, [k]: e.target.value })}
        placeholder="—"
        className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm tabular-nums outline-none focus:border-accent-blue"
      />
    </label>
  );
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <span className="text-xs font-medium">{title}</span>
      <div className="grid grid-cols-4 gap-2">
        {box("registered", "Registered")}
        {box("approved", "Approved")}
        {box("rejected", "Rejected")}
        {box("pending", "Pending")}
      </div>
      <input
        value={value.reasons}
        onChange={(e) => onChange({ ...value, reasons: e.target.value })}
        placeholder="Rejection reasons"
        className={field}
      />
    </div>
  );
}

/**
 * Handing the desk over.
 *
 * What this asks for is only what cannot be read from the data. The shift's
 * deposits, withdrawals, refunds, volume and success rate are computed from the
 * payments over its own window and shown back below — the closing agent does
 * not type them, and cannot get them wrong.
 *
 * What IS asked for is the KYC queue (which lives in another system), the
 * support tickets still open (which live in Zendesk), and the sentence the next
 * person actually needs. Those are the three things that are lost if nobody
 * writes them down.
 */
export function EndShiftForm({
  shift,
  canForce,
  onDone,
}: {
  shift: Shift;
  canForce: boolean;
  onDone: () => void;
}) {
  const [mu, setMu] = useState<KycEntity>(emptyKyc());
  const [sl, setSl] = useState<KycEntity>(emptyKyc());
  const [tickets, setTickets] = useState<ShiftTicket[]>([]);
  const [draft, setDraft] = useState<ShiftTicket>({
    num: "",
    subject: "",
    desc: "",
    status: "Pending",
  });
  const [handoverTo, setHandoverTo] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const team = useQuery({
    queryKey: ["shift-team"],
    queryFn: () => apiFetch<TeamMember[]>("/shifts/team"),
  });

  const end = useMutation({
    mutationFn: (force: boolean) =>
      apiFetch<ShiftReport>("/shifts/end", {
        method: "POST",
        body: JSON.stringify({
          handoverTo: handoverTo.trim() || undefined,
          notes: notes.trim() || undefined,
          force,
          // Anything still in the draft row is included rather than lost —
          // typing a ticket and not pressing Add is the commonest way a
          // handover arrives missing the one thing it was written for.
          tickets: [...tickets, ...(draft.num || draft.subject ? [draft] : [])],
          kyc: {
            mauritius: {
              registered: num(mu.registered),
              approved: num(mu.approved),
              rejected: num(mu.rejected),
              pending: num(mu.pending),
              reasons: mu.reasons.trim() || null,
            },
            saintLucia: {
              registered: num(sl.registered),
              approved: num(sl.approved),
              rejected: num(sl.rejected),
              pending: num(sl.pending),
              reasons: sl.reasons.trim() || null,
            },
          },
        }),
      }),
    onSuccess: onDone,
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  const blocked = error?.includes("assigned to you are still open") ?? false;

  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs text-muted">
        The shift&rsquo;s numbers are read from the payments — you do not need to
        upload or type them. What is asked for below is only what lives outside
        this dashboard.
      </p>

      {/* The balances this shift inherited, shown back at close. A closing
          balance means nothing on its own; it means something next to the one
          the shift opened with. */}
      {shift.startBalances && Object.keys(shift.startBalances).length ? (
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-card p-3">
          <span className={label}>Balances at takeover</span>
          {Object.entries(shift.startBalances).map(([psp, amount]) => (
            <div key={psp} className="flex justify-between gap-3 text-xs">
              <span className="truncate text-muted">{psp}</span>
              <span className="tabular-nums">
                {Number(amount).toLocaleString(undefined, {
                  maximumFractionDigits: 2,
                })}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <span className={label}>KYC queue at close</span>
        <KycBlock title="🇲🇺 Mauritius (FSC)" value={mu} onChange={setMu} />
        <KycBlock title="🇱🇨 Saint Lucia (IFCSC)" value={sl} onChange={setSl} />
      </div>

      <div className="flex flex-col gap-2">
        <span className={label}>Support tickets still open</span>
        {tickets.map((t, i) => (
          <div
            key={`${t.num}-${i}`}
            className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs"
          >
            <span className="font-mono">#{t.num || "—"}</span>
            <span className="flex-1 truncate">{t.subject}</span>
            <span className="text-muted">{t.status}</span>
            <button
              type="button"
              onClick={() => setTickets((all) => all.filter((_, x) => x !== i))}
              className="text-muted hover:text-accent-red"
              aria-label="Remove ticket"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
        <div className="grid grid-cols-[90px_1fr_110px] gap-2">
          <input
            value={draft.num}
            onChange={(e) => setDraft({ ...draft, num: e.target.value })}
            placeholder="#"
            className={field}
          />
          <input
            value={draft.subject}
            onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
            placeholder="What it is"
            className={field}
          />
          <select
            value={draft.status}
            onChange={(e) => setDraft({ ...draft, status: e.target.value })}
            className={field}
          >
            {["Open", "Pending", "On-Hold", "Solved"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            if (!draft.num && !draft.subject) return;
            setTickets((all) => [...all, draft]);
            setDraft({ num: "", subject: "", desc: "", status: "Pending" });
          }}
        >
          Add ticket
        </Button>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className={label}>Handing over to</span>
        <select
          value={handoverTo}
          onChange={(e) => setHandoverTo(e.target.value)}
          className={field}
        >
          <option value="">— nobody yet —</option>
          {(team.data ?? []).map((m) => (
            <option key={m.id} value={m.name}>
              {m.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className={label}>What the next person needs to know</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          placeholder="The thing you would say out loud if they were sitting next to you."
          className={field}
        />
      </label>

      {error ? (
        <div className="flex flex-col gap-2 rounded-lg border border-accent-red/25 bg-accent-red-soft px-3 py-2 text-xs text-accent-red">
          <span>{error}</span>
          {blocked && canForce ? (
            <span className="text-muted-foreground">
              You can close it anyway — it will be recorded as your decision.
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="flex gap-2">
        <Button
          className="flex-1"
          onClick={() => {
            setError(null);
            end.mutate(false);
          }}
          disabled={end.isPending}
        >
          {end.isPending ? "Closing…" : "End shift & hand over"}
        </Button>
        {blocked && canForce ? (
          <Button
            variant="destructive"
            onClick={() => {
              setError(null);
              end.mutate(true);
            }}
            disabled={end.isPending}
          >
            Close anyway
          </Button>
        ) : null}
      </div>
    </div>
  );
}
