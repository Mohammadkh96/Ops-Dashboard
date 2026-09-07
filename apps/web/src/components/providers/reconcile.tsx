"use client";

import { useRef, useState } from "react";
import { FileUp, Info, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { parseFile } from "@/lib/recon/parse";
import { useReconcileStatement, type ReconcileReport } from "@/hooks/use-psps";

/**
 * The provider's own statement, checked against ours payment by payment.
 *
 * WHY IT IS HERE, under the balance rather than on a page of its own.
 *
 * The balance panel above answers "does the total agree", and on the morning
 * this was written it answered YES on a terminal that was holding a client's
 * USD 3,999.40 deposit as USD 299.70. The client had paid twice into an address
 * whose invoice was already closed; the wallet received everything, so the
 * total was right and stayed right. Somebody was owed 3,699.70 and no sum on
 * any screen could have said so.
 *
 * So this sits directly beneath the figure it disproves. The two belong
 * together: one says whether the total agrees, the other says which payment
 * does not — and the second is the only one that can name a client.
 */
const money = (n: number, ccy: string | null) =>
  `${ccy ? `${ccy} ` : ""}${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const day = (iso: string | null) =>
  iso ? iso.slice(0, 16).replace("T", " ") : "—";

export function StatementReconciler({
  connectionId,
  currency,
}: {
  connectionId: string;
  currency: string | null;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const recon = useReconcileStatement(connectionId);
  const report: ReconcileReport | undefined = recon.data;

  async function onPick(file: File | undefined) {
    if (!file) return;
    setReadError(null);
    setFileName(file.name);
    setReading(true);
    try {
      // Parsed HERE rather than uploaded. The file never leaves the browser as
      // a file — only the rows do — which keeps a statement full of client
      // references out of anything that stores request bodies.
      const ds = await parseFile(file);
      if (!ds.rows.length) {
        setReadError(
          `No rows could be read out of ${file.name}. If it is an Excel export, check the payments are on the first sheet.`,
        );
        return;
      }
      recon.mutate(ds.rows as Record<string, unknown>[]);
    } catch (e) {
      setReadError(e instanceof Error ? e.message : "Could not read that file.");
    } finally {
      setReading(false);
    }
  }

  const busy = reading || recon.isPending;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card/40 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">
          Check against the provider&rsquo;s own statement
        </span>
        <input
          ref={input}
          type="file"
          accept=".csv,.tsv,.txt,.xls,.xlsx"
          className="hidden"
          onChange={(e) => void onPick(e.target.files?.[0])}
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <FileUp className="size-3.5" />
          )}
          {busy ? "Reading…" : report ? "Check another" : "Upload statement"}
        </Button>
      </div>

      {!report && !readError && !recon.isError ? (
        <p className="text-[11px] leading-relaxed text-muted">
          Export the payment list from the provider&rsquo;s own portal and drop
          it here. Every payment it says it settled is matched against ours and
          the differences are named — the balance above can only say whether the
          totals agree, never which payment is wrong.
        </p>
      ) : null}

      {readError ? (
        <p className="text-[11px] text-accent-red">{readError}</p>
      ) : null}
      {recon.isError ? (
        <p className="text-[11px] text-accent-red">
          {recon.error instanceof Error
            ? recon.error.message
            : "That statement could not be read."}
        </p>
      ) : null}

      {report ? <Report report={report} currency={currency} file={fileName} /> : null}
    </div>
  );
}

function Report({
  report: r,
  currency,
  file,
}: {
  report: ReconcileReport;
  currency: string | null;
  file: string | null;
}) {
  const clean =
    !r.amountErrors.length && !r.uncounted.length && !r.missing.length;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] text-muted">
        {file ? <span className="text-muted-foreground">{file}</span> : null}
        {file ? " · " : ""}
        {r.statement.settled.toLocaleString()} settled payment
        {r.statement.settled === 1 ? "" : "s"} between {day(r.statement.from)}{" "}
        and {day(r.statement.to)}
        {r.statement.ignored
          ? `, ${r.statement.ignored.toLocaleString()} not settled and ignored`
          : ""}
        {r.statement.unreadable
          ? `, ${r.statement.unreadable.toLocaleString()} unreadable`
          : ""}
        . Matched {r.matched.toLocaleString()}.
      </p>

      {/* Which column was read as what. A statement whose crypto column was
          taken for the fiat one produces a page of confident nonsense, and the
          header that was picked is the only way to see it. */}
      <p className="text-[10px] text-muted">
        Read as: date “{r.statement.columns.at ?? "—"}”, type “
        {r.statement.columns.direction ?? "—"}”, amount “
        {r.statement.columns.amount ?? "—"}”, status “
        {r.statement.columns.status ?? "—"}”.
      </p>

      {/* Said BEFORE any figure. Ten withdrawals were reported as missing money
          this way while this was being built, and none of them were. */}
      {r.boundary ? (
        <p className="flex items-start gap-1.5 text-[11px] text-accent-orange">
          <Info className="mt-px size-3.5 shrink-0" />
          {r.boundary}
        </p>
      ) : null}

      {clean ? (
        <p className="text-[11px] text-accent-green">
          Every settled payment matches ours, to the cent —{" "}
          {money(r.counted.in, currency)} in and {money(r.counted.out, currency)}{" "}
          out across {r.counted.payments.toLocaleString()} payments.
        </p>
      ) : (
        <p className="text-[11px] text-muted">
          <span className="text-muted-foreground">
            {r.net >= 0 ? "Our estimate runs high" : "Our estimate runs low"} by{" "}
            <span className="tnum font-medium text-foreground">
              {money(Math.abs(r.net), currency)}
            </span>
          </span>{" "}
          against the provider&rsquo;s own record — and unlike a fitted
          correction, every part of it is a payment you can go and look at.
        </p>
      )}

      {r.amountErrors.length ? (
        <Table
          title="Recorded for a different amount"
          note="The provider settled one figure and our ledger holds another. A client who paid twice into the same address looks exactly like this."
          rows={r.amountErrors.map((e) => ({
            key: `${e.at}-${e.reference ?? ""}`,
            left: `${day(e.at)} · ${e.customer ?? e.reference ?? "—"}`,
            mid: `${money(e.ours, currency)} → ${money(e.theirs, currency)}`,
            right: money(e.difference, currency),
          }))}
        />
      ) : null}

      {r.uncounted.length ? (
        <Table
          title="Settled by the provider, not counted by us"
          note="Money that moved while our ledger holds it under a status the balance rules exclude. Chase the callbacks — counting the status wholesale would also count the ones that genuinely did not complete."
          rows={r.uncounted.map((u) => ({
            key: `${u.direction}-${u.status}`,
            left: `${u.status} · ${u.direction === "in" ? "deposit" : "withdrawal"}`,
            mid: `${u.payments.toLocaleString()} payment${u.payments === 1 ? "" : "s"}`,
            right: money(u.value, currency),
          }))}
        />
      ) : null}

      {r.missing.length ? (
        <Table
          title="Settled by the provider, no record of ours at all"
          note="Neither counted nor stored. If these are not simply outside the window above, they never reached us."
          rows={r.missing.map((m) => ({
            key: `${m.at}-${m.amount}`,
            left: day(m.at),
            mid: m.direction === "in" ? "deposit" : "withdrawal",
            right: money(m.amount, currency),
          }))}
        />
      ) : null}
    </div>
  );
}

function Table({
  title,
  note,
  rows,
}: {
  title: string;
  note: string;
  rows: { key: string; left: string; mid: string; right: string }[];
}) {
  // Capped, and the cap is SAID. A list silently cut at twenty reads as "there
  // were twenty", which is how a reconciliation understates itself.
  const shown = rows.slice(0, 20);
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border/60 px-2.5 py-2">
      <span className="text-[11px] font-medium text-foreground">{title}</span>
      <span className="text-[10px] leading-relaxed text-muted">{note}</span>
      <div className="mt-0.5 overflow-x-auto">
        <table className="w-full text-[11px]">
          <tbody>
            {shown.map((r) => (
              <tr key={r.key} className="border-t border-border/40">
                <td className="py-1 pr-3 whitespace-nowrap text-muted-foreground">
                  {r.left}
                </td>
                <td className="py-1 pr-3 whitespace-nowrap text-muted">
                  {r.mid}
                </td>
                <td className="tnum py-1 text-right whitespace-nowrap text-foreground">
                  {r.right}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown.length ? (
        <span className="text-[10px] text-muted">
          and {(rows.length - shown.length).toLocaleString()} more.
        </span>
      ) : null}
    </div>
  );
}
