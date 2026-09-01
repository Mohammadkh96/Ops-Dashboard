import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { open, SecretBoxError } from '../common/secret-box';
import {
  callPsp,
  describeWebPage,
  looksLikeWebPage,
  providerError,
  readExtras,
  readTransactions,
  type EndpointConfig,
  type Txn,
} from './psp-connector';

/**
 * Reading a provider's whole ledger, fifty rows at a time.
 *
 * Providers cap a list — ForumPay returns 50 however many you ask for — so a
 * terminal with two and a half thousand transactions is fifty round trips. That
 * is far too slow to do while somebody waits on a page, and far too much load
 * to repeat every time one is opened. So it is done once, stored, and then kept
 * up to date incrementally.
 *
 * INCREMENTAL BY DEFAULT. Providers return newest first, so a page on which
 * every id is already known means everything after it is known too. Stopping
 * there turns a routine refresh into one or two calls instead of fifty.
 *
 * The stop conditions are the whole design. A sync that cannot stop is a sync
 * that hammers a payment provider until they block us, and an ignored
 * pagination parameter — which several providers accept silently — means every
 * page is page one and the loop never sees anything new.
 */

export type SyncResult = {
  ok: boolean;
  pages: number;
  fetched: number;
  created: number;
  updated: number;
  /** Why the loop stopped, in words. Always populated. */
  stopped: string;
  error?: string;
};

/** How many pages one sync may ever ask for, whatever else happens. */
const MAX_PAGES = 200;
/** How long one sync may run. Serverless functions are killed at 60s. */
const BUDGET_MS = 45_000;
const DEFAULT_PAGE_SIZE = 50;
/** How many stored records to read when listing the fields a provider sends. */
const SAMPLE = 200;

/**
 * Every leaf in a record, as a dotted path.
 *
 * Depth-limited and array-summarised: a provider's record can nest, but a
 * column mapped twelve levels into the third element of an array is not a
 * column anybody is going to configure, and listing them all would bury the
 * dozen that matter.
 */
