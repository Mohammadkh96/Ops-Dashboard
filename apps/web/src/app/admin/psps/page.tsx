"use client";

import { useState } from "react";
import { CheckCircle2, CircleSlash, Plus, TriangleAlert } from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import {
  AUTH_MODES,
  useCredentialsKey,
  usePspAdmin,
  usePsps,
  type Psp,
  type TestResult,
} from "@/hooks/use-psps";

const field =
  "h-10 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-border-strong";
const label = "text-[10px] font-medium uppercase tracking-wider text-muted";

/**
 * The payment providers this dashboard talks to directly.
 *
 * Paymaxis already gives us the transactions; what it does not give us is the
 * BALANCE at each provider — which is why the Start-shift form asks somebody to
 * type it, with a note that an empty box is honest and a zero is a claim. This
 * is how that number stops being a thing a person copies at 4am.
 *
 * CONFIGURATION, NOT CODE. Every provider differs, and a hand-written client
 * each would mean a deploy to add the eighth. Everything a request needs — base
 * URL, how the key is presented, which path, where the numbers are — is a field
 * on this form, and Test Connection shows the raw reply so the field paths can
 * be found by looking rather than by guessing.
 */
export default function PspsPage() {
  const { toast } = useToast();
  const { data, isLoading, isError, error } = usePsps();
  const keyStatus = useCredentialsKey();
  const { create } = usePspAdmin();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Psp | null>(null);
  const [terminal, setTerminal] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const psps = data ?? [];
  const connected = psps.filter((p) => p.enabled && p.lastOkAt && !p.lastError);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Payment providers"
        description="Read-only connections to each PSP, for balances the desk would otherwise type by hand."
        actions={
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            Add PSP
          </Button>
        }
      />

      {/* Nothing can be saved without this, so it is said before somebody
          fills in a form and loses it. */}
      {keyStatus.data && !keyStatus.data.configured ? (
        <p className="rounded-lg border border-accent-orange/25 bg-accent-orange-soft px-3 py-2 text-xs text-accent-orange">
          <span className="font-medium">Credentials cannot be stored yet.</span>{" "}
          Set <code className="font-mono">{keyStatus.data.variable}</code> in the
          API environment — generate one with{" "}
          <code className="font-mono">openssl rand -base64 48</code>. Provider
          keys are encrypted with it before they touch the database, so without
          it there is nowhere safe to put them.
        </p>
      ) : null}

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

      {psps.length ? (
        <p className="text-xs text-muted">
          {connected.length} of {psps.length} connected.
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        {psps.map((p) => (
          <PspRow key={p.id} psp={p} onOpen={() => setEditing(p)} />
        ))}
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        Every request these make is a GET — there is no code path here that can
        move money, whatever is configured. Keys are encrypted before storage and
        are never sent back to this screen; only their last four characters are,
        so you can confirm the right one landed.
      </p>

      <Drawer
        open={adding}
        onOpenChange={setAdding}
        title="Add a provider"
        subtitle="Use the terminal name exactly as it appears on the payments"
      >
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className={label}>Terminal name</span>
            <input
              autoFocus
              value={terminal}
              onChange={(e) => setTerminal(e.target.value)}
              placeholder="Paystrax_Tradin SL"
              className={field}
            />
            <span className="text-[11px] text-muted">
              This is what joins the connection to the payment data already
              stored. A tidied-up version joins to nothing — copy it exactly,
              spaces and all.
            </span>
          </label>
          {addError ? (
            <p className="rounded-lg border border-accent-red/25 bg-accent-red-soft px-3 py-2 text-xs text-accent-red">
              {addError}
            </p>
          ) : null}
          <Button
            disabled={create.isPending || !terminal.trim()}
            onClick={() => {
              setAddError(null);
              create.mutate(
                { terminal: terminal.trim() },
                {
                  onSuccess: () => {
                    setTerminal("");
                    setAdding(false);
                    toast({ kind: "success", title: "Added — now configure it" });
                  },
                  onError: (e: unknown) =>
                    setAddError(e instanceof Error ? e.message : String(e)),
                },
              );
            }}
          >
            {create.isPending ? "Adding…" : "Add"}
          </Button>
        </div>
      </Drawer>

      <Drawer
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing?.label ?? ""}
        subtitle={editing?.terminal}
      >
        {editing ? (
          <PspForm
            psp={editing}
            onClose={() => setEditing(null)}
            onSaved={(m) => toast({ kind: "success", title: m })}
          />
        ) : null}
      </Drawer>
    </div>
  );
}

