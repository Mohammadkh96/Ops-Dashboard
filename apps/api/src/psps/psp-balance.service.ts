import { BadRequestException, Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { latestPerPayment, MAX_EVENTS } from './payment-events';
import { numericTotals } from './record-fields';

/**
 * A balance for providers that will not tell us one.
 *
 * ForumPay's portal shows a USD figure and GetBalance does not return it.
 * Asked directly, it answers with twenty swept wallets — BCH, BTC, USDT and
 * USDC across four chains — every one of them 0.00000000, and no fiat row at
 * all. ForumPay have since confirmed in as many words that NO endpoint returns
 * the fiat balance. That is recorded here so nobody investigates it a third
 * time: it is not a mapping problem and there is no path to fix it.
 *
 * Match2Pay publishes exactly two endpoints and both of them CREATE money
 * movements; there is no read API for anyone. So for these terminals there is
 * nothing to fetch, and the only figure available is the one a person reads off
 * the portal.
 *
 * WHAT THIS IS, SAID PLAINLY. Somebody enters the true figure once — that is
 * the ANCHOR — and it is then MOVED by the transactions already stored here.
 * The result is an ESTIMATE. It is labelled as one everywhere it appears, and
 * it is never presented as a reading, because it is not one.
 *
 * WHAT IT WILL MISS, and therefore why it drifts:
 *   • the provider's processing fees, deducted on their side
 *   • crypto-to-fiat conversion spread
 *   • settlements out to the bank
 *   • anything done by hand inside the portal
 *
 * Each is small. They compound, in one direction, and nothing here can see any
 * of them. That is why re-anchoring keeps the estimate it replaced and the gap
 * between the two: the drift is recorded rather than quietly corrected, so the
 * desk can see how wrong a week of estimating gets and decide how often the
 * portal actually needs opening. A balance that silently repairs itself teaches
 * nobody anything, and this one is believed precisely because it says "balance".
 */

/** Which of the provider's own words move the balance, and which way. */
export type MovementRules = {
  /**
   * The currency the balance is kept in. Rows in any other currency are not
   * converted — they are excluded and counted, because a made-up FX rate is a
   * worse answer than a visible gap.
   */
  currency?: string;
  /** Direction values that increase the balance: "Sell", "DEPOSIT"… */
  add?: string[];
  /** Direction values that decrease it: "Buy", "WITHDRAWAL", "REFUND"… */
  subtract?: string[];
  /**
   * Statuses that count at all. Empty means every status counts, which is
   * almost never what anyone wants — a pending deposit is not money yet.
   */
  statuses?: string[];
  /**
   * The provider already put the sign in the amount.
   *
   * BEEM's wallet export does: PAYMENT_IN is +35,939.59 and PAYMENT_OUT is
   * −11,609.15, and the signed total reconciles to their Running Balance
   * column to the last decimal place. Subtracting a row that is ALREADY
   * negative adds it back — so a ledger like that, configured the ordinary
   * way, moves the balance by twice the outflows in the wrong direction and
   * looks entirely reasonable while doing it.
   *
   * When this is set, add and subtract mean only "counts"; the direction comes
   * from the data. The in/out figures on screen are still split by sign, so
   * they read the same either way.
   */
  signed?: boolean;
  /**
   * What the provider takes, as a percentage, when it never tells us per
   * payment.
   *
   * ForumPay does not. It reports no fiat fee on a transaction and publishes no
   * balance, so for a month the estimate simply ran high — and it ran high in a
   * shape that turned out to be exactly solvable. Two corrections against the
   * portal, over windows whose inflow share differed by nearly a factor of two:
   *
   *   0.70% x 10,177.71 in + 0.20% x  9,081.86 out =  89.41   (portal said 89.40)
   *   0.70% x 15,623.18 in + 0.20% x 39,372.14 out = 188.11   (portal said 188.08)
   *
   * Two equations in two unknowns always fit, so the fit alone is worth
   * nothing. What makes it real is that the payout rate landed on 0.1999% and
   * ForumPay had been separately observed charging 3.14 on a 1,570.45 payout —
   * 0.1999% — a number that was not used to derive it. A coincidence would not
   * survive that, nor the mix moving from 53% inbound to 28%.
   *
   * SEPARATE RATES, not one rate on volume, because they are not one charge. A
   * provider prices taking money in and sending money out differently, and a
   * single blended rate fitted to one week's mix is wrong the moment the mix
   * changes — which is precisely what a heavy payout day is.
   *
   * A MODEL, and labelled one everywhere it shows. It is not a reading, and it
   * stops being true the day the provider changes its pricing; the drift
   * recorded at every re-anchor is what says so.
   */
  feeRateIn?: number;
  feeRateOut?: number;
};

/** One anchor, as the API reports it. */
export type Anchor = {
  id: string;
  amount: number;
  currency: string;
  takenAt: string;
  enteredAt: string;
  enteredBy: string | null;
  note: string | null;
  /** What was on screen the instant before this replaced it, and the gap. */
  estimateWas: number | null;
  drift: number | null;
  /**
   * What was already counting when this balance was entered, and under which
   * rules. Null on anchors entered before this existed — those fall back to
   * the date window until somebody re-enters the balance.
   */
  baselineIn: number | null;
  baselineOut: number | null;
  /** How much of baselineOut was the provider's cut. Display only. */
  baselineFees: number | null;
  baselineRules: MovementRules | null;
  /**
   * Which field the fee was read from when this baseline was measured.
   *
   * Null on anchors taken before this was recorded, which is treated as
   * "cannot say" rather than "none" — see feeMappingChanged.
   */
  baselineFeePath: string | null;
};

export type BalanceView = {
  connectionId: string;
  /** The last figure a person entered, or null if nobody has. */
  anchor: Anchor | null;
  /** The rules in force, normalised. Null when nothing is configured. */
  rules: MovementRules | null;
  /** Anchor plus movement. Null without an anchor — there is nothing to move. */
  estimate: number | null;
  currency: string | null;
  movement: {
    /** Signed, in the balance currency. */
    net: number;
    added: number;
    subtracted: number;
    /** Of `subtracted`, how much was the provider's cut rather than payments. */
    fees: number;
    /** How many rows went each way, and how many were left out and why. */
    counted: number;
    ignoredDirection: number;
    ignoredStatus: number;
    ignoredCurrency: number;
    /** Rows whose timestamp we could not read, so cannot place against the anchor. */
    undated: number;
    /**
     * Rows that moved BEFORE the anchor, and are therefore already inside the
     * figure somebody read off the portal.
     *
     * Reported because it used to be invisible. A payment excluded here is
     * excluded by a date comparison rather than by a rule, so it never reached
     * the "not counted" tally either — it simply was not in the query. When a
     * payment goes missing from a balance this is the first number to look at.
     */
    beforeAnchor: number;
  };
  /**
   * Whether the rules can actually classify what this terminal sends. False
   * when nothing is configured, which is the difference between "the balance
   * has not moved" and "nothing here knows how to move it".
   */
  configured: boolean;
  /** Hours since the anchor was true. The age is the caveat. */
  ageHours: number | null;
  /**
   * How the movement was worked out.
   *
   * "baseline" — the difference between what counts now and what counted when
   * the balance was entered. Exact, and the only one that catches a payment
   * that settles late or is later reversed.
   *
   * "date" — everything that moved after the anchor, which is what anchors
   * entered before baselines existed fall back to. It cannot see a late
   * settlement on a provider that reports only one timestamp.
   */
  basis: 'baseline' | 'date';
  /**
   * The rules changed after the baseline was measured, so the two totals
   * answer different questions and their difference means nothing.
   */
  rulesChanged: boolean;
  /**
   * The FEE MAPPING changed after the baseline was measured.
   *
   * Its own flag rather than a case of rulesChanged, because it is a different
   * kind of change with a much nastier failure. The movement's fee is
   * `now.fees - baselineFees`; map a fee field on a terminal whose anchor was
   * taken before that mapping existed and the baseline holds zero while "now"
   * holds every fee in the stored history. A month of them then comes off a
   * twenty-hour movement — roughly a thousand dollars, in the right direction
   * to look like a correction, with no warning at all, because the like-for-
   * like check compares add/subtract/status words and a fee mapping is none of
   * those.
   *
   * When this is true the fee is held OUT of the arithmetic entirely rather
   * than half-applied, and the screen asks for a fresh balance — after which
   * the two totals are measured the same way and the fee starts counting
   * properly.
   */
  feeMappingChanged: boolean;
  /**
   * What the PROVIDER says the balance is, when the provider can be asked.
   *
   * This is not another input to the estimate. It is the answer, and the
   * estimate is the thing that was standing in for it.
   *
   * Whether any given provider supplies one is a question of fact, not of
   * configuration effort, and the note at the top of this file records what was
   * found the last time it was asked: Match2Pay publishes no read API at all,
   * and ForumPay's GetBalance returned swept crypto wallets rather than the USD
   * figure its portal shows. If that is still true for a terminal, this stays
   * null and the estimate remains the only thing available — which is why the
   * estimate is not being removed.
   *
   * But it is the question worth re-asking whenever a balance drifts, because
   * the drift is unbounded and a reading is not: BEEM's /ledger/v1/wallets is
   * exactly this, and a currency-denominated wallet on any provider would end
   * the estimating for that terminal entirely.
   *
   * Null, too, when the last attempt to read failed. A stale reading is still
   * returned WITH its age, because "the provider said this six hours ago" is a
   * fact worth having and hiding it leaves only the estimate.
   */
  reported: {
    amount: number;
    currency: string | null;
    /** Which wallet or sub-account, where a provider reports several. */
    account: string | null;
    /** When we read it, not when the provider computed it. */
    at: string;
    ageHours: number;
  } | null;
  /**
   * Estimate minus reported: how far out we were, signed.
   *
   * Positive means the estimate claimed MORE than the provider holds, which is
   * the direction an unrecorded deduction pushes it and the one worth noticing.
   * Null unless both numbers exist and are in the same currency — a drift
   * between USD and EUR is not a number.
   */
  drift: number | null;
  /**
   * What past corrections say this estimate is probably out by.
   *
   * The remaining answer for a provider that will not report a balance — which,
   * having now been asked, is what ForumPay is: its GetBalance returns twenty
   * swept wallets at 0.00000000 and no fiat row at all. There is nothing to
   * read, so the estimate is all there is, and the only improvement left is to
   * stop ignoring that it is known to lean one way.
   *
   * Kept SEPARATE from `estimate`, deliberately. The estimate is a stated
   * derivation — this anchor, plus these transactions, nothing else — and that
   * is exactly what makes it checkable by hand against the ledger underneath
   * it. Folding a fitted correction into it would make it uncheckable and would
   * quietly move a number the desk has learned to read. So it is offered
   * beside, with its sample size attached, and a person decides.
   *
   * Null until two anchors have been taken under the same rules: there is no
   * error to measure before an estimate has been corrected at least once.
   */
  expectedDrift: {
    /** Intervals behind the rate. Two is a hint, not a rate. */
    samples: number;
    /**
     * Which quantity the drift is projected from.
     *
     * "volume" — a charge on what moved, so a rate on throughput projects it.
     * "time"   — a balance that moves on its own, where throughput is nearly
     *            irrelevant and hours are what accumulate.
     */
    basis: 'volume' | 'time';
    /** Fraction of gross volume. Positive = the estimate runs high. */
    rate: number;
    /** Drift per day, which is the readable form when the basis is time. */
    perDay: number;
    /** Hours the fit spans. */
    fittedOverHours: number;
    /** Volume the rate was fitted over — the weight to put on it. */
    fittedOver: number;
    /** rate × the volume since this anchor, in the balance currency. */
    expected: number;
    /** The estimate with that taken off. */
    adjusted: number;
    /**
     * Whether this drift behaves like a charge on what moved at all.
     *
     * The question ForumPay and Match2Pay answer differently, and the reason
     * one recipe must not be carried to the other. ForumPay's gap is 0.3-0.5%
     * of volume across windows whose mix swung by a factor of two — a fee, and
     * a solvable one. Match2Pay's most recent gap is USD 23.35 against USD
     * 426.66 of volume, which is 5.5%: no payment provider charges that, and
     * the same terminal drifted only USD 2.50 the window before. A number that
     * does not scale with volume is not a rate, and projecting it as one would
     * be worst exactly when the desk is quietest.
     *
     * What it IS, for a provider whose balance is a valuation of crypto
     * holdings rather than a fiat ledger, is the market moving. Nothing in a
     * transaction list can see that, and no percentage of throughput models it.
     */
    looksLikeFee: boolean;
    /**
     * The projected drift has outgrown the largest correction ever measured.
     *
     * Past this point the rate is being extrapolated beyond everything it was
     * fitted on, so the corrected figure is no better founded than the
     * uncorrected one and the honest move is to go and read the portal. The
     * threshold comes from the data rather than from a constant somebody chose,
     * which matters because the right staleness for a provider doing twenty
     * thousand a day is not the right one for a provider doing two hundred.
     */
    beyondExperience: boolean;
  } | null;
};

/** A balance reading stored on the connection by the last successful test. */
type StoredBalances = {
  at?: string;
  rows?: {
    account?: string | null;
    currency?: string | null;
    amount?: number;
  }[];
};

/**
 * The provider's own figure for this balance, out of the last reading.
 *
 * Picked by currency rather than taken as the first row, because a provider
 * with several wallets returns several rows and the first one is not
 * necessarily the one this terminal's balance is denominated in. When nothing
 * matches, nothing is returned: a balance in the wrong currency shown as this
 * balance is worse than no balance at all.
 */
export function pickReported(
  stored: unknown,
  currency: string | null,
): {
  amount: number;
  currency: string | null;
  account: string | null;
  at: string;
} | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored))
    return null;
  const { at, rows } = stored as StoredBalances;
  if (!at || !Array.isArray(rows) || !rows.length) return null;

  const usable = rows.filter(
    (
      r,
    ): r is {
      account?: string | null;
      currency?: string | null;
      amount: number;
    } => typeof r?.amount === 'number' && Number.isFinite(r.amount),
  );
  if (!usable.length) return null;

  const want = (currency ?? '').trim().toUpperCase();
  const matching = want
    ? usable.filter((r) => (r.currency ?? '').trim().toUpperCase() === want)
    : usable;

  // Several wallets in the same currency is a total, not a choice — a provider
  // holding USD in two places holds the sum of them.
  if (!matching.length) return null;
  const amount = round(matching.reduce((sum, r) => sum + r.amount, 0));

  return {
    amount,
    currency: matching[0].currency?.trim().toUpperCase() ?? (want || null),
    account: matching.length === 1 ? (matching[0].account ?? null) : null,
    at,
  };
}

