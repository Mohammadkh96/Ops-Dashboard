import { BadRequestException, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

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
  };
  /**
   * Whether the rules can actually classify what this terminal sends. False
   * when nothing is configured, which is the difference between "the balance
   * has not moved" and "nothing here knows how to move it".
   */
  configured: boolean;
  /** Hours since the anchor was true. The age is the caveat. */
  ageHours: number | null;
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
  };
  const empty =
    !rules.currency &&
    !rules.add?.length &&
    !rules.subtract?.length &&
    !rules.statuses?.length;
  return empty ? null : rules;
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
      };
    }

    const since = new Date(anchor.takenAt);
    const groups =
      conn.ledgerSource === 'paymaxis'
        ? await this.groupsFromPaymaxis(conn.terminal, since)
        : await this.groupsFromStore(conn.id, since);
    const undated =
      conn.ledgerSource === 'paymaxis'
        ? await this.prisma.paymentEvent.count({
            where: { terminal: conn.terminal, occurredAt: null },
          })
        : await this.prisma.pspTransaction.count({
            where: { connectionId: conn.id, occurredAt: null },
          });

    const m = { ...zero, undated };
    for (const g of groups) {
      // Order matters, because each row is excluded for exactly one reason and
      // the reason is what the screen shows. Currency first: a EUR row under a
      // USD anchor is not "an unknown direction", and saying so would send
      // somebody off to configure a rule that would not have helped.
      if (currency && (g.currency ?? '').toUpperCase() !== currency) {
        m.ignoredCurrency += g.count;
      } else if (rules?.statuses?.length && !has(rules.statuses, g.status)) {
        m.ignoredStatus += g.count;
      } else if (has(rules?.add, g.direction)) {
        m.added += g.sum;
        m.counted += g.count;
      } else if (has(rules?.subtract, g.direction)) {
        m.subtracted += g.sum;
        m.counted += g.count;
      } else {
        m.ignoredDirection += g.count;
      }
    }

    m.added = round(m.added);
    m.subtracted = round(m.subtracted);
    m.net = round(m.added - m.subtracted);

    return {
      connectionId: conn.id,
      anchor,
      rules,
      estimate: round(anchor.amount + m.net),
      currency,
      movement: m,
      configured: Boolean(rules?.add?.length || rules?.subtract?.length),
      ageHours: Math.max(0, (Date.now() - since.getTime()) / 3_600_000),
    };
  }

  private async groupsFromStore(
    connectionId: string,
    since: Date,
  ): Promise<Group[]> {
    const rows = await this.prisma.pspTransaction.groupBy({
      by: ['direction', 'status', 'currency'],
      where: { connectionId, occurredAt: { gt: since } },
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
   */
  private async groupsFromPaymaxis(
    terminal: string,
    since: Date,
  ): Promise<Group[]> {
    const rows = await this.prisma.paymentEvent.groupBy({
      by: ['type', 'state', 'currency'],
      where: { terminal, occurredAt: { gt: since } },
      _sum: { amount: true },
      _count: { _all: true },
    });
    return rows.map((r) => ({
      direction: r.type,
      status: r.state,
      currency: r.currency,
      sum: num(r._sum.amount),
      count: r._count._all,
    }));
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

    const row = await this.prisma.pspBalanceAnchor.create({
      data: {
        connectionId,
        amount,
        currency,
        takenAt,
        enteredBy: enteredBy ?? null,
        note: body.note?.trim() || null,
        estimateWas: before.estimate,
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
  };
}
