"use client";

import { Info } from "lucide-react";

import { useKycSummary, type KycFormBreakdown } from "@/hooks/use-kyc";

/**
 * The verifications, split by the form that ran them.
 *
 * ONE FORM IS ONE BRAND. Each entity runs its own KYCAID form — "DEFAULT KYC
 * Tradin MAU" and "DEFAULT KYC" — and they are not the same check: one
 * includes ADDRESS and the other does not. A single total across both is an
 * average of two different standards, and the question "were these two clients
 * held to the same one" is exactly what a compliance officer gets asked.
 *
 * A row with no form is shown as its own line rather than folded into either.
 * It means the import did not carry a form for those rows — a gap, and a gap
 * quietly added to one brand's count is worse than one that says so.
 */
export function ByBrand() {
  const { data } = useKycSummary();
  const forms = data?.byForm ?? [];
  if (forms.length < 1) return null;

  const total = forms.reduce((n, f) => n + f.verifications, 0);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card/60 px-4 py-3">
      <div className="flex flex-col">
        <span className="text-[10px] font-medium tracking-wider text-muted uppercase">
          By form
        </span>
        <span className="text-[11px] text-muted">
          Each entity runs its own form, and the checks are not the same — one
          includes address verification and the other does not. This is the only
          record that two clients were held to different standards.
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-[11px]">
          <thead>
            <tr className="text-left text-muted">
              <th className="pb-1.5 font-medium">Form</th>
              <th className="pb-1.5 text-right font-medium">Verifications</th>
              <th className="pb-1.5 text-right font-medium">Approved</th>
              <th className="pb-1.5 text-right font-medium">Rejected</th>
              <th className="pb-1.5 text-right font-medium">Awaiting</th>
              <th className="pb-1.5 text-right font-medium">No account</th>
              <th className="pb-1.5 text-right font-medium">Spend</th>
            </tr>
          </thead>
          <tbody>
            {forms.map((f) => (
              <Row key={f.form ?? "(none)"} form={f} total={total} />
            ))}
          </tbody>
        </table>
      </div>

      {forms.some((f) => !f.form) ? (
        <p className="flex items-start gap-1.5 text-[11px] text-accent-orange">
          <Info className="mt-px size-3.5 shrink-0" />
          Some verifications carry no form, so they cannot be attributed to
          either entity. If they came from a file import, the export was missing
          its form column; fetching those days from the provider fills it in.
        </p>
      ) : null}
    </div>
  );
}

function Row({ form: f, total }: { form: KycFormBreakdown; total: number }) {
  const awaiting =
    (f.byStatus.PENDING ?? 0) +
    (f.byStatus.IN_REVIEW ?? 0) +
    (f.byStatus.EDD_REQUIRED ?? 0) +
    (f.byStatus.NOT_STARTED ?? 0);
  const share = total ? Math.round((f.verifications / total) * 100) : 0;

  return (
    <tr className="border-t border-border/60">
      <td className="py-1.5 pr-3">
        <span className={f.form ? "text-muted-foreground" : "text-accent-orange"}>
          {f.form ?? "No form recorded"}
        </span>{" "}
        <span className="tnum text-muted">{share}%</span>
      </td>
      <td className="tnum py-1.5 text-right font-medium">
        {f.verifications.toLocaleString()}
      </td>
      <td className="tnum py-1.5 text-right text-accent-green">
        {(f.byStatus.APPROVED ?? 0).toLocaleString()}
      </td>
      <td className="tnum py-1.5 text-right text-accent-red">
        {(f.byStatus.REJECTED ?? 0).toLocaleString()}
      </td>
      <td className="tnum py-1.5 text-right text-muted-foreground">
        {awaiting.toLocaleString()}
      </td>
      {/* Kept and counted, never dropped: an application abandoned before it
          reached an account still cost money and still carries a reason. */}
      <td className="tnum py-1.5 text-right text-muted">
        {f.unlinked.toLocaleString()}
      </td>
      <td className="tnum py-1.5 text-right text-muted-foreground">
        €{f.spentEur.toLocaleString(undefined, { maximumFractionDigits: 2 })}
      </td>
    </tr>
  );
}