/** Case-insensitive membership, because "Sell" and "sell" are one word. */
function has(list: string[] | undefined, value: string | null): boolean {
  if (!list?.length || value === null) return false;
  const v = value.trim().toLowerCase();
  return list.some((x) => x.trim().toLowerCase() === v);
}

/**
 * A percentage, as a person would type one: 0.7 means 0.7%.
 *
 * Bounded at 100 and at zero. A negative fee is a rebate nobody has, and a
 * fee over 100% is a typo — most likely 0.7 entered as a fraction and then
 * multiplied, or a decimal point in the wrong place. Either would quietly
 * remove the whole balance, so neither is accepted.
 */
function rate(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return undefined;
  return n;
}

/** Whatever was stored, read as rules. Nothing here trusts the JSON's shape. */
export function readRules(value: unknown): MovementRules | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const words = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.map((x) => String(x).trim()).filter((x) => x !== '')
      : [];
  const rules: MovementRules = {
    currency:
      typeof r.currency === 'string' && r.currency.trim()
        ? r.currency.trim().toUpperCase()
        : undefined,
    add: words(r.add),
    subtract: words(r.subtract),
    statuses: words(r.statuses),
    signed: r.signed === true,
    feeRateIn: rate(r.feeRateIn),
    feeRateOut: rate(r.feeRateOut),
  };
  const empty =
    !rules.currency &&
    !rules.add?.length &&
    !rules.subtract?.length &&
    !rules.statuses?.length &&
    rules.feeRateIn === undefined &&
    rules.feeRateOut === undefined;
  return empty ? null : rules;
}

