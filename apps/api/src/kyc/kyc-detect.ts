import type { Detection } from '../modules/incident-detect';

/**
 * The conditions the KYC side can raise, in the shape the incident screen
 * already understands.
 *
 * WHY THESE JOIN THE PAYMENT DETECTIONS RATHER THAN GETTING THEIR OWN SCREEN.
 * The desk works one list. A PSP failing and a verification queue that stopped
 * moving are the same kind of event — something is wrong now and somebody has
 * to decide whether to act — and splitting them across two pages means the
 * quieter one is the one nobody opens. They go through the same declare,
 * evidence and resolve flow, with the same rule that a condition still true
 * after its incident was closed comes back rather than staying hidden.
 *
 * PURE, like the payment detector beside it: every figure arrives as an
 * argument, so the rules can be checked against fixtures without a database and
 * without the provider. The thresholds are the only judgement in the file and
 * they are all named constants.
 *
 * NO SAMPLES. The payment detections carry the payments behind them, because
 * the first question after "54 payments are stuck" is "which ones". These carry
 * evidence lines instead: the rows behind a KYC condition are people, and a
 * list of names does not belong in an incident feed that anybody on the desk
 * can open. The screens that are allowed to name them link from the evidence.
 */

/** No verifications for this long, with a token configured, is a stall. */
const STALL_HOURS = 36;

/**
 * Why 36 and not 12.
 *
 * The unattended floor is a DAILY cron — this account's plan refuses anything
 * finer, and the finer schedule is what silently blocked deploys for three
 * days. A quiet night is therefore normal and must not page anybody; a day and
 * a half of silence is not.
 */
const STALL_MS = STALL_HOURS * 60 * 60 * 1000;

/** A pass rate this far below the account's own baseline is a collapse. */
const PASS_DROP_POINTS = 15;
/** Below this many decided verifications, a rate is noise rather than news. */
const PASS_MIN_DECIDED = 20;

/** A national-id service failing this often is a fault, not a rejection rate. */
const LOOKUP_FAIL_PCT = 25;
const LOOKUP_MIN_RUN = 20;

/** Approved clients whose document has lapsed, before it is worth raising. */
const EXPIRED_MIN_CLIENTS = 10;

export type KycDetectInput = {
  now: Date;
  /** Whether a provider token is configured at all. No token, no stall. */
  configured: boolean;
  /** The newest verification held, whatever its outcome. */
  newestAt: Date | null;
  /** Per entity: the recent window against that entity's own baseline. */
  accounts: {
    account: string;
    recentApproved: number;
    recentRejected: number;
    baseApproved: number;
    baseRejected: number;
  }[];
  /** Per national-id service, over the recent window. */
  lookups: { check: string; run: number; failed: number }[];
  /** Approved clients whose document has expired, or expires within 30 days. */
  expired: { clients: number; within30: number };
  /**
   * Settled deposits from clients who are not currently verified.
   *
   * The figure the CU join exists to produce. `threshold` is the amount above
   * which it becomes an incident rather than a number on a panel.
   */
  unverified: { clients: number; amount: number; threshold: number };
};

const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);

