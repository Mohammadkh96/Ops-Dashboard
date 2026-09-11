"use client";

import { useState } from "react";
import { CloudDownload, Info, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  useCatchUp,
  useKycProvider,
  useSyncProvider,
  type KycSyncResult,
} from "@/hooks/use-kyc";

/**
 * Verifications read from KYCAID directly.
 *
 * THIS PANEL REPLACED A FILE IMPORT BUILT ON A WRONG FINDING.
 * That screen was written after four probes — `/applicants`,
 * `/verifications`, `/applicants/{id}/verifications`, `/forms/{id}` — all
 * returned 404, and the conclusion drawn was that the provider will not
 * enumerate. It does: `GET /verifications/report?date=…` returns a day at a
 * time, with very nearly the columns the console export has.
 *
 * The file import that preceded it is gone. A second way in that nobody should
 * use is a second way to be wrong about where the numbers came from.
 *
 * WHY A DATE RANGE AND NOT A BUTTON. The provider has no range query — `date`
 * is required and returns that date — so a year is three hundred and sixty-five
 * requests. The API reads as many days as it can inside its budget and hands
 * back where it stopped; this asks again from there until the range is done,
 * and says which day it is on meanwhile.
 *
 * THE RANGE BELONGS TO THE PAGE, not to this panel. It had its own pair of date
 * inputs, so the period being fetched and the period being displayed were two
 * different things on one screen with no way to tell them apart — fetch a week,
 * read a year, and conclude the fetch did nothing. One control at the top now
 * drives the cards, the table and this.
 */

function daysBetween(from: string, to: string): number {
  const a = Date.parse(from + "T00:00:00Z");
  const b = Date.parse(to + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / 86_400_000) + 1;
}

export function SyncProvider({ from, to }: { from: string; to: string }) {
  const provider = useKycProvider();
  const [progress, setProgress] = useState<{ day: string; days: number } | null>(
    null,
  );
  const sync = useSyncProvider((day, days) => setProgress({ day, days }));

  /**
   * The last two days, re-read on a timer while this page is open.
   *
   * This is what was missing. Between the nightly cron and somebody pressing
   * Fetch, nothing asked the provider anything — so a verification from three
   * minutes ago was not late or filtered, it had never been requested, and the
   * screen presented the newest row it held as the newest row there is.
   */
  const live = useCatchUp(Boolean(provider.data?.configured));

  const start = from;
  const end = to;
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
          its own.
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
            Reads {start} to {end} — the period selected above — a day at a time.
            Nothing is exported and nothing is uploaded, and re-reading a day
            updates what is already here rather than duplicating it.
          </span>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || live.isFetching}
            onClick={() => void live.refetch()}
            title="Re-reads yesterday and today from the provider"
          >
            <RefreshCw
              className={`size-3.5 ${live.isFetching ? "animate-spin" : ""}`}
            />
            {live.isFetching ? "Checking…" : "Check now"}
          </Button>
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
            ? `, plus ${provider.data.unattributed.toLocaleString()} loaded before the entity was recorded — fetching those dates again assigns them`
            : ""}
          .
        </p>
      ) : null}

      {provider.data ? (
        <p className="text-[11px] text-muted">
          {provider.data.verifications.toLocaleString()} verification
          {provider.data.verifications === 1 ? "" : "s"} held
          {provider.data.newest
            ? `, newest ${provider.data.newest.slice(0, 16).replace("T", " ")}`
            : " — nothing yet, so pick a start date far enough back to cover your history"}
          {provider.data.oldest && provider.data.verifications
            ? `, oldest ${provider.data.oldest.slice(0, 10)}`
            : ""}
          .
        </p>
      ) : null}

      {/* WHEN THE PROVIDER WAS LAST ASKED, which is the fact this screen was
          missing. Without it the newest row held reads as the newest row there
          is, and a verification nobody has requested yet is indistinguishable
          from one that does not exist. */}
      <Live live={live} />

      {/* The Form column shows raw ids when this fails, and it used to fail in
          silence — "12666" looked like the best the provider offers. */}
      {live.data?.formNamesUnavailable?.length ||
      sync.data?.formNamesUnavailable?.length ? (
        <p className="flex items-start gap-1.5 text-[11px] text-accent-orange">
          <Info className="mt-px size-3.5 shrink-0" />
          Form names could not be read, so the Form column is showing the
          provider&rsquo;s ids:{" "}
          {(live.data?.formNamesUnavailable?.length
            ? live.data.formNamesUnavailable
            : (sync.data?.formNamesUnavailable ?? [])
          )
            .map((f) => `${f.account || "unlabelled"} — ${f.why}`)
            .join("; ")}
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

/**
 * When the provider was last asked, and what it said.
 *
 * Deliberately says "checked" rather than "updated": a check that finds
 * nothing new is a fact about the provider, and reporting only the finds would
 * leave a screen that looks identical whether it is current or forgotten.
 */
function Live({
  live,
}: {
  live: {
    isFetching: boolean;
    isError: boolean;
    dataUpdatedAt: number;
    data?: KycSyncResult;
  };
}) {
  /**
   * The clock time it was checked, not "n minutes ago".
   *
   * An age has to be computed from the current time on every render, which is
   * a different answer each time for the same props — React's own rule, and
   * the lint catches it. A timestamp says the same thing without lying about
   * when it was measured, and it is the figure to compare against the newest
   * verification above it.
   */
  const at = live.dataUpdatedAt;
  const when = at
    ? new Date(at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  const added = (live.data?.created ?? 0) + (live.data?.updated ?? 0);

  if (live.isError)
    return (
      <p className="flex items-start gap-1.5 text-[11px] text-accent-orange">
        <Info className="mt-px size-3.5 shrink-0" />
        The last check for new verifications failed, so what is on screen may be
        behind the provider. It tries again every five minutes.
      </p>
    );

  return (
    <p className="text-[11px] text-muted">
      {live.isFetching
        ? "Checking the provider for new verifications…"
        : when === null
          ? "Checking the provider for new verifications every five minutes while this page is open."
          : `Checked at ${when} — ${
              added
                ? `${added.toLocaleString()} verification${added === 1 ? "" : "s"} in the last two days`
                : "nothing new in the last two days"
            }. Re-checked every five minutes while this page is open.`}
    </p>
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