/**
 * Whether two sets of rules ask the same question.
 *
 * A baseline is a total measured under particular rules. Change which words
 * count and the current total measures something else, so the difference
 * between them is not movement — it is the gap between two different
 * questions. Compared as sorted, lower-cased word lists, because the order
 * they were ticked in is not part of the meaning.
 */
export function sameRules(
  a: MovementRules | null,
  b: MovementRules | null,
): boolean {
  const norm = (r: MovementRules | null) =>
    JSON.stringify({
      feeRateIn: r?.feeRateIn ?? null,
      feeRateOut: r?.feeRateOut ?? null,
      currency: r?.currency ?? null,
      add: [...(r?.add ?? [])].map((w) => w.toLowerCase()).sort(),
      subtract: [...(r?.subtract ?? [])].map((w) => w.toLowerCase()).sort(),
      statuses: [...(r?.statuses ?? [])].map((w) => w.toLowerCase()).sort(),
      signed: r?.signed === true,
    });
  return norm(a) === norm(b);
}

/** Decimal | Float | null, as a number. Prisma returns all three from here. */
function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Two decimal places, so a sum of eight-place decimals stops wobbling. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * One group of transactions: the provider's two words, and the totals.
 *
 * Grouped in the database rather than paged through here — a terminal with
 * thirty thousand rows must not be loaded into memory to add up a column, and
 * the number of distinct (direction, status, currency) triples a provider
 * emits is a couple of dozen at the outside.
 */
type Group = {
  direction: string | null;
  status: string | null;
  currency: string | null;
  sum: number;
  /** The provider's cut on these, where it reports one. Always a deduction. */
  fees: number;
  count: number;
};

/** What a set of transactions comes to, once the rules have been applied. */
type Totals = {
  in: number;
  out: number;
  /** How much of `out` was the provider's cut rather than a payment. */
  fees: number;
  counted: number;
  ignoredDirection: number;
  ignoredStatus: number;
  ignoredCurrency: number;
};

/**
 * Which field a connection currently reads the fee from, or null for none.
 *
 * Deliberately tolerant: `endpoints` is a JSON column typed as unknown, and a
 * connection with no transactions endpoint, no fields, or no fee among them all
 * mean the same thing here — nothing is being read.
 */
/**
 * How the fee is being arrived at, as one comparable string.
 *
 * Covers both ways it can be: a field mapped on the endpoint, and a modelled
 * percentage in the rules. Either changing makes a stored baseline's fee total
 * incomparable with the current one, and the failure is identical — a whole
 * history of fees subtracted from one day of movement. One signature catches
 * both, and the anchor stores it.
 */
/**
 * Which authority decides the fee for a connection.
 *
 * From the CONFIGURATION, never from the data. Inferring it from the data was
 * tried twice and is wrong both ways round: per group it lets one payment with
 * a reported fee suppress the model for everything grouped with it, and per
 * reading it flips the meaning of a balance the first time a provider happens
 * to report one fee.
 *
 * Reported is the default and the fallback, because a provider that states its
 * own cut is the authority on it. Percentages are used only when they are set
 * AND no field is mapped — configuring both is a contradiction, and resolving
 * it toward the provider's own figure is the safe direction: at worst a
 * modelled charge goes uncounted, where the other way round charges the same
 * payment twice.
 */
export function feeModeOf(
  endpoints: unknown,
  rules: MovementRules | null,
): FeeMode {
  if (feePathOf(endpoints)) return 'reported';
  return rules?.feeRateIn || rules?.feeRateOut ? 'modelled' : 'reported';
}

export function feeSignature(
  endpoints: unknown,
  rules: MovementRules | null,
): string | null {
  const parts = [
    feePathOf(endpoints) ?? '',
    rules?.feeRateIn ? String(rules.feeRateIn) : '',
    rules?.feeRateOut ? String(rules.feeRateOut) : '',
  ];
  return parts.some(Boolean) ? parts.join('|') : null;
}

export function feePathOf(endpoints: unknown): string | null {
  if (!endpoints || typeof endpoints !== 'object') return null;
  const txn = (endpoints as Record<string, unknown>).transactions;
  if (!txn || typeof txn !== 'object') return null;
  const fields = (txn as Record<string, unknown>).fields;
  if (!fields || typeof fields !== 'object') return null;
  const fee = (fields as Record<string, unknown>).fee;
  const t = typeof fee === 'string' ? fee.trim() : '';
  return t || null;
}

/**
 * What the provider takes on this group, when it never says.
 *
 * Applied to the AMOUNT, not to the net, and by direction: a deposit is charged
 * the inbound rate and a payout the outbound one. Those are different numbers
 * on every provider that has been looked at, and a single blended rate fitted
 * to one week is wrong as soon as the mix changes — which a heavy payout day
 * is, by definition.
 *
 * Magnitudes throughout. A signed ledger reports an outflow as a negative and
 * a percentage of a negative is a credit, which would turn a charge into a gain
 * on exactly the rows that cost the most.
 */
function modelFee(g: Group, rules: MovementRules | null): number {
  const inRate = rules?.feeRateIn ?? 0;
  const outRate = rules?.feeRateOut ?? 0;
  if (!inRate && !outRate) return 0;

  const amount = Math.abs(g.sum);
  if (!amount) return 0;

  // Which side this group sits on. With signed amounts the data decides;
  // otherwise the word does.
  const inbound = rules?.signed ? g.sum >= 0 : has(rules?.add, g.direction);

  return (amount * (inbound ? inRate : outRate)) / 100;
}

/**
 * The rules, applied to a set of grouped transactions.
 *
 * One function, used twice: over everything counting NOW, and over everything
 * that was counting when the balance was entered. Movement is the difference.
 * Using the same code for both is the point — two totals computed by two
 * routines would differ for reasons nobody could find.
 */
/**
 * How the fee is arrived at for one reading.
 *
 * "reported"  — the provider tells us, per payment, and is the authority on it.
 * "modelled"  — it does not, so the configured percentages stand in.
 * "none"      — the two sides of the subtraction disagree about which of those
 *               was in force, so no fee may be claimed at all until a fresh
 *               balance is entered.
 *
 * An explicit mode rather than something inferred from the data, because the
 * first attempt DID infer it — per group, skipping the model wherever a
 * reported fee was present — and a group is an aggregate of many rows. One
 * payment carrying a reported fee then suppressed the model for every other
 * payment grouped with it, quietly removing most of the charge.
 */
export type FeeMode = 'reported' | 'modelled' | 'none';

