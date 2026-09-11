"use client";

import { useMemo, useState } from "react";
import { CloudDownload, Info, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  useKycProvider,
  useSyncProvider,
  type KycSyncResult,
} from "@/hooks/use-kyc";

/**
 * Verifications read from KYCAID directly.
 *
 * THIS PANEL EXISTS BECAUSE THE PANEL BELOW IT WAS BUILT ON A WRONG FINDING.
 * The import screen was written after four probes — `/applicants`,
 * `/verifications`, `/applicants/{id}/verifications`, `/forms/{id}` — all
 * returned 404, and the conclusion drawn was that the provider will not
 * enumerate. It does: `GET /verifications/report?date=…` returns a day at a
 * time, with very nearly the columns the console export has.
 *
 * The file import stays and is not deprecated. It needs no credential, it
 * loads history from before any of this was wired up, and it works on a day
 * the provider does not. This is simply the path that does not require anybody
 * to export anything.
 *
 * WHY A DATE RANGE AND NOT A BUTTON. The provider has no range query — `date`
 * is required and returns that date — so a year is three hundred and sixty-five
 * requests. The API reads as many days as it can inside its budget and hands
 * back where it stopped; this asks again from there until the range is done,
 * and says which day it is on meanwhile.
 */

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(from + "T00:00:00Z");
  const b = Date.parse(to + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / 86_400_000) + 1;
}

export function SyncProvider() {
  const provider = useKycProvider();
  const [progress, setProgress] = useState<{ day: string; days: number } | null>(
    null,
  );
  const sync = useSyncProvider((day, days) => setProgress({ day, days }));

  const today = provider.data?.today ?? iso(new Date());
  /**
   * Where an update should start: the day of the newest verification held, not
   * the day after it.
   *
   * A verification that arrived at 23:50 while a sync was reading that same day
   * is otherwise never fetched at all. Re-reading one day is free — the
   * verification id is the key, so what is already there updates.
   */
  const suggestedFrom = useMemo(() => {
    const newest = provider.data?.newest;
    if (newest) return newest.slice(0, 10);
    const back = new Date(today + "T00:00:00Z");
    back.setUTCDate(back.getUTCDate() - 30);
    return iso(back);
  }, [provider.data?.newest, today]);

  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const start = from ?? suggestedFrom;
  const end = to ?? today;
  const span = daysBetween(start, end);

  const result = sync.data;
  const busy = sync.isPending;

  if (provider.isLoading) return null;

  if (provider.data && !provider.data.configured) {
    return (
      <div className="flex items-start gap-1.5 rounded-xl border border-border bg-card/60 px-4 py-3 text-[11px] text-muted">
        <Info className="mt-px size-3.5 shrink-0" />
        <span>
          Verifications can be read straight from the provider, but no token is
          configured. Set{" "}
          <code className="text-muted-foreground">
            {provider.data.variable}
          </code>{" "}
          on the API and redeploy — or one per entity, suffixed:{" "}
          <code className="text-muted-foreground">KYCAID_API_TOKENMU</code> and{" "}
          <code className="text-muted-foreground">KYCAID_API_TOKENSL</code>.
          Each entity holds its own KYCAID account, and a token can only read
          its own. Until then the file import below does the same job and needs
          no credential.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card/60 px-4 py-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-[10px] font-medium tracking-wider text-muted uppercase">
            Fetch from KYCAID
          </span>
          <span className="text-[11px] text-muted">
            Read the provider directly, a day at a time. Nothing is exported and
            nothing is uploaded — and re-reading a day updates what is already
            here rather than duplicating it.
          </span>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-muted">From</span>
            <input
              type="date"
              value={start}
              max={end}
              disabled={busy}
              onChange={(e) => setFrom(e.target.value)}
              className="tnum h-7 rounded-md border border-border bg-card px-2 text-[11px]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-muted">To</span>
            <input
              type="date"
              value={end}
              max={today}
              disabled={busy}
              onChange={(e) => setTo(e.target.value)}
              className="tnum h-7 rounded-md border border-border bg-card px-2 text-[11px]"
            />
          </label>
          <Button
            size="sm"
            disabled={busy || span < 1}
            onClick={() => {
              setProgress(null);
              sync.mutate({ from: start, to: end });
            }}
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <CloudDownload className="size-3.5" />
            )}
            {busy
              ? progress
                ? `Reading ${progress.day}…`
                : "Reading…"
              : `Fetch ${span.toLocaleString()} day${span === 1 ? "" : "s"}`}
          </Button>
        </div>
      </div>

      {/* What is already here, so "from" is a decision and not a guess. */}
      {/* Per entity as well as in total: a combined number looks healthy while
          one of the two accounts is empty, and "is Saint Lucia loaded" is only
          answered by Saint Lucia's own count. */}
      {provider.data && provider.data.accounts.length > 1 ? (
        <p className="text-[11px] text-muted">
          Connected:{" "}
          {provider.data.accounts
            .map(
              (a) =>
                `${a.account || "unlabelled"} (${a.verifications.toLocaleString()})`,
            )
            .join(", ")}
          {provider.data.unattributed
            ? `, plus ${provider.data.unattributed.toLocaleString()} from a file import, which does not say which entity it came from`
            : ""}
          .
        </p>
      ) : null}

      {provider.data ? (
        <p className="text-[11px] text-muted">
          {provider.data.verifications.toLocaleString()} verification
          {provider.data.verifications === 1 ? "" : "s"} held
          {provider.data.newest
            ? `, newest ${provider.data.newest.slice(0, 10)}`
            : " — nothing yet, so pick a start date far enough back to cover your history"}
          {provider.data.oldest && provider.data.verifications
            ? `, oldest ${provider.data.oldest.slice(0, 10)}`
            : ""}
          .
        </p>
      ) : null}

      {span > 120 && !busy ? (
        <p className="flex items-start gap-1.5 text-[11px] text-accent-orange">
          <Info className="mt-px size-3.5 shrink-0" />
          {span.toLocaleString()} days is {span.toLocaleString()} calls to the
          provider — this will take a few minutes and the page has to stay open.
          It is safe to stop and re-run from where it got to.
        </p>
      ) : null}

      {sync.isError ? (
        <p className="text-[11px] text-accent-red">
          {sync.error instanceof Error ? sync.error.message : "The fetch failed."}
        </p>
      ) : null}

      {result ? <Result result={result} /> : null}
    </div>
  );
}

