/**
 * What actually happens after a payment is declined — measured here, not
 * quoted from anybody's benchmark.
 *
 * The industry number is "about one in four declines can be recovered". That
 * figure is true of somebody else's traffic and worthless as a decision: it
 * cannot tell this desk WHICH declines are worth chasing, and chasing the
 * wrong ones costs a fee per attempt and annoys customers whose card is
 * genuinely dead.
 *
 * So this measures the desk's own history: after a decline, did that customer
 * try again, and did it work? Grouped by the provider's own decline code,
 * which turns an opinion into a ranked list — these codes recover, those do
 * not, and here is the money that came back last month.
 *
 * WHAT THIS CANNOT KNOW, stated plainly because the number is useless if the
 * limits are not: nothing in the data says "this payment is a retry of that
 * one". Only refunds carry a parent id. A retry is therefore INFERRED — the
 * same customer, the same amount, within a few hours of a decline — and the
 * inference is wrong in both directions. A customer who tries again with a
 * different card for a different amount is missed; a customer who genuinely
 * pays twice for two things looks like a recovery. The window is kept short
 * and the amount must match exactly, which makes the guess conservative: it
 * under-counts rather than flatters.
 */

export type AttemptRow = {
  key: string;
  customer: string | null;
  psp: string | null;
  amount: number;
  currency: string | null;
  state: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  at: Date;
};

/**
 * How long after a decline a second attempt still counts as the same attempt.
 *
 * Six hours: long enough to catch a customer who went and found another card
 * or waited for their bank, short enough that tomorrow's genuine second
 * deposit is not counted as today's recovery.
 */
const RETRY_WINDOW_MS = 6 * 60 * 60_000;

const SETTLED = /complete|success|settle|approv|paid|finish|confirm/i;
const DECLINED = /declin|fail|reject|error|void|chargeback/i;

export type CodeRecovery = {
  /** The provider's own code, or its message when there is no code. */
  code: string;
  label: string;
  declines: number;
  /** Declines where the customer tried again, however it turned out. */
  retried: number;
  /** Retries that settled. */
  recovered: number;
  /** recovered ÷ retried — of those who tried again, how many got through. */
  recoveryRate: number | null;
  /** recovered ÷ declines — the share of this code that ends up recovered. */
  overallRate: number | null;
  /** Money that came back, from the settled retry. */
  recoveredAmount: number;
  /** Declines nobody ever retried. The queue worth working. */
  neverRetried: number;
  /** Value of those, at the declined amount. */
  neverRetriedAmount: number;
  /** Did switching provider help? Only counted where a retry changed psp. */
  switchedProvider: { retried: number; recovered: number };
  /** Median minutes between the decline and the successful retry. */
  medianMins: number | null;
};

export type RecoveryReport = {
  declines: number;
  retried: number;
  recovered: number;
  recoveredAmount: number;
  recoveryRate: number | null;
  codes: CodeRecovery[];
  /** Declines with no retry, worst code first — what to chase. */
  worthChasing: {
    code: string;
    label: string;
    neverRetried: number;
    amount: number;
    /** The observed recovery rate for this code, when anyone did retry. */
    recoveryRate: number | null;
  }[];
};

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

const codeOf = (r: AttemptRow) =>
  (r.errorCode ?? '').trim() ||
  (r.errorMessage ?? '').trim().slice(0, 60) ||
  'No code given';

/**
 * Pairs each decline with the customer's next attempt, if there was one.
 *
 * `rows` must be EVERY attempt in the period — one row per payment at its
 * latest state — not just the declines, because the recovery is a different
 * payment.
 */
