"use client";

import { useQuery } from "@tanstack/react-query";

import { StatusBadge } from "@/components/ui/status-badge";
import { apiFetch, isDemoMode } from "@/lib/api";
import type { Transaction } from "@/lib/modules";

export type TransactionDetail = {
  id: string;
  paymentId: string | null;
  reference: string | null;
  externalId: string | null;
  parentPaymentId: string | null;
  cryptoTxHash: string | null;
  type: string | null;
  state: string | null;
  amount: number;
  currency: string | null;
  method: string;
  description: string | null;
  customer: string | null;
  customerEmail: string | null;
  country: string | null;
  billingAddress: {
    country: string | null;
    state: string | null;
    city: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    postalCode: string | null;
  };
  entity: string | null;
  shop: string | null;
  psp: string | null;
  terminal: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  occurredAt: string | null;
  receivedAt: string;
  source: string;
  signatureOk: boolean;
  history: {
    state: string | null;
    amount: number;
    errorCode: string | null;
    errorMessage: string | null;
    at: string;
    source: string;
  }[];
  raw: Record<string, unknown>;
};

const when = (s: string | null) =>
  s ? new Date(s).toISOString().slice(0, 19).replace("T", " ") : "—";

/** Renders only the fields that have a value, so absence is visible as absence. */
function Facts({ rows }: { rows: [string, string | null | undefined][] }) {
  const present = rows.filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (!present.length) return null;
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
      {present.map(([k, v]) => (
        <div key={k} className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted">{k}</dt>
          <dd className="break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs font-medium uppercase tracking-wider text-muted">
        {title}
      </span>
      {children}
    </div>
  );
}

/**
 * Everything known about one payment.
 *
 * The drawer previously showed six fields and a three-step "timeline" whose
 * entries all carried the same timestamp — Created, Risk scored, Gateway
 * response — none of which was recorded anywhere. The real history is the set
 * of states the payment actually passed through, which the ingest stores as
 * separate rows.
 */
export function TransactionDetail({ row }: { row: Transaction }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["transaction", row.id],
    queryFn: () => apiFetch<TransactionDetail | null>(`/transactions/${row.id}`),
    enabled: !isDemoMode,
  });

  const money = (n: number, ccy: string | null) =>
    `${ccy ? `${ccy} ` : ""}${n.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between rounded-xl border border-border bg-card p-4">
        <div className="flex flex-col">
          <span className="text-xs text-muted">Amount</span>
          <span className="tnum text-xl font-semibold">
            {data ? money(data.amount, data.currency) : `${row.currency} ${row.amount}`}
          </span>
        </div>
        <StatusBadge status={row.status} />
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
          <Section title="Payment">
            <Facts
              rows={[
                ["Type", data.type],
                ["State", data.state],
                ["Method", data.method],
                ["Description", data.description],
                ["Entity", data.entity],
                ["Shop", data.shop],
              ]}
            />
          </Section>

          <Section title="References">
            <Facts
              rows={[
                ["Payment ID", data.paymentId],
                // The PSP's own id — what you quote when chasing them, and the
                // join to their settlement file.
                ["PSP reference", data.externalId],
                ["Merchant reference", data.reference],
                ["Refund of", data.parentPaymentId],
                ["On-chain hash", data.cryptoTxHash],
              ]}
            />
          </Section>

          <Section title="Customer">
            <Facts
              rows={[
                ["Reference", data.customer],
                ["Email", data.customerEmail],
                ["Country", data.billingAddress.country ?? data.country],
                ["City", data.billingAddress.city],
                ["State", data.billingAddress.state],
                ["Address", data.billingAddress.addressLine1],
                ["Address 2", data.billingAddress.addressLine2],
                ["Postal code", data.billingAddress.postalCode],
              ]}
            />
          </Section>

          <Section title="Routing">
            <Facts
              rows={[
                ["PSP", data.psp],
                ["Terminal", data.terminal],
                ["Ingested via", data.source === "poll" ? "API poll" : "Webhook"],
                ["Signature verified", data.signatureOk ? "Yes" : "No"],
              ]}
            />
          </Section>

          {data.errorCode || data.errorMessage ? (
            <Section title="Failure">
              <Facts
                rows={[
                  ["Code", data.errorCode],
                  ["Reason", data.errorMessage],
                ]}
              />
            </Section>
          ) : null}

          <Section title="History">
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
                      <span className="text-xs text-accent-red">{h.errorMessage}</span>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-xs text-muted">Only one state recorded.</p>
            )}
            <Facts
              rows={[
                ["Occurred", when(data.occurredAt)],
                ["Received", when(data.receivedAt)],
              ]}
            />
          </Section>

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
        </>
      )}
    </div>
  );
}