export function detectKycIncidents(input: KycDetectInput): Detection[] {
  const out: Detection[] = [];
  const { now } = input;

  // ── The verification feed has stopped ────────────────────────────────────
  //
  // First, because every rule below reads the same rows: if nothing is
  // arriving, a pass rate that has not moved is a reporting failure rather
  // than a change in outcomes, and raising it as one sends somebody to the
  // wrong place entirely.
  const silence = input.newestAt
    ? now.getTime() - input.newestAt.getTime()
    : null;
  if (input.configured && (silence === null || silence > STALL_MS)) {
    const hours = silence === null ? null : Math.floor(silence / 3_600_000);
    return [
      {
        signature: 'kyc-stalled',
        kind: 'kyc-stalled',
        severity: 'high',
        title: 'No verifications have arrived from KYCAID',
        impact:
          'Clients may be completing checks that this dashboard cannot see, so the onboarding queue and every figure derived from it are stale.',
        evidence: [
          hours === null
            ? 'No verification has ever been read from the provider.'
            : `The newest verification held is ${hours} hours old; the daily sync should keep this under ${STALL_HOURS}.`,
          'Check the API deployed recently, that KYCAID is answering, and that the daily cron ran — GET /api/health reports the running build.',
        ],
        samples: [],
        sampleTotal: 0,
        since: input.newestAt ? input.newestAt.toISOString() : null,
        psp: null,
      },
    ];
  }

  // ── One entity's pass rate has fallen away from its own baseline ─────────
  //
  // AGAINST ITSELF, never against the other entity or a fixed number. The two
  // entities run different forms with different checks — one includes Address
  // and Adverse Media and the other does not — so Mauritius sitting near 40%
  // while Saint Lucia sits near 85% is a policy difference, not an incident,
  // and a fixed threshold would page the desk about it every hour for ever.
  // What is worth raising is a rate that has moved away from where that same
  // form has been.
  for (const a of input.accounts) {
    const decided = a.recentApproved + a.recentRejected;
    const baseDecided = a.baseApproved + a.baseRejected;
    if (decided < PASS_MIN_DECIDED || baseDecided < PASS_MIN_DECIDED) continue;
    const recent = pct(a.recentApproved, decided);
    const base = pct(a.baseApproved, baseDecided);
    if (base - recent < PASS_DROP_POINTS) continue;
    out.push({
      signature: `kyc-pass-drop:${a.account}`,
      kind: 'kyc-pass-drop',
      severity: base - recent >= 30 ? 'high' : 'medium',
      title: `${a.account} pass rate has fallen to ${recent}%`,
      impact: `Clients who would have been approved a month ago are being declined, which is either a change in the applicants or a change in the form.`,
      evidence: [
        `${recent}% of ${decided.toLocaleString()} decided in the last 7 days, against ${base}% of ${baseDecided.toLocaleString()} over the 30 before it.`,
        `${a.recentRejected.toLocaleString()} rejected in the recent window.`,
        'The Failed column on the KYC screen says which check is doing it — a jump in one check is a form or provider change, a spread across all of them is the applicants.',
      ],
      samples: [],
      sampleTotal: decided,
      since: null,
      psp: null,
    });
  }

  // ── A national-id service is failing ─────────────────────────────────────
  //
  // These are billed per call and paid for whether they validate or not, so a
  // service failing at 44% is both a compliance gap and money leaving the
  // account. Usually a format problem upstream rather than 88 people with
  // invented numbers.
  for (const l of input.lookups) {
    if (l.run < LOOKUP_MIN_RUN) continue;
    const rate = pct(l.failed, l.run);
    if (rate < LOOKUP_FAIL_PCT) continue;
    out.push({
      signature: `kyc-lookup-failing:${l.check}`,
      kind: 'kyc-lookup-failing',
      severity: rate >= 40 ? 'high' : 'medium',
      title: `${l.check} is failing ${rate}% of the time`,
      impact:
        'Onboarding is paying for a national-id check per attempt and getting a refusal, so clients are being blocked or waved through without one.',
      evidence: [
        `${l.failed.toLocaleString()} of ${l.run.toLocaleString()} did not validate in the last 7 days.`,
        'A rate this high is usually the number reaching the provider, not the client: check the CRM validates the format before it calls.',
      ],
      samples: [],
      sampleTotal: l.run,
      since: null,
      psp: null,
    });
  }

  // ── Approvals resting on documents that have expired ─────────────────────
  if (input.expired.clients >= EXPIRED_MIN_CLIENTS) {
    out.push({
      signature: 'kyc-documents-expired',
      kind: 'kyc-documents-expired',
      severity: 'medium',
      title: `${input.expired.clients.toLocaleString()} approved clients hold an expired document`,
      impact:
        'An approval that rests on a document which has since lapsed is not a current verification, and these clients are trading on it.',
      evidence: [
        `${input.expired.clients.toLocaleString()} approved clients have a document that has already expired.`,
        `${input.expired.within30.toLocaleString()} more expire within 30 days.`,
        'The KYC screen filters on Doc expiry — expired first, since a lapsed document is more urgent than one lapsing.',
      ],
      samples: [],
      sampleTotal: input.expired.clients,
      since: null,
      psp: null,
    });
  }

  // ── Money from people who were never checked ─────────────────────────────
  //
  // The one detection here that is not about the provider at all. It is the
  // join: settled deposits against the payer's standing, which no screen could
  // answer until the CU reference tied the two sides together.
  if (
    input.unverified.amount >= input.unverified.threshold &&
    input.unverified.clients > 0
  ) {
    out.push({
      signature: 'kyc-unverified-funding',
      kind: 'kyc-unverified-funding',
      severity: 'critical',
      title: `${Math.round(input.unverified.amount).toLocaleString()} funded by clients who are not verified`,
      impact:
        'Accounts are being funded by people this business has not verified, has refused, or verified against a document that has since expired.',
      evidence: [
        `${input.unverified.clients.toLocaleString()} clients funded ${Math.round(input.unverified.amount).toLocaleString()} in settled deposits over the last 7 days.`,
        'Counted from settled deposits only, one row per payment at its latest state — declined attempts and withdrawals are excluded.',
        'The KYC screen names them, worst first, under Deposits by verification standing.',
      ],
      samples: [],
      sampleTotal: input.unverified.clients,
      since: null,
      psp: null,
    });
  }

  return out;
}
