"use client";

import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleSlash,
  Settings2,
} from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePspDirectory, type PspCard } from "@/hooks/use-psps";

/**
 * The payment providers and their ledgers.
 *
 * ITS OWN TAB rather than a page inside Admin, because reading a ledger is
 * something that happens every shift while configuring a connection happens
 * once — and a screen buried three levels into an administration area is a
 * screen nobody opens.
 *
 * A SESSION IS ENOUGH to read it. The operations team opens this every shift,
 * and gating it on the admin passphrase would mean the admin passphrase gets
 * shared around the desk — which is worse than what it would be protecting,
 * because that same passphrase also changes roles, reveals the audit trail and
 * stores payment credentials.
 *
 * The line is between reading and doing: syncing from a provider spends a live
 * credential and still needs the unlock, as does anything that changes a
 * connection. Base URLs, key hints and the field mapping stay in Admin.
 */
export default function ProvidersPage() {
  const { data, isLoading, isError, error } = usePspDirectory();
  const psps = data ?? [];

  const withLedger = psps.filter((p) => p.hasTransactions);
  const rest = psps.filter((p) => !p.hasTransactions);
  const total = psps.reduce((n, p) => n + p.stored, 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Payment providers"
        description="Each provider's own record of what it processed."
        actions={
          <Link href="/admin/psps">
            <Button variant="ghost" size="sm">
              <Settings2 className="size-3.5" />
              Configure
            </Button>
          </Link>
        }
      />

      {isError ? (
        <p className="rounded-lg border border-accent-red/25 bg-accent-red-soft px-3 py-2 text-xs text-accent-red">
          Could not read the providers: {String(error)}
        </p>
      ) : null}

      {isLoading ? (
        <Card className="glass card-seam">
          <CardContent className="py-10 text-center text-sm text-muted">
            Reading the providers…
          </CardContent>
        </Card>
      ) : null}

      {total > 0 ? (
        <p className="text-xs text-muted">
          <span className="tnum font-medium text-foreground">
            {total.toLocaleString()}
          </span>{" "}
          transactions stored across {withLedger.length} provider
          {withLedger.length === 1 ? "" : "s"}.
        </p>
      ) : null}

      {withLedger.length ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {withLedger.map((p) => (
            <ProviderCard key={p.id} psp={p} />
          ))}
        </div>
      ) : null}

      {/* Shown, not hidden. A terminal with no ledger configured is a piece of
          work outstanding, and leaving it off the page makes it invisible. */}
      {rest.length ? (
        <div className="flex flex-col gap-2">
          <span className="text-[10px] font-medium tracking-wider text-muted uppercase">
            Not connected yet
          </span>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {rest.map((p) => (
              <Card key={p.id} className="glass card-seam">
                <CardContent className="flex items-center gap-3 py-3">
                  <CircleSlash className="size-4 shrink-0 text-muted" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm">{p.label}</span>
                    <span className="text-[11px] text-muted">
                      No transactions endpoint configured
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ) : null}

      {!isLoading && psps.length === 0 ? (
        <Card className="glass card-seam">
          <CardContent className="py-10 text-center text-sm text-muted">
            No providers yet. Add one under{" "}
            <Link href="/admin/psps" className="underline">
              Configure
            </Link>
            .
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/** One provider, as a way in to its ledger. */
function ProviderCard({ psp }: { psp: PspCard }) {
  const state = psp.lastError
    ? { Icon: AlertTriangle, cls: "text-accent-orange", word: "Failing" }
    : psp.stored > 0
      ? { Icon: CheckCircle2, cls: "text-accent-green", word: "Connected" }
      : { Icon: CircleSlash, cls: "text-muted", word: "Nothing synced yet" };

  return (
    <Link href={`/providers/transactions/?id=${psp.id}`} className="group">
      <Card className="glass card-seam h-full transition-colors group-hover:border-border-strong">
        <CardContent className="flex h-full flex-col gap-3 py-4">
          <div className="flex items-start gap-2">
            <state.Icon className={cn("mt-0.5 size-4 shrink-0", state.cls)} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">{psp.label}</span>
              <span className="text-[11px] text-muted capitalize">
                {psp.provider}
              </span>
            </div>
            <ArrowRight className="size-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" />
          </div>

          <div className="flex flex-1 flex-col justify-end gap-0.5">
            <span className="tnum text-2xl leading-none font-semibold">
              {psp.stored.toLocaleString()}
            </span>
            <span className="text-[11px] text-muted">
              transaction{psp.stored === 1 ? "" : "s"} stored
            </span>
          </div>

          {/* The age of the newest row, always. A ledger last synced on Tuesday
              looks exactly like a current one unless it says so. */}
          <span className="text-[11px] text-muted">
            {psp.newest
              ? `Newest ${psp.newest.slice(0, 10)}`
              : "Nothing synced yet"}
          </span>

          {psp.lastError ? (
            <span className="line-clamp-2 text-[11px] text-accent-orange">
              {psp.lastError}
            </span>
          ) : null}
        </CardContent>
      </Card>
    </Link>
  );
}
