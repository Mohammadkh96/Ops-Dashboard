import { BadRequestException, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { latestPerPayment, MAX_EVENTS } from './payment-events';
import { has, readRules, type MovementRules } from './psp-balance.service';

/**
 * The provider's own statement, checked against ours payment by payment.
 *
 * WHY THIS EXISTS, and why no balance check could replace it.
 *
 * A Match2Pay terminal matched its portal to thirty-six cents on the morning
 * this was written — while a client deposit of USD 3,999.40 sat in the ledger
 * recorded as USD 299.70. Both facts were true at once, and they are not in
 * tension: the client had sent a second transfer to a deposit address whose
 * invoice was already closed, the provider credited the wallet with everything
 * that arrived, and only the CRM's side of it was short. The money WAS there.
 * The balance was right. A customer was owed 3,699.70 and nothing on any screen
 * could say so, because every instrument we had compares totals.
 *
 * That is the whole argument. A balance is a sum, and a sum cannot tell you
 * WHICH payment is wrong — it cannot even tell you that one is, when the errors
 * are on the client side of a figure the provider reports correctly. The only
 * thing that finds it is a comparison at the level the error happens: one
 * payment at a time, against what the provider says it did.
 *
 * WHAT IT FOUND, on one month of two terminals, which is also what the checks
 * are built from:
 *
 *   Saint Lucia   379 payments   every one matched, every amount right but ONE
 *                                (that deposit: 3,699.70)
 *   Mauritius   2,202 payments   14 deposits worth 559.10 that the provider had
 *                                completed and we still held as "Awaiting
 *                                Webhook", "Pending" or "Declined"
 *
 * So the drift on this provider is not a fee and not a valuation — the two
 * things the balance panel is able to model. Its withdrawals reconcile to the
 * cent and every row is USDT at a conversion rate of 1.0. It is a handful of
 * individually nameable payments, and naming them is worth more than fitting a
 * rate to their sum.
 */

/** One line of the provider's statement, once the columns have been read. */
export type StatementRow = {
  at: Date;
  direction: 'in' | 'out';
  amount: number;
  status: string;
};

/**
 * Which column meant what.
 *
 * Reported back rather than assumed silently. A statement whose amount column
 * was read as the crypto figure instead of the fiat one produces a report full
 * of confident discrepancies, and the only way to notice is to see which header
 * was picked.
 */
export type StatementColumns = {
  at: string | null;
  direction: string | null;
  amount: string | null;
  status: string | null;
};

/**
 * Words a provider uses for money that actually moved.
 *
 * Deliberately narrow. Anything not here is reported as ignored with its own
 * count, so a vocabulary this list has never seen shows up as "1,204 rows
 * ignored" rather than as a reconciliation that quietly compared nothing.
 */
const SETTLED = [
  'done',
  'completed',
  'complete',
  'success',
  'successful',
  'confirmed',
  'paid',
  'settled',
  'finished',
  'approved',
];

/**
 * A cell as text — and only when it IS text.
 *
 * A spreadsheet cell can arrive as an object, and String() turns those into
 * "[object Object]": a value that is not a status, not a direction, and reads
 * as one all the way to the screen. Anything that is not already a primitive
 * becomes an empty string, which the callers treat as "unreadable" and count.
 */
function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint')
    return String(v);
  return '';
}

/**
 * Direction, by PREFIX rather than by equality.
 *
 * Match2Pay writes "WITHDRAW" and the CRM writes "WITHDRAWAL". Comparing those
 * for equality rejected every single withdrawal on both terminals and turned
 * 1,348 perfectly reconciled payouts into 1,348 discrepancies worth tens of
 * thousands — a false alarm large enough to send somebody to a provider with
 * it. Prefix matching costs nothing and removes the whole class.
 */
function directionOf(word: unknown): 'in' | 'out' | null {
  const w = asText(word).trim().toLowerCase();
  if (!w) return null;
  if (
    w.startsWith('withdraw') ||
    w.startsWith('payout') ||
    w.startsWith('sell')
  )
    return 'out';
  if (w.startsWith('deposit') || w.startsWith('payin') || w.startsWith('buy'))
    return 'in';
  return null;
}

