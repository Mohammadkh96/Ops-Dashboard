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
    const prunable = await this.prunable(30);

    return {
      databaseBytes: Number(database[0]?.size ?? 0),
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
   * How much the two JSON columns hold, for rows older than a cutoff.
   *
   * Reported before anything is deleted, and again as a dry run, because "this
   * will free 300MB" and "this deleted 40 rows worth 2MB" are very different
   * decisions and only one of them is worth the loss.
   */
  async prunable(olderThanDays: number) {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
    const [payments, kyc] = await Promise.all([
      this.prisma.$queryRaw<{ rows: bigint; bytes: bigint }[]>`
        SELECT count(*) AS rows,
               COALESCE(SUM(pg_column_size(payload) + pg_column_size(headers)), 0) AS bytes
        FROM "PaymentEvent"
        WHERE "receivedAt" < ${cutoff} AND payload IS NOT NULL
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
  async prune(opts: { olderThanDays: number; apply?: boolean }) {
    const olderThanDays = Math.max(1, Math.round(opts.olderThanDays));
    const before = await this.prunable(olderThanDays);
    if (!opts.apply) return { applied: false, ...before };

    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
    this.log.warn(
      `Pruning stored payloads older than ${olderThanDays} days (${before.bytes} bytes)`,
    );

    /**
     * `DbNull`, not `undefined` — the whole point is to erase.
     *
     * Prisma reads `undefined` as "leave this alone" on an update, which here
     * would report success having freed nothing at all.
     */
    const [payments, kyc] = await this.prisma.$transaction([
      this.prisma.$executeRaw`
        UPDATE "PaymentEvent"
        SET payload = NULL, headers = '{}'::jsonb
        WHERE "receivedAt" < ${cutoff} AND payload IS NOT NULL
      `,
      this.prisma.$executeRaw`
        UPDATE "KycCase" SET raw = NULL
        WHERE "submittedAt" < ${cutoff} AND raw IS NOT NULL
      `,
    ]);

    return {
      applied: true,
      olderThanDays,
      cutoff: cutoff.toISOString(),
      paymentEventsPruned: payments,
      kycCasesPruned: kyc,
      freedBytesEstimate: before.bytes,
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