function Result({ result: r }: { result: KycSyncResult }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[11px] text-accent-green">
        {r.days.toLocaleString()} day{r.days === 1 ? "" : "s"} read ·{" "}
        {r.fetched.toLocaleString()} verification
        {r.fetched === 1 ? "" : "s"} fetched · {r.created.toLocaleString()}{" "}
        added, {r.updated.toLocaleString()} updated ·{" "}
        {r.clientsCreated.toLocaleString()} client
        {r.clientsCreated === 1 ? "" : "s"} created.
      </p>
      {r.unlinked ? (
        <p className="flex items-start gap-1.5 text-[11px] text-accent-orange">
          <Info className="mt-px size-3.5 shrink-0" />
          {r.unlinked.toLocaleString()} verification
          {r.unlinked === 1 ? "" : "s"} carried no account reference. They are
          kept and counted — an application abandoned before it reached an
          account still cost money and still carries a decline reason.
        </p>
      ) : null}
      {/* Test-mode rows are dropped, and saying so is the point. The provider's
          own documentation says test mode differs from live only in priority —
          same columns, same prices, same statuses — so a test verification
          counted into a compliance total would never look wrong on screen. */}
      {/* An entity that returned nothing is the finding a combined total
          hides. Named, even when the run looks entirely successful. */}
      {r.accounts.length > 1 ? (
        <p className="text-[11px] text-muted">
          {r.accounts
            .map((a) => `${a.account || "unlabelled"}: ${a.rows.toLocaleString()}`)
            .join(" · ")}
        </p>
      ) : null}
      {r.accounts.some((a) => a.rows === 0) && r.days > 0 ? (
        <p className="flex items-start gap-1.5 text-[11px] text-accent-orange">
          <Info className="mt-px size-3.5 shrink-0" />
          {r.accounts
            .filter((a) => a.rows === 0)
            .map((a) => a.account || "the unlabelled account")
            .join(" and ")}{" "}
          returned nothing for this range. That is either a quiet period or a
          token pointed at the wrong account — worth checking before you treat
          the range as loaded.
        </p>
      ) : null}
      {r.testSkipped ? (
        <p className="text-[11px] text-muted">
          {r.testSkipped.toLocaleString()} test-mode verification
          {r.testSkipped === 1 ? " was" : "s were"} returned and left out. They
          are the provider&rsquo;s sandbox, not your clients.
        </p>
      ) : null}
      {/* A day the provider kept paging on. Said out loud, because the
          alternative is a day that quietly holds only its first 20,000 rows. */}
      {r.truncated.length ? (
        <p className="text-[11px] text-accent-orange">
          These days hit the page limit and may be incomplete:{" "}
          {r.truncated.join(", ")}.
        </p>
      ) : null}
      {!r.done && r.nextDate ? (
        <p className="text-[11px] text-accent-orange">
          Stopped at {r.nextDate}. Set “From” to that date and run it again.
        </p>
      ) : null}
      {r.forms.length > 1 ? (
        <p className="text-[11px] text-muted">
          Forms in this range:{" "}
          {r.forms.map((f) => `${f.form} (${f.rows.toLocaleString()})`).join(", ")}
          . Their checks are not necessarily the same.
        </p>
      ) : null}
    </div>
  );
}