function flatten(value: unknown, prefix = '', depth = 0): [string, unknown][] {
  if (depth > 2 || value === null || typeof value !== 'object') {
    return prefix ? [[prefix, value]] : [];
  }
  if (Array.isArray(value)) {
    // The first element stands for the array: the shape repeats, and the path
    // that is useful is the one into element zero.
    return value.length ? flatten(value[0], `${prefix}.0`, depth + 1) : [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    flatten(v, prefix ? `${prefix}.${k}` : k, depth + 1),
  );
}

@Injectable()
export class PspSyncService {
  private readonly log = new Logger(PspSyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  async sync(id: string, opts: { full?: boolean } = {}): Promise<SyncResult> {
    const conn = await this.prisma.pspConnection.findUnique({ where: { id } });
    if (!conn) throw new BadRequestException('No such PSP connection.');

    const endpoints = (conn.endpoints ?? {}) as Record<string, EndpointConfig>;
    const endpoint = endpoints.transactions;
    if (!endpoint?.path) {
      throw new BadRequestException(
        `No transactions endpoint configured for ${conn.label}. Add its path and field names first.`,
      );
    }

    let creds: { key?: string; secret?: string };
    try {
      creds = {
        key: conn.apiKeyEnc ? open(conn.apiKeyEnc) : undefined,
        secret: conn.apiSecretEnc ? open(conn.apiSecretEnc) : undefined,
      };
    } catch (e) {
      throw new BadRequestException(
        e instanceof SecretBoxError
          ? e.message
          : 'Could not read the stored credential.',
      );
    }

    const p = endpoint.pagination ?? {};
    const limitParam = p.limitParam || 'limit';
    const offsetParam = p.offsetParam || 'offset';
    const pageSize =
      p.pageSize && p.pageSize > 0 ? p.pageSize : DEFAULT_PAGE_SIZE;

    const started = Date.now();
    let pages = 0;
    let fetched = 0;
    let created = 0;
    let updated = 0;
    let offset = 0;
    let stopped = 'reached the end of the list';

    // Ids seen in THIS run. A provider that ignores the offset parameter hands
    // back page one every time; without this the loop would run to MAX_PAGES
    // storing the same fifty rows and calling it a success.
    const seenThisRun = new Set<string>();

    for (;;) {
      if (pages >= MAX_PAGES) {
        stopped = `stopped at the ${MAX_PAGES}-page limit — run it again to continue`;
        break;
      }
      if (Date.now() - started > BUDGET_MS) {
        stopped = 'ran out of time — run it again to continue';
        break;
      }

      const page: EndpointConfig = {
        ...endpoint,
        query: {
          ...(endpoint.query ?? {}),
          [limitParam]: String(pageSize),
          [offsetParam]: String(offset),
        },
      };

      const result = await callPsp(conn, page, creds);
      pages++;

      if (looksLikeWebPage(result.body)) {
        return this.fail(id, describeWebPage(result.body), {
          pages,
          fetched,
          created,
          updated,
        });
      }
      const said = providerError(result.body);
      if (said) {
        return this.fail(id, `The provider refused: ${said}`, {
          pages,
          fetched,
          created,
          updated,
        });
      }
      if (!result.ok) {
        return this.fail(id, result.error, {
          pages,
          fetched,
          created,
          updated,
        });
      }

      const rows = readTransactions(result.body, endpoint);
      if (rows.length === 0) break;
      fetched += rows.length;

      // A row with no id cannot be stored without duplicating on every sync,
      // and a ledger that grows by two thousand phantom rows a day is worse
      // than one that is missing some. Counted, so the number is not silently
      // different from what the provider sent.
      const withIds = rows.filter((r) => r.id);
      let newOnThisPage = 0;
      let repeats = 0;

      for (const row of withIds) {
        if (seenThisRun.has(row.id as string)) {
          repeats++;
          continue;
        }
        seenThisRun.add(row.id as string);
        const wrote = await this.store(conn.id, conn.terminal, row);
        if (wrote === 'created') {
          created++;
          newOnThisPage++;
        } else {
          updated++;
        }
      }

      if (repeats === withIds.length && withIds.length > 0) {
        // Every id on this page was already seen in this same run. The offset
        // parameter is being ignored, so continuing would loop for ever.
        stopped = `the provider ignored "${offsetParam}" — every page came back the same. Ask them which parameter pages this endpoint.`;
        this.log.warn(`${conn.terminal}: ${stopped}`);
        break;
      }

      // Incremental: newest first, so a page with nothing new means everything
      // older is already stored. The full sync ignores this and reads to the
      // end, which is what a first run and a repair need.
      if (!opts.full && newOnThisPage === 0) {
        stopped = 'up to date — nothing new on this page';
        break;
      }

      // Short page means the end. This is the ordinary way a sync finishes.
      if (rows.length < pageSize) break;
      offset += pageSize;
    }

    await this.prisma.pspConnection.update({
      where: { id },
      data: {
        lastSyncAt: new Date(),
        lastSyncPages: pages,
        lastSyncFetched: fetched,
        lastTriedAt: new Date(),
        lastOkAt: new Date(),
        lastError: null,
      },
    });

    return { ok: true, pages, fetched, created, updated, stopped };
  }

  /**
   * One transaction, written or refreshed.
   *
   * An upsert on (connection, provider id): a re-sync must update a row whose
   * status has moved from `waiting` to `confirmed`, not add a second one.
   */
  private async store(
    connectionId: string,
    terminal: string,
    row: Txn,
  ): Promise<'created' | 'updated'> {
    const data = {
      terminal,
      reference: row.reference,
      direction: row.direction,
      status: row.status,
      amount:
        row.amount === null ? null : new Prisma.Decimal(row.amount.toString()),
      currency: row.currency,
      occurredAt: row.atISO ? new Date(row.atISO) : null,
      rawAt: row.at,
      customer: row.customer,
      raw: (row.raw ?? {}) as Prisma.InputJsonValue,
    };

    const existing = await this.prisma.pspTransaction.findUnique({
      where: {
        connectionId_externalId: { connectionId, externalId: row.id as string },
      },
      select: { id: true },
    });

    if (existing) {
      await this.prisma.pspTransaction.update({
        where: { id: existing.id },
        data,
      });
      return 'updated';
    }
    await this.prisma.pspTransaction.create({
      data: { ...data, connectionId, externalId: row.id as string },
    });
    return 'created';
  }

  private async fail(
    id: string,
    error: string,
    counts: {
      pages: number;
      fetched: number;
      created: number;
      updated: number;
    },
  ): Promise<SyncResult> {
    await this.prisma.pspConnection.update({
      where: { id },
      data: { lastTriedAt: new Date(), lastError: error.slice(0, 500) },
    });
    return {
      ok: false,
      ...counts,
      // Whatever was stored before the failure is kept. A provider that goes
      // down on page thirty should not cost the twenty-nine that worked.
      stopped: 'stopped on an error',
      error,
    };
  }

  /**
   * The stored transactions for one connection.
   *
   * Read from our own table, not the provider — that is the entire point of
   * storing them. Opening a page must not cost fifty calls to somebody's
   * payment API.
   */
  async list(
    connectionId: string,
    q: {
      limit?: number;
      offset?: number;
      status?: string;
      direction?: string;
      from?: string;
      to?: string;
      search?: string;
    } = {},
  ) {
    const take = Math.min(Math.max(q.limit ?? 100, 1), 500);
    const skip = Math.max(q.offset ?? 0, 0);

    const where: Prisma.PspTransactionWhereInput = { connectionId };
    if (q.status) where.status = q.status;
    if (q.direction) where.direction = q.direction;
    if (q.from || q.to) {
      where.occurredAt = {
        ...(q.from ? { gte: new Date(q.from) } : {}),
        ...(q.to ? { lte: new Date(q.to) } : {}),
      };
    }
    if (q.search?.trim()) {
      const s = q.search.trim();
      where.OR = [
        { externalId: { contains: s, mode: 'insensitive' } },
        { reference: { contains: s, mode: 'insensitive' } },
        { customer: { contains: s, mode: 'insensitive' } },
      ];
    }

    // The extra columns are projected from the stored record HERE, at read
    // time, rather than being written into columns at sync time. Adding a
    // column then shows it on rows that arrived last week, with no re-sync and
    // no call to the provider — which matters when a provider keeps ninety
    // days and the rows we hold are the only copy left.
    const conn = await this.prisma.pspConnection.findUnique({
      where: { id: connectionId },
      select: { endpoints: true },
    });
    const endpoints = (conn?.endpoints ?? {}) as Record<string, EndpointConfig>;
    const extraSpec = endpoints.transactions?.fields?.extras;

    const [rows, total] = await Promise.all([
      this.prisma.pspTransaction.findMany({
        where,
        // Nulls last: a row whose timestamp we could not read still exists, and
        // burying it at the top of every page would be its own kind of wrong.
        orderBy: [{ occurredAt: 'desc' }, { firstSeenAt: 'desc' }],
        take,
        skip,
        select: {
          id: true,
          externalId: true,
          reference: true,
          direction: true,
          status: true,
          amount: true,
          currency: true,
          occurredAt: true,
          rawAt: true,
          customer: true,
          // Only when there is something to project from it. A page of a
          // hundred whole provider records is a couple of hundred kilobytes
          // that nothing on the screen would use.
          raw: Boolean(extraSpec && Object.keys(extraSpec).length),
        },
      }),
      this.prisma.pspTransaction.count({ where }),
    ]);

    return {
      total,
      limit: take,
      offset: skip,
      /** The column labels, in the order they were configured. */
      extraColumns: Object.keys(extraSpec ?? {}),
      rows: rows.map(({ raw, ...r }) => ({
        ...r,
        amount: r.amount === null ? null : Number(r.amount),
        occurredAt: r.occurredAt?.toISOString() ?? null,
        extras: extraSpec ? readExtras(raw, extraSpec) : {},
      })),
    };
  }

  /**
   * Every provider, for the desk rather than for an administrator.
   *
   * A SESSION is enough. Nothing here is a secret — no base URL, no key hint,
   * no endpoint configuration; just the terminal names the desk already reads
   * on every payment, and how much of each ledger we hold. Requiring the admin
   * passphrase to see that would mean the admin passphrase gets shared, which
   * is the failure the second password exists to prevent.
   */
  async directory() {
    const [conns, counts, latest] = await Promise.all([
      this.prisma.pspConnection.findMany({
        orderBy: [{ provider: 'asc' }, { terminal: 'asc' }],
        select: {
          id: true,
          terminal: true,
          label: true,
          provider: true,
          enabled: true,
          endpoints: true,
          balances: true,
          lastSyncAt: true,
          lastError: true,
        },
      }),
      this.prisma.pspTransaction.groupBy({
        by: ['connectionId'],
        _count: { _all: true },
      }),
      this.prisma.pspTransaction.groupBy({
        by: ['connectionId'],
        _max: { occurredAt: true },
      }),
    ]);

    const stored = new Map(counts.map((c) => [c.connectionId, c._count._all]));
    const newest = new Map(
      latest.map((c) => [c.connectionId, c._max.occurredAt]),
    );

    return conns.map((c) => {
      const endpoints = (c.endpoints ?? {}) as Record<string, EndpointConfig>;
      return {
        id: c.id,
        terminal: c.terminal,
        label: c.label,
        provider: c.provider,
        enabled: c.enabled,
        /** Whether there is a ledger to open — a card that leads nowhere is worse than no card. */
        hasTransactions: Boolean(endpoints.transactions?.path),
        stored: stored.get(c.id) ?? 0,
        newest: newest.get(c.id)?.toISOString() ?? null,
        lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
        /** Said plainly on the card: a provider that is failing should say so. */
        lastError: c.lastError,
        balances: c.balances ?? null,
      };
    });
  }

  /**
   * Every field the provider actually sends, read off the stored records.
   *
   * Configuring a column meant knowing a field name, and the only places to
   * learn one were the provider's documentation — which is wrong as often as
   * not; ForumPay's says GetTransactions returns a bare array and it does not —
   * or their portal, which shows columns the API does not return. Guessing
   * `payer_email` because the portal has a Payer Email column produces a column
   * of dashes and no explanation.
   *
   * So: look at what arrived. The whole record is kept, so this is a question
   * the data can answer, and it answers it with how OFTEN each field is filled
   * — which is the difference between a field that does not exist and one that
   * only Sell rows carry.
   */
  async fields(connectionId: string) {
    const rows = await this.prisma.pspTransaction.findMany({
      where: { connectionId },
      orderBy: { firstSeenAt: 'desc' },
      take: SAMPLE,
      select: { raw: true },
    });

    const seen = new Map<string, { filled: number; example: string | null }>();
    for (const { raw } of rows) {
      for (const [path, value] of flatten(raw)) {
        const at = seen.get(path) ?? { filled: 0, example: null };
        const empty =
          value === null || value === undefined || String(value).trim() === '';
        if (!empty) {
          at.filled++;
          // The first real value, trimmed. An example is what makes a field
          // name recognisable — "payer_id" means nothing, "CU43365" is obvious.
          at.example ??= String(value).slice(0, 60);
        }
        seen.set(path, at);
      }
    }

    return {
      sampled: rows.length,
      fields: [...seen.entries()]
        .map(([path, v]) => ({ path, ...v }))
        // Most-filled first: the fields worth a column are the ones with
        // values in them, and a field that is empty in every record sampled is
        // the answer to "why is my column all dashes".
        .sort((a, b) => b.filled - a.filled || a.path.localeCompare(b.path)),
    };
  }

  /** What the stored set looks like as a whole — the header of the page. */
  async summary(connectionId: string) {
    const [count, oldest, newest, statuses] = await Promise.all([
      this.prisma.pspTransaction.count({ where: { connectionId } }),
      this.prisma.pspTransaction.findFirst({
        where: { connectionId, occurredAt: { not: null } },
        orderBy: { occurredAt: 'asc' },
        select: { occurredAt: true },
      }),
      this.prisma.pspTransaction.findFirst({
        where: { connectionId, occurredAt: { not: null } },
        orderBy: { occurredAt: 'desc' },
        select: { occurredAt: true },
      }),
      this.prisma.pspTransaction.groupBy({
        by: ['status'],
        where: { connectionId },
        _count: { _all: true },
      }),
    ]);

    return {
      count,
      oldest: oldest?.occurredAt?.toISOString() ?? null,
      newest: newest?.occurredAt?.toISOString() ?? null,
      byStatus: statuses
        .map((s) => ({ status: s.status ?? '—', count: s._count._all }))
        .sort((a, b) => b.count - a.count),
    };
  }
}
