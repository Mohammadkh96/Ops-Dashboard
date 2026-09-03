"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Info, Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { cn } from "@/lib/utils";
import {
  useAnchorFromProvider,
  useSetAnchor,
  usePspAnchors,
  type BalanceView,
} from "@/hooks/use-psps";

/**
 * An estimated provider balance, and the honesty that has to travel with it.
 *
 * WHY THIS EXISTS. Several providers will not tell us a balance. ForumPay's
 * portal shows a USD figure no documented endpoint returns; Match2Pay publishes
 * no read API at all. So somebody enters the figure once — the anchor — and it
 * is moved from there by the transactions already stored.
 *
 * WHY IT IS NEVER SHOWN AS A PLAIN NUMBER. What it moves by is the
 * transactions, and what it misses is everything else: the provider's fees,
 * conversion spread, settlements out to the bank, and anything done by hand
 * inside the portal. Each is small; they compound in one direction; nothing
 * here can see any of them. A figure captioned "Balance" is believed, and this
 * one has not earned that, so every rendering of it carries the word
 * "estimated" and the age of the anchor underneath it. That is not decoration —
 * it is the difference between a number and a claim.
 */

export function money(amount: number, currency?: string | null): string {
  const n = amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency ? `${currency} ${n}` : n;
}

/** "3 days ago", "just now" — the age is the caveat, so it is always shown. */
export function age(hours: number | null): string {
  if (hours === null) return "";
  if (hours < 1) return "under an hour ago";
  if (hours < 2) return "an hour ago";
  if (hours < 48) return `${Math.round(hours)} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** How stale an anchor is allowed to get before the screen says so. */
const STALE_HOURS = 24 * 7;

/**
 * The compact form, for a card.
 *
 * Returns null when there is nothing to say. A card that reads "— no balance"
 * is worse than one that simply has no balance line: it invites somebody to
 * treat the dash as a figure.
 */
export function BalanceLine({ balance }: { balance: BalanceView | null }) {
  if (!balance?.anchor || balance.estimate === null) return null;
  const { expectedDrift } = balance;

  // The card and the panel must not disagree. The panel's own headline is the
  // drift-corrected figure, and a card showing the uncorrected one beside it is
  // two numbers for one balance — which is the thing that sends somebody to a
  // provider's portal to find out which of our screens is lying.
  //
  // Corrected wins, when there is a correction: showing a figure we have
  // MEASURED to be ninety dollars high, while holding the measurement, is not
  // caution. It is publishing a known error.
  const corrected =
    expectedDrift && Math.abs(expectedDrift.expected) >= 0.01
      ? expectedDrift
      : null;
  const shown = corrected ? corrected.adjusted : balance.estimate;

  // Stale by what it COSTS, not by the calendar. A week was the old threshold
  // and at the rate ForumPay actually drifts it is several hundred dollars —
  // while a quiet provider is fine after a month. The data sets the line:
  // once the projected drift outgrows the largest correction ever made, the
  // correction is extrapolating and the portal is the only honest answer.
  const stale = corrected
    ? corrected.beyondExperience
    : (balance.ageHours ?? 0) > STALE_HOURS;

  return (
    <div className="flex flex-col gap-0.5">
      <span className="tnum text-lg leading-none font-semibold">
        ≈ {money(shown, balance.currency)}
      </span>
      <span
        className={cn(
          "text-[11px]",
          stale ? "text-accent-orange" : "text-muted",
        )}
      >
        {corrected ? "estimated, drift-corrected" : "estimated"} · anchored{" "}
        {age(balance.ageHours)}
      </span>
      {stale && corrected ? (
        <span className="text-[11px] text-accent-orange">
          Drifted further than we have ever measured — read the portal
        </span>
      ) : null}
      {/* Said out loud, because an estimate that cannot classify anything looks
          exactly like a balance that has not moved. */}
      {!balance.configured ? (
        <span className="text-[11px] text-accent-orange">
          No add/subtract rules — this is not moving
        </span>
      ) : null}
    </div>
  );
}

/**
 * The full panel, for the transactions page: anchor, movement, estimate.
 *
 * The three lines are shown separately on purpose. Anchor and movement are the
 * two things that were actually established; the estimate is what follows from
 * them. Collapsing them into one number is what turns this into a balance
 * somebody quotes to a provider.
 */
export function BalancePanel({
  connectionId,
  balance,
}: {
  connectionId: string;
  balance: BalanceView | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [anchorError, setAnchorError] = useState<string | null>(null);
  const fromProvider = useAnchorFromProvider();

  // `movement` as well as `balance`, and not only for tidiness: reading a
  // field off it unguarded THREW and took the whole transactions page down
  // with it — the ledger, the filters, the export, everything — because a
  // balance response arrived without one. A panel that cannot render itself
  // must disappear, not remove the page it sits on. Any deploy where the
  // browser holds a newer app than the API can produce exactly that shape.
  if (!balance?.movement) return null;
  const { anchor, movement, estimate, currency, reported, drift, expectedDrift } =
    balance;
  const stale = (balance.ageHours ?? 0) > STALE_HOURS;
  const ignored =
    movement.ignoredDirection + movement.ignoredStatus + movement.ignoredCurrency;

  return (
    <>
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card/60 px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <span className="text-[10px] font-medium tracking-wider text-muted uppercase">
            Balance
          </span>
          <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
            <Pencil className="size-3.5" />
            {anchor ? "Update from portal" : "Enter balance"}
          </Button>
        </div>

        {!anchor ? (
          <p className="text-xs text-muted">
            Nobody has entered a balance for this provider yet. Open their
            portal, read the figure, and put it in — the transactions here will
            move it from there.
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Figure
                label="Anchored"
                value={money(anchor.amount, anchor.currency)}
                note={`${anchor.takenAt.slice(0, 16).replace("T", " ")} · ${age(balance.ageHours)}`}
                noteClass={stale ? "text-accent-orange" : undefined}
              />
              <Figure
                label="Movement since"
                value={`${movement.net >= 0 ? "+" : "−"}${money(Math.abs(movement.net), currency)}`}
                valueClass={
                  movement.net >= 0 ? "text-accent-green" : "text-accent-orange"
                }
                note={`${movement.counted.toLocaleString()} transaction${movement.counted === 1 ? "" : "s"} counting`}
              />
              <Figure
                label={reported ? "We estimate" : "Estimated now"}
                value={estimate === null ? "—" : `≈ ${money(estimate, currency)}`}
                note="estimated — not read from the provider"
              />
            </div>

            {/* For a provider that will not report a balance — ForumPay's
                GetBalance returns twenty swept wallets at zero and no fiat row
                — the estimate is all there is. So the last improvement
                available is to stop ignoring that it leans: every past
                correction says by how much, per unit of money that moved.

                Beside the estimate, never inside it. The estimate is
                "this anchor plus these transactions", which is checkable by
                hand against the ledger below; folding a fitted number into it
                would end that and move a figure the desk has learned to read. */}
            {expectedDrift && Math.abs(expectedDrift.expected) >= 0.01 ? (
              <div className="flex flex-col gap-1 rounded-lg border border-border bg-card/40 px-3 py-2.5">
                <span className="text-[11px] text-muted">
                  On past form this estimate runs{" "}
                  <span className="font-medium text-accent-orange">
                    {expectedDrift.expected > 0 ? "high" : "low"} by about{" "}
                    {money(Math.abs(expectedDrift.expected), currency)}
                  </span>{" "}
                  by now — so the balance is likely nearer{" "}
                  <span className="tnum font-medium text-primary">
                    {money(expectedDrift.adjusted, currency)}
                  </span>
                  .
                </span>
                {/* The sample size travels with the number, always. Two
                    corrections is a hint; presenting it as a rate is how a
                    guess becomes a figure somebody quotes to a provider. */}
                <span className="text-[11px] text-muted">
                  {(Math.abs(expectedDrift.rate) * 100).toFixed(3)}% of what
                  moves, measured over {expectedDrift.samples} correction
                  {expectedDrift.samples === 1 ? "" : "s"} and{" "}
                  {money(expectedDrift.fittedOver, currency)} of volume
                  {expectedDrift.samples < 3
                    ? " — too few to rely on yet, but it is the direction the error has taken every time"
                    : ""}
                  . Fees, spread and portal handwork, none of which reach the
                  transactions.
                </span>
                {/* The correction has its own expiry, and it is not a date.
                    Past the largest gap ever actually measured, the rate is
                    being extrapolated beyond everything it was fitted on and
                    the corrected figure is no better founded than the raw one. */}
                {expectedDrift.beyondExperience ? (
                  <span className="flex items-start gap-1.5 text-[11px] text-accent-orange">
                    <Info className="mt-px size-3.5 shrink-0" />
                    That is further than this estimate has ever been corrected
                    by, so the figure above is extrapolating. Read the portal
                    and press Update from portal — it also gives the correction
                    another measurement, which is what makes it sharper.
                  </span>
                ) : null}
              </div>
            ) : null}

            {/* The provider's own answer, when there is one — and it is placed
                BELOW the estimate rather than beside it because it is not a
                fourth figure of the same kind. The three above are a
                derivation; this is a reading, and it settles the question the
                derivation was approximating. */}
            {reported ? (
              <div className="flex flex-col gap-2 rounded-lg border border-accent-green/25 bg-accent-green-soft/40 px-3 py-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[10px] font-medium tracking-wider text-muted uppercase">
                    The provider says
                  </span>
                  <span className="text-[11px] text-muted">
                    read {age(reported.ageHours)}
                    {reported.account ? ` · ${reported.account}` : ""}
                  </span>
                </div>
                <span className="tnum text-2xl leading-none font-semibold">
                  {money(reported.amount, reported.currency ?? currency)}
                </span>
                {/* The whole value of having both: not the reading, which is
                    just true, but the gap — which is the size of everything
                    the estimate cannot see, measured rather than argued about. */}
                {drift !== null ? (
                  <span className="text-[11px] text-muted">
                    Our estimate is{" "}
                    <span
                      className={cn(
                        "font-medium",
                        Math.abs(drift) < 0.01
                          ? "text-accent-green"
                          : "text-accent-orange",
                      )}
                    >
                      {Math.abs(drift) < 0.01
                        ? "exact"
                        : `${drift > 0 ? "over" : "under"} by ${money(Math.abs(drift), currency)}`}
                    </span>
                    {Math.abs(drift) >= 0.01
                      ? " — fees, spread and anything done by hand in the portal, none of which reach the transactions."
                      : "."}
                  </span>
                ) : null}
                <button
                  type="button"
                  disabled={fromProvider.isPending}
                  onClick={() =>
                    fromProvider.mutate(connectionId, {
                      onError: (e: unknown) =>
                        setAnchorError(
                          e instanceof Error ? e.message : String(e),
                        ),
                    })
                  }
                  className="self-start text-[11px] text-accent-blue underline underline-offset-2 disabled:opacity-50"
                >
                  {fromProvider.isPending
                    ? "Anchoring…"
                    : "Anchor to this instead of typing it"}
                </button>
                {anchorError ? (
                  <span className="text-[11px] text-accent-red">
                    {anchorError}
                  </span>
                ) : null}
              </div>
            ) : null}

            {/* The arithmetic in the open. Somebody asked to trust the estimate
                should be able to see what went into it. */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
              <span className="inline-flex items-center gap-1">
                <ArrowUp className="size-3 text-accent-green" />
                {money(movement.added, currency)} in
              </span>
              <span className="inline-flex items-center gap-1">
                <ArrowDown className="size-3 text-accent-orange" />
                {money(movement.subtracted, currency)} out
              </span>
              {/* The answer to "why is the estimate three dollars above the
                  portal": an unaccounted fee looks exactly like that, and once
                  it IS accounted for this line is where it shows up. */}
              {movement.fees > 0 ? (
                <span title="The provider's cut, included in the amount going out">
                  of which {money(movement.fees, currency)} in fees
                </span>
              ) : null}
              {ignored > 0 ? (
                <span title="Rows that no rule classified, or in another status or currency">
                  {ignored.toLocaleString()} not counted
                </span>
              ) : null}
              {movement.undated > 0 ? (
                <span className="text-accent-orange">
                  {movement.undated.toLocaleString()} with no readable date
                </span>
              ) : null}
              {/* Said out loud because these are held out by a DATE rather than
                  by a rule, so they never appear in "not counted" — and a
                  payment that settles after the anchor but was raised before it
                  used to land here and vanish. */}
              {movement.beforeAnchor > 0 ? (
                <span title="Moved before the anchor, so already inside that figure">
                  {movement.beforeAnchor.toLocaleString()} before the anchor
                </span>
              ) : null}
            </div>

            {/* A balance entered before baselines existed is still worked out
                by date, which cannot see a payment that settles after it was
                entered — the failure that kept losing payments. Re-entering
                the figure switches it over, so the screen asks. */}
            {balance.basis === "date" ? (
              <p className="flex items-start gap-1.5 text-[11px] text-accent-orange">
                <Info className="mt-px size-3.5 shrink-0" />
                This balance is still worked out by date, so a payment that
                settles after it was entered will not be counted. Press{" "}
                <span className="font-medium">Update from portal</span> once to
                fix that permanently.
              </p>
            ) : null}

            {/* The baseline was measured under different rules, so the two
                totals answer different questions and their difference is not
                movement. */}
            {balance.rulesChanged ? (
              <p className="flex items-start gap-1.5 text-[11px] text-accent-orange">
                <Info className="mt-px size-3.5 shrink-0" />
                The add/subtract rules changed after this balance was entered,
                so the movement above is not reliable. Enter the balance again
                to measure from the new rules.
              </p>
            ) : null}

            {!balance.configured ? (
              <p className="flex items-start gap-1.5 text-[11px] text-accent-orange">
                <Info className="mt-px size-3.5 shrink-0" />
                No add or subtract rules are configured, so nothing is moving
                this figure. Set them under Configure → this provider → Balance.
              </p>
            ) : null}

            {anchor.drift !== null ? (
              <p className="text-[11px] text-muted">
                Last correction: we were estimating{" "}
                <span className="tnum">
                  {money(anchor.estimateWas ?? 0, anchor.currency)}
                </span>
                , the portal said{" "}
                <span className="tnum">
                  {money(anchor.amount, anchor.currency)}
                </span>{" "}
                — off by{" "}
                <span className="tnum text-foreground">
                  {money(Math.abs(anchor.drift), anchor.currency)}
                </span>
                .
              </p>
            ) : null}
          </>
        )}
      </div>

      <AnchorDrawer
        connectionId={connectionId}
        balance={balance}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

function Figure({
  label,
  value,
  note,
  valueClass,
  noteClass,
}: {
  label: string;
  value: string;
  note: string;
  valueClass?: string;
  noteClass?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] tracking-wider text-muted uppercase">
        {label}
      </span>
      <span className={cn("tnum text-lg leading-none font-semibold", valueClass)}>
        {value}
      </span>
      <span className={cn("text-[11px] text-muted", noteClass)}>{note}</span>
    </div>
  );
}

/**
 * Entering what the portal says.
 *
 * The moment it was TRUE is settable and defaults to now, because it is not the
 * moment it gets typed in: somebody reads the portal at 14:20 and enters it at
 * 14:35, and the deposits in between would otherwise be counted twice — once
 * inside the figure they read, once as movement on top of it.
 */
function AnchorDrawer({
  connectionId,
  balance,
  open,
  onOpenChange,
}: {
  connectionId: string;
  balance: BalanceView;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const setAnchor = useSetAnchor();
  const history = usePspAnchors(open ? connectionId : null);

  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(
    balance.currency ?? balance.anchor?.currency ?? "USD",
  );
  const [takenAt, setTakenAt] = useState(localNow);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    const n = Number(amount.replace(/[, ]/g, ""));
    if (!Number.isFinite(n)) {
      setError("Enter the balance as a number.");
      return;
    }
    try {
      await setAnchor.mutateAsync({
        id: connectionId,
        amount: n,
        currency: currency.trim().toUpperCase(),
        // Typed in local time; sent as an instant, so the arithmetic does not
        // depend on which timezone the browser happens to be in.
        takenAt: new Date(takenAt).toISOString(),
        note: note.trim() || undefined,
      });
      setAmount("");
      setNote("");
      onOpenChange(false);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="Balance from the provider's portal"
      subtitle="What their screen says right now. Everything after it is estimated."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={setAnchor.isPending}>
            {setAnchor.isPending ? "Saving…" : "Save balance"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Balance">
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm tnum outline-none focus:border-border-strong"
              placeholder="61512.27"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <input
              className="w-24 rounded-lg border border-border bg-card px-3 py-2 text-sm uppercase outline-none focus:border-border-strong"
              placeholder="USD"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            />
          </div>
        </Field>

        <Field
          label="As at"
          hint="When their screen showed it — not when you typed it in. Transactions after this moment are what move the estimate."
        >
          <input
            type="datetime-local"
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-border-strong"
            value={takenAt}
            onChange={(e) => setTakenAt(e.target.value)}
          />
        </Field>

        <Field label="Note" hint="Optional — where the figure came from.">
          <input
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-border-strong"
            placeholder="ForumPay portal, Balances tab"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>

        {error ? (
          <p className="rounded-lg border border-accent-red/25 bg-accent-red-soft px-3 py-2 text-xs text-accent-red">
            {error}
          </p>
        ) : null}

        <p className="rounded-lg border border-border bg-card/60 px-3 py-2 text-[11px] text-muted">
          Between one entry and the next the figure here is an estimate. It moves
          with the transactions we hold and cannot see the provider&apos;s fees,
          conversion spread, settlements out, or anything done by hand in their
          portal — so it drifts. Entering the real figure again is what corrects
          it, and the gap is recorded below each time.
        </p>

        {/* The drift history, which is the evidence for how often this needs
            doing. Two entries a week apart that agree to the dollar mean it can
            be left alone; two that are eighty dollars apart do not. */}
        {history.data?.length ? (
          <div className="flex flex-col gap-2">
            <span className="text-[10px] font-medium tracking-wider text-muted uppercase">
              Previously entered
            </span>
            <div className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border">
              {history.data.map((a) => (
                <div key={a.id} className="flex flex-col gap-0.5 px-3 py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="tnum text-sm">
                      {money(a.amount, a.currency)}
                    </span>
                    <span className="text-[11px] text-muted">
                      {a.takenAt.slice(0, 16).replace("T", " ")}
                    </span>
                  </div>
                  <span className="text-[11px] text-muted">
                    {a.drift === null
                      ? "first entry"
                      : `estimate was off by ${money(Math.abs(a.drift), a.currency)}${a.drift > 0 ? " too high" : a.drift < 0 ? " too low" : ""}`}
                    {a.enteredBy ? ` · ${a.enteredBy}` : ""}
                  </span>
                  {a.note ? (
                    <span className="text-[11px] text-muted">{a.note}</span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Drawer>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium">{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-muted">{hint}</span> : null}
    </label>
  );
}

/** Now, in the shape a datetime-local input wants. */
function localNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