export function buildRecovery(rows: AttemptRow[]): RecoveryReport {
  const declines = rows.filter((r) => DECLINED.test(r.state ?? ''));

  // Everything a customer did, in order, so a decline can look forward.
  const byCustomer = new Map<string, AttemptRow[]>();
  for (const r of rows) {
    if (!r.customer) continue;
    const list = byCustomer.get(r.customer);
    if (list) list.push(r);
    else byCustomer.set(r.customer, [r]);
  }
  for (const list of byCustomer.values()) {
    list.sort((a, b) => a.at.getTime() - b.at.getTime());
  }

  type Acc = {
    declines: number;
    retried: number;
    recovered: number;
    recoveredAmount: number;
    neverRetried: number;
    neverRetriedAmount: number;
    switchedRetried: number;
    switchedRecovered: number;
    gaps: number[];
  };
  const codes = new Map<string, Acc>();
  const acc = (code: string): Acc => {
    const found = codes.get(code);
    if (found) return found;
    const made: Acc = {
      declines: 0,
      retried: 0,
      recovered: 0,
      recoveredAmount: 0,
      neverRetried: 0,
      neverRetriedAmount: 0,
      switchedRetried: 0,
      switchedRecovered: 0,
      gaps: [],
    };
    codes.set(code, made);
    return made;
  };

  let totalRetried = 0;
  let totalRecovered = 0;
  let totalRecoveredAmount = 0;

  for (const d of declines) {
    const code = codeOf(d);
    const a = acc(code);
    a.declines += 1;

    const history = d.customer ? (byCustomer.get(d.customer) ?? []) : [];
    // The next attempt by the same customer, for the same amount, inside the
    // window. Same amount is what makes this a retry rather than a second
    // purchase — a weak signal, but the only honest one available.
    const retry = history.find(
      (r) =>
        r.key !== d.key &&
        r.at.getTime() > d.at.getTime() &&
        r.at.getTime() - d.at.getTime() <= RETRY_WINDOW_MS &&
        Math.abs(Math.abs(r.amount) - Math.abs(d.amount)) < 0.01 &&
        (r.currency ?? '') === (d.currency ?? ''),
    );

    if (!retry) {
      a.neverRetried += 1;
      a.neverRetriedAmount += Math.abs(d.amount);
      continue;
    }

    a.retried += 1;
    totalRetried += 1;
    const switched = (retry.psp ?? '') !== (d.psp ?? '');
    if (switched) a.switchedRetried += 1;

    if (SETTLED.test(retry.state ?? '')) {
      a.recovered += 1;
      a.recoveredAmount += Math.abs(retry.amount);
      a.gaps.push(Math.round((retry.at.getTime() - d.at.getTime()) / 60_000));
      if (switched) a.switchedRecovered += 1;
      totalRecovered += 1;
      totalRecoveredAmount += Math.abs(retry.amount);
    }
  }

  const list: CodeRecovery[] = [...codes.entries()]
    .map(([code, a]) => ({
      code,
      label: code,
      declines: a.declines,
      retried: a.retried,
      recovered: a.recovered,
      // Null, not zero, when nobody retried: "none of the retries worked" and
      // "nobody tried" are different facts and lead to different actions.
      recoveryRate: a.retried
        ? Math.round((a.recovered / a.retried) * 1000) / 10
        : null,
      overallRate: a.declines
        ? Math.round((a.recovered / a.declines) * 1000) / 10
        : null,
      recoveredAmount: Math.round(a.recoveredAmount * 100) / 100,
      neverRetried: a.neverRetried,
      neverRetriedAmount: Math.round(a.neverRetriedAmount * 100) / 100,
      switchedProvider: {
        retried: a.switchedRetried,
        recovered: a.switchedRecovered,
      },
      medianMins: median(a.gaps),
    }))
    .sort((a, b) => b.declines - a.declines);

  return {
    declines: declines.length,
    retried: totalRetried,
    recovered: totalRecovered,
    recoveredAmount: Math.round(totalRecoveredAmount * 100) / 100,
    recoveryRate: totalRetried
      ? Math.round((totalRecovered / totalRetried) * 1000) / 10
      : null,
    codes: list,
    // The queue: declines nobody chased, ordered by the money sitting in them,
    // and only for codes that have EVER been recovered. A code with a proven
    // 0% recovery rate is not worth a customer's time or a retry fee, and
    // putting it at the top of a work queue is how the queue gets abandoned.
    worthChasing: list
      .filter((c) => c.neverRetried > 0 && (c.recoveryRate ?? 0) > 0)
      .map((c) => ({
        code: c.code,
        label: c.label,
        neverRetried: c.neverRetried,
        amount: c.neverRetriedAmount,
        recoveryRate: c.recoveryRate,
      }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10),
  };
}
