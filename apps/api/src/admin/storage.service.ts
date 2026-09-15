import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

/**
 * What the database is spending its space on, and how to get some back.
 *
 * WRITTEN BECAUSE IT RAN OUT. A hosted Postgres plan has a hard size ceiling,
 * and reaching it does not degrade anything gracefully: every write fails with
 * `53100 could not extend file`, the syncs read zero rows and store zero rows,
 * and the screens keep showing yesterday's data as though nothing were wrong.
 * The failure that followed looked for hours like a provider problem and a
 * missing client, because nothing anywhere said "the disk is full".
 *
 * THE SPACE IS IN THE JSON. Two columns exist to answer questions nobody has
 * asked yet: `PaymentEvent.payload` (the provider's whole message, redacted)
 * and `KycCase.raw` (the verification row minus identity fields). Both were
 * deliberate — the field nobody mapped today is the one a dispute needs next
 * month, and re-pulling a year of history is hundreds of requests. Both are
 * also, by a wide margin, the biggest thing in the database.
 *
 * So pruning drops the JSON and keeps every mapped column: the amounts, the
 * states, the verdicts, the references, the dates. What is lost is the ability
 * to recover a field that was never mapped, for the period pruned. That is a
 * real loss and it is the cheapest one available, which is why this reports
 * before it deletes and never runs on its own.
 */
/**
 * The payload keys anything here actually reads.
 *
 * Listed so the report can mark the rest as droppable, and so that dropping
 * one becomes a deliberate change to this list rather than a surprise in a
 * drawer six weeks later. Drawn from `transactionDetail`, the column picker
 * and the client search — the three places that read the stored payload.
 */
const READ_KEYS = new Set([
  'paymentMethod',
  'description',
  'billingAddress',
  'customer',
  'errorCode',
  'errorMessage',
  'externalResultCode',
  'state',
  'type',
  'amount',
  'currency',
  'createdAt',
  'updatedAt',
]);