/** Candidate header names, most specific first. */
const COLUMN_HINTS = {
  at: [
    'created',
    'created at',
    'createdat',
    'date',
    'when',
    'timestamp',
    'time',
  ],
  direction: ['type', 'direction', 'operation', 'kind'],
  amount: [
    // "Final amount" before "amount": a statement that carries both means the
    // first is what settled and the second is what was asked for, and it is the
    // settled one that moved the balance.
    'final amount',
    'settled amount',
    'amount',
    'value',
    'total',
  ],
  status: ['status', 'state', 'result'],
};

function pickColumn(headers: string[], hints: string[]): string | null {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const hint of hints) {
    const i = lower.indexOf(hint);
    if (i >= 0) return headers[i];
  }
  for (const hint of hints) {
    const i = lower.findIndex((h) => h.includes(hint));
    if (i >= 0) return headers[i];
  }
  return null;
}

function asAmount(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  // Thousands separators only, and only when they are where they belong. A
  // string that is not simply a number is left alone rather than coerced.
  const s = v.trim().replace(/,(?=\d{3}\b)/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function asDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string' || !v.trim()) return null;
  const d = new Date(v.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Reads whatever the browser parsed out of the file into rows we can compare. */
export function readStatement(records: Record<string, unknown>[]): {
  rows: StatementRow[];
  columns: StatementColumns;
  unreadable: number;
} {
  const headers = [...new Set(records.flatMap((r) => Object.keys(r)))];
  const columns: StatementColumns = {
    at: pickColumn(headers, COLUMN_HINTS.at),
    direction: pickColumn(headers, COLUMN_HINTS.direction),
    amount: pickColumn(headers, COLUMN_HINTS.amount),
    status: pickColumn(headers, COLUMN_HINTS.status),
  };

  const rows: StatementRow[] = [];
  let unreadable = 0;
  for (const r of records) {
    const at = columns.at ? asDate(r[columns.at]) : null;
    const direction = columns.direction
      ? directionOf(r[columns.direction])
      : null;
    const amount = columns.amount ? asAmount(r[columns.amount]) : null;
    if (!at || !direction || amount === null) {
      unreadable++;
      continue;
    }
    rows.push({
      at,
      direction,
      amount,
      status: asText(columns.status ? r[columns.status] : '').trim(),
    });
  }
  return { rows, columns, unreadable };
}

/**
 * The instant a payment was RAISED, recovered from our own reference.
 *
 * The join this whole comparison rests on. Two systems that share no id still
 * share a moment: the CRM mints a reference like `CU13228_1788259307681` whose
 * tail is the millisecond the deposit address was asked for, and the provider
 * creates its record a second or two later. Nothing else lines up as well —
 * our stored timestamps are the payment's own event times, which drift from the
 * provider's by minutes, and amounts cannot be a key in a comparison whose
 * entire purpose is to find amounts that disagree.
 *
 * Measured on real statements: 211 of 211 payments joined on one terminal and
 * 1,032 of 1,034 on the other. The two that did not were outside the window.
 */
export function raisedAt(reference: string | null, fallback: Date | null) {
  const m = /_(\d{13})$/.exec(reference ?? '');
  if (!m) return fallback;
  const t = Number(m[1]);
  return Number.isFinite(t) ? new Date(t) : fallback;
}

/** Our side of the comparison: one entry per PAYMENT, not per event. */
type Ours = {
  at: Date | null;
  direction: string | null;
  amount: number;
  status: string;
  reference: string | null;
  customer: string | null;
  counts: boolean;
};

export type ReconcileReport = {
  statement: {
    rows: number;
    settled: number;
    ignored: number;
    unreadable: number;
    from: string | null;
    to: string | null;
    columns: StatementColumns;
  };
  ledger: { payments: number; to: string | null };
  /** Set when the statement runs past our ledger — see the note in reconcile(). */
  boundary: string | null;
  matched: number;
  /** Money the provider settled that our rules DO count, for scale. */
  counted: { payments: number; in: number; out: number };
  /** Money the provider settled that our rules do not count, and under what. */
  uncounted: {
    status: string;
    direction: 'in' | 'out';
    payments: number;
    value: number;
  }[];
  /** Counted, but for a different figure than the provider settled. */
  amountErrors: {
    at: string;
    direction: 'in' | 'out';
    reference: string | null;
    customer: string | null;
    ours: number;
    theirs: number;
    difference: number;
  }[];
  /** Settled by the provider, and we hold no record of it at all. */
  missing: { at: string; direction: 'in' | 'out'; amount: number }[];
  /**
   * What all of that does to the estimate, in money.
   *
   * Positive = our estimate runs HIGH against the provider's wallet; negative =
   * it runs low. This is the drift, itemised — the same quantity the balance
   * panel otherwise fits a rate to, except that here every contributing payment
   * can be named and chased.
   */
  net: number;
};

const round = (n: number) => Math.round(n * 100) / 100;
/** Nearest-first, and generous only forwards: the provider records after us. */
const EARLY_S = -5;
const LATE_S = 60;

@Injectable()
export class PspReconcileService {
  constructor(private readonly prisma: PrismaService) {}

  async reconcile(
    connectionId: string,
    records: Record<string, unknown>[],
  ): Promise<ReconcileReport> {
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
    if (!records.length) {
      throw new BadRequestException(
        'That file had no rows in it. Export the provider statement again and upload the file it produced.',
      );
    }

    const { rows, columns, unreadable } = readStatement(records);
    if (!rows.length) {
      throw new BadRequestException(
        `None of those ${records.length} rows could be read as payments. The columns found were: ${Object.keys(records[0] ?? {}).join(', ') || '(none)'}. A statement needs a date, a type and an amount.`,
      );
    }

    const rules = readRules(conn.movementRules);
    const ours = await this.ledger(conn, rules);

    const settled = rows.filter((r) => has(SETTLED, r.status));
    const sorted = [...settled].sort((a, b) => +a.at - +b.at);
    const ledgerTo = ours.reduce<Date | null>(
      (max, o) => (o.at && (!max || o.at > max) ? o.at : max),
      null,
    );

    /**
     * The trap this exists to disarm.
     *
     * A statement pulled at nine in the morning covers payments our own ledger
     * export stopped short of, and every one of them reads as money the
     * provider moved and we never recorded. It happened while this was being
     * written: ten Mauritius withdrawals worth 431.34, all of them stamped on
     * the last day, all of them phantoms. Nothing was missing — the comparison
     * was between windows of different lengths.
     *
     * So the overhang is named before any figure is shown, and the figures are
     * cut at our own last record rather than pretending to cover ground we do
     * not hold.
     */
    const overhang = ledgerTo
      ? sorted.filter((r) => r.at > ledgerTo)
      : sorted.slice();
    const boundary =
      overhang.length && ledgerTo
        ? `${overhang.length} payment(s) on the statement are dated after the last one we hold (${ledgerTo.toISOString().slice(0, 16).replace('T', ' ')}). They are left out — comparing a longer window against a shorter one reports the difference as missing money, and it is not.`
        : null;
    const inWindow = ledgerTo ? sorted.filter((r) => r.at <= ledgerTo) : [];

    const used = new Set<number>();
    const uncounted = new Map<string, { payments: number; value: number }>();
    const amountErrors: ReconcileReport['amountErrors'] = [];
    const missing: ReconcileReport['missing'] = [];
    let matched = 0;
    let countedIn = 0;
    let countedOut = 0;
    let countedPayments = 0;
    let net = 0;

    for (const s of inWindow) {
      let best: { i: number; o: Ours; gap: number } | null = null;
      for (let i = 0; i < ours.length; i++) {
        if (used.has(i)) continue;
        const o = ours[i];
        if (!o.at || directionOf(o.direction) !== s.direction) continue;
        const gap = (+s.at - +o.at) / 1000;
        if (gap < EARLY_S || gap > LATE_S) continue;
        if (!best || Math.abs(gap) < Math.abs(best.gap)) best = { i, o, gap };
      }

      // Nothing of ours at all. The money left or arrived and our ledger never
      // heard: the one case where a per-payment check beats every total.
      if (!best) {
        missing.push({
          at: s.at.toISOString(),
          direction: s.direction,
          amount: round(s.amount),
        });
        net += s.direction === 'out' ? s.amount : -s.amount;
        continue;
      }

      used.add(best.i);
      matched++;
      const o = best.o;

      if (!o.counts) {
        // Held under a status the rules exclude. On one terminal every such row
        // was an address nobody ever paid into, which is right to exclude; on
        // the other, fourteen of them had actually completed. The difference is
        // invisible without the provider's own word for it, which is this.
        const key = `${s.direction}\u0000${o.status || '(no status)'}`;
        const acc = uncounted.get(key) ?? { payments: 0, value: 0 };
        acc.payments++;
        acc.value += s.amount;
        uncounted.set(key, acc);
        net += s.direction === 'out' ? s.amount : -s.amount;
        continue;
      }

      countedPayments++;
      if (s.direction === 'in') countedIn += s.amount;
      else countedOut += s.amount;

      const diff = s.amount - o.amount;
      if (Math.abs(diff) > 0.01) {
        amountErrors.push({
          at: s.at.toISOString(),
          direction: s.direction,
          reference: o.reference,
          customer: o.customer,
          ours: round(o.amount),
          theirs: round(s.amount),
          difference: round(diff),
        });
        net += s.direction === 'out' ? diff : -diff;
      }
    }

    return {
      statement: {
        rows: rows.length,
        settled: settled.length,
        ignored: rows.length - settled.length,
        unreadable,
        from: sorted[0]?.at.toISOString() ?? null,
        to: sorted[sorted.length - 1]?.at.toISOString() ?? null,
        columns,
      },
      ledger: { payments: ours.length, to: ledgerTo?.toISOString() ?? null },
      boundary,
      matched,
      counted: {
        payments: countedPayments,
        in: round(countedIn),
        out: round(countedOut),
      },
      uncounted: [...uncounted.entries()]
        .map(([k, v]) => {
          const [direction, status] = k.split('\u0000');
          return {
            direction: direction as 'in' | 'out',
            status,
            payments: v.payments,
            value: round(v.value),
          };
        })
        .sort((a, b) => b.value - a.value),
      amountErrors: amountErrors.sort(
        (a, b) => Math.abs(b.difference) - Math.abs(a.difference),
      ),
      missing: missing.sort((a, b) => b.amount - a.amount),
      net: round(net),
    };
  }

  /** One row per payment, with whether the rules in force count it. */
  private async ledger(
    conn: { id: string; terminal: string; ledgerSource: string },
    rules: MovementRules | null,
  ): Promise<Ours[]> {
    const counts = (status: string | null, direction: string | null) =>
      (!rules?.statuses?.length || has(rules.statuses, status)) &&
      (has(rules?.add, direction) || has(rules?.subtract, direction));

    if (conn.ledgerSource === 'paymaxis') {
      const events = await this.prisma.paymentEvent.findMany({
        where: { terminal: conn.terminal },
        orderBy: [{ occurredAt: 'desc' }, { receivedAt: 'desc' }],
        take: MAX_EVENTS,
        select: {
          id: true,
          paymentId: true,
          externalId: true,
          occurredAt: true,
          receivedAt: true,
          reference: true,
          customer: true,
          type: true,
          state: true,
          amount: true,
        },
      });
      // Per PAYMENT, not per event: Paymaxis sends PENDING and COMPLETED for
      // the same money, and counting both would double every deposit.
      return latestPerPayment(events).map((r) => {
        const e = r as (typeof events)[number];
        return {
          at: raisedAt(e.reference, e.occurredAt),
          direction: e.type,
          amount: Number(e.amount ?? 0),
          status: e.state ?? '',
          reference: e.reference,
          customer: e.customer,
          counts: counts(e.state, e.type),
        };
      });
    }

    const rows = await this.prisma.pspTransaction.findMany({
      where: { connectionId: conn.id },
      select: {
        reference: true,
        customer: true,
        direction: true,
        status: true,
        amount: true,
        occurredAt: true,
        settledAt: true,
      },
    });
    return rows.map((r) => ({
      at: raisedAt(r.reference, r.settledAt ?? r.occurredAt),
      direction: r.direction,
      amount: Number(r.amount ?? 0),
      status: r.status ?? '',
      reference: r.reference,
      customer: r.customer,
      counts: counts(r.status, r.direction),
    }));
  }
}
