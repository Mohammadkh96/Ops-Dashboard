/**
 * The path each payment actually took, and where they stop.
 *
 * Every other figure in this dashboard collapses a payment to its LATEST state
 * — the right answer for "how much settled today" and the wrong one for "why
 * didn't it". This module does the opposite: it keeps every state a payment
 * passed through, in order, because the interesting question is not what a
 * payment ended as but where it stopped moving.
 *
 * Almost no payments dashboard can do this. Most systems overwrite a payment
 * row as it changes state, so the history is gone by the time anyone asks.
 * Here each state is stored as its own row sharing a payment id, which means
 * the journey is recoverable exactly — it is a property of how the data was
 * written, not an analysis bolted on afterwards.
 *
 * What it is for: separating three failures that look identical in a success
 * rate and have three different owners.
 *
 *   • The customer never finished — they reached the checkout and left.
 *     That is a checkout problem, and it is ours.
 *   • The issuer said no — the payment was decided and the answer was no.
 *     That is a routing, BIN or risk problem, and it is the PSP's and ours
 *     together.
 *   • Nobody ever said anything — the payment went to the provider and no
 *     final state ever came back. That is an integration problem, and it is
 *     the provider's.
 *
 * A dashboard reporting "82% approval" hides all three inside the other 18%.
 */

/** Where a payment got to, as far as the data shows. */
export type Outcome =
  | 'completed'
  /** Decided, and the answer was no. */
  | 'declined'
  /** The customer stopped: cancelled, expired, abandoned at the checkout. */
  | 'abandoned'
  /** No final state, and old enough that one is not coming. */
  | 'stalled'
  /** No final state yet, but recent enough to still be normal. */
  | 'in-flight';

export type JourneyRow = {
  /** Identity of the PAYMENT, shared by all of its states. */
  key: string;
  state: string | null;
  type: string | null;
  psp: string | null;
  terminal: string | null;
  customer: string | null;
  amount: number;
  currency: string | null;
  at: Date;
};

export type Journey = {
  key: string;
  psp: string;
  type: string | null;
  customer: string | null;
  amount: number;
  currency: string | null;
  /** Distinct states in the order they were reached. */
  path: string[];
  startedAt: Date;
  lastAt: Date;
  outcome: Outcome;
  /** How long from first sight to the last thing that happened, in minutes. */
  durationMins: number;
};

/** A payment with no final state older than this has stopped, not slowed. */
const STALLED_MS = 60 * 60_000;

const SETTLED = /complete|success|settle|approv|paid|finish|confirm/i;
const DECLINED = /declin|fail|reject|error|chargeback|fraud/i;
const ABANDONED = /cancel|void|expire|abandon|timeout/i;

/**
 * One state, reduced to what it means for a funnel.
 *
 * Deliberately coarser than the provider's own vocabulary: AWAITING_WEBHOOK,
 * PENDING and RECONCILIATION are three different waits and one answer to
 * "did this payment finish".
 */
export function stageOf(state: string | null | undefined): string {
  const s = (state ?? '').trim();
  if (!s) return 'unknown';
  if (SETTLED.test(s)) return 'completed';
  if (DECLINED.test(s)) return 'declined';
  if (ABANDONED.test(s)) return 'abandoned';
  if (/checkout|created|new|initiat/i.test(s)) return 'checkout';
  return 'waiting';
}

/**
 * Groups rows into journeys.
 *
 * Rows may arrive in any order and may repeat a state — a payment re-read as
 * PENDING three times is one wait, not three — so the path holds each stage
 * once, in the order it was first reached.
 */
export function buildJourneys(rows: JourneyRow[], now: Date): Journey[] {
  const byPayment = new Map<string, JourneyRow[]>();
  for (const r of rows) {
    const list = byPayment.get(r.key);
    if (list) list.push(r);
    else byPayment.set(r.key, [r]);
  }

  const out: Journey[] = [];
  for (const [key, list] of byPayment) {
    const sorted = [...list].sort((a, b) => a.at.getTime() - b.at.getTime());
    const first = sorted[0];
    const last = sorted[sorted.length - 1];

    const path: string[] = [];
    for (const r of sorted) {
      const stage = stageOf(r.state);
      // Consecutive repeats collapse; a genuine return to an earlier stage
      // does not, because that is a real thing that happened.
      if (path[path.length - 1] !== stage) path.push(stage);
    }

    const finalStage = path[path.length - 1] ?? 'unknown';
    const ageMs = now.getTime() - last.at.getTime();
    const outcome: Outcome =
      finalStage === 'completed'
        ? 'completed'
        : finalStage === 'declined'
          ? 'declined'
          : finalStage === 'abandoned'
            ? 'abandoned'
            : ageMs > STALLED_MS
              ? 'stalled'
              : 'in-flight';

    // The provider that actually handled it. An early state can carry no
    // terminal at all — a payment abandoned before routing — and calling that
    // "Unassigned" is more honest than attributing it to whoever appears
    // later.
    const psp =
      sorted.find((r) => r.psp)?.psp ??
      sorted.find((r) => r.terminal)?.terminal ??
      'Unassigned';

    out.push({
      key,
      psp,
      type: sorted.find((r) => r.type)?.type ?? null,
      customer: sorted.find((r) => r.customer)?.customer ?? null,
      // The amount at the final state: an amount can be adjusted in flight,
      // and what matters is what the customer was actually charged.
      amount: Math.abs(last.amount || first.amount || 0),
      currency: last.currency ?? first.currency,
      path,
      startedAt: first.at,
      lastAt: last.at,
      outcome,
      durationMins: Math.max(
        0,
        Math.round((last.at.getTime() - first.at.getTime()) / 60_000),
      ),
    });
  }
  return out;
}

