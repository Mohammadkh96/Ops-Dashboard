/**
 * Incidents the payment data is already telling us about.
 *
 * The page used to list four invented incidents — a ForumPay outage, a Visa EU
 * decline spike — that never changed and never referred to anything. On an
 * operations screen that is worse than an empty page: it trains whoever is on
 * the desk to ignore the one place an outage should appear.
 *
 * There is no incident-management system to read from, but the dashboard
 * already holds the evidence an incident is made of: every payment, its
 * provider, its state and when it reached it. So the incidents here are derived
 * from that, and each one carries the numbers that produced it. Nothing is
 * asserted that cannot be checked against the rows.
 *
 * Two rules govern what counts as a detection:
 *
 *   1. Compare a provider against ITSELF. "Zero settled payments in an hour" is
 *      an outage for a provider that settles all day and meaningless for one
 *      that takes two payments a week. Every rule below is a change against
 *      that provider's own recent baseline.
 *   2. Say the numbers. Every detection lists the counts behind it, so the
 *      person reading can disagree with it — a threshold nobody can inspect
 *      gets ignored the second time it is wrong.
 *
 * Detections are transient by design: they live while the condition holds and
 * disappear when it clears. Declaring one turns it into a persisted incident,
 * copying the evidence, because by then the condition may already be over.
 */

export type DetectionKind =
  | 'psp-failing'
  | 'decline-spike'
  | 'stuck-in-flight'
  | 'data-stopped'
  | 'double-charge';

/**
 * One of the payments the detection is about.
 *
 * A count is enough to raise an incident and never enough to work one: the
 * first question after "54 payments are stuck" is always "which ones" — the
 * references to quote to the provider, the customers to warn, whether it is one
 * terminal or all of them. Without these, whoever is on the desk has to go and
 * reconstruct the query the detector just ran.
 */
export type DetectionSample = {
  reference: string;
  customer: string | null;
  psp: string | null;
  type: string | null;
  amount: number;
  currency: string | null;
  state: string | null;
  at: string;
  /** How long it has been in this state, in minutes. */
  ageMins: number;
};

export type Detection = {
  /** Stable across runs for the same condition, so declaring one twice reopens
   *  the same incident rather than making a second. */
  signature: string;
  kind: DetectionKind;
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  impact: string;
  /** The counts behind the call, in the order a human would check them. */
  evidence: string[];
  /** The payments themselves, worst/oldest first. Capped — the count in the
   *  evidence is the true total. */
  samples: DetectionSample[];
  /** How many payments the condition covers, when more than the samples shown. */
  sampleTotal: number;
  /** When the condition started, as far as the data shows. */
  since: string | null;
  psp: string | null;
};

/** One payment, already collapsed to its latest state. */
export type DetectRow = {
  /** What a person would quote: the provider's payment id or our reference. */
  reference: string;
  customer: string | null;
  psp: string | null;
  state: string | null;
  type: string | null;
  amount: number;
  currency: string | null;
  at: Date;
};

export type DetectInput = {
  /** Latest-state payments over the baseline window, newest first. */
  rows: DetectRow[];
  now: Date;
  /** When a payment was last received from anywhere. */
  lastEventAt: Date | null;
  /** Whether polling is configured at all — with no credentials, silence is
   *  expected and reporting it as an incident would be noise. */
  pollConfigured: boolean;
  settled: (state: string) => boolean;
  failed: (state: string) => boolean;
};

/** The window a "right now" claim is made over. */
const RECENT_MS = 60 * 60_000;
/** What "normally" means: the 24 hours before the recent window. */
const BASELINE_MS = 24 * 60 * 60_000;
/** Below this, an hour's worth of payments is too few to call anything. */
const MIN_DECIDED = 5;
/** A decline rate this much higher than the provider's own baseline. */
const SPIKE_POINTS = 25;
/** A payment past this age with no final state is stuck, not in flight. */
const STUCK_MS = 60 * 60_000;
const MIN_STUCK = 3;
/** Silence longer than this, while polling is configured, is a fault. */
const SILENCE_MS = 2 * 60 * 60_000;
/**
 * Two identical settled charges closer together than this are one charge that
 * landed twice.
 *
 * Ten minutes, not an hour: a customer topping up twice in an evening is
 * ordinary and must not be reported, while a customer who pressed pay again
 * because the first attempt looked stuck does it within a minute or two. The
 * window has to be short enough that a match is surprising.
 */
const DOUBLE_CHARGE_MS = 10 * 60_000;

