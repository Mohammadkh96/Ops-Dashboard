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
          Set <code className="font-mono">{keyStatus.data.variable}</code> in
          the API environment — generate one by running{" "}
          <code className="font-mono">
            node -e
            &quot;console.log(require(&apos;crypto&apos;).randomBytes(48).toString(&apos;base64&apos;))&quot;
          </code>{" "}
          and pasting what it prints. Provider keys are encrypted with it before
          they touch the database, so without it there is nowhere safe to put
          them.
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
        move money, whatever is configured. Keys are encrypted before storage
        and are never sent back to this screen; only their last four characters
        are, so you can confirm the right one landed.
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
                    toast({
                      kind: "success",
                      title: "Added — now configure it",
                    });
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
            // Passed in rather than looked up again: the form has to be able to
            // say "this cannot be saved" BEFORE somebody fills it in, and the
            // banner on the page behind is hidden by this very drawer.
            canStore={keyStatus.data?.configured ?? true}
            keyVariable={keyStatus.data?.variable ?? "CREDENTIALS_KEY"}
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
        : {
            Icon: TriangleAlert,
            cls: "text-accent-orange",
            word: "Never tested",
          }
    : {
        Icon: CircleSlash,
        cls: "text-muted",
        word: psp.ready ? "Off" : "Not set up",
      };

  const rows = psp.balances?.rows ?? [];
  // A crypto provider reports every wallet it can hold, and sweeps them, so
  // nineteen of twenty are zero. Showing the first two shows two zeros and
  // buries the one wallet with money in it — which is the only row anybody
  // opened this screen to see.
  const holding = rows.filter((b) => b.amount !== 0);
  const empty = rows.length - holding.length;

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
            <span className="text-[11px] text-accent-orange">
              {psp.lastError}
            </span>
          ) : null}
        </div>

        {rows.length ? (
          <div className="flex shrink-0 flex-col items-end">
            {holding.slice(0, 2).map((b, i) => (
              <span key={i} className="tnum text-sm">
                {money(b.amount)}{" "}
                <span className="text-[11px] text-muted">
                  {b.currency ?? ""}
                </span>
              </span>
            ))}
            {/* Said, not hidden. "Nothing here" and "we could not read it" look
                identical on a screen that simply shows no rows, and they are
                not the same fact at 4am. */}
            {empty ? (
              <span className="text-[10px] text-muted">
                {holding.length
                  ? `+${empty} empty`
                  : `${empty} wallet${empty === 1 ? "" : "s"}, all empty`}
              </span>
            ) : null}
            {/* The age, always. A balance with no timestamp is read as "now",
                and a six-hour-old reading is not the one you inherited. */}
            {psp.balances?.at ? (
              <span className="text-[10px] text-muted">
                {ago(psp.balances.at)}
              </span>
            ) : null}
          </div>
        ) : null}

        <span
          className={cn(
            "shrink-0 text-[10px] font-medium uppercase tracking-wider",
            state.cls,
          )}
        >
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
  canStore,
  keyVariable,
  onClose,
  onSaved,
}: {
  psp: Psp;
  canStore: boolean;
  keyVariable: string;
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
  const [currencyField, setCurrencyField] = useState(
    balance.fields?.currency ?? "",
  );
  const [accountField, setAccountField] = useState(
    balance.fields?.account ?? "",
  );
  // Written the way a URL writes them, because that is how provider
  // documentation shows them: "user=f854cc1d-…&locale=en".
  const [query, setQuery] = useState(queryToText(balance.query));
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
        query: textToQuery(query),
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
      {/* First thing in the drawer, not on the page behind it. Somebody filled
          in this whole form — including pasting a live API key — and only found
          out on Save that there was nowhere to put it. */}
      {!canStore ? (
        <div className="flex flex-col gap-1.5 rounded-lg border border-accent-orange/25 bg-accent-orange-soft px-3 py-2.5 text-xs text-accent-orange">
          <span className="font-medium">Nothing here can be saved yet.</span>
          <span>
            Provider keys are encrypted before they touch the database, and the
            key that does it is not set on this deployment. Add{" "}
            <code className="font-mono">{keyVariable}</code> to the API
            environment and redeploy, then come back — this form will work as it
            looks.
          </span>
          {/* node, not openssl: this gets run on a Windows machine as often as
              not, and PowerShell has no openssl. Whoever is deploying this
              already has node. */}
          <code className="mt-0.5 block rounded bg-elevated px-2 py-1 font-mono text-[11px] break-all text-muted-foreground">
            node -e
            &quot;console.log(require(&apos;crypto&apos;).randomBytes(48).toString(&apos;base64&apos;))&quot;
          </code>
          <span>
            The line it prints is the value. Keep it — every credential stored
            under it becomes unreadable if it changes.
          </span>
        </div>
      ) : null}

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
        {/* The length, because providers reject on it — "should be 60
            characters, but is 30" is a provider saying the wrong one of these
            two boxes was pasted, and the only other way to act on that is to
            count the characters of a live secret somewhere it must not go. */}
        <Stored what="key" length={psp.keyLength} typed={apiKey} />
        <input
          type="password"
          value={apiSecret}
          onChange={(e) => setApiSecret(e.target.value)}
          placeholder={
            psp.hasSecret
              ? "Replace the secret"
              : "API secret (if the provider uses one)"
          }
          className={field}
        />
        <Stored what="secret" length={psp.secretLength} typed={apiSecret} />

        {/* An empty box KEEPS the stored value — which is right, this form is
            reopened to change a URL far more often than a credential. But it
            left no way at all to take one back out, and "the wrong key is in
            here" is not a rare event: it is what happens the first time
            somebody pastes a credential belonging to another system. Deleting
            the whole provider to remove a key is not an answer. */}
        {psp.hasKey || psp.hasSecret ? (
          <button
            type="button"
            disabled={update.isPending}
            onClick={() => {
              setApiKey("");
              setApiSecret("");
              // Empty strings, explicitly: this is the one case that means
              // "clear it" rather than "leave it alone". Switched off with
              // them — a connection left on with no credentials would be
              // polled on a schedule and fail every time, which is a provider
              // watching us retry a bad login forever.
              save(
                { apiKey: "", apiSecret: "", enabled: false },
                "Credentials removed",
              );
            }}
            className="self-start text-[11px] text-accent-red underline underline-offset-2"
          >
            Remove the stored credentials
          </button>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <span className={label}>Balance endpoint</span>
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/v1/balances"
          className={field}
        />
        {/* Pasting the base URL again here is the obvious mistake — the field
            above wanted a URL, so this one looks like it does too. It gets
            joined onto the base, and the resulting nonsense fails as an
            unparseable URL rather than as the plain error it is. */}
        {/^https?:\/\//i.test(path.trim()) ? (
          <span className="text-[11px] text-accent-orange">
            This is joined onto the base URL, so it wants only the path —{" "}
            <code className="font-mono">/v1/balances</code>, not the whole
            address again.
          </span>
        ) : null}
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
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Query parameters, e.g. user=f854cc1d-4715-4380"
          className={field}
        />
        <span className="text-[11px] text-muted">
          Query parameters go in the last box, written as they appear in a URL —{" "}
          <code className="font-mono">a=1&amp;b=2</code>. Several providers use
          one to pick which account or brand to report on.
        </span>
        <span className="text-[11px] text-muted">
          Not sure of the paths? Press “Save and test” and read the response
          below — it shows exactly what the provider sent.
        </span>
      </div>

      {error ? (
        <p className="rounded-lg border border-accent-red/25 bg-accent-red-soft px-3 py-2 text-xs text-accent-red">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button disabled={update.isPending || !canStore} onClick={() => save()}>
          {update.isPending ? "Saving…" : canStore ? "Save" : "Cannot save yet"}
        </Button>
        {/* Saves first, always. The call is made by the SERVER from the stored
            row — it has to be, the credential never leaves it — so testing
            without saving silently tries the previous settings. Changing the
            auth mode, pressing Test, and getting the identical error back is
            the exact shape of that bug, and it reads as "my key is wrong". */}
        <Button
          variant="secondary"
          disabled={update.isPending || test.isPending || !canStore}
          onClick={() => {
            setError(null);
            setResult(null);
            update.mutate(body(), {
              onSuccess: () => {
                setApiKey("");
                setApiSecret("");
                test.mutate(psp.id, {
                  onSuccess: setResult,
                  onError: (e: unknown) =>
                    setError(e instanceof Error ? e.message : String(e)),
                });
              },
              onError: (e: unknown) =>
                setError(e instanceof Error ? e.message : String(e)),
            });
          }}
        >
          {update.isPending
            ? "Saving…"
            : test.isPending
              ? "Calling…"
              : "Save and test"}
        </Button>
        {psp.enabled ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => save({ enabled: false }, "Switched off")}
          >
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
 * A balance, at the precision it was actually reported.
 *
 * Two decimal places is right for money and wrong for crypto. 0.009989 XRP
 * rendered as "0.01" is a rounding that invents value; 0.00000001 BTC rendered
 * as "0.00" reports a wallet with something in it as empty, which is the more
 * dangerous of the two on a screen the desk uses to decide whether a provider
 * has run dry.
 */
function money(n: number): string {
  const abs = Math.abs(n);
  const digits = n === 0 ? 2 : abs < 0.01 ? 8 : abs < 1 ? 6 : 2;
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  });
}

/**
 * Query parameters, as a URL writes them.
 *
 * `user=abc&locale=en` rather than a key/value table, because that is the form
 * every provider's documentation prints them in — copying is then transcription
 * rather than translation, and there is one fewer thing to get subtly wrong.
 */
function textToQuery(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const pair of text.replace(/^[?&]+/, "").split("&")) {
    if (!pair.trim()) continue;
    const i = pair.indexOf("=");
    // A name with no value is dropped, not sent empty: "?user=" means
    // something different to some providers than sending nothing at all.
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (name && value) out[name] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function queryToText(query?: Record<string, string>): string {
  return Object.entries(query ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/**
 * How long the credential is — the stored one, or the one being typed.
 *
 * Counting characters is the only way to act on "should be 60 characters, but
 * is 30", and doing it by hand means pasting a live secret into a text editor
 * or a terminal. Shown while typing too, so a half-copied paste is visible
 * before it is saved rather than after a provider rejects it.
 */
function Stored({
  what,
  length,
  typed,
}: {
  what: string;
  length: number | null;
  typed: string;
}) {
  if (typed) {
    return (
      <span className="text-[11px] text-muted">
        {typed.length} characters typed.
      </span>
    );
  }
  if (length === null) return null;
  return (
    <span className="text-[11px] text-muted">
      Stored {what} is {length} characters.
    </span>
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
              {money(b.amount)} {b.currency ?? ""}
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