export type FunnelOutcome = {
  outcome: Outcome;
  count: number;
  amount: number;
  share: number;
};

export type FunnelPath = {
  /** e.g. "checkout → waiting → completed" */
  path: string;
  count: number;
  share: number;
  outcome: Outcome;
};

export type PspFunnel = {
  psp: string;
  total: number;
  outcomes: FunnelOutcome[];
  /** The commonest routes through, worst-to-best is not assumed. */
  paths: FunnelPath[];
  /** Settled ÷ decided — the same definition the rest of the dashboard uses. */
  approvalRate: number | null;
  /**
   * Of everything that did NOT complete, how it failed. This is the number
   * the funnel exists for: three failures, three owners.
   */
  lostTo: { abandoned: number; declined: number; stalled: number };
  /**
   * Median minutes from first sight to settlement, over payments we actually
   * watched move. Null when none were — see the note where it is computed.
   */
  medianMins: number | null;
  /**
   * How many of these payments have exactly one stored state, and so were
   * never observed moving at all. Almost every imported payment is one: an
   * export carries the final row and nothing before it. Reported so a list of
   * one-step "routes" is legible rather than mysterious.
   */
  singleState: number;
};

const MAX_PATHS = 8;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** Groups journeys by provider and describes how each one loses payments. */
export function buildFunnel(journeys: Journey[]): PspFunnel[] {
  const byPsp = new Map<string, Journey[]>();
  for (const j of journeys) {
    const list = byPsp.get(j.psp);
    if (list) list.push(j);
    else byPsp.set(j.psp, [j]);
  }

  const out: PspFunnel[] = [];
  for (const [psp, list] of byPsp) {
    const total = list.length;
    const counts = new Map<Outcome, { count: number; amount: number }>();
    const paths = new Map<string, { count: number; outcome: Outcome }>();

    for (const j of list) {
      const c = counts.get(j.outcome) ?? { count: 0, amount: 0 };
      c.count += 1;
      c.amount += j.amount;
      counts.set(j.outcome, c);

      const label = j.path.join(' → ');
      const p = paths.get(label) ?? { count: 0, outcome: j.outcome };
      p.count += 1;
      paths.set(label, p);
    }

    const completed = counts.get('completed')?.count ?? 0;
    const declined = counts.get('declined')?.count ?? 0;
    const abandoned = counts.get('abandoned')?.count ?? 0;
    const stalled = counts.get('stalled')?.count ?? 0;
    const decided = completed + declined;

    out.push({
      psp,
      total,
      outcomes: [...counts.entries()]
        .map(([outcome, v]) => ({
          outcome,
          count: v.count,
          amount: Math.round(v.amount * 100) / 100,
          share: total ? Math.round((v.count / total) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.count - a.count),
      paths: [...paths.entries()]
        .map(([path, v]) => ({
          path,
          count: v.count,
          outcome: v.outcome,
          share: total ? Math.round((v.count / total) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, MAX_PATHS),
      // Null rather than 0 when nothing was decided: "we approved none of
      // nothing" is not a 0% approval rate.
      approvalRate: decided
        ? Math.round((completed / decided) * 1000) / 10
        : null,
      lostTo: { abandoned, declined, stalled },
      // Only payments we watched MOVE. A payment whose entire history is one
      // stored state — everything that arrived by import, where the export
      // carries the final row and nothing before it — has no measurable
      // duration, and counting those as zero reported "median 0m to settle",
      // which is not fast. It is unmeasured.
      medianMins: median(
        list
          .filter((j) => j.outcome === 'completed' && j.path.length > 1)
          .map((j) => j.durationMins),
      ),
      singleState: list.filter((j) => j.path.length === 1).length,
    });
  }

  return out.sort((a, b) => b.total - a.total);
}
