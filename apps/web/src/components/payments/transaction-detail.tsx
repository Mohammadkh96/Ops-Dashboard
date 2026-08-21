"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { StatusBadge } from "@/components/ui/status-badge";
import { apiFetch, isDemoMode } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fieldText, useColumnCatalogue, type FieldSpec } from "@/lib/columns";
import type { Transaction } from "@/lib/modules";

export type TransactionDetail = {
  id: string;
  paymentId: string | null;
  reference: string | null;
  state: string | null;
  amount: number;
  currency: string | null;
  history: {
    state: string | null;
    amount: number;
    errorCode: string | null;
    errorMessage: string | null;
    at: string;
    source: string;
  }[];
  fields: Record<string, string | number | boolean | null>;
  raw: Record<string, unknown>;
};

const when = (s: string | null) =>
  s ? new Date(s).toISOString().slice(0, 19).replace("T", " ") : "—";

/**
 * Renders one group of fields, omitting the ones with no value.
 *
 * Paymaxis shows every field including the empty ones, which is right for a
 * console you configure and wrong for a drawer you read: thirty blank rows bury
 * the six that say something. Redacted fields are the exception — they are
 * named, because "we removed this" and "the provider never sent it" are
 * different facts and only one of them is worth chasing the provider about.
 */
function Group({
  specs,
  values,
}: {
  specs: FieldSpec[];
  values: Record<string, string | number | boolean | null>;
}) {
  const rows = specs
    .map((s) => ({ spec: s, text: fieldText(values[s.key]) }))
    .filter((r) => r.text !== "" || r.spec.redacted);
  if (!rows.length) return null;

  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
      {rows.map(({ spec, text }) => (
        <div key={spec.key} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-xs text-muted">{spec.label}</dt>
          <dd className="break-words">
            {text ? (
              text
            ) : (
              <span
                className="text-muted"
                title="Removed from the payload on ingest — see PAYMAXIS_REDACT_KEYS"
              >
                redacted on ingest
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Everything known about one payment, laid out the way the provider's own
 * console lays it out.
 *
 * The drawer previously showed a curated dozen fields. The rest were in the
 * stored payload the whole time — issuing country, billing address, crypto
 * network and destination, the base-currency amounts finance reconciles
 * against — but reaching them meant expanding raw JSON. Grouping follows the
 * Paymaxis tabs so someone who knows that console finds a field where they
 * expect it.
 */
export function TransactionDetail({ row }: { row: Transaction }) {
  const { data: catalogue } = useColumnCatalogue();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["transaction", row.id],
    queryFn: () => apiFetch<TransactionDetail | null>(`/transactions/${row.id}`),
    enabled: !isDemoMode,
  });
  const [tab, setTab] = useState<string>("payment");

  const money = (n: number, ccy: string | null) =>
    `${ccy ? `${ccy} ` : ""}${n.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

  // Only groups that have something in them, so a card payment does not offer
  // an empty Crypto tab and a crypto payout does not offer an empty Card one.
  const groups = (() => {
    if (!catalogue || !data) return [];
    const order = [...new Set(catalogue.fields.map((f) => f.group))];
    return order
      .map((g) => ({
        key: g,
        label: catalogue.groups[g] ?? g,
        specs: catalogue.fields.filter((f) => f.group === g),
      }))
      .filter((g) =>
        g.specs.some((s) => fieldText(data.fields[s.key]) !== ""),
      );
  })();

  const active = groups.find((g) => g.key === tab) ?? groups[0];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between rounded-xl border border-border bg-card p-4">
        <div className="flex flex-col">
          <span className="text-xs text-muted">Amount</span>
          <span className="tnum text-xl font-semibold">
            {data ? money(data.amount, data.currency) : `${row.currency} ${row.amount}`}
          </span>
        </div>
        <StatusBadge status={row.status} label={row.stateLabel ?? undefined} />
      </div>

      {isDemoMode ? (
        <p className="text-xs text-muted">
          Full detail is read from the API and is not available in demo mode.
        </p>
      ) : isLoading ? (
        <p className="text-xs text-muted">Loading detail…</p>
      ) : isError || !data ? (
        <p className="text-xs text-muted">Detail could not be loaded.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1 border-b border-border">
            {groups.map((g) => (
              <button
                key={g.key}
                onClick={() => setTab(g.key)}
                className={cn(
                  "relative px-2.5 py-2 text-xs font-medium transition-colors",
                  active?.key === g.key
                    ? "text-foreground"
                    : "text-muted hover:text-muted-foreground",
                )}
              >
                {g.label}
                {active?.key === g.key ? (
                  <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent-blue" />
                ) : null}
              </button>
            ))}
            <button
              onClick={() => setTab("history")}
              className={cn(
                "relative px-2.5 py-2 text-xs font-medium transition-colors",
                tab === "history"
                  ? "text-foreground"
                  : "text-muted hover:text-muted-foreground",
              )}
            >
              History
              {tab === "history" ? (
                <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent-blue" />
              ) : null}
            </button>
          </div>

          {tab === "history" ? (
            <div className="flex flex-col gap-3">
              {/*
                Our own record, not the provider's operation log: these are the
                states this payment was in each time we read it. Paymaxis keeps
                a finer-grained list under Operations, which is a separate
                resource we do not pull.
              */}
              {data.history.length ? (
                <ol className="flex flex-col gap-3 border-l border-border pl-4">
                  {data.history.map((h, i) => (
                    <li key={i} className="relative text-sm">
                      <span className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-accent-blue" />
                      <div className="flex justify-between gap-3">
                        <span>{h.state ?? "—"}</span>
                        <span className="tnum text-xs text-muted">{when(h.at)}</span>
                      </div>
                      {h.errorMessage ? (
                        <span className="text-xs text-accent-red">
                          {h.errorMessage}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-xs text-muted">Only one state recorded.</p>
              )}

              <details className="rounded-lg border border-border bg-card p-3">
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                  Provider payload
                </summary>
                {/*
                  Kept verbatim on ingest, minus card and identity data. A field
                  nobody has mapped yet is exactly what is needed when a payment
                  behaves oddly, so it stays reachable rather than discarded.
                */}
                <pre className="mt-2 max-h-72 overflow-auto text-[11px] leading-relaxed text-muted">
                  {JSON.stringify(data.raw, null, 2)}
                </pre>
              </details>
            </div>
          ) : active ? (
            <Group specs={active.specs} values={data.fields} />
          ) : null}
        </>
      )}
    </div>
  );
}