function applyRules(
  groups: Group[],
  rules: MovementRules | null,
  currency: string | null,
  feeMode: FeeMode = 'modelled',
): Totals {
  const t: Totals = {
    in: 0,
    out: 0,
    fees: 0,
    counted: 0,
    ignoredDirection: 0,
    ignoredStatus: 0,
    ignoredCurrency: 0,
  };
  for (const g of groups) {
    // Order matters, because each row is excluded for exactly one reason and
    // the reason is what the screen shows. Currency first: a EUR row under a
    // USD anchor is not "an unknown direction", and saying so would send
    // somebody off to configure a rule that would not have helped.
    if (currency && (g.currency ?? '').toUpperCase() !== currency) {
      t.ignoredCurrency += g.count;
    } else if (rules?.statuses?.length && !has(rules.statuses, g.status)) {
      t.ignoredStatus += g.count;
    } else if (
      has(rules?.add, g.direction) ||
      has(rules?.subtract, g.direction)
    ) {
      t.counted += g.count;
      // A fee leaves the balance whichever way the payment went — the provider
      // charges for taking a deposit and for sending a payout alike — so it is
      // an outflow regardless of direction, never netted against the amount.
      //
      const fee =
        feeMode === 'reported'
          ? g.fees
          : feeMode === 'modelled'
            ? modelFee(g, rules)
            : 0;
      t.fees += fee;
      t.out += fee;
      if (rules?.signed) {
        // The provider already put the sign in the amount, so which list the
        // word sits in decides only WHETHER it counts. Split by sign for the
        // in/out figures, so the screen reads the same as it does for a
        // provider that reports magnitudes.
        if (g.sum >= 0) t.in += g.sum;
        else t.out += -g.sum;
      } else if (has(rules?.add, g.direction)) {
        t.in += g.sum;
      } else {
        t.out += g.sum;
      }
    } else {
      t.ignoredDirection += g.count;
    }
  }
  return t;
}

/**
 * How wrong this method has been, per unit of money that moved.
 *
 * The estimate misses fees, spread, settlements out and portal handwork. Every
 * one of those is a deduction, so the error has a SIGN: over twenty hours it
 * ran USD 89.40 above ForumPay's portal, and over the interval before that,
 * 352.20 above. A bias that always points the same way is not noise to be
 * tolerated — it is a measurable quantity that nobody was measuring, sitting in
 * the drift column of every anchor ever entered.
 *
 * THE MEASUREMENT. Each anchor records the drift against the estimate it
 * replaced, and the cumulative in/out totals at the moment it was taken. The
 * difference between two consecutive anchors' totals is exactly the volume that
 * flowed between them, so `drift ÷ volume` is the rate at which this method
 * loses money, expressed in the only unit that projects forward.
 *
 * POOLED, not averaged. Total drift over total volume, so a fortnight of
 * trading counts for more than an afternoon of it. Averaging the per-interval
 * rates would let one quiet day with a rounding error in it outvote everything.
 *
 * WHAT IS THROWN AWAY, and why each has to be:
 *   • an interval whose anchors were measured under different rules — the
 *     volumes are then counts of different things and their difference is not
 *     a volume
 *   • an anchor with no baseline, from before baselines existed, which has no
 *     volume to attribute its drift to
 *   • a zero or negative volume, which is not an interval anything flowed in
 *
 * WHAT THIS IS NOT. It is not a fee schedule and does not pretend to be one; a
 * provider that changes its pricing invalidates it, and so does a manual
 * withdrawal to the bank, which is a deduction with no volume behind it at all.
 * It is a correction fitted to past error, and it is only ever shown WITH the
 * number of intervals behind it — two corrections is a hint, not a rate.
 */
export function fitDrift(anchors: Anchor[]): {
  /** Anchor-to-anchor intervals the rate was fitted over. */
  samples: number;
  /** Drift as a fraction of gross volume. Positive = we run high. */
  rate: number;
  /** The volume behind the fit — the weight to put on it. */
  volume: number;
  /** Total drift observed across those intervals. */
  drift: number;
  /** Hours the fit spans, so a drift driven by time rather than volume can be
   * expressed in the unit that actually drives it. */
  hours: number;
  /** Drift per hour. Meaningful when a balance moves without transactions. */
  perHour: number;
  /**
   * The biggest single correction ever actually made, as a magnitude.
   *
   * The edge of experience. A projected drift larger than this is the rate
   * being extrapolated past everything it was fitted on, and that is the point
   * at which somebody should open the portal rather than trust the correction —
   * a threshold the data supplies, rather than a number invented here.
   */
  largest: number;
} | null {
  let totalDrift = 0;
  let totalVolume = 0;
  let samples = 0;
  let largest = 0;
  let totalHours = 0;

  // Newest first, so each anchor pairs with the one after it in the array.
  for (let i = 0; i + 1 < anchors.length; i++) {
    const curr = anchors[i];
    const prev = anchors[i + 1];
    if (curr.drift === null) continue;
    if (curr.baselineIn === null || curr.baselineOut === null) continue;
    if (prev.baselineIn === null || prev.baselineOut === null) continue;
    if (!sameRules(curr.baselineRules, prev.baselineRules)) continue;

    const volume =
      curr.baselineIn - prev.baselineIn + (curr.baselineOut - prev.baselineOut);
    if (!(volume > 0)) continue;

    const hours =
      (new Date(curr.takenAt).getTime() - new Date(prev.takenAt).getTime()) /
      3_600_000;
    if (!(hours > 0)) continue;

    totalDrift += curr.drift;
    totalVolume += volume;
    totalHours += hours;
    largest = Math.max(largest, Math.abs(curr.drift));
    samples++;
  }

  if (!samples || totalVolume <= 0 || totalHours <= 0) return null;
  return {
    samples,
    rate: totalDrift / totalVolume,
    volume: round(totalVolume),
    hours: totalHours,
    perHour: totalDrift / totalHours,
    drift: round(totalDrift),
    largest: round(largest),
  };
}

/**
 * How many past anchors the drift rate is fitted over.
 *
 * Bounded because the rate is a claim about how this provider behaves NOW. A
 * correction from six months ago is evidence about a fee schedule that may not
 * exist any more, and letting it in makes the rate slower to notice a change
 * than the desk is.
 */
const DRIFT_WINDOW = 12;

/**
 * The most a drift can be, as a share of what moved, and still be a fee.
 *
 * Two percent is far above any payment provider's cut — ForumPay's is 0.7% and
 * 0.2% — and far below what a drift looks like when it is driven by something
 * other than throughput. It exists to separate those two cases, not to shave
 * the boundary: a gap of 5.5% of volume, as Match2Pay showed on a quiet
 * weekend, is a different phenomenon rather than an expensive provider.
 */
const MAX_FEE_RATE = 0.02;

