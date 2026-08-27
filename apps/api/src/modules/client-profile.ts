/**
 * Everything one customer has done, from the payments we hold.
 *
 * The customer reference is the only identity Paymaxis gives us on every
 * payment, and it is what a client quotes when they call. Until now it was a
 * column of text: seeing whether CU52405 had ever successfully deposited meant
 * filtering the table by hand and adding the rows up.
 *
 * Two honesty rules run through this file.
 *
 * First, a payment is stored once per state it passes through, so summing the
 * rows would count a payment that went PENDING -> COMPLETED twice. Every figure
 * here is computed from payments already collapsed to their latest state.
 *
 * Second, our totals only cover what we have ingested. Paymaxis reports its own
 * lifetime figures per customer, computed over the account's whole history
 * including payments made before this dashboard existed, so where those are
 * present they are reported separately rather than blended — a total that
 * silently means "since we started polling" is the kind of number that gets
 * repeated in a meeting as though it meant "ever".
 */

import {
  isFailedState,
  isSettledState,
  providerLabel,
} from '../paymaxis/normalize';
import { paymentFieldValues, type MappedRow } from './payment-fields';

export type Tally = { count: number; amount: number };

export type CurrencyTotals = {
  currency: string;
  deposits: Tally;
  withdrawals: Tally;
  refunds: Tally;
  /** Attempts that did not settle, for context beside the settled figures. */
  declined: Tally;
  /** Still in flight at the last state we saw. */
  pending: Tally;
};

export type ClientProfile = {
  reference: string;
  email: string | null;
  phone: string | null;
  accountNumber: string | null;
  country: string | null;
  citizenshipCountry: string | null;
  kycStatus: string | null;
  entity: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  payments: number;
  /**
   * Paymaxis's own lifetime counters, when the payload carries them. Null when
   * it does not — an absent figure is left absent rather than replaced with
   * ours under the same label.
   */
  providerLifetime: {
    depositsCount: number | null;
    depositsAmount: number | null;
    withdrawalsCount: number | null;
    withdrawalsAmount: number | null;
    dateOfFirstDeposit: string | null;
  };
  /** Per currency, because adding USD to EUR produces a number that means nothing. */
  totals: CurrencyTotals[];
  methods: { label: string; count: number; amount: number }[];
  psps: {
    psp: string;
    count: number;
    amount: number;
    successRate: number | null;
  }[];
  /** Why this client's payments fail, most common first. */
  declineReasons: { reason: string; code: string | null; count: number }[];
  /**
   * Every payment in the window, newest first — not a sample of it.
   *
   * This used to be the twelve most recent, which answered "what happened
   * lately" but not "show me their deposits and withdrawals", the question
   * people actually opened it for. A list that stops at twelve without saying so
   * reads as a complete history that happens to be short.
   */
  history: HistoryEntry[];
  /** The window these figures cover. Null bounds mean the whole history. */
  window: {
    from: string | null;
    to: string | null;
    /** True when the store held more than this request would read. */
    truncated: boolean;
    /** The span we hold ANY payment for, whatever the window asked for. */
    heldFrom: string | null;
    heldTo: string | null;
    /**
     * The whole store, not this client: how many payments it holds and the span
     * they cover. A client whose history starts where the store starts has not
     * been quiet — nothing older has been fetched yet — and that distinction is
     * the difference between reassuring a customer and going to import. Stated
     * as figures rather than a verdict, so the reader can judge it.
     */
    storeFrom: string | null;
    storeTo: string | null;
    storePayments: number;
    /**
     * Every identity these figures were gathered under. The provider files a
     * payment against whichever of referenceId / email / account number the
     * payload carried, so a client can be several strings; showing them makes a
     * wrong merge visible instead of silent.
     */
    identities: string[];
  };
};

