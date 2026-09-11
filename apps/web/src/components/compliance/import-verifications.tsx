"use client";

import { useRef, useState } from "react";
import { FileUp, Info, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { parseFile } from "@/lib/recon/parse";
import {
  readVerifications,
  type DetectedColumns,
  type VerificationRow,
} from "@/lib/kyc/read-export";
import {
  useImportVerifications,
  useKycProvider,
  type KycImportResult,
} from "@/hooks/use-kyc";

/**
 * A KYC export, read here and reduced before it goes anywhere.
 *
 * WHY AN IMPORT WHEN THERE IS ALSO AN API. This was built on the finding that
 * the provider "will not enumerate" — `/applicants`, `/verifications` and
 * `/applicants/{id}/verifications` all return 404, so the index had to come
 * from the console export. That finding was wrong: the enumeration is
 * `GET /verifications/report?date=…`, and the panel above this one uses it.
 *
 * This one stays anyway, and not out of sentiment. It needs no credential at
 * all — the person doing it already has the file — it is how history from
 * before any of this was wired up gets loaded in one go, and it is what works
 * on a day the provider does not. Both paths key on the verification id, so
 * running one after the other updates rather than duplicates.
 *
 * The file is parsed in this browser and stripped to ten columns before a
 * request is made. Names, dates of birth, passport numbers, tax ids, phone
 * numbers and addresses never leave the machine the file was downloaded to.
 */
const STATUSES = [
  "APPROVED",
  "REJECTED",
  "PENDING",
  "IN_REVIEW",
  "EDD_REQUIRED",
  "NOT_STARTED",
] as const;

export function ImportVerifications() {
  /**
   * Out of the way once the provider is connected.
   *
   * With a token set, nobody should ever have to export a file again — the
   * panel above reads the same verifications directly. Leaving an upload box
   * sitting open beside it reads as though the file were still the way in.
   *
   * Folded, not deleted. It is the fallback for a day the provider is down and
   * the way a year of history is loaded in one go, and a compliance tool
   * should not lose its second route because the first one works today.
   */
  const provider = useKycProvider();
  const [open, setOpen] = useState(false);
  const secondary = provider.data?.configured === true;

  const input = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [staged, setStaged] = useState<{
    rows: VerificationRow[];
    columns: DetectedColumns;
    unusable: number;
    undated: number;
  } | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  // A 30,000-row export is thirty requests. Without this the button simply
  // sits there for a minute and the obvious conclusion is that it has hung.
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const load = useImportVerifications((done, total) => setProgress({ done, total }));
  const result: KycImportResult | undefined = load.data;

  async function onPick(file: File | undefined) {
    if (!file) return;
    setError(null);
    setStaged(null);
    setProgress(null);
    load.reset();
    setFileName(file.name);
    setReading(true);
    try {
      const ds = await parseFile(file);
      if (!ds.rows.length) {
        setError(
          `No rows could be read out of ${file.name}. If it is an Excel export, check the verifications are on the first sheet.`,
        );
        return;
      }
      const read = readVerifications(ds.rows);
      if (!read.rows.length) {
        setError(
          `None of those ${ds.rows.length} rows had a verification id. Columns found: ${ds.headers.join(", ")}.`,
        );
        return;
      }
      setStaged(read);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that file.");
    } finally {
      setReading(false);
    }
  }

  const busy = reading || load.isPending;
  const vocabulary = staged
    ? [...new Set(staged.rows.map((r) => r.status || "(blank)"))].sort()
    : [];

  // One line while the provider is connected and nothing is in progress.
  if (secondary && !open && !staged && !result) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="self-start text-[11px] text-muted underline-offset-2 hover:underline"
      >
        Import a console export instead
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card/60 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <span className="text-[10px] font-medium tracking-wider text-muted uppercase">
            Verifications from a file
          </span>
          <span className="text-[11px] text-muted">
            {secondary
              ? "Only needed to load history in one go, or on a day the provider is down — the panel above reads the same verifications directly."
              : "Export from the provider’s console and drop it here."}{" "}
            The file is read in this browser and only ids, references and
            verdicts are sent — names, documents and addresses are dropped
            first.
          </span>
        </div>
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
          {busy ? "Reading…" : "Choose export"}
        </Button>
      </div>

      {error ? <p className="text-[11px] text-accent-red">{error}</p> : null}
      {load.isError ? (
        <p className="text-[11px] text-accent-red">
          {load.error instanceof Error ? load.error.message : "Import failed."}
        </p>
      ) : null}

      {staged && !result ? (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] text-muted">
            <span className="text-muted-foreground">{fileName}</span> ·{" "}
            {staged.rows.length.toLocaleString()} verification
            {staged.rows.length === 1 ? "" : "s"} ready
            {staged.unusable
              ? `, ${staged.unusable.toLocaleString()} with no verification id skipped`
              : ""}
            {staged.undated
              ? `, ${staged.undated.toLocaleString()} with an unreadable date`
              : ""}
            .
          </p>

          {/* Which column was read as what. A file whose provider id column was
              taken for the account reference imports everything and links
              nothing, and the header that was picked is the only way to see it
              before it happens. */}
          <p className="text-[10px] leading-relaxed text-muted">
            Read as: verification “{staged.columns.verificationId ?? "—"}”,
            applicant “{staged.columns.applicantId ?? "—"}”, your reference “
            {staged.columns.externalApplicantId ?? "—"}”, status “
            {staged.columns.status ?? "—"}”, date “{staged.columns.at ?? "—"}”.
          </p>

          {!staged.columns.externalApplicantId ? (
            <p className="flex items-start gap-1.5 text-[11px] text-accent-orange">
              <Info className="mt-px size-3.5 shrink-0" />
              No account reference column was found, so nothing will be linked
              to a client. That column is the whole point of the import — check
              the export includes the external applicant id.
            </p>
          ) : null}

          {/* Discovered, never assumed. The same provider says VALID in its
              export and completed in its callbacks, so anything hard-coded is
              wrong for half its own output. */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] text-muted-foreground">
              What each of their words means here
            </span>
            <div className="flex flex-col gap-1">
              {vocabulary.map((word) => (
                <label key={word} className="flex items-center gap-2 text-[11px]">
                  <span className="tnum w-40 shrink-0 truncate text-muted">
                    {word}
                  </span>
                  <select
                    value={mapping[word] ?? ""}
                    onChange={(e) =>
                      setMapping((m) => ({ ...m, [word]: e.target.value }))
                    }
                    className="h-7 rounded-md border border-border bg-card px-2 text-[11px]"
                  >
                    <option value="">Default</option>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </div>

          <Button
            size="sm"
            className="self-start"
            disabled={busy}
            onClick={() => {
              setProgress({ done: 0, total: staged.rows.length });
              load.mutate({
                rows: staged.rows,
                mapping: Object.fromEntries(
                  Object.entries(mapping).filter(([, v]) => v),
                ),
              });
            }}
          >
            {load.isPending && progress
              ? `Importing ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}…`
              : `Import ${staged.rows.length.toLocaleString()}`}
          </Button>
        </div>
      ) : null}

      {result ? <Result result={result} /> : null}
    </div>
  );
}

function Result({ result: r }: { result: KycImportResult }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[11px] text-accent-green">
        {r.created.toLocaleString()} added, {r.updated.toLocaleString()} updated
        · {r.clientsCreated.toLocaleString()} client
        {r.clientsCreated === 1 ? "" : "s"} created,{" "}
        {r.clientsUpdated.toLocaleString()} refreshed.
      </p>
      {r.unlinked ? (
        <p className="flex items-start gap-1.5 text-[11px] text-accent-orange">
          <Info className="mt-px size-3.5 shrink-0" />
          {r.unlinked.toLocaleString()} verification
          {r.unlinked === 1 ? "" : "s"} had no account reference. They are kept
          and counted — an application abandoned before it reached an account
          still cost money and still carries a decline reason.
        </p>
      ) : null}
      {r.unusable ? (
        <p className="text-[11px] text-muted">
          {r.unusable.toLocaleString()} row{r.unusable === 1 ? "" : "s"} had no
          verification id and could not be stored.
        </p>
      ) : null}
      {r.forms.length > 1 ? (
        <p className="text-[11px] text-muted">
          Forms in this file:{" "}
          {r.forms.map((f) => `${f.form} (${f.rows.toLocaleString()})`).join(", ")}
          . Their checks are not necessarily the same.
        </p>
      ) : null}
    </div>
  );
}
