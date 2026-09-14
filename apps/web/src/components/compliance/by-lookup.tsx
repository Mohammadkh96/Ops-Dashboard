"use client";

import { AlertTriangle } from "lucide-react";

import { useKycSummary } from "@/hooks/use-kyc";

/**
 * National id numbers being validated — which is not the same as people being
 * verified, and this panel exists because the two were being counted together.
 *
 * WHAT THESE ARE. Saint Lucia's report carries several hundred rows a fortnight
 * that KYCAID files under `service: KYB`, and not one of them is a company.
 * They have no applicant, no form, `UNKNOWN` method and exactly one check:
 * `IN_AADHAAR_CARD_NUMBER`, `IN_DIGILOCKER_EAADHAAR`, `IN_DRIVING_LICENSE`,
 * `NG_NIN_NUMBER`, `MX_CURP`. They are the provider's national-id services,
 * called directly during onboarding for Indian, Nigerian and Mexican clients.
 * The provider's own console does not list them at all, because a verification
 * list is organised by applicant and these have none — which is why nobody
 * could find them when they appeared on this screen.
 *
 * WHY THEY GET THEIR OWN PANEL. Counted as verifications they did damage in two
 * directions at once: they inflated the entity's total and pass rate, and their
 * own failures vanished into it. 88 Aadhaar numbers failed to validate in a
 * fortnight — 44% of the Aadhaar checks run — and nothing anywhere said so.
 * Either the CRM is sending malformed numbers or a lot of clients are entering
 * ones that do not validate, and both are somebody's job.
 */

/** Their code, in words. Anything unmapped shows as the provider sends it. */
const NAMES: Record<string, string> = {
  IN_AADHAAR_CARD_NUMBER: "India · Aadhaar number",
  IN_DIGILOCKER_EAADHAAR: "India · DigiLocker eAadhaar",
  IN_DRIVING_LICENSE: "India · driving licence",
  NG_NIN_NUMBER: "Nigeria · NIN",
  NG_DRIVER_LICENSE_NUMBER: "Nigeria · driving licence",
  MX_CURP: "Mexico · CURP",
  BR_CPF: "Brazil · CPF",
  PE_DNI: "Peru · DNI",
  TR_IDENTITY_NUMBER: "Turkey · identity number",
  KZ_PERSONAL_DATA: "Kazakhstan · personal data",
};

export function ByLookup({
  from,
  to,
  account,
}: {
  from: string;
  to: string;
  account: string;
}) {
  const { data } = useKycSummary({ from, to, account });
  const rows = data?.lookups ?? [];
  if (!rows.length) return null;

  const total = rows.reduce((n, r) => n + r.rows, 0);
  const failed = rows.reduce((n, r) => n + r.invalid, 0);
  const spent = rows.reduce((n, r) => n + r.spentEur, 0);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card/60 px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium">National id checks</span>
        <span className="tnum text-[11px] text-muted">
          {total.toLocaleString()} lookup{total === 1 ? "" : "s"} · €
          {spent.toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </span>
      </div>

      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-[10px] tracking-wider text-muted uppercase">
            <th className="pb-1 text-left font-normal">Check</th>
            <th className="pb-1 text-right font-normal">Run</th>
            <th className="pb-1 text-right font-normal">Failed</th>
            <th className="pb-1 text-right font-normal">Fail rate</th>
            <th className="pb-1 text-right font-normal">Spend</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const rate = r.rows ? Math.round((r.invalid / r.rows) * 100) : 0;
            return (
              <tr key={r.check} className="border-t border-border/60">
                <td className="py-1.5 text-muted-foreground">
                  {NAMES[r.check] ?? r.check}
                </td>
                <td className="tnum py-1.5 text-right text-muted-foreground">
                  {r.rows.toLocaleString()}
                </td>
                <td
                  className={`tnum py-1.5 text-right ${r.invalid ? "text-accent-red" : "text-muted"}`}
                >
                  {r.invalid.toLocaleString()}
                </td>
                {/* A quarter of a national id service failing is a finding, not
                    a statistic — coloured so it is read as one. */}
                <td
                  className={`tnum py-1.5 text-right ${
                    rate >= 25
                      ? "text-accent-red"
                      : rate > 0
                        ? "text-accent-orange"
                        : "text-muted"
                  }`}
                >
                  {rate}%
                </td>
                <td className="tnum py-1.5 text-right text-muted">
                  €{r.spentEur.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="flex items-start gap-1.5 text-[11px] text-muted">
        <AlertTriangle className="mt-px size-3.5 shrink-0" />
        <span>
          Numbers validated during onboarding, not people verified — no
          applicant, no form, one check each. They are counted apart from the
          verifications above and excluded from the pass rate.
          {failed
            ? ` ${failed.toLocaleString()} did not validate: either the numbers reaching the provider are malformed, or the clients entering them are.`
            : ""}
        </span>
      </p>
    </div>
  );
}