export type HistoryEntry = {
  id: string;
  reference: string;
  type: 'Deposit' | 'Withdrawal' | 'Refund';
  /** Colour bucket for the badge; `state` is the provider's own wording. */
  status: 'approved' | 'declined' | 'pending';
  state: string | null;
  amount: number;
  currency: string | null;
  psp: string | null;
  method: string | null;
  at: string | null;
};

const tally = (): Tally => ({ count: 0, amount: 0 });

function add(t: Tally, amount: number) {
  t.count += 1;
  t.amount = Math.round((t.amount + amount) * 100) / 100;
}

function kindOf(type: string | null): 'deposit' | 'withdrawal' | 'refund' {
  const t = type ?? '';
  if (/refund/i.test(t)) return 'refund';
  if (/withdraw|payout/i.test(t)) return 'withdrawal';
  return 'deposit';
}

/**
 * @param rows One row per payment, latest state, newest first.
 * @param window What the caller asked for and what the store actually holds, so
 *   the figures can be labelled with the period they cover.
 */
export function buildClientProfile(
  reference: string,
  rows: MappedRow[],
  window: ClientProfile['window'] = {
    from: null,
    to: null,
    truncated: false,
    heldFrom: null,
    heldTo: null,
    storeFrom: null,
    storeTo: null,
    storePayments: 0,
    identities: [],
  },
): ClientProfile {
  const byCurrency = new Map<string, CurrencyTotals>();
  const methods = new Map<string, { count: number; amount: number }>();
  const psps = new Map<
    string,
    { count: number; amount: number; settled: number; decided: number }
  >();
  const reasons = new Map<
    string,
    { reason: string; code: string | null; count: number }
  >();

  // The newest payment that carries each identity field wins: an email or a KYC
  // status can change, and the current value is the useful one.
  const identity = {
    email: null,
    phone: null,
    accountNumber: null,
    country: null,
    citizenship: null,
    kyc: null,
  } as Record<string, string | null>;
  const lifetime = {
    depositsCount: null as number | null,
    depositsAmount: null as number | null,
    withdrawalsCount: null as number | null,
    withdrawalsAmount: null as number | null,
    dateOfFirstDeposit: null as string | null,
  };

  let entity: string | null = null;
  let firstSeen: Date | null = null;
  let lastSeen: Date | null = null;

  for (const r of rows) {
    const f = paymentFieldValues(r);
    const amount = Math.abs(r.amount);
    const currency = r.currency || '—';
    const settled = isSettledState(r.state ?? '');
    const failed = isFailedState(r.state ?? '');

    const totals = byCurrency.get(currency) ?? {
      currency,
      deposits: tally(),
      withdrawals: tally(),
      refunds: tally(),
      declined: tally(),
      pending: tally(),
    };
    byCurrency.set(currency, totals);

    // Settled money is counted by direction; everything else is counted as what
    // it is. A declined deposit is not a deposit, and folding it into the total
    // would overstate what this client has actually paid in.
    if (settled) {
      const kind = kindOf(r.type);
      add(
        kind === 'refund'
          ? totals.refunds
          : kind === 'withdrawal'
            ? totals.withdrawals
            : totals.deposits,
        amount,
      );
    } else if (failed) {
      add(totals.declined, amount);
    } else {
      add(totals.pending, amount);
    }

    const methodLabel =
      typeof f.methodLabel === 'string' ? f.methodLabel : null;
    if (methodLabel) {
      const m = methods.get(methodLabel) ?? { count: 0, amount: 0 };
      m.count += 1;
      if (settled) m.amount = Math.round((m.amount + amount) * 100) / 100;
      methods.set(methodLabel, m);
    }

    if (r.psp) {
      const p = psps.get(r.psp) ?? {
        count: 0,
        amount: 0,
        settled: 0,
        decided: 0,
      };
      p.count += 1;
      if (settled) {
        p.amount = Math.round((p.amount + amount) * 100) / 100;
        p.settled += 1;
      }
      // Only decided payments can have a success rate; counting in-flight ones
      // as failures would show a client's provider as worse than it is.
      if (settled || failed) p.decided += 1;
      psps.set(r.psp, p);
    }

    if (failed && (r.errorMessage || r.errorCode)) {
      const reason = r.errorMessage || `Code ${r.errorCode}`;
      const e = reasons.get(reason) ?? { reason, code: r.errorCode, count: 0 };
      e.count += 1;
      reasons.set(reason, e);
    }

    const pick = (k: string, v: unknown) => {
      if (identity[k] === null && typeof v === 'string' && v) identity[k] = v;
    };
    pick('email', f.customerEmail);
    pick('phone', f.customerPhone);
    pick('accountNumber', f.customerAccountNumber);
    pick('country', f.billingCountry ?? f.ipCountry);
    pick('citizenship', f.citizenshipCountry);
    pick('kyc', f.kycStatus);
    if (!entity && r.entity) entity = r.entity;

    const num = (v: unknown) => (typeof v === 'number' ? v : null);
    if (lifetime.depositsCount === null)
      lifetime.depositsCount = num(f.depositsCount);
    if (lifetime.depositsAmount === null)
      lifetime.depositsAmount = num(f.depositsAmount);
    if (lifetime.withdrawalsCount === null)
      lifetime.withdrawalsCount = num(f.withdrawalsCount);
    if (lifetime.withdrawalsAmount === null)
      lifetime.withdrawalsAmount = num(f.withdrawalsAmount);
    if (
      lifetime.dateOfFirstDeposit === null &&
      typeof f.dateOfFirstDeposit === 'string'
    ) {
      lifetime.dateOfFirstDeposit = f.dateOfFirstDeposit;
    }

    const at = r.occurredAt ?? r.receivedAt;
    if (!lastSeen || at > lastSeen) lastSeen = at;
    if (!firstSeen || at < firstSeen) firstSeen = at;
  }

  return {
    reference,
    email: identity.email,
    phone: identity.phone,
    accountNumber: identity.accountNumber,
    country: identity.country,
    citizenshipCountry: identity.citizenship,
    kycStatus: identity.kyc,
    entity,
    firstSeen: firstSeen ? firstSeen.toISOString() : null,
    lastSeen: lastSeen ? lastSeen.toISOString() : null,
    payments: rows.length,
    providerLifetime: lifetime,
    // Busiest currency first, so a stray payment in another currency does not
    // head the list.
    totals: [...byCurrency.values()].sort(
      (a, b) => b.deposits.amount - a.deposits.amount,
    ),
    methods: [...methods.entries()]
      .map(([label, m]) => ({ label, ...m }))
      .sort((a, b) => b.count - a.count),
    psps: [...psps.entries()]
      .map(([psp, p]) => ({
        psp,
        count: p.count,
        amount: p.amount,
        successRate: p.decided
          ? Number(((p.settled / p.decided) * 100).toFixed(1))
          : null,
      }))
      .sort((a, b) => b.count - a.count),
    declineReasons: [...reasons.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
    window,
    history: rows.map((r) => {
      const f = paymentFieldValues(r);
      return {
        id: r.id,
        reference: r.paymentId || r.reference || r.id,
        type:
          kindOf(r.type) === 'refund'
            ? 'Refund'
            : kindOf(r.type) === 'withdrawal'
              ? 'Withdrawal'
              : 'Deposit',
        status: isSettledState(r.state ?? '')
          ? ('approved' as const)
          : isFailedState(r.state ?? '')
            ? ('declined' as const)
            : ('pending' as const),
        state: providerLabel(r.state),
        amount: Math.abs(r.amount),
        currency: r.currency,
        psp: r.psp,
        method: typeof f.methodLabel === 'string' ? f.methodLabel : null,
        at: (r.occurredAt ?? r.receivedAt).toISOString(),
      };
    }),
  };
}