@Injectable()
export class StorageService {
  private readonly log = new Logger(StorageService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Every table, largest first, with what its indexes and TOAST cost. */
  async report() {
    const tables = await this.prisma.$queryRaw<
      { table: string; total: bigint; data: bigint; rows: bigint }[]
    >`
      SELECT c.relname                                AS "table",
             pg_total_relation_size(c.oid)            AS total,
             pg_relation_size(c.oid)                  AS data,
             COALESCE(s.n_live_tup, 0)                AS rows
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY pg_total_relation_size(c.oid) DESC
    `;

    const database = await this.prisma.$queryRaw<{ size: bigint }[]>`
      SELECT pg_database_size(current_database()) AS size
    `;

    /**
     * What pruning would actually free, measured rather than guessed.
     *
     * The JSON lives in TOAST storage, so its size is not visible from a row
     * count — this sums the on-disk length of the two columns for rows older
     * than the cutoff. A number somebody is about to make an irreversible
     * decision on should be measured.
     */
    const [prunable, payload] = await Promise.all([
      this.prunable(30),
      this.payloadKeys().catch(() => null),
    ]);

    return {
      databaseBytes: Number(database[0]?.size ?? 0),
      /** What the biggest column is spending its space on, key by key. */
      payload,
      /**
       * The ceiling, where it is known.
       *
       * Not discoverable from inside Postgres — the limit belongs to the
       * hosting plan, not the database — so it is configuration, and the
       * screen says "unknown" rather than assuming one.
       */
      limitBytes: Number(process.env.DATABASE_SIZE_LIMIT_BYTES ?? 0) || null,
      tables: tables.map((t) => ({
        table: t.table,
        totalBytes: Number(t.total),
        dataBytes: Number(t.data),
        /** Indexes and TOAST — usually most of it, on these two tables. */
        overheadBytes: Number(t.total) - Number(t.data),
        rows: Number(t.rows),
      })),
      prunable,
    };
  }

  /**
   * WHAT IS ACTUALLY IN THE PAYLOAD, by top-level key, largest first.
   *
   * 427MB across eighty thousand payments is five kilobytes each, and nobody
   * can say which part that is without looking. Guessing here is expensive in
   * both directions: cut the wrong key and the detail drawer loses the billing
   * address it is opened for, cut nothing and the database fills again in a
   * month.
   *
   * Sampled rather than summed over the table — a thousand rows is enough to
   * rank keys, and reading eighty thousand payloads to measure them would need
   * the memory this is trying to free.
   */
  async payloadKeys(sample = 1000) {
    const rows = await this.prisma.$queryRaw<
      { key: string; bytes: bigint; rows: bigint }[]
    >`
      WITH recent AS (
        SELECT payload FROM "PaymentEvent"
        WHERE payload <> '{}'::jsonb
        ORDER BY "receivedAt" DESC
        LIMIT ${sample}
      )
      SELECT kv.key                               AS key,
             SUM(pg_column_size(kv.value))        AS bytes,
             count(*)                             AS rows
      FROM recent, jsonb_each(recent.payload) AS kv
      GROUP BY kv.key
      ORDER BY 2 DESC
      LIMIT 25
    `;
    const total = rows.reduce((n, r) => n + Number(r.bytes), 0);
    return {
      sampled: sample,
      /** Per key: what it costs, and what share of a payment it is. */
      keys: rows.map((r) => ({
        key: r.key,
        bytes: Number(r.bytes),
        rows: Number(r.rows),
        sharePct: total ? Math.round((Number(r.bytes) / total) * 100) : 0,
        /** Whether anything in this dashboard reads it. */
        read: READ_KEYS.has(r.key),
      })),
      totalBytes: total,
      averageBytesPerPayment: sample ? Math.round(total / sample) : 0,
    };
  }

  /**
   * How much the two JSON columns hold, for rows older than a cutoff.
   *
   * Reported before anything is deleted, and again as a dry run, because "this
   * will free 300MB" and "this deleted 40 rows worth 2MB" are very different
   * decisions and only one of them is worth the loss.
   */
  async prunable(olderThanDays: number) {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
    const [payments, kyc] = await Promise.all([
      /**
       * EMPTY, NOT NULL — the column forbids null and always has.
       *
       * `payload IS NOT NULL` looks like the right predicate and matches every
       * row in the table, which would report the whole history as prunable
       * however many times it had already been pruned. An emptied payload is
       * `{}`, so that is what "nothing left to free here" looks like.
       */
      this.prisma.$queryRaw<{ rows: bigint; bytes: bigint }[]>`
        SELECT count(*) AS rows,
               COALESCE(SUM(pg_column_size(payload) + pg_column_size(headers)), 0) AS bytes
        FROM "PaymentEvent"
        WHERE "receivedAt" < ${cutoff}
          AND (payload <> '{}'::jsonb OR headers <> '{}'::jsonb)
      `,
      this.prisma.$queryRaw<{ rows: bigint; bytes: bigint }[]>`
        SELECT count(*) AS rows,
               COALESCE(SUM(pg_column_size(raw)), 0) AS bytes
        FROM "KycCase"
        WHERE "submittedAt" < ${cutoff} AND raw IS NOT NULL
      `,
    ]);
    return {
      olderThanDays,
      cutoff: cutoff.toISOString(),
      paymentEvents: {
        rows: Number(payments[0]?.rows ?? 0),
        bytes: Number(payments[0]?.bytes ?? 0),
      },
      kycCases: {
        rows: Number(kyc[0]?.rows ?? 0),
        bytes: Number(kyc[0]?.bytes ?? 0),
      },
      bytes: Number(payments[0]?.bytes ?? 0) + Number(kyc[0]?.bytes ?? 0),
    };
  }

  /**
   * Drop the stored JSON for rows older than a cutoff. Keeps every column.
   *
   * DRY RUN BY DEFAULT, and the caller has to ask for the other thing. This is
   * irreversible without re-fetching from the providers, and a one-character
   * difference between "show me" and "do it" is not a safe interface for an
   * operation whose mistake costs a year of history.
   *
   * What survives: every mapped column on both tables — amounts, states,
   * customers, references, verdicts, decline reasons, prices, dates. What goes
   * is the unparsed original, which matters only for a field nobody has mapped
   * yet.
   */
  async prune(opts: {
    olderThanDays: number;
    apply?: boolean;
    /**
     * `slim` keeps the keys the screens read and drops the rest; `null` drops
     * the payload entirely.
     *
     * Slim is the default because the loss is smaller and usually invisible:
     * the detail drawer still shows the billing address, the customer email,
     * the method and the description, and what goes is whatever the provider
     * sends that nothing here has ever read. Dropping the payload outright is
     * for a database that is full now and needs the space today.
     */
    mode?: 'slim' | 'null';
  }) {
    const olderThanDays = Math.max(1, Math.round(opts.olderThanDays));
    const mode = opts.mode === 'null' ? 'null' : 'slim';
    const before = await this.prunable(olderThanDays);
    if (!opts.apply) return { applied: false, mode, ...before };

    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
    this.log.warn(
      `Pruning stored payloads older than ${olderThanDays} days (${before.bytes} bytes)`,
    );

    /**
     * EMPTIED, NOT NULLED. `payload` and `headers` are NOT NULL columns and
     * have been since the table was created, so the obvious `SET payload =
     * NULL` is not a stronger version of this — it is an update that fails.
     * `{}` is the empty state the schema allows, and it reads back through
     * every existing caller as "no keys", which nulling would not.
     */
    /**
     * IN BATCHES, AND NOT IN ONE TRANSACTION, because the database this is
     * for is already full.
     *
     * An UPDATE writes a NEW version of every row it touches and only frees
     * the old one afterwards — so rewriting eighty thousand rows at once needs
     * more space than is left, and fails with the very error it is meant to
     * cure. Two thousand at a time, with a vacuum between, keeps the working
     * set small enough to fit in what has just been freed.
     *
     * Each pass selects rows that STILL HOLD something this mode would drop,
     * so a row it has already done is not picked again. A predicate that stays
     * true after the update is an endless loop that reports work it did not do.
     */
    const keep = [...READ_KEYS];
    let payments = 0;
    for (let pass = 0; pass < 100; pass++) {
      const done: number =
        mode === 'null'
          ? await this.prisma.$executeRaw`
              UPDATE "PaymentEvent"
              SET payload = '{}'::jsonb, headers = '{}'::jsonb
              WHERE id IN (
                SELECT id FROM "PaymentEvent"
                WHERE "receivedAt" < ${cutoff}
                  AND (payload <> '{}'::jsonb OR headers <> '{}'::jsonb)
                LIMIT 2000
              )
            `
          : await this.prisma.$executeRaw`
              UPDATE "PaymentEvent"
              SET payload = (
                    SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb)
                    FROM jsonb_each(payload) AS e(k, v)
                    WHERE k = ANY(${keep}::text[])
                  ),
                  headers = '{}'::jsonb
              WHERE id IN (
                SELECT id FROM "PaymentEvent"
                WHERE "receivedAt" < ${cutoff}
                  AND (
                    headers <> '{}'::jsonb
                    OR EXISTS (
                      SELECT 1 FROM jsonb_each(payload) AS e(k, v)
                      WHERE NOT (k = ANY(${keep}::text[]))
                    )
                  )
                LIMIT 2000
              )
            `;
      payments += done;
      if (!done) break;
      // Hand the space back for reuse before asking for more of it.
      await this.prisma.$executeRawUnsafe('VACUUM "PaymentEvent"');
    }

    /**
     * SLIM LEAVES THE VERIFICATIONS ALONE, because there is no equivalent list
     * for them: `KycCase.raw` is the provider's verification row, and what the
     * screens read out of it changes as columns are added — the last two
     * additions came from it. Nulling it is offered because a full database is
     * an emergency; narrowing it by guesswork is not.
     */
    const kyc: number =
      mode === 'null'
        ? await this.prisma.$executeRaw`
            UPDATE "KycCase" SET raw = NULL
            WHERE "submittedAt" < ${cutoff} AND raw IS NOT NULL
          `
        : 0;

    return {
      applied: true,
      mode,
      olderThanDays,
      cutoff: cutoff.toISOString(),
      paymentEventsPruned: payments,
      kycCasesPruned: kyc,
      /**
       * What the two columns held before this ran — an upper bound, not a
       * measurement of what went. Slim keeps the read keys, so it frees less
       * than this; and neither mode counts the KYC half when it did not touch
       * it. Reported as an estimate and named as one, because the honest
       * after-figure is `report()` run again.
       */
      freedBytesEstimate:
        mode === 'null' ? before.bytes : before.paymentEvents.bytes,
      /**
       * SPACE COMES BACK SLOWLY, and saying so avoids a second panic.
       *
       * Postgres marks the old rows dead and reuses the space for new writes;
       * it does not hand it back to the filesystem until a full vacuum, which
       * rewrites the table and needs room to do it — precisely what a full
       * database does not have. Writes work again immediately, which is the
       * thing that was broken.
       */
      note: 'Writes resume immediately. The reported size falls as Postgres reuses the freed pages; it does not drop the moment this returns.',
    };
  }
}