/** One provider in the list. */
function PspRow({ psp, onOpen }: { psp: Psp; onOpen: () => void }) {
  const state = psp.enabled
    ? psp.lastError
      ? { Icon: TriangleAlert, cls: "text-accent-orange", word: "Failing" }
      : psp.lastOkAt
        ? { Icon: CheckCircle2, cls: "text-accent-green", word: "Connected" }
        : { Icon: TriangleAlert, cls: "text-accent-orange", word: "Never tested" }
    : { Icon: CircleSlash, cls: "text-muted", word: psp.ready ? "Off" : "Not set up" };

  const rows = psp.balances?.rows ?? [];

  return (
    <Card className="glass card-seam">
      <CardContent className="flex flex-wrap items-center gap-4 py-3">
        <state.Icon className={cn("size-4 shrink-0", state.cls)} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{psp.terminal}</span>
          <span className="text-[11px] text-muted">
            {psp.provider}
            {psp.baseUrl ? ` · ${new URL(psp.baseUrl).host}` : " · no URL yet"}
            {psp.keyHint ? ` · key ${psp.keyHint}` : " · no key"}
          </span>
          {psp.lastError ? (
            <span className="text-[11px] text-accent-orange">{psp.lastError}</span>
          ) : null}
        </div>

        {rows.length ? (
          <div className="flex shrink-0 flex-col items-end">
            {rows.slice(0, 2).map((b, i) => (
              <span key={i} className="tnum text-sm">
                {b.amount.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}{" "}
                <span className="text-[11px] text-muted">{b.currency ?? ""}</span>
              </span>
            ))}
            {/* The age, always. A balance with no timestamp is read as "now",
                and a six-hour-old reading is not the one you inherited. */}
            {psp.balances?.at ? (
              <span className="text-[10px] text-muted">{ago(psp.balances.at)}</span>
            ) : null}
          </div>
        ) : null}

        <span className={cn("shrink-0 text-[10px] font-medium uppercase tracking-wider", state.cls)}>
          {state.word}
        </span>
        <Button variant="ghost" size="sm" onClick={onOpen}>
          Configure
        </Button>
      </CardContent>
    </Card>
  );
}