@Injectable()
export class PspBalanceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The balance for one connection.
   *
   * Reading, so a plain session — see the note on the controller. Entering an
   * anchor is desk work too: it is somebody typing in what the portal says,
   * which is the same act as reading a ledger, not an act of configuration.
   */
  async balance(connectionId: string): Promise<BalanceView> {
    const conn = await this.prisma.pspConnection.findUnique({
      where: { id: connectionId },
      select: {
        id: true,
        terminal: true,
        ledgerSource: true,
        movementRules: true,
        // The provider's own last answer, which beats anything derived from
        // transactions when it exists.
        balances: true,
        lastError: true,
        // Only to read which field the fee comes from — a change there makes a
        // stored baseline's fee total incomparable. See feeMappingChanged.
        endpoints: true,
      },
    });
    if (!conn) throw new BadRequestException('No such PSP connection.');

    // A history, not just the latest. The one before last is what makes the
    // last one's drift measurable — see fitDrift. Bounded because the rate is
    // about how this provider behaves NOW, and a correction from six months ago
    // is evidence about a fee schedule that may no longer exist.
    const anchorRows = await this.prisma.pspBalanceAnchor.findMany({
      where: { connectionId },
      orderBy: { takenAt: 'desc' },
      take: DRIFT_WINDOW,
    });

    const rules = readRules(conn.movementRules);
    const history = anchorRows.map(toAnchor);
    return this.view(conn, history[0] ?? null, rules, history);
  }

  /** The same figure for every connection at once, for the dashboard. */
  async balances(): Promise<BalanceView[]> {
    const conns = await this.prisma.pspConnection.findMany({
      select: {
        id: true,
        terminal: true,
        ledgerSource: true,
        movementRules: true,
        balances: true,
        lastError: true,
        endpoints: true,
      },
    });

    // Every anchor, newest first, reduced to one per connection here rather
    // than in N queries. There are a handful of connections and a few anchors
    // each; this is one round trip either way.
    const anchors = await this.prisma.pspBalanceAnchor.findMany({
      orderBy: { takenAt: 'desc' },
    });
    const history = new Map<string, Anchor[]>();
    for (const a of anchors) {
      const list = history.get(a.connectionId) ?? [];
      if (list.length < DRIFT_WINDOW) list.push(toAnchor(a));
      history.set(a.connectionId, list);
    }

    return Promise.all(
      conns.map((c) => {
        const list = history.get(c.id) ?? [];
        return this.view(c, list[0] ?? null, readRules(c.movementRules), list);
      }),
    );
  }

  private async view(
    conn: {
      id: string;
      terminal: string;
      ledgerSource: string;
      balances?: unknown;
      lastError?: string | null;
      endpoints?: unknown;
    },
    anchor: Anchor | null,
    rules: MovementRules | null,
    /** Newest first, including `anchor`. Only used to fit the drift rate. */
    history: Anchor[] = [],
  ): Promise<BalanceView> {
    const currency = rules?.currency ?? anchor?.currency ?? null;

    // Read before the early return: a provider that answers is worth showing
    // even when nobody has ever typed an anchor, and that is the commonest
    // moment to want it — a terminal with a working balance endpoint and no
    // anchor should show its balance, not an empty panel asking for one.
    const picked = pickReported(conn.balances, currency);
    const reported = picked
      ? {
          ...picked,
          ageHours: Math.max(
            0,
            (Date.now() - new Date(picked.at).getTime()) / 3_600_000,
          ),
        }
      : null;
    const zero = {
      net: 0,
      added: 0,
      subtracted: 0,
      counted: 0,
      ignoredDirection: 0,
      ignoredStatus: 0,
      ignoredCurrency: 0,
      undated: 0,
      beforeAnchor: 0,
      fees: 0,
    };

    // No anchor means no estimate. Movement without something to move is a
    // number that looks like a balance and is not one, so it is not computed
    // and not shown.
    if (!anchor) {
      return {
        connectionId: conn.id,
        anchor: null,
        rules,
        estimate: null,
        currency,
        movement: zero,
        configured: Boolean(rules?.add?.length || rules?.subtract?.length),
        ageHours: null,
        basis: 'baseline',
        rulesChanged: false,
        feeMappingChanged: false,
        reported,
        drift: null,
        expectedDrift: null,
      };
    }

    const since = new Date(anchor.takenAt);

    // EVERYTHING currently counting, and everything that was counting when the
    // balance was entered. Movement is the difference between two totals, not
    // a filter on dates.
    //
    // That is what fixes the payment that keeps going missing. Pending at the
    // anchor, confirmed afterwards: absent from the baseline, present now, so
    // it counts — and it needs no settlement timestamp, which matters because
    // Paymaxis has none to give. Its PENDING and COMPLETED events carry the
    // same occurredAt, so by date those payments could never have been placed
    // correctly by any field.
    //
    // It also expresses something the date filter could not at all: a payment
    // that was confirmed and is later cancelled or refunded leaves the current
    // total, and the estimate goes DOWN. That is right, and it used to be
    // invisible.
    // Whether the fee is being read from the same place it was when the
    // baseline was measured. Compared before anything is summed, because the
    // answer decides whether the fee may be counted at all.
    const feePathNow = feeSignature(conn.endpoints, rules);
    const anchorKnowsFeePath =
      anchor.baselineFeePath !== null || anchor.baselineFees !== null;
    const feeMappingChanged =
      anchorKnowsFeePath && (anchor.baselineFeePath ?? null) !== feePathNow;

    const groups =
      conn.ledgerSource === 'paymaxis'
        ? await this.groupsFromPaymaxis(conn.terminal)
        : await this.groupsFromStore(conn.id);
    // Which authority is in force for this reading. A fee field mapped on the
    // endpoint means the provider reports its own cut and is the authority on
    // it; otherwise the configured percentages stand in. And when the two sides
    // of the subtraction were measured under different answers to that
    // question, neither may be used.
    const feeMode: FeeMode = feeMappingChanged
      ? 'none'
      : feeModeOf(conn.endpoints, rules);
    const now = applyRules(groups, rules, currency, feeMode);

    // The baseline. Stored on the anchor when it was entered — or, for anchors
    // entered before that column existed, reconstructed from the date window so
    // nothing changes under somebody until they re-enter the balance.
    // THE STORED BASELINE, PLUS WHAT ARRIVED LATE.
    //
    // baselineIn/baselineOut are a snapshot of what was STORED the moment the
    // balance was entered — and a row can reach us long after its money moved.
    // A full sync, a CSV import, or a provider reporting a payout a day late
    // all add rows that belong BEFORE the anchor. Absent from the snapshot and
    // present in "now", each one reads as movement since, when in truth it is
    // already inside the figure somebody copied off the portal. One late payout
    // is enough to move a balance by tens of thousands.
    //
    // So the snapshot is topped up with exactly those rows. The discriminator
    // is not the date on its own — a payment PENDING at the anchor and settling
    // afterwards carries a date before the anchor too, on a provider that
    // stamps settlement at the original time, and that one IS movement. What
    // separates them is whether we already held the row, which firstSeenAt
    // answers and nothing else does.
    const arrived =
      anchor.baselineIn !== null && anchor.baselineOut !== null
        ? applyRules(
            await this.groupsFromStore(conn.id, {
              arrivedAfter: new Date(anchor.enteredAt),
              until: since,
            }),
            rules,
            currency,
            feeMode,
          )
        : null;

    const stored =
      anchor.baselineIn !== null && anchor.baselineOut !== null
        ? {
            in: anchor.baselineIn + (arrived?.in ?? 0),
            out: anchor.baselineOut + (arrived?.out ?? 0),
            fees: feeMappingChanged
              ? 0
              : (anchor.baselineFees ?? 0) + (arrived?.fees ?? 0),
            counted: 0,
          }
        : null;
    const baseline =
      stored ??
      applyRules(
        conn.ledgerSource === 'paymaxis'
          ? await this.groupsFromPaymaxis(conn.terminal, { until: since })
          : await this.groupsFromStore(conn.id, { until: since }),
        rules,
        currency,
        feeMode,
      );

    const added = round(now.in - baseline.in);
    const subtracted = round(now.out - baseline.out);
    // Only meaningful against a stored baseline: a reconstructed one carries no
    // fee total of its own, so the difference would be the whole history.
    const fees = stored ? round(now.fees - stored.fees) : 0;

    const undated =
      conn.ledgerSource === 'paymaxis'
        ? await this.prisma.paymentEvent.count({
            where: { terminal: conn.terminal, occurredAt: null },
          })
        : await this.prisma.pspTransaction.count({
            where: { connectionId: conn.id, occurredAt: null },
          });

    const m = {
      added,
      subtracted,
      fees,
      net: round(added - subtracted),
      // How many are counting NOW. Not "how many moved since": with a baseline
      // there is no such number, because a payment can enter and leave the
      // counting set without any date changing.
      counted: now.counted,
      ignoredDirection: now.ignoredDirection,
      ignoredStatus: now.ignoredStatus,
      ignoredCurrency: now.ignoredCurrency,
      undated,
      // Nothing is held out by a date any more, so this is only ever non-zero
      // on a legacy anchor still using the date window.
      beforeAnchor: stored ? 0 : baseline.counted,
    };

    const estimate = round(anchor.amount + m.net);

    // Only against a stored baseline, and only while the rules still match the
    // ones it was fitted under. A rate measured over totals that counted
    // different things is not a rate, and applying it would dress up a
    // meaningless number as a correction.
    const fitted =
      stored && !sameRules(anchor.baselineRules, rules)
        ? null
        : fitDrift(history);
    const volumeSince = m.added + m.subtracted;
    // WHICH THING DRIVES THE DRIFT, decided by whether a fee-shaped answer is
    // even arithmetically possible.
    //
    // ForumPay's gap is 0.3-0.5% of what moved, so it scales with throughput
    // and a rate projects it. Match2Pay's most recent gap was 5.5% of what
    // moved — no provider charges that, and the window before it drifted 2.50
    // on a comparable trickle. Its USD figure is a valuation of crypto
    // holdings, so it moves when the market moves and barely notices the
    // payments at all.
    //
    // Projecting a valuation-driven drift as a percentage of volume is not a
    // slightly worse model, it is an inverted one: it predicts near-nothing on
    // a quiet weekend, which is exactly when such a balance has drifted most.
    // So above the fee ceiling the same history is re-read per HOUR, which is
    // the unit that actually moves it.
    const hoursSince = Math.max(0, (Date.now() - since.getTime()) / 3_600_000);
    const looksLikeFee = fitted ? Math.abs(fitted.rate) <= MAX_FEE_RATE : true;
    const expected = fitted
      ? looksLikeFee
        ? fitted.rate * volumeSince
        : fitted.perHour * hoursSince
      : 0;

    const expectedDrift = fitted
      ? {
          samples: fitted.samples,
          basis: looksLikeFee ? ('volume' as const) : ('time' as const),
          rate: fitted.rate,
          perDay: round(fitted.perHour * 24),
          fittedOver: fitted.volume,
          fittedOverHours: round(fitted.hours),
          expected: round(expected),
          adjusted: round(estimate - expected),
          beyondExperience: Math.abs(expected) > fitted.largest,
          looksLikeFee,
        }
      : null;

    return {
      connectionId: conn.id,
      anchor,
      rules,
      estimate,
      currency,
      movement: m,
      reported,
      // Only across the same currency. A gap between a USD estimate and a EUR
      // reading is not a gap, it is a category error with a minus sign in it.
      drift:
        reported &&
        (!currency ||
          !reported.currency ||
          reported.currency === currency.trim().toUpperCase())
          ? round(estimate - reported.amount)
          : null,
      expectedDrift,
      /** How the movement was worked out — the two are not equally reliable. */
      basis: stored ? ('baseline' as const) : ('date' as const),
      /**
       * The rules have changed since the baseline was measured, so the two
       * totals answer different questions and their difference means nothing.
       * Said rather than silently reported.
       */
      rulesChanged: stored ? !sameRules(anchor.baselineRules, rules) : false,
      feeMappingChanged,
      configured: Boolean(rules?.add?.length || rules?.subtract?.length),
      ageHours: Math.max(0, (Date.now() - since.getTime()) / 3_600_000),
    };
  }

  /**
   * The stored ledger, grouped.
   *
   * With no `until` this is EVERYTHING — which is what the baseline model
   * wants. With one it is everything that had moved by that instant, used only
   * to reconstruct a baseline for an anchor entered before baselines existed.
   *
   * "Moved" is settledAt where the provider reports one and occurredAt where it
   * does not. Stated positively, never as the negation of the other side: SQL
   * has three-valued logic, and `NOT (settledAt > x OR (settledAt IS NULL AND
   * occurredAt > x))` is NULL rather than TRUE for a row with no settledAt, so
   * every such row silently vanishes from the result.
   */
  private async groupsFromStore(
    connectionId: string,
    opts: { until?: Date; arrivedAfter?: Date } = {},
  ): Promise<Group[]> {
    // Everything whose money had moved by `until`. Stated positively — SQL's
    // three-valued logic makes the negation drop every row with a null
    // settledAt, which is every row until somebody maps the field.
    const movedBy = (until: Date) => [
      { settledAt: { lte: until } },
      { settledAt: null, occurredAt: { lte: until } },
      // A row that cannot be placed in time belongs in the baseline rather
      // than outside it. It is in the current total either way, so leaving it
      // out here would make it look like movement — a payment with an
      // unreadable date would silently inflate the balance, having never
      // moved at all.
      { settledAt: null, occurredAt: null },
    ];

    const rows = await this.prisma.pspTransaction.groupBy({
      by: ['direction', 'status', 'currency'],
      where: opts.arrivedAfter
        ? {
            connectionId,
            // Rows we did NOT hold when the balance was entered...
            firstSeenAt: { gt: opts.arrivedAfter },
            // ...whose money had already moved by the time it was true.
            // Undated rows are deliberately excluded here: they are already
            // inside the stored baseline's own undated handling, and adding
            // them again would double them.
            OR: [
              { settledAt: { lte: opts.until } },
              { settledAt: null, occurredAt: { lte: opts.until } },
            ],
          }
        : opts.until
          ? { connectionId, OR: movedBy(opts.until) }
          : { connectionId },
      _sum: { amount: true, fee: true },
      _count: { _all: true },
    });
    return rows.map((r) => ({
      direction: r.direction,
      status: r.status,
      currency: r.currency,
      sum: num(r._sum.amount),
      fees: num(r._sum.fee),
      count: r._count._all,
    }));
  }

  /**
   * The same grouping over what Paymaxis imported.
   *
   * Paymaxis calls the direction `type` and the state `state`; everything above
   * this is written against the provider's words and does not need to know
   * which table they came out of.
   *
   * NOT a groupBy, which is what this used to be and what made it wrong.
   * PaymentEvent holds one row per STATE CHANGE, so a deposit that went PENDING
   * then COMPLETED is two rows — and grouping over them counted the payment
   * twice, at two different amounts, because a fee is often taken between the
   * two. A status filter hid it whenever one was configured and let the whole
   * of it through whenever one was not.
   *
   * So the events are collapsed to their latest state first, and the grouping
   * happens over payments. It is done here rather than in SQL so that the rule
   * deciding which state wins is one readable function with its own check,
   * instead of an ORDER BY buried in a DISTINCT ON.
   */
  private async groupsFromPaymaxis(
    terminal: string,
    opts: { until?: Date } = {},
  ): Promise<Group[]> {
    const rows = await this.prisma.paymentEvent.findMany({
      where: opts.until
        ? {
            terminal,
            OR: [{ occurredAt: { lte: opts.until } }, { occurredAt: null }],
          }
        : { terminal },
      orderBy: [{ occurredAt: 'desc' }, { receivedAt: 'desc' }],
      take: MAX_EVENTS,
      select: {
        id: true,
        paymentId: true,
        externalId: true,
        occurredAt: true,
        receivedAt: true,
        type: true,
        state: true,
        currency: true,
        amount: true,
      },
    });

    const groups = new Map<string, Group>();
    for (const r of latestPerPayment(rows)) {
      const e = r as (typeof rows)[number];
      const key = JSON.stringify([e.type, e.state, e.currency]);
      const g = groups.get(key) ?? {
        direction: e.type,
        status: e.state,
        currency: e.currency,
        sum: 0,
        // Paymaxis reports no fee of its own. Whatever a provider deducted
        // before telling Paymaxis is already inside the amount, and anything
        // deducted afterwards is invisible from here.
        fees: 0,
        count: 0,
      };
      g.sum += num(e.amount);
      g.count++;
      groups.set(key, g);
    }
    return [...groups.values()];
  }

  /**
   * Records what the portal actually says, and what we had been claiming.
   *
   * The drift is computed BEFORE the new anchor is written, against the anchor
   * being replaced — that comparison is the whole reason this is a table.
   */
  async setAnchor(
    connectionId: string,
    body: {
      amount?: unknown;
      currency?: string;
      takenAt?: string;
      note?: string;
    },
    enteredBy?: string,
  ) {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount)) {
      throw new BadRequestException('Enter the balance as a number.');
    }
    const currency = (body.currency ?? '').trim().toUpperCase();
    if (!currency) {
      throw new BadRequestException('Say which currency the balance is in.');
    }

    // Defaults to now, but is settable: somebody reads the portal at 14:20 and
    // types it in at 14:35, and the transactions in between would otherwise be
    // counted twice — once inside the figure they read, once as movement.
    const takenAt = body.takenAt ? new Date(body.takenAt) : new Date();
    if (Number.isNaN(takenAt.getTime())) {
      throw new BadRequestException('That is not a date we can read.');
    }

    const before = await this.balance(connectionId);

    // THE BASELINE: what is already counting at the moment this figure is
    // entered. Movement from here on is the difference between this and the
    // current total, which is what makes a late settlement countable — it is
    // absent here and present later, whatever its dates say.
    //
    // Measured under the rules in force NOW and stored beside them, so a later
    // rule change can be detected rather than silently changing what the
    // difference means.
    const conn = await this.prisma.pspConnection.findUnique({
      where: { id: connectionId },
      select: {
        terminal: true,
        ledgerSource: true,
        movementRules: true,
        endpoints: true,
      },
    });
    if (!conn) throw new BadRequestException('No such PSP connection.');
    const rules = readRules(conn.movementRules);
    const baseline = applyRules(
      conn.ledgerSource === 'paymaxis'
        ? await this.groupsFromPaymaxis(conn.terminal)
        : await this.groupsFromStore(connectionId),
      rules,
      rules?.currency ?? currency,
      feeModeOf(conn.endpoints, rules),
    );

    const row = await this.prisma.pspBalanceAnchor.create({
      data: {
        connectionId,
        amount,
        currency,
        takenAt,
        enteredBy: enteredBy ?? null,
        note: body.note?.trim() || null,
        estimateWas: before.estimate,
        baselineIn: round(baseline.in),
        baselineOut: round(baseline.out),
        baselineFees: round(baseline.fees),
        baselineRules: rules ?? Prisma.DbNull,
        // Recorded so a later change of fee mapping is detectable. Without it
        // the fee difference silently compares two different measurements.
        baselineFeePath: feeSignature(conn.endpoints, rules),
        // Signed: positive means we were claiming MORE than the portal shows,
        // which is the direction unrecorded fees push it and the one worth
        // noticing.
        drift:
          before.estimate === null ? null : round(before.estimate - amount),
      },
    });

    return { anchor: toAnchor(row), balance: await this.balance(connectionId) };
  }

  /**
   * Re-anchors to what the provider last said, instead of to what someone read.
   *
   * The anchor exists because somebody has to supply a true figure. When the
   * provider supplies one, there is no reason for that somebody to be a person
   * at 4am with a portal open in another tab — and every reason for it not to
   * be, because a typed figure can be typed wrong and a read one cannot.
   *
   * Goes through setAnchor rather than writing a row directly, so a provider
   * reading is anchored exactly like a typed one: same baseline, same recorded
   * drift, same history. The drift column then becomes an accuracy log of the
   * estimate against a source that is not us, which is the only way to know
   * whether the estimating is working.
   *
   * `takenAt` is when the reading was TAKEN, not now. The gap between reading a
   * balance and storing it is small but not zero, and anchoring it as "now"
   * would count whatever moved in between twice — once inside the provider's
   * figure, once as movement since.
   */
  async anchorFromProvider(connectionId: string, enteredBy?: string) {
    const current = await this.balance(connectionId);
    if (!current.reported) {
      throw new BadRequestException(
        'This provider has not returned a balance. Configure its balance endpoint and press “Save and test balance” — if it answers, this button anchors to what it said.',
      );
    }
    const { amount, currency, at } = current.reported;
    if (!currency) {
      throw new BadRequestException(
        'The provider’s reading has no currency on it. Map the currency field on the balance endpoint, or set the currency in the movement rules.',
      );
    }
    return this.setAnchor(
      connectionId,
      {
        amount,
        currency,
        takenAt: at,
        note: 'Read from the provider',
      },
      enteredBy,
    );
  }

  /**
   * What the gap is made of, looked for in the data rather than reasoned about.
   *
   * The question this exists to end. The ledger is complete and the
   * transactions are right, so the balance ought to be exact — and it is not,
   * by 89.40 over a day. Something is being deducted that no rule subtracts.
   *
   * The insight is that a provider which deducts a fee REPORTS it, on the
   * record of the payment it came out of. We store every record whole, exactly
   * as it arrived. So the missing money is already in this database, under a
   * field name nobody has mapped — and the sum of the right field, over the
   * transactions of one measured interval, equals that interval's drift.
   *
   * Which turns guessing into searching. Every numeric field in every record of
   * the interval is summed, and the sums are ranked by how close they land to
   * the drift that was actually recorded when the anchor was corrected. A field
   * that matches to the cent is not a coincidence in a list of twenty; it is
   * the fee, and mapping it makes the estimate exact rather than corrected.
   *
   * The interval used is the last CLOSED one — between the two most recent
   * anchors — because that is the only window whose true error is known. The
   * open interval's drift is exactly what nobody can measure yet.
   *
   * Both signs are searched. A provider can report a deduction as 3.14 or as
   * −3.14 and the field is equally the answer; only the mapping differs.
   */
  async explainDrift(connectionId: string) {
    const conn = await this.prisma.pspConnection.findUnique({
      where: { id: connectionId },
      select: {
        id: true,
        terminal: true,
        ledgerSource: true,
        movementRules: true,
      },
    });
    if (!conn) throw new BadRequestException('No such PSP connection.');

    // Soft, not thrown. This runs unattended now — the panel asks it the moment
    // a drift exists rather than waiting for somebody to press a button — and a
    // 400 on a terminal that simply has nothing to search would render as a red
    // error under a balance that is working fine.
    const nothing = (note: string) => ({
      target: 0,
      from: null,
      to: null,
      transactions: 0,
      candidates: [] as never[],
      statuses: [] as never[],
      note,
    });

    const [curr, prev] = await this.prisma.pspBalanceAnchor.findMany({
      where: { connectionId },
      orderBy: { takenAt: 'desc' },
      take: 2,
    });
    if (!curr || !prev) {
      return nothing(
        'This needs two balances entered: the gap between them is the amount being searched for. Press “Update from portal”, and again next time the estimate has drifted.',
      );
    }
    if (curr.drift === null) {
      return nothing(
        'The most recent balance recorded no drift against the estimate it replaced, so there is no gap to explain.',
      );
    }

    const target = Number(curr.drift);
    const rules = readRules(conn.movementRules);

    const rows =
      conn.ledgerSource === 'paymaxis'
        ? await this.windowFromPaymaxis(
            conn.terminal,
            prev.takenAt,
            curr.takenAt,
          )
        : (
            await this.prisma.pspTransaction.findMany({
              where: {
                connectionId,
                // Placed by settlement where the provider reports one, because
                // that is when the money — and its fee — actually moved.
                OR: [
                  { settledAt: { gt: prev.takenAt, lte: curr.takenAt } },
                  {
                    settledAt: null,
                    occurredAt: { gt: prev.takenAt, lte: curr.takenAt },
                  },
                ],
              },
              select: {
                raw: true,
                status: true,
                direction: true,
                amount: true,
                currency: true,
              },
            })
          ).map((r) => ({
            raw: r.raw,
            status: r.status,
            direction: r.direction,
            amount: num(r.amount),
            currency: r.currency,
          }));

    // WHAT IF WE COUNTED THIS TOO.
    //
    // The other half of the question, and the only half that applies to a
    // terminal whose ledger arrives through Paymaxis — there is no per-payment
    // fee to find there, but there is a far larger suspect: a status that is
    // not being counted and should be.
    //
    // Match2Pay is the case. Roughly 38% of its stored payments sit in
    // "Awaiting Webhook", which is where a payment stays for ever when its
    // completion callback never arrives. A WITHDRAWAL that completed and lost
    // its callback took money out that our ledger never subtracted — an
    // estimate too high, by exactly the value of the lost callbacks. Both MT
    // terminals drifted about 9% of their outflow in the same window, on
    // volumes that differ nineteen-fold, which is what an integration-wide
    // callback loss looks like and is not what any fee looks like.
    //
    // So: for every status NOT currently counted, what would including it do
    // to the gap. The one that closes it is the answer.
    const counted = (st: string | null) =>
      !rules?.statuses?.length || has(rules.statuses, st);
    const buckets = new Map<
      string,
      {
        status: string | null;
        direction: string | null;
        sum: number;
        count: number;
      }
    >();
    for (const r of rows) {
      if (counted(r.status)) continue;
      if (
        rules?.currency &&
        (r.currency ?? '').toUpperCase() !== rules.currency
      )
        continue;
      const key = JSON.stringify([r.status, r.direction]);
      const b = buckets.get(key) ?? {
        status: r.status,
        direction: r.direction,
        sum: 0,
        count: 0,
      };
      b.sum += r.amount ?? 0;
      b.count++;
      buckets.set(key, b);
    }

    const statuses = [...buckets.values()]
      .map((b) => {
        // Counting an outflow lowers the estimate and so closes a positive
        // gap; counting an inflow raises it and widens one.
        const inbound = rules?.signed
          ? b.sum >= 0
          : has(rules?.add, b.direction);
        const magnitude = Math.abs(b.sum);
        const remaining = inbound ? target + magnitude : target - magnitude;
        return {
          status: b.status,
          direction: b.direction,
          count: b.count,
          sum: round(magnitude),
          /** The gap that would be left if these were counted. */
          leaves: round(remaining),
          closes: round(Math.abs(target) - Math.abs(remaining)),
        };
      })
      .sort((a, b) => Math.abs(a.leaves) - Math.abs(b.leaves))
      .slice(0, 12);

    const totals = numericTotals(rows.map((r) => r.raw));
    const candidates = totals
      // A field of zeros explains nothing, and neither does one nobody filled.
      .filter((t) => t.nonZero > 0)
      .map((t) => ({
        ...t,
        total: round(t.total),
        // Signed either way: a deduction reported as a positive number and one
        // reported as a negative are the same finding.
        missBy: round(
          Math.min(Math.abs(t.total - target), Math.abs(-t.total - target)),
        ),
        /** Of the gap, how much this field would account for. */
        covers:
          target === 0
            ? null
            : round((Math.abs(t.total) / Math.abs(target)) * 100),
      }))
      .sort((a, b) => a.missBy - b.missBy)
      .slice(0, 12);

    return {
      /** The gap being explained, and where it came from. */
      target: round(target),
      from: prev.takenAt.toISOString(),
      to: curr.takenAt.toISOString(),
      transactions: rows.length,
      candidates,
      statuses,
      note: rows.length
        ? null
        : 'No transactions are stored in that window, so there is nothing to add up. Sync the ledger and try again.',
    };
  }

  /**
   * The payments that moved in one window, from what Paymaxis imported.
   *
   * Collapsed to the latest state per payment first, for the reason the whole
   * ledger is: PaymentEvent is an event log, and MT's PENDING and COMPLETED
   * rows carry the SAME occurredAt. Counting events would put one payment in
   * two status buckets and report a backlog that does not exist.
   */
  private async windowFromPaymaxis(
    terminal: string,
    from: Date,
    to: Date,
  ): Promise<
    {
      raw: unknown;
      status: string | null;
      direction: string | null;
      amount: number | null;
      currency: string | null;
    }[]
  > {
    const rows = await this.prisma.paymentEvent.findMany({
      where: { terminal, occurredAt: { gt: from, lte: to } },
      orderBy: [{ occurredAt: 'desc' }, { receivedAt: 'desc' }],
      take: MAX_EVENTS,
      select: {
        id: true,
        paymentId: true,
        externalId: true,
        occurredAt: true,
        receivedAt: true,
        type: true,
        state: true,
        currency: true,
        amount: true,
      },
    });
    return latestPerPayment(rows).map((r) => {
      const e = r as (typeof rows)[number];
      return {
        // Paymaxis events carry no provider record of their own here, so there
        // is no field to search — only the status question.
        raw: undefined,
        status: e.state,
        direction: e.type,
        amount: num(e.amount),
        currency: e.currency,
      };
    });
  }

  /** Every anchor entered, newest first — the drift history. */
  async history(connectionId: string, limit = 50) {
    const rows = await this.prisma.pspBalanceAnchor.findMany({
      where: { connectionId },
      orderBy: { takenAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    return rows.map(toAnchor);
  }

  /**
   * The provider's own vocabulary, counted off the stored rows.
   *
   * Because the matching is exact, and asking somebody to TYPE "WITHDRAWAL"
   * when the provider says "payout" produces a rule that silently matches
   * nothing and a balance that silently stops moving. The values that exist are
   * a question the data can answer, so it answers it.
   */
  async vocabulary(connectionId: string) {
    const conn = await this.prisma.pspConnection.findUnique({
      where: { id: connectionId },
      select: { terminal: true, ledgerSource: true },
    });
    if (!conn) throw new BadRequestException('No such PSP connection.');

    if (conn.ledgerSource === 'paymaxis') {
      const [dirs, states, curr] = await Promise.all([
        this.prisma.paymentEvent.groupBy({
          by: ['type'],
          where: { terminal: conn.terminal },
          _count: { _all: true },
        }),
        this.prisma.paymentEvent.groupBy({
          by: ['state'],
          where: { terminal: conn.terminal },
          _count: { _all: true },
        }),
        this.prisma.paymentEvent.groupBy({
          by: ['currency'],
          where: { terminal: conn.terminal },
          _count: { _all: true },
        }),
      ]);
      return {
        directions: tally(dirs.map((d) => [d.type, d._count._all])),
        statuses: tally(states.map((s) => [s.state, s._count._all])),
        currencies: tally(curr.map((c) => [c.currency, c._count._all])),
      };
    }

    const [dirs, states, curr] = await Promise.all([
      this.prisma.pspTransaction.groupBy({
        by: ['direction'],
        where: { connectionId },
        _count: { _all: true },
      }),
      this.prisma.pspTransaction.groupBy({
        by: ['status'],
        where: { connectionId },
        _count: { _all: true },
      }),
      this.prisma.pspTransaction.groupBy({
        by: ['currency'],
        where: { connectionId },
        _count: { _all: true },
      }),
    ]);
    return {
      directions: tally(dirs.map((d) => [d.direction, d._count._all])),
      statuses: tally(states.map((s) => [s.status, s._count._all])),
      currencies: tally(curr.map((c) => [c.currency, c._count._all])),
    };
  }
}

/** Distinct values, commonest first, nulls dropped. */
function tally(pairs: [string | null, number][]) {
  return pairs
    .filter(([v]) => v !== null && String(v).trim() !== '')
    .map(([value, count]) => ({ value: String(value), count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function toAnchor(row: {
  id: string;
  amount: unknown;
  currency: string;
  takenAt: Date;
  enteredAt: Date;
  enteredBy: string | null;
  note: string | null;
  estimateWas: unknown;
  drift: unknown;
  baselineIn?: unknown;
  baselineOut?: unknown;
  baselineFees?: unknown;
  baselineFeePath?: unknown;
  baselineRules?: unknown;
}): Anchor {
  return {
    id: row.id,
    amount: num(row.amount),
    currency: row.currency,
    takenAt: row.takenAt.toISOString(),
    enteredAt: row.enteredAt.toISOString(),
    enteredBy: row.enteredBy,
    note: row.note,
    estimateWas: row.estimateWas === null ? null : num(row.estimateWas),
    drift: row.drift === null ? null : num(row.drift),
    // Null and zero are different here: zero is a measured baseline of nothing
    // counting yet, null is an anchor from before baselines existed.
    baselineIn:
      row.baselineIn === null || row.baselineIn === undefined
        ? null
        : num(row.baselineIn),
    baselineOut:
      row.baselineOut === null || row.baselineOut === undefined
        ? null
        : num(row.baselineOut),
    baselineFees:
      row.baselineFees === null || row.baselineFees === undefined
        ? null
        : num(row.baselineFees),
    baselineFeePath:
      typeof row.baselineFeePath === 'string' ? row.baselineFeePath : null,
    baselineRules: readRules(row.baselineRules),
  };
}
