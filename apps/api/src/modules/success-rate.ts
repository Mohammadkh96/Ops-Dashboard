/**
 * The payment overview: how much moved, how much of it succeeded, and what
 * happened to the rest.
 *
 * Four groups — everything, deposits, withdrawals, refunds — each answering the
 * same three questions in the same shape, because the question "is today going
 * well" is asked of all four at once and a different layout per group makes them
 * uncomparable.
 *
 * Three definitions are choices, and the UI states each one rather than leaving
 * a number to be interpreted:
 *
 *  1. SUCCESS RATE is completed ÷ (completed + declined). A payment the customer
 *     abandoned and one still in flight are not failures of the payment rail,
 *     and counting them as such makes a quiet morning look like an outage. Both
 *     are still shown, in the bar and the legend, so nothing is hidden — only
 *     kept out of a rate that is meant to measure whether the rail works.
 *
 *  2. DIRECTION is signed. Deposits come in; withdrawals and refunds go out and
 *     are negative. The total is their sum, which is net flow — the figure that
 *     answers "did more money arrive than left", rather than a gross number that
 *     grows when a customer withdraws.
 *
 *  3. THE BAR is share of payment COUNT, not value. One €50,000 withdrawal
 *     beside forty small deposits would otherwise paint the day as a single
 *     colour, when the operational picture is forty-one payments.
 *
 * Amounts are whatever the provider booked in the shop's base currency, which is
 * what makes them addable at all; the currencies actually seen are reported so
 * the UI can say so instead of implying one.
 */

export type StateKey = 'completed' | 'declined' | 'cancelled' | 'pending';

export type StateSlice = {
  key: StateKey;
  count: number;
  amount: number;
  /** Share of this group's payments, by count. 0–100. */
  share: number;
};

export type GroupKey = 'total' | 'deposits' | 'withdrawals' | 'refunds';

export type SuccessGroup = {
  key: GroupKey;
  label: string;
  /** Signed: money in minus money out. */
  amount: number;
  count: number;
  /** Completed ÷ decided, 0–100. Null when nothing has been decided yet — a
   *  rate over zero payments is not 0%, it is unknown, and 0% reads as an
   *  outage. */
  successRate: number | null;
  decided: number;
  slices: StateSlice[];
};

export type SuccessRateReport = {
  groups: SuccessGroup[];
  from: string | null;
  to: string | null;
  currencies: string[];
  /** Payments considered, after collapsing each to its latest state. */
  payments: number;
};

export type SuccessRow = {
  type: string | null;
  state: string | null;
  amount: number;
  currency: string | null;
};

const LABELS: Record<GroupKey, string> = {
  total: 'Total',
  deposits: 'Deposits',
  withdrawals: 'Withdrawals',
  refunds: 'Refunds',
};

const ORDER: StateKey[] = ['completed', 'declined', 'cancelled', 'pending'];

/**
 * Which of the four buckets a provider state belongs to.
 *
 * Cancelled is separated from declined on purpose, though both are "not
 * settled": a customer who closed the window and an issuer that refused are
 * different problems with different owners, and merging them hides whichever is
 * smaller. This is deliberately narrower than isFailedState, which groups every
 * non-success together for reconciliation, where the only question is whether
 * money moved.
 */
export function stateBucket(
  state: string | null,
  settled: (s: string) => boolean,
): StateKey {
  const s = (state ?? '').toUpperCase();
  if (settled(s)) return 'completed';
  if (/CANCEL|VOID|ABANDON|EXPIRE|TIMEOUT/.test(s)) return 'cancelled';
  if (/DECLIN|FAIL|REJECT|ERROR|CHARGEBACK|FRAUD/.test(s)) return 'declined';
  return 'pending';
}

/** Deposit, withdrawal or refund — the three directions money moves. */
export function directionOf(type: string | null): Exclude<GroupKey, 'total'> {
  const t = (type ?? '').toUpperCase();
  if (/REFUND/.test(t)) return 'refunds';
  if (/WITHDRAW|PAYOUT/.test(t)) return 'withdrawals';
  return 'deposits';
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * @param rows One row per payment, already collapsed to its latest state.
 */
export function buildSuccessRate(
  rows: SuccessRow[],
  opts: {
    settled: (s: string) => boolean;
    from?: string | null;
    to?: string | null;
  },
): SuccessRateReport {
  const blank = (key: GroupKey): SuccessGroup => ({
    key,
    label: LABELS[key],
    amount: 0,
    count: 0,
    successRate: null,
    decided: 0,
    slices: ORDER.map((k) => ({ key: k, count: 0, amount: 0, share: 0 })),
  });

  const groups: Record<GroupKey, SuccessGroup> = {
    total: blank('total'),
    deposits: blank('deposits'),
    withdrawals: blank('withdrawals'),
    refunds: blank('refunds'),
  };
  const currencies = new Set<string>();

  for (const r of rows) {
    const dir = directionOf(r.type);
    const bucket = stateBucket(r.state, opts.settled);
    // Out is negative, so the total is net flow rather than gross turnover.
    const signed = (dir === 'deposits' ? 1 : -1) * Math.abs(r.amount);
    if (r.currency) currencies.add(r.currency);

    for (const g of [groups[dir], groups.total]) {
      g.count += 1;
      const slice = g.slices.find((s) => s.key === bucket)!;
      slice.count += 1;
      slice.amount = round2(slice.amount + signed);
      // Only settled money counts toward the headline. A declined deposit is
      // not revenue, and adding it in would report a day of failures as a
      // record day.
      if (bucket === 'completed') g.amount = round2(g.amount + signed);
      if (bucket === 'completed' || bucket === 'declined') g.decided += 1;
    }
  }

  for (const g of Object.values(groups)) {
    const completed = g.slices.find((s) => s.key === 'completed')!.count;
    g.successRate = g.decided
      ? Math.round((completed / g.decided) * 100)
      : null;
    g.slices.forEach((s) => {
      s.share = g.count ? Math.round((s.count / g.count) * 100) : 0;
    });
  }

  return {
    groups: [groups.total, groups.deposits, groups.withdrawals, groups.refunds],
    from: opts.from ?? null,
    to: opts.to ?? null,
    currencies: [...currencies].sort(),
    payments: rows.length,
  };
}