/** The configuration form for one provider. */
function PspForm({
  psp,
  onClose,
  onSaved,
}: {
  psp: Psp;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { update, remove, test } = usePspAdmin();
  const balance = psp.endpoints?.balance ?? { path: "" };

  const [baseUrl, setBaseUrl] = useState(psp.baseUrl ?? "");
  const [authMode, setAuthMode] = useState(psp.authMode);
  const [authName, setAuthName] = useState(psp.authName ?? "");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [path, setPath] = useState(balance.path ?? "");
  const [recordsPath, setRecordsPath] = useState(balance.recordsPath ?? "");
  const [amountField, setAmountField] = useState(balance.fields?.amount ?? "");
  const [currencyField, setCurrencyField] = useState(balance.fields?.currency ?? "");
  const [accountField, setAccountField] = useState(balance.fields?.account ?? "");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);

  const body = () => ({
    id: psp.id,
    baseUrl: baseUrl.trim(),
    authMode,
    authName: authName.trim(),
    // Absent, not empty: an empty string CLEARS the stored key, and this form
    // is reopened to change a URL far more often than to change a credential.
    ...(apiKey ? { apiKey } : {}),
    ...(apiSecret ? { apiSecret } : {}),
    endpoints: {
      ...psp.endpoints,
      balance: {
        path: path.trim(),
        recordsPath: recordsPath.trim() || undefined,
        fields: {
          amount: amountField.trim() || undefined,
          currency: currencyField.trim() || undefined,
          account: accountField.trim() || undefined,
        },
      },
    },
  });

  const save = (extra: Record<string, unknown> = {}, message = "Saved") => {
    setError(null);
    update.mutate(
      { ...body(), ...extra },
      {
        onSuccess: () => {
          setApiKey("");
          setApiSecret("");
          onSaved(message);
        },
        onError: (e: unknown) =>
          setError(e instanceof Error ? e.message : String(e)),
      },
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <label className="flex flex-col gap-1.5">
        <span className={label}>Base URL</span>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.provider.com"
          className={field}
        />
        <span className="text-[11px] text-muted">
          Must be https — plain http would send the API key unencrypted.
        </span>
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1.5">
          <span className={label}>Auth mode</span>
          <select
            value={authMode}
            onChange={(e) => setAuthMode(e.target.value)}
            className={`${field} cursor-pointer`}
          >
            {AUTH_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={label}>Header / parameter name</span>
          <input
            value={authName}
            onChange={(e) => setAuthName(e.target.value)}
            placeholder="X-API-KEY"
            disabled={authMode === "bearer" || authMode === "basic"}
            className={`${field} disabled:opacity-40`}
          />
        </label>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-border bg-card/40 px-3 py-2.5">
        <span className={label}>Credentials</span>
        <span className="text-[11px] text-muted">
          {psp.hasKey
            ? `A key ending ${psp.keyHint} is stored. Leave blank to keep it.`
            : "No key stored yet."}{" "}
          Encrypted before it touches the database, and never sent back here.
        </span>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={psp.hasKey ? "Replace the API key" : "API key"}
          className={field}
        />
        <input
          type="password"
          value={apiSecret}
          onChange={(e) => setApiSecret(e.target.value)}
          placeholder={
            psp.hasSecret ? "Replace the secret" : "API secret (if the provider uses one)"
          }
          className={field}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className={label}>Balance endpoint</span>
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/v1/balances"
          className={field}
        />
        <div className="grid grid-cols-2 gap-2">
          <input
            value={recordsPath}
            onChange={(e) => setRecordsPath(e.target.value)}
            placeholder="Records path, e.g. data.balances"
            className={field}
          />
          <input
            value={amountField}
            onChange={(e) => setAmountField(e.target.value)}
            placeholder="Amount field, e.g. available"
            className={field}
          />
          <input
            value={currencyField}
            onChange={(e) => setCurrencyField(e.target.value)}
            placeholder="Currency field"
            className={field}
          />
          <input
            value={accountField}
            onChange={(e) => setAccountField(e.target.value)}
            placeholder="Account field"
            className={field}
          />
        </div>
        <span className="text-[11px] text-muted">
          Not sure of the paths? Save, press Test, and read the response below —
          it shows exactly what the provider sent.
        </span>
      </div>

      {error ? (
        <p className="rounded-lg border border-accent-red/25 bg-accent-red-soft px-3 py-2 text-xs text-accent-red">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button disabled={update.isPending} onClick={() => save()}>
          {update.isPending ? "Saving…" : "Save"}
        </Button>
        <Button
          variant="secondary"
          disabled={test.isPending || !psp.ready}
          onClick={() => {
            setError(null);
            setResult(null);
            test.mutate(psp.id, {
              onSuccess: setResult,
              onError: (e: unknown) =>
                setError(e instanceof Error ? e.message : String(e)),
            });
          }}
        >
          {test.isPending ? "Calling…" : "Test connection"}
        </Button>
        {psp.enabled ? (
          <Button variant="ghost" size="sm" onClick={() => save({ enabled: false }, "Switched off")}>
            Switch off
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={!psp.ready}
            onClick={() => save({ enabled: true }, "Switched on")}
          >
            Switch on
          </Button>
        )}
      </div>

      {result ? <TestPanel result={result} /> : null}

      <div className="border-t border-border pt-4">
        <button
          type="button"
          onClick={() => {
            remove.mutate(psp.id, {
              onSuccess: () => {
                onClose();
                onSaved(`${psp.terminal} removed`);
              },
              onError: (e: unknown) =>
                setError(e instanceof Error ? e.message : String(e)),
            });
          }}
          className="text-[11px] text-accent-red underline underline-offset-2"
        >
          Remove this provider
        </button>
      </div>
    </div>
  );
}

/**
 * What the provider actually sent.
 *
 * Shown in full, deliberately. Nobody here has the provider's documentation to
 * hand, so the way the right records path and field names get found is by
 * looking at the reply — a test that only said "failed" would leave somebody
 * guessing at JSON shapes.
 */
function TestPanel({ result }: { result: TestResult }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card/40 p-3">
      <span
        className={cn(
          "text-xs font-medium",
          result.ok ? "text-accent-green" : "text-accent-red",
        )}
      >
        {result.ok
          ? `Answered in ${result.ms}ms (HTTP ${result.status})`
          : `${result.error}${result.status ? "" : " — no response"}`}
      </span>

      {result.ok && result.balances.length ? (
        <div className="flex flex-col gap-0.5">
          {result.balances.map((b, i) => (
            <span key={i} className="tnum text-sm">
              {b.account ? `${b.account}: ` : ""}
              {b.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}{" "}
              {b.currency ?? ""}
            </span>
          ))}
        </div>
      ) : null}

      {result.ok && result.note ? (
        <span className="text-[11px] text-accent-orange">{result.note}</span>
      ) : null}

      {result.body !== undefined ? (
        <>
          <span className="text-[10px] uppercase tracking-wider text-muted">
            Response
          </span>
          <pre className="max-h-64 overflow-auto rounded bg-elevated p-2 text-[11px] leading-relaxed">
            {typeof result.body === "string"
              ? result.body
              : JSON.stringify(result.body, null, 2)}
          </pre>
        </>
      ) : null}
    </div>
  );
}

/** A timestamp as "4m ago". */
function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins)) return "";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
