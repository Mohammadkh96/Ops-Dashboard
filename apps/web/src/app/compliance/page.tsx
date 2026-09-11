"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Check, AlertTriangle, UserSearch } from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import { SyncProvider } from "@/components/compliance/sync-provider";
import { ByBrand, entityName } from "@/components/compliance/by-brand";
import { StatTileRow, type Stat } from "@/components/ui/stat-tile";
import { DataTable, type Column } from "@/components/ui/data-table";
import { FilterBar } from "@/components/ui/filter-bar";
import { StatusBadge } from "@/components/ui/status-badge";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { ClientDetail } from "@/components/payments/client-detail";
import { type KycCase } from "@/lib/modules";
import { useKycCases, useKycCaseCount } from "@/hooks/use-modules";
import { useApplicant, useKycProvider, useKycSummary } from "@/hooks/use-kyc";

const STATUS_OPTIONS: { label: string; value: KycCase["status"] }[] = [
  { label: "Pending", value: "pending" },
  { label: "In review", value: "in_review" },
  { label: "Approved", value: "approved_kyc" },
  { label: "Rejected", value: "rejected" },
  { label: "EDD required", value: "edd_required" },
];

/**
 * A RISK FILTER USED TO SIT BESIDE THE STATUS ONE and it is gone.
 *
 * It filtered on `client.riskLevel`, which nothing in this repository sets —
 * the column beside it was already showing `risk: null` on every row for the
 * same reason. A filter that silently narrows a compliance table by a field
 * nobody populates is worse than no filter at all. What replaced it filters on
 * things the provider actually returns: the entity, the period, the outcome,
 * and free text over the account reference, the country and the verification
 * id.
 */

/** How many rows one page of the table holds. */
const PAGE_SIZE = 200;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function shift(day: string, days: number): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}

/**
 * A value that stops changing while somebody is still typing.
 *
 * The filters run in the database now, so every keystroke in the search box
 * would otherwise be a query. Three hundred milliseconds is under the pause
 * between words and well over the pause between letters.
 */
function useSettled<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/**
 * Suspense because `useSearchParams` suspends during the static prerender,
 * which has no address bar to read. The entity lives in the address so that
 * one desk can be linked to, reloaded and kept open in its own tab.
 */
export default function CompliancePage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col gap-6">
          <PageHeader title="KYC" />
        </div>
      }
    >
      <Kyc />
    </Suspense>
  );
}