/** Enough to see the pattern — one terminal or all of them — without a wall. */
const MAX_SAMPLES = 25;

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

function toSamples(rows: DetectRow[], now: Date): DetectionSample[] {
  return rows.slice(0, MAX_SAMPLES).map((r) => ({
    reference: r.reference,
    customer: r.customer,
    psp: r.psp,
    type: r.type,
    amount: r.amount,
    currency: r.currency,
    state: r.state,
    at: r.at.toISOString(),
    ageMins: Math.max(0, Math.round((now.getTime() - r.at.getTime()) / 60_000)),
  }));
}

function fmtAge(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

export function detectIncidents(input: DetectInput): Detection[] {
  const { rows, now, settled, failed } = input;
  const out: Detection[] = [];

  const recentFrom = new Date(now.getTime() - RECENT_MS);
  const baselineFrom = new Date(now.getTime() - BASELINE_MS);

  // ── Payment data has stopped arriving ────────────────────────────────────
  //
  // First, because every other rule reads the same data: if nothing is coming
  // in, a provider showing zero payments is a reporting failure, not an outage,
  // and calling it an outage would send someone to the wrong place.
  const silence = input.lastEventAt
    ? now.getTime() - input.lastEventAt.getTime()
    : null;
  if (input.pollConfigured && (silence === null || silence > SILENCE_MS)) {
    return [
      {
        signature: 'data-stopped',
        kind: 'data-stopped',
        severity: 'high',
        title: 'Payment data has stopped arriving',
        impact:
          'Every figure on this dashboard is as old as the last payment received. ' +
          'Provider-level detection is suspended until data resumes, because ' +
          'silence would otherwise look like an outage at every provider at once.',
        evidence: [
          input.lastEventAt
            ? `Last payment received ${fmtAge(silence as number)} ago (${input.lastEventAt.toISOString()}).`
            : 'No payment has ever been received.',
          `Polling is configured, so data was expected within ${fmtAge(SILENCE_MS)}.`,
          'Check the sync badge in the header and the API logs for a rejected key or an unreachable host.',
        ],
        samples: [],
        sampleTotal: 0,
        since: input.lastEventAt ? input.lastEventAt.toISOString() : null,
        psp: null,
      },
    ];
  }

  // ── Per-provider rules ───────────────────────────────────────────────────
  type Bucket = {
    recentSettled: number;
    recentFailed: number;
    baseSettled: number;
    baseFailed: number;
    firstFailureAt: Date | null;
    lastSettledAt: Date | null;
    failedAmount: number;
    currency: string | null;
    /** The failures themselves, so the incident can name them. */
    recentFailures: DetectRow[];
  };
  const byPsp = new Map<string, Bucket>();

  for (const r of rows) {
    if (!r.psp || r.at < baselineFrom) continue;
    const b = byPsp.get(r.psp) ?? {
      recentSettled: 0,
      recentFailed: 0,
      baseSettled: 0,
      baseFailed: 0,
      firstFailureAt: null,
      lastSettledAt: null,
      failedAmount: 0,
      currency: null,
      recentFailures: [],
    };
    const isRecent = r.at >= recentFrom;
    const ok = settled(r.state ?? '');
    const bad = failed(r.state ?? '');

    if (ok) {
      if (isRecent) b.recentSettled++;
      else b.baseSettled++;
      if (!b.lastSettledAt || r.at > b.lastSettledAt) b.lastSettledAt = r.at;
    } else if (bad) {
      if (isRecent) {
        b.recentFailed++;
        b.failedAmount =
          Math.round((b.failedAmount + Math.abs(r.amount)) * 100) / 100;
        b.currency = b.currency ?? r.currency;
        b.recentFailures.push(r);
        if (!b.firstFailureAt || r.at < b.firstFailureAt)
          b.firstFailureAt = r.at;
      } else b.baseFailed++;
    }
    byPsp.set(r.psp, b);
  }

  byPsp.forEach((b, psp) => {
    const recentDecided = b.recentSettled + b.recentFailed;
    const baseDecided = b.baseSettled + b.baseFailed;
    if (recentDecided < MIN_DECIDED) return; // too little to say anything

    // Everything is failing at a provider that was working. Not "a provider
    // with no successes" — one that has never settled here is a routing
    // question, not an outage.
    if (b.recentSettled === 0 && b.baseSettled > 0) {
      out.push({
        signature: `psp-failing:${psp}`,
        kind: 'psp-failing',
        severity: 'critical',
        title: `${psp} is declining everything`,
        impact:
          `Every ${psp} payment in the last hour failed. Customers routed there ` +
          `cannot fund, and the money is not arriving.`,
        evidence: [
          `${b.recentFailed} of ${recentDecided} decided payments failed in the last hour — a 0% success rate.`,
          `The same provider settled ${b.baseSettled} of ${baseDecided} in the 24 hours before that (${pct(b.baseSettled, baseDecided)}%).`,
          b.lastSettledAt
            ? `Last successful payment: ${b.lastSettledAt.toISOString()} (${fmtAge(now.getTime() - b.lastSettledAt.getTime())} ago).`
            : 'No successful payment in the window.',
          b.failedAmount
            ? `Value of the failed attempts: ${b.failedAmount.toLocaleString()} ${b.currency ?? ''}`.trim() +
              '.'
            : '',
        ].filter(Boolean),
        // Newest first: the most recent failures are the ones to quote when
        // asking the provider what changed.
        samples: toSamples(b.recentFailures, now),
        sampleTotal: b.recentFailures.length,
        since: b.firstFailureAt ? b.firstFailureAt.toISOString() : null,
        psp,
      });
      return; // a total outage is not also reported as a decline spike
    }

    // A decline rate well above this provider's own normal.
    if (baseDecided >= MIN_DECIDED) {
      const nowRate = pct(b.recentFailed, recentDecided);
      const baseRate = pct(b.baseFailed, baseDecided);
      if (nowRate - baseRate >= SPIKE_POINTS) {
        out.push({
          signature: `decline-spike:${psp}`,
          kind: 'decline-spike',
          severity: nowRate >= 70 ? 'high' : 'medium',
          title: `Declines up sharply at ${psp}`,
          impact:
            `${psp} is declining ${nowRate}% of payments against a normal of ${baseRate}%. ` +
            `Deposits that would have funded are being turned away.`,
          evidence: [
            `Last hour: ${b.recentFailed} declined of ${recentDecided} decided (${nowRate}%).`,
            `Previous 24 hours: ${b.baseFailed} of ${baseDecided} (${baseRate}%).`,
            `That is ${nowRate - baseRate} percentage points above this provider's own baseline (threshold ${SPIKE_POINTS}).`,
            b.failedAmount
              ? `Value of the declined attempts in the last hour: ${b.failedAmount.toLocaleString()} ${b.currency ?? ''}`.trim() +
                '.'
              : '',
          ].filter(Boolean),
          samples: toSamples(b.recentFailures, now),
          sampleTotal: b.recentFailures.length,
          since: b.firstFailureAt ? b.firstFailureAt.toISOString() : null,
          psp,
        });
      }
    }
  });

  // ── Payments that never reached a final state ────────────────────────────
  //
  // These are the ones that quietly cost money: the customer has paid, the
  // provider has not confirmed, and nothing in the daily figures says so.
  const stuck = rows.filter(
    (r) =>
      r.at >= baselineFrom &&
      now.getTime() - r.at.getTime() > STUCK_MS &&
      !settled(r.state ?? '') &&
      !failed(r.state ?? ''),
  );
  if (stuck.length >= MIN_STUCK) {
    const byState = new Map<string, number>();
    stuck.forEach((r) => {
      const k = r.state || 'unknown';
      byState.set(k, (byState.get(k) ?? 0) + 1);
    });
    const oldest = stuck.reduce((a, b) => (a.at < b.at ? a : b));
    const value =
      Math.round(stuck.reduce((s, r) => s + Math.abs(r.amount), 0) * 100) / 100;
    out.push({
      signature: 'stuck-in-flight',
      kind: 'stuck-in-flight',
      severity: stuck.length >= 10 ? 'high' : 'medium',
      title: `${stuck.length} payments stuck without a final state`,
      impact:
        'These are neither settled nor declined. Money may have left the customer ' +
        'with nothing confirming it, and they are invisible in settled totals.',
      evidence: [
        `${stuck.length} payments older than ${fmtAge(STUCK_MS)} have not reached a final state.`,
        `States: ${[...byState.entries()].map(([s, n]) => `${s} × ${n}`).join(', ')}.`,
        `Oldest: ${oldest.at.toISOString()} (${fmtAge(now.getTime() - oldest.at.getTime())} ago)${oldest.psp ? ` at ${oldest.psp}` : ''}.`,
        `Combined value: ${value.toLocaleString()} ${stuck[0].currency ?? ''}`.trim() +
          '.',
      ],
      // Oldest first: the payment that has been waiting longest is the one the
      // customer is already asking about.
      samples: toSamples(
        [...stuck].sort((a, b2) => a.at.getTime() - b2.at.getTime()),
        now,
      ),
      sampleTotal: stuck.length,
      since: oldest.at.toISOString(),
      psp: null,
    });
  }

  // ── the same customer charged twice for the same thing ──────────────────
  //
  // Two settled deposits, same customer, same amount, same terminal, minutes
  // apart. Almost always one payment the customer made twice — they pressed
  // again because the first one looked like it had failed — and occasionally a
  // provider that captured a retry as a second charge.
  //
  // This is the only rule here that catches money the desk owes BACK. Every
  // other detection is about payments that did not work; this one is about a
  // payment that worked twice, which is invisible in every figure the
  // dashboard shows — volume, success rate and settled totals all read a
  // double charge as a good day.
  //
  // Found before the customer finds it, a refund is an apology. Found after,
  // it is a chargeback, and chargebacks are counted against the acquirer at a
  // ratio that decides whether the account keeps its terminals.
  const settledDeposits = rows.filter(
    (r) =>
      r.at >= baselineFrom &&
      settled(r.state ?? '') &&
      // Withdrawals and refunds repeat legitimately; a customer being paid the
      // same amount twice is a payout schedule, not a mistake.
      !/withdraw|payout|refund/i.test(r.type ?? ''),
  );

  const byKey = new Map<string, DetectRow[]>();
  for (const r of settledDeposits) {
    if (!r.customer) continue; // nothing to say two payments came from one person
    // The amount is part of the key at 2dp: two different amounts minutes
    // apart is somebody topping up, not the same charge landing twice.
    const key = [
      r.customer,
      Math.abs(r.amount).toFixed(2),
      r.currency ?? '',
      r.psp ?? '',
    ].join('|');
    const list = byKey.get(key);
    if (list) list.push(r);
    else byKey.set(key, [r]);
  }

  const doubles: DetectRow[] = [];
  let pairs = 0;
  let doubledValue = 0;
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b2) => a.at.getTime() - b2.at.getTime());
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].at.getTime() - sorted[i - 1].at.getTime();
      if (gap > DOUBLE_CHARGE_MS) continue;
      pairs += 1;
      // Only the SECOND charge is the money owed back. Counting both would
      // double the figure being reported as a doubling.
      doubledValue += Math.abs(sorted[i].amount);
      if (!doubles.includes(sorted[i - 1])) doubles.push(sorted[i - 1]);
      doubles.push(sorted[i]);
    }
  }

  if (pairs > 0) {
    const customers = new Set(doubles.map((r) => r.customer));
    const newest = doubles.reduce((a, b2) => (a.at > b2.at ? a : b2));
    const oldest = doubles.reduce((a, b2) => (a.at < b2.at ? a : b2));
    out.push({
      signature: 'double-charge',
      kind: 'double-charge',
      // Money owed to a customer who does not know yet. It outranks a decline
      // spike, which costs revenue that was never taken.
      severity: pairs >= 3 ? 'high' : 'medium',
      title: `${pairs} possible double charge${pairs === 1 ? '' : 's'} across ${customers.size} customer${customers.size === 1 ? '' : 's'}`,
      impact:
        'The same customer was charged the same amount at the same terminal ' +
        'twice within minutes. Refunded now it is an apology; found by the ' +
        'customer later it is a chargeback, and chargebacks are counted ' +
        'against the acquirer.',
      evidence: [
        `${pairs} pair(s) of settled deposits within ${fmtAge(DOUBLE_CHARGE_MS)} of each other, matching on customer, amount, currency and terminal.`,
        `${customers.size} customer(s) affected.`,
        `Value of the second charge in each pair: ${(Math.round(doubledValue * 100) / 100).toLocaleString()} ${doubles[0].currency ?? ''}`.trim() +
          '.',
        `Most recent: ${newest.at.toISOString()}${newest.psp ? ` at ${newest.psp}` : ''}.`,
      ],
      // Newest first: the pair that just happened is the one that can still be
      // refunded before the customer notices.
      samples: toSamples(
        [...doubles].sort((a, b2) => b2.at.getTime() - a.at.getTime()),
        now,
      ),
      sampleTotal: doubles.length,
      since: oldest.at.toISOString(),
      psp: null,
    });
  }

  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
