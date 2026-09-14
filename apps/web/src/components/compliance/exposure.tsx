"use client";

import { AlertTriangle } from "lucide-react";

import { useKycExposure } from "@/hooks/use-kyc";

/**
 * Money, grouped by whether the person who moved it was ever checked.
 *
 * THE QUESTION THE JOIN WAS BUILT FOR. `external_applicant_id` is on every
 * verification and on every payment, and until now it only put a clickable CU
 * number in a table. This is what it is actually for: not how many clients are
 * unverified, but how much money the unverified ones funded.
 *
 * Five standings, and three of them are work:
 *
 *   rejected — checked, refused, and still funding an account
 *   expired  — passed once, against a document that has since lapsed
 *   none     — money moved by somebody with no verification on record
 *
 * `expired` is the one no screen anywhere could show before the document dates
 * were stored. An approval from eighteen months ago against a passport that ran
 * out in March is not a current verification, and nothing was watching.
 */

const TONE: Record<string, string> = {
  approved: "text-accent-green",
  pending: "text-muted-foreground",
  in_review: "text-muted-foreground",
  expired: "text-accent-orange",
  rejected: "text-accent-red",
  none: "text-accent-red",
};

const LABEL: Record<string, string> = {
  approved: "Verified",
  pending: "Awaiting a decision",
  in_review: "In review",
  edd_required: "EDD required",
  not_started: "Never started",
  expired: "Document expired",
  rejected: "Rejected",
  none: "No verification on record",
};

export function Exposure({
  from,
  to,
  account,
}: {
  from: string;
  to: string;
  account: string;
}) {
  const { data } = useKycExposure({ from, to, account });
  const rows = data?.byStanding ?? [];
  if (!rows.length) return null;

  const total = rows.reduce((n, r) => n + r.amount, 0);
  /**
   * One currency, or none named.
   *
   * Amounts are summed exactly as the ledger stores them. Where that ledger
   * holds more than one currency the total is a nonsense, and printing a euro
   * sign over it would be the confident kind of wrong.
   */
  const one = data && data.currencies.length === 1 ? data.currencies[0] : null;
  const money = (n: number) =>
    `${one ? (one === "EUR" ? "€" : one === "USD" ? "$" : `${one} `) : ""}${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card/60 px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium">
          Deposits by verification standing
        </span>
        <span className="tnum text-[11px] text-muted">
          {money(total)} settled in this period
        </span>
      </div>

      {/* The headline, stated rather than left to be worked out from a table.
          "Eleven clients are unverified" is a note; "eleven clients funded
          forty thousand with no verification" is a decision due today. */}
      {data && data.uncheckedEur > 0 ? (
        <p className="flex items-start gap-1.5 text-[12px] text-accent-red">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="tnum font-medium">{money(data.uncheckedEur)}</span>{" "}
            was funded by clients who are not currently verified —{" "}
            {total > 0 ? Math.round((data.uncheckedEur / total) * 100) : 0}% of
            settled deposits in this period.
          </span>
        </p>
      ) : null}

      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-[10px] tracking-wider text-muted uppercase">
            <th className="pb-1 text-left font-normal">Standing</th>
            <th className="pb-1 text-right font-normal">Clients</th>
            <th className="pb-1 text-right font-normal">Deposits</th>
            <th className="pb-1 text-right font-normal">Funded</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.standing} className="border-t border-border/60">
              <td className={`py-1.5 ${TONE[r.standing] ?? "text-muted-foreground"}`}>
                {LABEL[r.standing] ?? r.standing}
              </td>
              <td className="tnum py-1.5 text-right text-muted-foreground">
                {r.clients.toLocaleString()}
              </td>
              <td className="tnum py-1.5 text-right text-muted">
                {r.deposits.toLocaleString()}
              </td>
              <td
                className={`tnum py-1.5 text-right ${TONE[r.standing] ?? "text-muted-foreground"}`}
              >
                {money(r.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* The work list. A total nobody can act on is a total nobody acts on, so
          the clients behind it are named — worst first. */}
      {data?.clients.length ? (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] tracking-wider text-muted uppercase">
            Who, worst first
          </span>
          <div className="flex flex-wrap gap-1.5">
            {data.clients.slice(0, 12).map((c) => (
              <span
                key={c.reference}
                className="tnum rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground"
                title={`${c.deposits} deposit${c.deposits === 1 ? "" : "s"} · ${LABEL[c.standing] ?? c.standing}`}
              >
                {c.reference}
                <span className={`ml-1.5 ${TONE[c.standing] ?? "text-muted"}`}>
                  {money(c.amount)}
                </span>
              </span>
            ))}
            {data.clients.length > 12 ? (
              <span className="px-1 py-0.5 text-[11px] text-muted">
                +{data.clients.length - 12} more
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {data && data.currencies.length > 1 ? (
        <p className="flex items-start gap-1.5 text-[11px] text-accent-orange">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          The ledger holds {data.currencies.join(", ")} in this period and these
          totals add them together. Read them as magnitudes, not as one currency.
        </p>
      ) : null}
    </div>
  );
}