function Kyc() {
  const router = useRouter();
  const entity = (useSearchParams().get("entity") ?? "").toUpperCase();

  const provider = useKycProvider();
  const today = provider.data?.today ?? iso(new Date());

  /**
   * ONE PERIOD FOR THE WHOLE SCREEN.
   *
   * The cards were totals over everything ever loaded, the fetch panel carried
   * its own pair of dates, and the table had no dates at all — three answers to
   * "which period is this" on one page. They are one control now: the tiles,
   * the entity cards, the table and the provider read all describe the range
   * named here.
   *
   * Thirty days to start. Long enough to hold a month's verifications, short
   * enough that the first fetch somebody runs from this screen is thirty calls
   * to the provider rather than a year of them.
   */
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  // -29 rather than -30: the range includes both ends, so this is exactly the
  // "30 days" preset and that button reads as selected on arrival.
  const start = from ?? shift(today, -29);
  const end = to ?? today;

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<KycCase | null>(null);
  /**
   * The CU reference whose payments are open.
   *
   * `external_applicant_id` is the CRM's own account reference and it is on
   * every payment in the ledger, which is the whole reason this integration is
   * worth having: it is the one field that connects a person who was verified
   * to the money they moved. The panel is the same one the payment screens
   * use — one client history, not two that can disagree.
   */
  const [client, setClient] = useState<string | null>(null);
  /** Asked of the provider only when somebody asks for it. */
  const [showApplicant, setShowApplicant] = useState(false);

  const q = useSettled(search);
  // A filter changes what the pages ARE, so it goes back to the first one.
  // Staying on page four of a result set that no longer has four pages shows
  // an empty table, which reads as "no matches" and is not.
  const refilter = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(0);
  };

  /** Opens one entity's desk, or goes back to both. Bookmarkable either way. */
  const openEntity = (account: string) => {
    setPage(0);
    router.push(account ? `/compliance?entity=${account}` : "/compliance", {
      scroll: false,
    });
  };

  const query = { status, q, account: entity, from: start, to: end };
  const { data: kycCases, isLoading } = useKycCases({
    ...query,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  const { data: count } = useKycCaseCount(query);
  const total = count.total;

  /**
   * The tiles count the TABLE over the period shown, not the page.
   *
   * They used to count whichever rows had been fetched, so the fourth tile
   * read "500 open cases" for any database with at least five hundred
   * verifications — the page size, relabelled as a finding. It also called
   * settled verifications open, when most of them are Approved or Rejected.
   *
   * The average risk score has gone with it. Nothing computes a risk score, so
   * every row holds a zero, and a tile averaging zeroes is a number with the
   * shape of a fact and nothing behind it. Verifications held is true.
   */
  const summary = useKycSummary({ from: start, to: end, account: entity });
  const stats: Stat[] = useMemo(() => {
    const by = new Map(
      (summary.data?.byStatus ?? []).map((s) => [s.status, s.count]),
    );
    const pending = by.get("PENDING") ?? 0;
    const inReview = by.get("IN_REVIEW") ?? 0;
    const edd = by.get("EDD_REQUIRED") ?? 0;
    const held = summary.data?.verifications ?? total;
    const spent = summary.data?.spentEur ?? 0;
    const awaiting = pending + inReview + edd;
    return [
      { label: "Pending KYC", value: pending.toLocaleString(), tone: "blue", spark: [1, 2, 1, 3, 2, 2, pending] },
      { label: "In review", value: inReview.toLocaleString(), tone: "purple", spark: [3, 2, 4, 2, 3, 2, inReview] },
      {
        label: "Spend",
        value: `€${spent.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
        tone: "orange",
        delta: {
          text: edd ? `${edd.toLocaleString()} EDD required` : "in this period",
          positive: edd === 0,
        },
      },
      {
        label: "Verifications",
        value: held.toLocaleString(),
        tone: awaiting ? "orange" : "green",
        delta: {
          text: awaiting
            ? `${awaiting.toLocaleString()} awaiting a decision`
            : "none awaiting a decision",
          positive: awaiting === 0,
        },
      },
    ];
  }, [summary.data, total]);

  /**
   * The columns the provider actually gives, in place of the ones it does not.
   *
   * COUNTRY was empty on every row until the reader started mapping
   * `country_code`; RISK and RISK SCORE were a level nothing assigns and a
   * score nothing computes, printed with the confidence of a measurement; and
   * ASSIGNEE read "Unassigned" for all ten thousand rows because nothing
   * assigns them. Three columns of furniture on the one screen where an
   * invented number is least excusable.
   *
   * What replaced them is what KYCAID returns: which entity paid for the
   * check, which form ran it, whether it was a person or a database lookup,
   * where the applicant lives, who decided it, what it cost and how long it
   * took. The Entity column drops out when an entity is already open — it
   * would hold the same word on every row.
   */
  const columns: Column<KycCase>[] = [
    /* The CU reference opens that client's payments — the same panel the
       payment screens use. It is the join this whole integration exists for:
       every payment carries this reference, so "was the person who moved this
       money ever checked" is finally one click rather than two systems. */
    {
      key: "client",
      header: "Client",
      render: (c) =>
        c.client.startsWith("CU") ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setClient(c.client);
            }}
            className="font-medium underline decoration-dotted underline-offset-4 hover:text-accent-blue"
            title={`Payments for ${c.client}`}
          >
            {c.client}
          </button>
        ) : (
          <span className="text-muted">{c.client}</span>
        ),
    },
    ...(entity
      ? []
      : [
          {
            key: "account",
            header: "Entity",
            render: (c: KycCase) => (
              <span className={c.account ? "text-muted-foreground" : "text-muted"}>
                {c.account ?? "—"}
              </span>
            ),
          } as Column<KycCase>,
        ]),
    { key: "country", header: "Country", render: (c) => <span className="text-muted-foreground">{c.country}</span> },
    { key: "status", header: "Status", render: (c) => <StatusBadge status={c.status} /> },
    /* Their word beside ours, so a mapping that reads oddly can be checked
       against the console without opening a row. */
    { key: "providerStatus", header: "Provider said", render: (c) => <span className="text-muted">{c.providerStatus ?? "—"}</span> },
    /* Several at once, routinely: "Wrong name, Other, Expired document". */
    { key: "declineReasons", header: "Why", render: (c) => <span className="text-muted" title={c.declineReasons.join(", ")}>{c.declineReasons.length ? c.declineReasons.join(", ") : "—"}</span> },
    /* A client verified four times in an afternoon is the finding. */
    { key: "attempts", header: "Attempts", align: "right", render: (c) => <span className={`tnum ${c.attempts > 1 ? "text-accent-orange" : "text-muted-foreground"}`}>{c.attempts}</span> },
    /* SERVICE is a paid database lookup with no applicant — without this it
       reads as a verification that failed to link to an account. */
    { key: "service", header: "Type", render: (c) => <span className="text-muted">{c.service ?? "—"}</span> },
    { key: "form", header: "Form", render: (c) => <span className="text-muted" title={c.form ?? ""}>{c.form ?? "—"}</span> },
    /* What the approval actually covered. Six checks and three are not the
       same verification, and the two entities' forms do not run the same set —
       so this is the column that says two clients were held to different
       standards. Counted in the table, named in full in the drawer. */
    {
      key: "checks",
      header: "Checks",
      align: "right",
      render: (c) => (
        <span className="tnum text-muted" title={(c.checks ?? []).join(", ")}>
          {c.checks?.length ? c.checks.length : "—"}
        </span>
      ),
    },
    { key: "method", header: "Method", render: (c) => <span className="text-muted">{c.method ?? "—"}</span> },
    { key: "priceEur", header: "Cost", align: "right", render: (c) => <span className="tnum text-muted-foreground">{c.priceEur === null || c.priceEur === undefined ? "—" : `€${c.priceEur.toFixed(2)}`}</span> },
    { key: "processingMin", header: "Mins", align: "right", render: (c) => <span className="tnum text-muted">{c.processingMin ?? "—"}</span> },
    { key: "submittedAt", header: "Submitted", align: "right", render: (c) => <span className="tnum text-muted" title={c.submittedOn?.slice(0, 16).replace("T", " ") ?? ""}>{c.submittedAt}</span> },
  ];

  const needsDocs = selected?.status === "rejected" || selected?.status === "edd_required";

  /** The entities the API can read, for the filter beside the status one. */
  const entityOptions = (provider.data?.accounts ?? [])
    .filter((a) => a.account)
    .map((a) => ({ label: entityName(a.account), value: a.account }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={entity ? `KYC — ${entityName(entity)}` : "KYC"}
        description={
          entity
            ? `Verifications read from ${entityName(entity)}'s own KYCAID account, ${start} to ${end}.`
            : `Verifications read from KYCAID, by entity, ${start} to ${end}.`
        }
        actions={
          entity ? (
            <Button size="sm" variant="secondary" onClick={() => openEntity("")}>
              <ArrowLeft className="size-4" /> All entities
            </Button>
          ) : null
        }
      />

      {/* The period, once, at the top: everything below it describes this. */}
      <Range
        from={start}
        to={end}
        today={today}
        onFrom={refilter(setFrom)}
        onTo={refilter(setTo)}
      />

      <StatTileRow stats={stats} />

      {/* One card per entity above the fetch control: the first question is
          whether each brand is loaded, not how to load it. Clicking one opens
          that entity's desk — the table below it narrows to that account. */}
      <ByBrand from={start} to={end} selected={entity} onSelect={openEntity} />
      <SyncProvider from={start} to={end} />

      <div className="flex flex-col gap-4">
        <FilterBar
          search={search}
          onSearch={refilter(setSearch)}
          searchPlaceholder="Search account reference, country, verification id…"
          filters={[
            { label: "Status", value: status, onChange: refilter(setStatus), options: STATUS_OPTIONS },
            ...(entityOptions.length > 1
              ? [
                  {
                    label: "Entity",
                    value: entity,
                    onChange: openEntity,
                    options: entityOptions,
                  },
                ]
              : []),
          ]}
        >
          {/* The range being shown, and the real total. It used to read
              "500 of 500" for a database holding twelve thousand — the page
              size reported as a fact about the data. */}
          <span className="tnum ml-auto text-xs text-muted">
            {total === 0
              ? "0"
              : `${(page * PAGE_SIZE + 1).toLocaleString()}–${Math.min(
                  page * PAGE_SIZE + kycCases.length,
                  total,
                ).toLocaleString()} of ${total.toLocaleString()}`}
          </span>
        </FilterBar>

        {/* Filtered by the DATABASE, and no longer again in the browser. The
            second pass could only ever remove rows the first had already
            matched, and on a paged table it removed them after the count was
            taken — so the footer and the rows disagreed. */}
        <DataTable
          columns={columns}
          rows={kycCases}
          getRowKey={(c) => c.id}
          onRowClick={setSelected}
          loading={isLoading}
          empty={`No verifications in ${start} to ${end}${entity ? ` for ${entityName(entity)}` : ""} match these filters.`}
        />

        {total > PAGE_SIZE ? (
          <div className="flex items-center justify-between gap-3">
            <span className="tnum text-xs text-muted">
              Page {(page + 1).toLocaleString()} of{" "}
              {Math.ceil(total / PAGE_SIZE).toLocaleString()}
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={page === 0 || isLoading}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={(page + 1) * PAGE_SIZE >= total || isLoading}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <Drawer
        open={selected !== null}
        onOpenChange={(o) => {
          if (!o) {
            setSelected(null);
            // The applicant is read live and kept nowhere; closing the row is
            // what "gone" means, so the next open asks again deliberately.
            setShowApplicant(false);
          }
        }}
        title={selected?.client ?? ""}
        subtitle={selected ? `${selected.country} · ${selected.attempts} attempt${selected.attempts === 1 ? "" : "s"}` : ""}
        footer={
          selected ? (
            <div className="flex gap-2">
              {/* The join, as a button: this client's whole payment history,
                  in the same panel the payment screens open. */}
              <Button
                variant="secondary"
                className="flex-1"
                disabled={!selected.client.startsWith("CU")}
                onClick={() => setClient(selected.client)}
              >
                View payments
              </Button>
              {needsDocs ? (
                <Button className="flex-1">Request docs</Button>
              ) : (
                <Button className="flex-1">Approve</Button>
              )}
            </div>
          ) : null
        }
      >
        {selected ? (
          <div className="flex flex-col gap-5">
            {/* Was a risk score and a risk badge. Nothing computes either, so
                every row read 0 and Low — a measurement's confidence attached
                to no measurement. The verdict and the provider's own word for
                it are the two facts there are. */}
            <div className="flex items-center justify-between rounded-xl border border-border bg-card p-4">
              <div className="flex flex-col">
                <span className="text-xs uppercase tracking-wider text-muted">
                  {selected.account ? entityName(selected.account) : "Entity unknown"}
                </span>
                <span className="text-sm text-muted-foreground">
                  {selected.form ?? "No form recorded"}
                </span>
              </div>
              <StatusBadge status={selected.status} />
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              {[
                ["Client", selected.client],
                ["Country", selected.country],
                ["Attempts", String(selected.attempts)],
                ["Provider said", selected.providerStatus ?? "—"],
                ["Type", selected.service ?? "—"],
                ["Method", selected.method ?? "—"],
                [
                  "Cost",
                  selected.priceEur === null || selected.priceEur === undefined
                    ? "—"
                    : `€${selected.priceEur.toFixed(2)}`,
                ],
                [
                  "Processing",
                  selected.processingMin === null ||
                  selected.processingMin === undefined
                    ? "—"
                    : `${selected.processingMin} min`,
                ],
                [
                  "Submitted",
                  selected.submittedOn
                    ? selected.submittedOn.slice(0, 16).replace("T", " ")
                    : selected.submittedAt,
                ],
                /* The one field that makes this row findable in KYCAID's own
                   console, which is where somebody goes when they disagree
                   with what this screen says. */
                ["Verification id", selected.verificationId ?? "—"],
              ].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-0.5">
                  <dt className="text-xs text-muted">{k}</dt>
                  <dd className="break-all">{v}</dd>
                </div>
              ))}
            </dl>

            {/* WHICH CHECKS RAN. The provider's own list, and the honest
                version of the checklist that used to sit further down this
                drawer: that one showed Sanctions / PEP / AML / EDD derived
                from a risk level nothing computed. This is what KYCAID says
                it actually ran. */}
            {selected.checks?.length ? (
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium uppercase tracking-wider text-muted">
                  Checks run
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {selected.checks.map((check) => (
                    <span
                      key={check}
                      className="rounded-md border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground"
                    >
                      {check.replace(/_/g, " ")}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            {/* The person, from the provider, at the moment you ask. */}
            <Applicant
              caseId={selected.id}
              show={showApplicant}
              onShow={() => setShowApplicant(true)}
            />

            {/* Was a Sanctions / PEP / AML / EDD checklist derived from the
                risk level — which is to say, from nothing. On a compliance
                screen a green "Sanctions: Clear" that no screening produced is
                not decoration, it is a false assurance. The provider's real
                decline reasons take its place. */}
            <div className="flex flex-col gap-3">
              <span className="text-xs font-medium uppercase tracking-wider text-muted">
                Why the provider decided this
              </span>
              {selected.declineReasons.length ? (
                <ol className="flex flex-col gap-3 border-l border-border pl-4">
                  {selected.declineReasons.map((reason) => (
                    <li key={reason} className="relative text-sm">
                      <span className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-accent-red" />
                      <div className="flex items-center justify-between">
                        <span>{reason.replace(/_/g, " ").toLowerCase()}</span>
                        <AlertTriangle className="size-3 text-accent-red" />
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="flex items-center gap-1.5 text-sm text-muted">
                  <Check className="size-3.5 text-accent-green" />
                  No decline reason recorded.
                </p>
              )}
            </div>
          </div>
        ) : null}
      </Drawer>

      {/* One client's whole payment history, opened from their CU reference.
          The same panel the payment screens use — two panels answering the
          same question is two panels that can disagree about it. */}
      <Drawer
        open={client !== null}
        onOpenChange={(o) => !o && setClient(null)}
        title={client ?? ""}
        subtitle="Payments for this account reference"
      >
        {client ? <ClientDetail reference={client} /> : null}
      </Drawer>
    </div>
  );
}

/**
 * The applicant as the provider holds them, read on request.
 *
 * BEHIND A BUTTON, AND NOT BY ACCIDENT. This is the one call in the KYC
 * integration that returns a named person — name, date of birth, address,
 * document — and none of it is stored here. Firing it as part of opening a row
 * would mean reading the identity of every verification anybody glances at;
 * asking for it is a deliberate act, which is what it should be.
 */
function Applicant({
  caseId,
  show,
  onShow,
}: {
  caseId: string;
  show: boolean;
  onShow: () => void;
}) {
  const { data, isLoading, isError, error } = useApplicant(caseId, show);

  if (!show)
    return (
      <Button variant="secondary" size="sm" onClick={onShow}>
        <UserSearch className="size-3.5" /> Look up the applicant at KYCAID
      </Button>
    );

  if (isLoading)
    return <p className="text-sm text-muted">Asking KYCAID…</p>;

  if (isError)
    return (
      <p className="text-sm text-accent-orange">
        {error instanceof Error
          ? error.message
          : "KYCAID could not be asked about this applicant."}
      </p>
    );

  if (!data) return null;

  const a = data.applicant;
  const fields: [string, string | null][] = [
    ["Name", a.name],
    ["Date of birth", a.dob],
    ["Residence", a.residenceCountry],
    ["Citizenship", a.citizenshipCountry],
    ["Email", a.email],
    ["Phone", a.phone],
  ];

  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs font-medium uppercase tracking-wider text-muted">
        Applicant, read live from KYCAID
      </span>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        {fields
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="flex flex-col gap-0.5">
              <dt className="text-xs text-muted">{k}</dt>
              <dd className="break-all">{v}</dd>
            </div>
          ))}
      </dl>

      {a.addresses.length ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted">Address</span>
          {a.addresses.map((ad, i) => (
            <p key={i} className="text-sm">
              {[ad.street, ad.city, ad.region, ad.postalCode, ad.country]
                .filter(Boolean)
                .join(", ")}
            </p>
          ))}
        </div>
      ) : null}

      {a.documents.length ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted">Documents</span>
          {a.documents.map((d, i) => (
            <p key={i} className="text-sm">
              {[
                d.type?.replace(/_/g, " "),
                d.number,
                d.issuedCountry,
                d.expiresAt ? `expires ${d.expiresAt}` : null,
                d.status,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ))}
        </div>
      ) : null}

      {/* Said plainly, because the alternative is somebody assuming this
          dashboard holds a copy of everyone's passport. It does not. */}
      <p className="text-[11px] text-muted">
        {data.note} Document numbers are shown as their last four — KYCAID holds
        the full one.
      </p>
    </div>
  );
}

/**
 * The period every figure on this page is about.
 *
 * The presets are what gets asked for in practice, and each one is also a
 * statement about how much work the Fetch button will do: 30 days is thirty
 * calls to the provider, 12 months is three hundred and sixty-five.
 */
function Range({
  from,
  to,
  today,
  onFrom,
  onTo,
}: {
  from: string;
  to: string;
  today: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
}) {
  const presets: { label: string; days: number }[] = [
    { label: "7 days", days: 7 },
    { label: "30 days", days: 30 },
    { label: "90 days", days: 90 },
    { label: "12 months", days: 365 },
  ];
  const span =
    Math.floor(
      (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) /
        86_400_000,
    ) + 1;

  return (
    <div className="flex flex-wrap items-end justify-between gap-3 rounded-xl border border-border bg-card/60 px-4 py-3">
      <div className="flex flex-col">
        <span className="text-[10px] font-medium tracking-wider text-muted uppercase">
          Period
        </span>
        <span className="text-[11px] text-muted">
          {span.toLocaleString()} day{span === 1 ? "" : "s"} — the cards, the
          table and the fetch below all describe this range.
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        {presets.map((p) => {
          const on = span === p.days && to === today;
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => {
                onTo(today);
                onFrom(shift(today, -(p.days - 1)));
              }}
              className={`h-7 rounded-md border px-2 text-[11px] transition-colors ${
                on
                  ? "border-border-strong bg-card text-foreground"
                  : "border-border text-muted hover:border-border-strong hover:text-foreground"
              }`}
            >
              {p.label}
            </button>
          );
        })}
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-muted">From</span>
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => onFrom(e.target.value)}
            className="tnum h-7 rounded-md border border-border bg-card px-2 text-[11px]"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-muted">To</span>
          <input
            type="date"
            value={to}
            max={today}
            onChange={(e) => onTo(e.target.value)}
            className="tnum h-7 rounded-md border border-border bg-card px-2 text-[11px]"
          />
        </label>
      </div>
    </div>
  );
}
