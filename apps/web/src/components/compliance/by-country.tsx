"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";

import { useKycCountries } from "@/hooks/use-kyc";

/**
 * Which jurisdictions are being verified, and how they fare.
 *
 * THE BREAKDOWN THE DESK DID NOT HAVE. Pass rate by entity says Mauritius
 * approves 44% against Saint Lucia's 89% — the same provider, the same checks,
 * a gap nobody can explain from that number alone. Pass rate by country says
 * whether the difference is the form or the applicants, because two brands
 * drawing from different jurisdictions are being held to one standard with
 * different inputs.
 *
 * THE NAMES COME FROM THE PROVIDER. `GET /countries` is the reference list of
 * the countries an account may verify at all, so it answers two questions at
 * once: what "PH" says in words, and whether the provider is configured to
 * accept it. A country with rows here that is NOT on that list is flagged —
 * either a jurisdiction turned off after those checks were paid for, or a code
 * the provider does not use, and both are somebody's afternoon.
 *
 * Asked separately from the summary so the cards above never wait on a third
 * party to render a figure this dashboard holds itself.
 */

/** How many rows before the list is folded. Beyond this it is a scroll, not a read. */
const FOLD = 8;

export function ByCountry({
  from,
  to,
  account,
}: {
  from: string;
  to: string;
  /** The entity being shown, or "" for both. */
  account: string;
}) {
  const [all, setAll] = useState(false);
  const { data, isPending, isError } = useKycCountries({ from, to, account });

  // Nothing to say yet, and nothing worth a spinner: the panel simply is not
  // there until it has something. A failed lookup is silent for the same
  // reason — the table below it is the screen, and this is a reading of it.
  if (isPending || isError || !data) return null;
  const rows = data.countries.filter((c) => c.verifications > 0);
  if (!rows.length) return null;

  const shown = all ? rows : rows.slice(0, FOLD);
  const unknown = rows.filter((c) => c.allowed === false).length;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card/60 px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium">By jurisdiction</span>
        <span className="tnum text-[11px] text-muted">
          {rows.length.toLocaleString()} countr{rows.length === 1 ? "y" : "ies"}
          {data.accepted ? ` · ${data.accepted} accepted by KYCAID` : ""}
        </span>
      </div>

      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-[10px] tracking-wider text-muted uppercase">
            <th className="pb-1 text-left font-normal">Country</th>
            <th className="pb-1 text-right font-normal">Checks</th>
            <th className="pb-1 text-right font-normal">Approved</th>
            <th className="pb-1 text-right font-normal">Rejected</th>
            <th className="pb-1 text-right font-normal">Pass</th>
            <th className="pb-1 text-right font-normal">Spend</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((c) => {
            const approved = c.byStatus.APPROVED ?? 0;
            const rejected = c.byStatus.REJECTED ?? 0;
            /**
             * Of the DECIDED ones, as everywhere else on this screen. A pass
             * rate with pending checks in the denominator falls whenever the
             * queue grows, which reads as quality dropping when nothing about
             * the decisions has changed.
             */
            const decided = approved + rejected;
            const pass = decided ? Math.round((approved / decided) * 100) : null;
            return (
              <tr key={c.country ?? "(none)"} className="border-t border-border/60">
                <td className="py-1.5">
                  <span className="text-muted-foreground">
                    {c.name ?? c.country ?? "No country recorded"}
                  </span>
                  {c.country && c.name ? (
                    <span className="ml-1.5 text-[10px] text-muted">{c.country}</span>
                  ) : null}
                  {/* Named rather than merely coloured: the icon carries a
                      title, so this is never colour alone. */}
                  {c.allowed === false ? (
                    <AlertTriangle
                      className="ml-1.5 inline size-3 text-accent-orange"
                      aria-label="Not on the provider's accepted list"
                    />
                  ) : null}
                </td>
                <td className="tnum py-1.5 text-right text-muted-foreground">
                  {c.verifications.toLocaleString()}
                </td>
                <td className="tnum py-1.5 text-right text-accent-green">
                  {approved.toLocaleString()}
                </td>
                <td className="tnum py-1.5 text-right text-accent-red">
                  {rejected.toLocaleString()}
                </td>
                <td
                  className={`tnum py-1.5 text-right ${
                    pass === null
                      ? "text-muted"
                      : pass < 60
                        ? "text-accent-orange"
                        : "text-muted-foreground"
                  }`}
                >
                  {pass === null ? "—" : `${pass}%`}
                </td>
                <td className="tnum py-1.5 text-right text-muted">
                  €{c.spentEur.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
        {rows.length > FOLD ? (
          <button
            type="button"
            onClick={() => setAll(!all)}
            className="underline decoration-dotted underline-offset-4 hover:text-muted-foreground"
          >
            {all ? "Show fewer" : `Show all ${rows.length}`}
          </button>
        ) : null}
        {unknown ? (
          <span className="text-accent-orange">
            {unknown} not on the provider&rsquo;s accepted list
          </span>
        ) : null}
        {/* Said plainly rather than left as codes without explanation: the
            column reading "PH" instead of "Philippines" has a reason, and it
            is this. */}
        {data.namesUnavailable ? (
          <span>Country names unavailable — {data.namesUnavailable}</span>
        ) : null}
      </div>
    </div>
  );
}
