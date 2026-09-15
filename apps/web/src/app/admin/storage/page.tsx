"use client";

import { useState } from "react";
import { Database, HardDrive, TriangleAlert } from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  useStorageReport,
  useStoragePrune,
  type PruneResult,
} from "@/hooks/use-admin";
import { cn } from "@/lib/utils";

/** Bytes as somebody reads them, not as the database counts them. */
function size(n: number): string {
  if (!n) return "0";
  const units = ["B", "kB", "MB", "GB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

const DAYS = [30, 90, 180, 365];

/**
 * What the database is spending its space on, and how to get some back.
 *
 * WRITTEN BECAUSE IT RAN OUT, and the failure gave no sign of what it was. A
 * hosted Postgres plan has a hard ceiling; past it every write fails with
 * `53100 could not extend file`, the syncs read their data and store none of
 * it, and every screen keeps showing yesterday&rsquo;s figures as though
 * nothing had happened. Hours went into the provider and into a client who
 * appeared to have no verification, because nothing anywhere said the disk was
 * full. This screen exists so the next time that question takes a minute.
 *
 * IT SHOWS BEFORE IT OFFERS TO DELETE. The prune below is the only irreversible
 * action in this application — the stored JSON cannot be recovered without
 * re-reading a year of history from the providers — so the size, the tables and
 * the payload&rsquo;s own contents are all on the page above the button, and the
 * button starts as a dry run.
 */
export default function StoragePage() {
  const { data, isLoading, isError, error } = useStorageReport();
  const prune = useStoragePrune();
  const [days, setDays] = useState(90);
  const [mode, setMode] = useState<"slim" | "null">("slim");
  const [preview, setPreview] = useState<PruneResult | null>(null);

  const used = data?.databaseBytes ?? 0;
  const limit = data?.limitBytes ?? null;
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : null;
  const tables = data?.tables ?? [];
  const biggest = tables[0]?.totalBytes ?? 0;
  const payload = data?.payload ?? null;
  // Only what nothing reads can be freed by slimming, so that is the figure
  // worth showing beside a decision — not the payload's whole size.
  const droppable = payload
    ? payload.keys.filter((k) => !k.read).reduce((n, k) => n + k.bytes, 0)
    : 0;

  // A dry run is stale the moment the settings change under it.
  const reset = () => {
    setPreview(null);
    prune.reset();
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Storage"
        description="What the database holds, and what can be freed without losing a mapped column."
      />

      {isError ? (
        <p className="rounded-lg border border-accent-red/25 bg-accent-red-soft px-3 py-2 text-xs text-accent-red">
          Could not read the storage report: {String(error)}
        </p>
      ) : null}

      {isLoading ? (
        <Card className="glass card-seam">
          <CardContent className="py-10 text-center text-sm text-muted">
            Measuring…
          </CardContent>
        </Card>
      ) : null}

      {data ? (
        <>
          {/* THE HEADLINE IS ONE NUMBER, because when this screen is opened in
              anger there is only one question. */}
          <Card className="glass card-seam">
            <CardContent className="flex flex-col gap-3 py-5">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <span className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted">
                  <Database className="size-4" />
                  Database size
                </span>
                <span className="text-2xl font-semibold tabular-nums">
                  {size(used)}
                  {limit ? (
                    <span className="text-sm font-normal text-muted">
                      {" "}
                      of {size(limit)}
                    </span>
                  ) : null}
                </span>
              </div>

              {pct === null ? (
                /* An unknown ceiling is said, not guessed at. The limit belongs
                   to the hosting plan and Postgres cannot be asked for it. */
                <p className="text-[11px] text-muted">
                  The plan&rsquo;s size limit is not configured, so there is
                  nothing to measure this against. Set{" "}
                  <code className="rounded bg-elevated px-1 py-0.5 font-mono text-[10px]">
                    DATABASE_SIZE_LIMIT_BYTES
                  </code>{" "}
                  in the API environment to see how much room is left.
                </p>
              ) : (
                <>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-elevated">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        pct >= 95
                          ? "bg-accent-red"
                          : pct >= 80
                            ? "bg-accent-orange"
                            : "bg-accent-blue",
                      )}
                      style={{ width: `${Math.max(2, pct)}%` }}
                    />
                  </div>
                  {/* The word as well as the colour. */}
                  <p
                    className={cn(
                      "text-xs",
                      pct >= 95
                        ? "text-accent-red"
                        : pct >= 80
                          ? "text-accent-orange"
                          : "text-muted",
                    )}
                  >
                    {pct}% used
                    {pct >= 95
                      ? " — writes fail at the ceiling, and nothing on the other screens says so. They keep showing the last data that was stored."
                      : pct >= 80
                        ? " — worth freeing space before it stops accepting writes."
                        : " — room to spare."}
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          <Card className="glass card-seam">
            <CardContent className="flex flex-col gap-3 py-5">
              <span className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted">
                <HardDrive className="size-4" />
                By table, largest first
              </span>
              <div className="flex flex-col gap-2">
                {tables.slice(0, 10).map((t) => (
                  <div key={t.table} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="font-medium">{t.table}</span>
                      <span className="tabular-nums text-muted">
                        {size(t.totalBytes)} ·{" "}
                        {t.rows.toLocaleString("en-GB")} rows
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-elevated">
                      <div
                        className="h-full rounded-full bg-accent-blue"
                        style={{
                          width: `${biggest ? Math.max(1, (t.totalBytes / biggest) * 100) : 0}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-[11px] leading-relaxed text-muted">
                Most of a row&rsquo;s size is not in its columns. The provider
                payloads live in TOAST storage and the indexes are counted here
                too, which is why a table of eighty thousand payments can be
                hundreds of megabytes.
              </p>
            </CardContent>
          </Card>

          {payload ? (
            <Card className="glass card-seam">
              <CardContent className="flex flex-col gap-3 py-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-xs uppercase tracking-wider text-muted">
                    Inside a stored payment payload
                  </span>
                  <span className="text-[11px] text-muted">
                    {size(payload.averageBytesPerPayment)} per payment, sampled
                    over {payload.sampled.toLocaleString("en-GB")} of the newest
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {payload.keys.slice(0, 12).map((k) => (
                    <div
                      key={k.key}
                      className="flex items-center gap-3 text-xs"
                    >
                      <span className="w-40 shrink-0 truncate font-mono text-[11px]">
                        {k.key}
                      </span>
                      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-elevated">
                        <span
                          className={cn(
                            "block h-full rounded-full",
                            /* One hue for magnitude; the muted step marks the
                               keys nothing reads, so the bar answers "how big"
                               and the label answers "kept or dropped". */
                            k.read ? "bg-accent-blue" : "bg-muted",
                          )}
                          style={{ width: `${Math.max(2, k.sharePct)}%` }}
                        />
                      </span>
                      <span className="w-16 shrink-0 text-right tabular-nums text-muted">
                        {k.sharePct}%
                      </span>
                      <span
                        className={cn(
                          "w-24 shrink-0 text-right text-[10px] uppercase tracking-wider",
                          k.read ? "text-accent-blue" : "text-muted",
                        )}
                      >
                        {k.read ? "Kept" : "Dropped"}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] leading-relaxed text-muted">
                  &ldquo;Kept&rdquo; is what the transaction drawer, the column
                  picker and the client search actually read. Slimming keeps
                  those and drops the rest — about {size(droppable)} of every{" "}
                  {size(payload.totalBytes)} sampled.
                </p>
              </CardContent>
            </Card>
          ) : null}

          {/* THE IRREVERSIBLE PART. Dry run first, and it says so. */}
          <Card className="glass card-seam">
            <CardContent className="flex flex-col gap-4 py-5">
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">Free space</span>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Every mapped column survives: amounts, states, customers,
                  references, verdicts, decline reasons, prices and dates. What
                  goes is the provider&rsquo;s unparsed original, which matters
                  only for a field nobody has mapped yet — and it cannot be
                  recovered without re-reading that period from the provider.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted">
                  Older than
                </span>
                {DAYS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => {
                      setDays(d);
                      reset();
                    }}
                    className={cn(
                      "rounded-lg border px-2.5 py-1 text-xs transition-colors",
                      days === d
                        ? "border-border-strong bg-elevated text-foreground"
                        : "border-border text-muted hover:text-foreground",
                    )}
                  >
                    {d} days
                  </button>
                ))}
              </div>

              <div className="flex flex-col gap-2">
                {(
                  [
                    {
                      m: "slim" as const,
                      title: "Slim — keep what the screens read",
                      what: "Drops the payload keys nothing here reads and the stored request headers. The transaction drawer still shows the method, description, billing address and customer. Verification records are left alone.",
                    },
                    {
                      m: "null" as const,
                      title: "Empty — drop the stored JSON entirely",
                      what: "Empties the payment payload and the verification JSON. Frees the most, and the transaction drawer loses the fields it reads from the payload. For a database that is full now.",
                    },
                  ] satisfies { m: "slim" | "null"; title: string; what: string }[]
                ).map((o) => (
                  <button
                    key={o.m}
                    type="button"
                    onClick={() => {
                      setMode(o.m);
                      reset();
                    }}
                    className={cn(
                      "rounded-lg border px-3 py-2.5 text-left transition-colors",
                      mode === o.m
                        ? "border-border-strong bg-elevated"
                        : "border-border hover:border-border-strong",
                    )}
                  >
                    <span className="text-xs font-medium">{o.title}</span>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted">
                      {o.what}
                    </p>
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  disabled={prune.isPending}
                  onClick={() =>
                    prune
                      .mutateAsync({ olderThanDays: days, mode })
                      .then(setPreview)
                      .catch(() => undefined)
                  }
                >
                  {prune.isPending && !preview ? "Measuring…" : "Show me first"}
                </Button>
                <Button
                  /* Only after a dry run. There is no path from opening this
                     screen to deleting a year of payloads in one click. */
                  disabled={!preview || prune.isPending}
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Drop the stored ${mode === "slim" ? "unread payload keys" : "provider JSON"} for rows older than ${days} days? This cannot be undone without re-reading that period from the providers.`,
                      )
                    )
                      return;
                    void prune
                      .mutateAsync({ olderThanDays: days, apply: true, mode })
                      .then(setPreview)
                      .catch(() => undefined);
                  }}
                >
                  {prune.isPending && preview ? "Freeing…" : "Free the space"}
                </Button>
              </div>

              {prune.isError ? (
                <p className="rounded-lg border border-accent-red/25 bg-accent-red-soft px-3 py-2 text-xs text-accent-red">
                  {String(prune.error)}
                </p>
              ) : null}

              {preview ? (
                <div
                  className={cn(
                    "flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 text-xs",
                    preview.applied
                      ? "border-accent-green/25 bg-accent-green-soft/40"
                      : "border-border bg-elevated",
                  )}
                >
                  {preview.applied ? (
                    <>
                      <span className="font-medium text-accent-green">
                        Done —{" "}
                        {(preview.paymentEventsPruned ?? 0).toLocaleString(
                          "en-GB",
                        )}{" "}
                        payments and{" "}
                        {(preview.kycCasesPruned ?? 0).toLocaleString("en-GB")}{" "}
                        verifications.
                      </span>
                      {/* SAYING THIS AVOIDS A SECOND PANIC: the size above will
                          not drop when the page refreshes. */}
                      <span className="text-muted">{preview.note}</span>
                    </>
                  ) : (
                    <>
                      <span className="flex items-center gap-2 font-medium">
                        <TriangleAlert className="size-3.5 text-accent-orange" />
                        Nothing has been changed yet.
                      </span>
                      <span className="text-muted">
                        {(preview.paymentEvents?.rows ?? 0).toLocaleString(
                          "en-GB",
                        )}{" "}
                        payments and{" "}
                        {(preview.kycCases?.rows ?? 0).toLocaleString("en-GB")}{" "}
                        verifications are older than {preview.olderThanDays}{" "}
                        days, holding {size(preview.bytes ?? 0)} of JSON between
                        them.
                        {mode === "slim"
                          ? " Slimming frees the part of that nothing reads, and leaves the verifications alone."
                          : ""}
                      </span>
                    </>
                  )}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <p className="text-[11px] leading-relaxed text-muted">
            Freeing space here does not shrink the reported size straight away.
            Postgres marks the old rows dead and reuses those pages for new
            writes; it returns them to the disk only on a full vacuum, which
            rewrites the table and needs room to do it. Writes start working
            again immediately, which is the thing that was broken.
          </p>
        </>
      ) : null}
    </div>
  );
}
