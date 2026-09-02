import { BadRequestException, Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { latestPerPayment, MAX_EVENTS } from './payment-events';

/**
 * A balance for providers that will not tell us one.
 *
 * ForumPay's portal shows a USD figure that no documented endpoint returns —
 * GetBalance answers with swept crypto wallets, all of them near zero.
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
  baselineRules: MovementRules | null;
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
};

/** Case-insensitive membership, because "Sell" and "sell" are one word. */
function has(list: string[] | undefined, value: string | null): boolean {
  if (!list?.length || value === null) return false;
  const v = value.trim().toLowerCase();
  return list.some((x) => x.trim().toLowerCase() === v);
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
  };
  const empty =
    !rules.currency &&
    !rules.add?.length &&
    !rules.subtract?.length &&
    !rules.statuses?.length;
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
  count: number;
};

/** What a set of transactions comes to, once the rules have been applied. */
type Totals = {
  in: number;
  out: number;
  counted: number;
  ignoredDirection: number;
  ignoredStatus: number;
  ignoredCurrency: number;
};

/**
 * The rules, applied to a set of grouped transactions.
 *
 * One function, used twice: over everything counting NOW, and over everything
 * that was counting when the balance was entered. Movement is the difference.
 * Using the same code for both is the point — two totals computed by two
 * routines would differ for reasons nobody could find.
 */
function applyRules(
  groups: Group[],
  rules: MovementRules | null,
  currency: string | null,
): Totals {
  const t: Totals = {
    in: 0,
    out: 0,
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
      },
    });
    if (!conn) throw new BadRequestException('No such PSP connection.');

    const [anchorRow] = await this.prisma.pspBalanceAnchor.findMany({
      where: { connectionId },
      orderBy: { takenAt: 'desc' },
      take: 1,
    });

    const rules = readRules(conn.movementRules);
    const anchor = anchorRow ? toAnchor(anchorRow) : null;
    return this.view(conn, anchor, rules);
  }

  /** The same figure for every connection at once, for the dashboard. */
  async balances(): Promise<BalanceView[]> {
    const conns = await this.prisma.pspConnection.findMany({
      select: {
        id: true,
        terminal: true,
        ledgerSource: true,
        movementRules: true,
      },
    });

    // Every anchor, newest first, reduced to one per connection here rather
    // than in N queries. There are a handful of connections and a few anchors
    // each; this is one round trip either way.
    const anchors = await this.prisma.pspBalanceAnchor.findMany({
      orderBy: { takenAt: 'desc' },
    });
    const latest = new Map<string, (typeof anchors)[number]>();
    for (const a of anchors)
      if (!latest.has(a.connectionId)) latest.set(a.connectionId, a);

    return Promise.all(
      conns.map((c) =>
        this.view(
          c,
          latest.get(c.id) ? toAnchor(latest.get(c.id)!) : null,
          readRules(c.movementRules),
        ),
      ),
    );
  }

  private async view(
    conn: { id: string; terminal: string; ledgerSource: string },
    anchor: Anchor | null,
    rules: MovementRules | null,
  ): Promise<BalanceView> {
    const currency = rules?.currency ?? anchor?.currency ?? null;
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
    const groups =
      conn.ledgerSource === 'paymaxis'
        ? await this.groupsFromPaymaxis(conn.terminal)
        : await this.groupsFromStore(conn.id);
    const now = applyRules(groups, rules, currency);

    // The baseline. Stored on the anchor when it was entered — or, for anchors
    // entered before that column existed, reconstructed from the date window so
    // nothing changes under somebody until they re-enter the balance.
    const stored =
      anchor.baselineIn !== null && anchor.baselineOut !== null
        ? { in: anchor.baselineIn, out: anchor.baselineOut, counted: 0 }
        : null;
    const baseline =
      stored ??
      applyRules(
        conn.ledgerSource === 'paymaxis'
          ? await this.groupsFromPaymaxis(conn.terminal, { until: since })
          : await this.groupsFromStore(conn.id, { until: since }),
        rules,
        currency,
      );

    const added = round(now.in - baseline.in);
    const subtracted = round(now.out - baseline.out);

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

    return {
      connectionId: conn.id,
      anchor,
      rules,
      estimate: round(anchor.amount + m.net),
      currency,
      movement: m,
      /** How the movement was worked out — the two are not equally reliable. */
      basis: stored ? ('baseline' as const) : ('date' as const),
      /**
       * The rules have changed since the baseline was measured, so the two
       * totals answer different questions and their difference means nothing.
       * Said rather than silently reported.
       */
      rulesChanged: stored ? !sameRules(anchor.baselineRules, rules) : false,
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
    opts: { until?: Date } = {},
  ): Promise<Group[]> {
    const rows = await this.prisma.pspTransaction.groupBy({
      by: ['direction', 'status', 'currency'],
      where: opts.until
        ? {
            connectionId,
            OR: [
              { settledAt: { lte: opts.until } },
              { settledAt: null, occurredAt: { lte: opts.until } },
              // A row that cannot be placed in time belongs in the baseline
              // rather than outside it. It is in the current total either way,
              // so leaving it out here would make it look like movement — a
              // payment with an unreadable date would silently inflate the
              // balance, having never moved at all.
              { settledAt: null, occurredAt: null },
            ],
          }
        : { connectionId },
      _sum: { amount: true },
      _count: { _all: true },
    });
    return rows.map((r) => ({
      direction: r.direction,
      status: r.status,
      currency: r.currency,
      sum: num(r._sum.amount),
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
      select: { terminal: true, ledgerSource: true, movementRules: true },
    });
    if (!conn) throw new BadRequestException('No such PSP connection.');
    const rules = readRules(conn.movementRules);
    const baseline = applyRules(
      conn.ledgerSource === 'paymaxis'
        ? await this.groupsFromPaymaxis(conn.terminal)
        : await this.groupsFromStore(connectionId),
      rules,
      rules?.currency ?? currency,
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
        baselineRules: rules ?? Prisma.DbNull,
        // Signed: positive means we were claiming MORE than the portal shows,
        // which is the direction unrecorded fees push it and the one worth
        // noticing.
        drift:
          before.estimate === null ? null : round(before.estimate - amount),
      },
    });

    return { anchor: toAnchor(row), balance: await this.balance(connectionId) };
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
    baselineRules: readRules(row.baselineRules),
  };
}
