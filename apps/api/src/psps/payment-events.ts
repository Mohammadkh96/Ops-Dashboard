/**
 * Reading an event log as a ledger.
 *
 * Its own module because both the ledger and the balance need it and they must
 * agree — a table showing one row per payment beside a balance built from one
 * row per callback is worse than either mistake alone.
 */

/**
 * One PAYMENT out of many EVENTS about it.
 *
 * PaymentEvent is an event log and is right to be one: the live feed needs to
 * know that a payment just moved to COMPLETED, and `dedupeKey` is deliberately
 * the identity of a payment IN A GIVEN STATE so that a transition is news and a
 * re-read is not.
 *
 * A LEDGER IS NOT AN EVENT LOG. Reading those rows straight out put the same
 * payment on screen twice — once PENDING, once COMPLETED, same id, same second,
 * sometimes different amounts because a fee was taken between the two — and a
 * balance built on that counts a deposit as many times as the provider talked
 * about it. Every count downstream was really a count of callbacks.
 *
 * So the events are collapsed to their LATEST state before anything reads them
 * as transactions. Latest by `occurredAt`, then `receivedAt` — the tiebreaker
 * is not decoration, because both states of one payment routinely carry the
 * identical occurredAt and only the arrival order separates them.
 *
 * Identity is `paymentId`, falling back to `externalId` and finally the row's
 * own id. Both of the first two are nullable, and a null key would collapse
 * every anonymous row into one.
 */
export type EventKey = {
  id: string;
  paymentId: string | null;
  externalId: string | null;
  occurredAt: Date | null;
  receivedAt: Date;
};

export function latestPerPayment(rows: EventKey[]): EventKey[] {
  const best = new Map<string, EventKey>();
  for (const r of rows) {
    const key = r.paymentId ?? r.externalId ?? r.id;
    const held = best.get(key);
    if (!held || newer(r, held)) best.set(key, r);
  }
  // Newest first, the order the ledger is read in. Rows with no timestamp sort
  // last rather than to the top: one exists, but it is not today's news.
  return [...best.values()].sort((a, b) => cmp(b, a));
}

function newer(a: EventKey, b: EventKey): boolean {
  return cmp(a, b) > 0;
}

function cmp(a: EventKey, b: EventKey): number {
  const at = a.occurredAt?.getTime();
  const bt = b.occurredAt?.getTime();
  if (at !== bt) {
    if (at === undefined) return -1;
    if (bt === undefined) return 1;
    return at - bt;
  }
  // `receivedAt` is non-null in the table, so this coalesce is not for the
  // database — it is because this function decides a balance, and a missing
  // field must degrade to a stable order rather than throw and take the whole
  // ledger and balance endpoint down with it.
  return (a.receivedAt?.getTime() ?? 0) - (b.receivedAt?.getTime() ?? 0);
}

/**
 * How many events one terminal's ledger will scan to collapse them.
 *
 * Only the key columns are read, never the payload, so this is cheap — but it
 * is bounded rather than unbounded, and the read says when it was hit instead
 * of quietly showing a short ledger.
 */
export const MAX_EVENTS = 20_000;
