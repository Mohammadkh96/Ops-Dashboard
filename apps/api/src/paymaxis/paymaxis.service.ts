import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LiveBus } from '../live/live-bus.service';
import { PaymaxisClient } from './paymaxis.client';
import {
  normalizePayment,
  redactPayload,
  toQueueItem,
  unwrapPayment,
} from './normalize';

function asJson(v: unknown): Prisma.InputJsonValue {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return (v ?? {}) as Prisma.InputJsonValue;
}

/**
 * Something printable for any thrown value.
 *
 * Prisma's connection errors carry an empty `.message`, so logging `e.message`
 * alone produced "Store failed for pm-77421:" and nothing else — which reads
 * like a mapping bug when the real cause was an unreachable database.
 */
function errText(e: unknown): string {
  const err = e as { message?: string; code?: string; name?: string };
  return err?.message || err?.code || err?.name || String(e);
}

/**
 * Paymaxis API host.
 *
 * NOT api.paymaxis.com — that hostname does not exist (NXDOMAIN), and an earlier
 * default pointing there meant every poll failed with an unhelpful "fetch
 * failed". app.paymaxis.com is the host Paymaxis itself uses for the webhook
 * endpoints, and is the only one confirmed to resolve.
 *
 * The path, auth header and pagination params are all still configurable —
 * `scripts/discover-paymaxis.mjs` finds the working combination and prints the
 * exact settings to use.
 */
const PAYMAXIS_DEFAULT_BASE_URL = 'https://app.paymaxis.com';

/**
 * Smallest gap between syncs triggered by an open dashboard.
 *
 * Every viewer asking for fresh data would otherwise mean one upstream call per
 * viewer per page load, against a live payments API. A minute is well inside
 * "current" for an operations screen and bounds the request rate no matter how
 * many people are watching.
 */
const REFRESH_MIN_SECONDS = 60;

/**
 * Floor for a refresh somebody asked for by pressing the button.
 *
 * Someone pressing Refresh has a reason — they are watching a payment move, or
 * chasing one a customer is on the phone about — and declining silently because
 * an automatic poll happened forty seconds ago makes the button look broken.
 * Still floored, so holding the button down cannot turn into a request per
 * click against a live payments API.
 */
const FORCED_REFRESH_MIN_SECONDS = 10;

/** Watermark row holding when a sync was last attempted, as opposed to how far
 * each shop has been read. Shares the table so this needs no migration. */
const LAST_RUN_KEY = 'paymaxis:lastRun';

/**
 * When a sync last completed without any shop reporting an error.
 *
 * Kept apart from the attempt time because they diverge in the case that
 * matters: a rejected key or an unreachable host means every attempt "runs" and
 * fetches nothing, so an indicator built on attempts would report "synced
 * seconds ago" over data that stopped arriving hours earlier. That is the stale
 * figure presented as current that the whole freshness display exists to
 * prevent.
 */
const LAST_OK_KEY = 'paymaxis:lastOk';

/** The last error text, so the dashboard can say what is wrong rather than
 * only that something is. Empty string means the last run was clean. */
const LAST_ERROR_KEY = 'paymaxis:lastError';

export type RefreshStatus = {
  /** Whether this call actually reached Paymaxis, or was inside the rate limit. */
  ran: boolean;
  lastRunAt: string | null;
  /** The age that matters: when data last actually arrived. */
  lastOkAt: string | null;
  configured: boolean;
  error: string | null;
};

export type ShopConfig = { shopId: string; apiKey: string };

export type SyncResult = {
  shop: string;
  fetched: number;
  stored: number;
  broadcast: number;
  error?: string;
};

@Injectable()
export class PaymaxisService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Paymaxis');
  private timer?: ReturnType<typeof setInterval>;
  /** Watermark per shop so each poll only asks for what changed since. */
  private readonly since = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: LiveBus,
  ) {}

  /**
   * Shops come from env as "shopId:apiKey" pairs, so adding a shop needs no
   * code change. Keys are never logged.
   */
  get shops(): ShopConfig[] {
    const raw = process.env.PAYMAXIS_SHOPS ?? '';
    return raw
      .split(',')
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const i = pair.indexOf(':');
        return {
          shopId: pair.slice(0, i).trim(),
          apiKey: pair.slice(i + 1).trim(),
        };
      })
      .filter((s) => s.shopId && s.apiKey);
  }

  get enabled(): boolean {
    return process.env.PAYMAXIS_POLL_ENABLED === '1' && this.shops.length > 0;
  }

  /**
   * True on a platform that discards the process between requests (Vercel).
   * There, a setInterval would be killed the moment the invocation that created
   * it returns, so the schedule has to come from outside — see the cron entry in
   * apps/api/vercel.json, which calls GET /api/paymaxis/sync.
   */
  get serverless(): boolean {
    return !!process.env.VERCEL;
  }

  onModuleInit() {
    if (!this.enabled) {
      this.log.log(
        'Polling disabled (set PAYMAXIS_POLL_ENABLED=1 and PAYMAXIS_SHOPS).',
      );
      return;
    }
    if (this.serverless) {
      this.log.log(
        'Serverless runtime: no in-process timer. Polling is driven by the ' +
          'scheduled GET /api/paymaxis/sync (see vercel.json crons).',
      );
      return;
    }
    const secs = Math.max(15, Number(process.env.PAYMAXIS_POLL_SECONDS ?? 60));
    this.log.log(
      `Polling ${this.shops.length} shop(s) every ${secs}s (read-only).`,
    );
    // Fire once on boot so the dashboard is populated without waiting a cycle.
    void this.syncAll();
    this.timer = setInterval(() => void this.syncAll(), secs * 1000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * A sync driven by someone having the dashboard open.
   *
   * On Vercel there is no process between requests, so an in-process timer dies
   * the moment the invocation that created it returns, and the daily cron a
   * Hobby plan allows leaves the screen up to 24 hours out of date. The only
   * thing reliably running is a browser with the dashboard in it, so that is
   * what drives the poll — which also means data is freshest exactly when
   * somebody is looking at it.
   *
   * Rate limited through the database rather than a field on this instance:
   * serverless invocations do not share memory, so an in-process counter would
   * permit one call per cold start per viewer. The timestamp is written before
   * the sync rather than after, so two invocations racing on the same tick
   * cannot both decide they are the one to run.
   */
  async refresh(
    opts: { force?: boolean } = {},
  ): Promise<RefreshStatus & { results?: SyncResult[] }> {
    if (!this.shops.length) {
      return {
        ran: false,
        lastRunAt: null,
        lastOkAt: null,
        configured: false,
        error: null,
      };
    }

    const marks = await this.marks();
    const lastRunAt = marks.get(LAST_RUN_KEY) ?? null;
    const lastOkAt = marks.get(LAST_OK_KEY) ?? null;
    const ageMs = lastRunAt ? Date.now() - Date.parse(lastRunAt) : Infinity;
    const floor = opts.force
      ? FORCED_REFRESH_MIN_SECONDS
      : REFRESH_MIN_SECONDS;
    if (ageMs < floor * 1000) {
      return {
        ran: false,
        lastRunAt,
        lastOkAt,
        configured: true,
        error: marks.get(LAST_ERROR_KEY) ?? null,
      };
    }

    const now = new Date().toISOString();
    // Written before syncing rather than after, so two invocations racing on the
    // same tick cannot both decide they are the one to run. A database that
    // cannot be written to means no rate limit at all, which is not a reason to
    // start hammering a payments API — so a failed claim declines the run.
    await this.mark(LAST_RUN_KEY, now);

    const results = await this.syncAll();
    const failure = results.find((r) => r.error)?.error ?? null;
    if (failure) {
      await this.mark(LAST_ERROR_KEY, failure.slice(0, 500));
    } else {
      await this.mark(LAST_OK_KEY, now);
      await this.mark(LAST_ERROR_KEY, '');
    }

    return {
      ran: true,
      lastRunAt: now,
      lastOkAt: failure ? lastOkAt : now,
      configured: true,
      error: failure,
      results,
    };
  }

  /** Freshness without triggering anything, for callers that only want to know. */
  async freshness(): Promise<RefreshStatus> {
    const marks = await this.marks();
    return {
      ran: false,
      lastRunAt: marks.get(LAST_RUN_KEY) ?? null,
      lastOkAt: marks.get(LAST_OK_KEY) ?? null,
      configured: this.shops.length > 0,
      error: marks.get(LAST_ERROR_KEY) || null,
    };
  }

  private async marks(): Promise<Map<string, string>> {
    const rows = await this.prisma.pollWatermark
      .findMany({
        where: { key: { in: [LAST_RUN_KEY, LAST_OK_KEY, LAST_ERROR_KEY] } },
        select: { key: true, since: true },
      })
      .catch(() => []);
    return new Map(rows.map((r): [string, string] => [r.key, r.since]));
  }

  private async mark(key: string, value: string): Promise<void> {
    await this.prisma.pollWatermark
      .upsert({
        where: { key },
        create: { key, since: value },
        update: { since: value },
      })
      .catch((e: unknown) => {
        this.log.warn(`Could not write ${key}: ${errText(e)}`);
        return null;
      });
  }

  async syncAll(): Promise<SyncResult[]> {
    const out: SyncResult[] = [];
    for (const shop of this.shops) out.push(await this.syncShop(shop));
    return out;
  }

  private wmKey(shopId: string) {
    return `paymaxis:${shopId}`;
  }

  /**
   * Where to resume from. Memory first (a warm instance already knows), then the
   * database — which is the only copy that survives a serverless cold start.
   */
  private async loadSince(shopId: string): Promise<string | undefined> {
    const mem = this.since.get(shopId);
    if (mem) return mem;
    const row = await this.prisma.pollWatermark
      .findUnique({ where: { key: this.wmKey(shopId) } })
      .catch(() => null);
    return row?.since ?? undefined;
  }

  /** Advances the watermark in both places. A failed write is not fatal: the
   * next poll re-reads a little more, and dedupeKey discards the overlap. */
  private async saveSince(shopId: string, since: string): Promise<void> {
    this.since.set(shopId, since);
    await this.prisma.pollWatermark
      .upsert({
        where: { key: this.wmKey(shopId) },
        create: { key: this.wmKey(shopId), since },
        update: { since },
      })
      .catch((e: unknown) => {
        this.log.warn(
          `Could not persist watermark for ${shopId}: ${errText(e)}`,
        );
        return null;
      });
  }

  /** Reads one shop's recent payments and stores/broadcasts only what is new. */
  async syncShop(
    shop: ShopConfig,
    overrideSince?: string,
  ): Promise<SyncResult> {
    const res: SyncResult = {
      shop: shop.shopId,
      fetched: 0,
      stored: 0,
      broadcast: 0,
    };
    const client = new PaymaxisClient(
      process.env.PAYMAXIS_BASE_URL ?? PAYMAXIS_DEFAULT_BASE_URL,
      shop.apiKey,
      // Bearer, confirmed against the live API. X-Api-Key — the previous
      // default and the more common convention — returns 401 here.
      process.env.PAYMAXIS_AUTH_HEADER ?? 'Authorization',
    );

    // Default look-back on first run, then advance the watermark.
    const lookbackMins = Number(process.env.PAYMAXIS_LOOKBACK_MINUTES ?? 60);
    const since =
      overrideSince ??
      (await this.loadSince(shop.shopId)) ??
      new Date(Date.now() - lookbackMins * 60_000).toISOString();

    const maxPages = Number(process.env.PAYMAXIS_MAX_PAGES ?? 20);
    let page = 0;
    let newest = since;
    // Every payment seen in THIS sync, to detect a page that repeats itself.
    const seen = new Set<string>();

    try {
      for (; page < maxPages; page++) {
        const { records, hasMore } = await client.listPayments({
          updatedSince: since,
          page,
        });
        if (!records.length) break;
        res.fetched += records.length;
        let fresh = 0;

        // Normalise the whole page first, then write it in ONE statement.
        //
        // This used to insert a row per record, and each insert was a separate
        // round trip to the database — measured at ~440ms each against a hosted
        // Postgres. A 180-record first sync therefore took over a minute, which
        // on a serverless platform means the function is killed mid-sync before
        // it ever finishes (Vercel caps a request at 60s).
        const batch: {
          payload: Prisma.PaymentEventCreateManyInput;
          normalized: ReturnType<typeof normalizePayment>;
        }[] = [];

        for (const raw of records) {
          const p = normalizePayment(unwrapPayment(raw));
          if (!p.paymentId && !p.reference) continue; // nothing to key on
          const identity = p.dedupeKey || p.paymentId || p.reference;
          if (seen.has(identity)) continue;
          seen.add(identity);
          fresh += 1;
          if (p.occurredAt && p.occurredAt.toISOString() > newest)
            newest = p.occurredAt.toISOString();

          batch.push({
            normalized: p,
            payload: {
              provider: 'paymaxis',
              source: 'poll',
              signatureOk: true, // authenticated by our own outbound API key
              dedupeKey: p.dedupeKey,
              paymentId: p.paymentId || null,
              externalId: p.externalId || null,
              terminal: p.terminal || null,
              psp: p.psp || null,
              parentPaymentId: p.parentPaymentId || null,
              cryptoTxHash: p.cryptoTxHash || null,
              errorCode: p.errorCode || null,
              errorMessage: p.errorMessage || null,
              reference: p.reference || null,
              shop: p.shop || shop.shopId,
              entity: p.entity || null,
              state: p.state || null,
              type: p.type || null,
              amount: p.amount,
              currency: p.currency || null,
              customer: p.customer || null,
              occurredAt: p.occurredAt,
              headers: asJson({}),
              payload: asJson(redactPayload(raw)),
            },
          });
        }

        // Which of these are genuinely new. createMany + skipDuplicates already
        // makes the unique dedupeKey the arbiter of what gets WRITTEN, but it
        // reports only a count — not which rows survived — and the feed must
        // announce exactly the new ones or it repeats itself every cycle.
        const keys = batch.map((b) => b.payload.dedupeKey).filter(Boolean) as string[];
        const existing = await this.prisma.paymentEvent
          .findMany({ where: { dedupeKey: { in: keys } }, select: { dedupeKey: true } })
          .catch(() => [] as { dedupeKey: string | null }[]);
        const known = new Set(existing.map((e) => e.dedupeKey));
        const incoming = batch.filter((b) => !known.has(b.payload.dedupeKey ?? null));

        let storedOnPage = 0;
        if (incoming.length) {
          const written = await this.prisma.paymentEvent
            .createMany({
              data: incoming.map((b) => b.payload),
              skipDuplicates: true,
            })
            .catch((e: unknown) => {
              this.log.error(`Store failed for shop ${shop.shopId}: ${errText(e)}`);
              return { count: 0 };
            });

          if (written.count > 0) {
            res.stored += written.count;
            storedOnPage = written.count;
            for (const b of incoming) {
              this.bus.publish(toQueueItem(b.normalized), {
                settled: b.normalized.settled,
                amount: b.normalized.amount,
              });
              res.broadcast += 1;
            }
          }
        }
        if (!hasMore) break;

        // Caught up. The list is ordered newest-first and there is no date
        // filter, so "this whole page was already in the database" means
        // everything past it is older and already known. Without this the
        // poller would walk the entire payment history on every single run
        // just to rediscover that it had seen all of it.
        //
        // The trade-off is deliberate: a payment inserted far down the list
        // after we passed that point would be missed. Nothing can insert into
        // the past of a newest-first feed, so that only applies to a bulk
        // backfill by the provider — for which the answer is a manual
        // POST /paymaxis/sync, not a slower poll forever.
        // Applies from the very first page: on a steady-state poll the newest
        // page is already known and there is nothing behind it worth walking.
        // Deliberately silent. This is the normal outcome of a steady-state
        // poll — nothing new — and it happens once a minute per shop forever.
        // Logging it buries the events that matter and, on a metered platform,
        // is paid-for noise. What a sync stored is reported below instead.
        if (!storedOnPage) break;

        // Stop when a page adds nothing new.
        //
        // A defence against the pagination parameter silently not working: if
        // `offset` ever stops being honoured the API returns the same newest
        // records every time. Without this guard the
        // loop would re-fetch that identical page maxPages times on every run —
        // harmless to the data (dedupeKey discards it) but 20x the API calls.
        if (!fresh) {
          this.log.warn(
            `Shop ${shop.shopId}: page ${page + 1} repeated the previous page — ` +
              'no pagination parameter is taking effect, stopping.',
          );
          break;
        }
      }
      // Advance only on success, so a failed poll re-reads rather than skipping.
      await this.saveSince(shop.shopId, newest);
      // The one thing worth a line in the log: real payments arrived. A quiet
      // poll says nothing, so anything that appears here is a genuine event.
      if (res.stored > 0) {
        this.log.log(
          `Shop ${shop.shopId}: ${res.stored} new payment(s) from ${res.fetched} read.`,
        );
      }
    } catch (e) {
      res.error = (e as Error).message;
      this.log.error(`Sync failed for shop ${shop.shopId}: ${res.error}`);
    }
    return res;
  }

  async status() {
    const marks: { key: string; since: string }[] =
      await this.prisma.pollWatermark
        .findMany({
          where: { key: { startsWith: 'paymaxis:' } },
          select: { key: true, since: true },
        })
        .catch(() => []);
    const bySkey = new Map(
      marks.map((m): [string, string] => [m.key, m.since]),
    );
    // Every terminal ever seen, with the PSP it resolved to, over all history
    // rather than the dashboard's 24-hour window.
    //
    // "Why is this PSP missing?" has three different answers — it is not routed
    // through Paymaxis at all, it had no activity in the window, or its terminal
    // name did not match a known pattern — and they call for completely
    // different responses. This distinguishes them: a terminal present here but
    // absent from the dashboard was simply quiet; a terminal whose psp looks
    // like a raw name fragment needs a pattern adding to TERMINAL_PSP.
    const terminals = await this.prisma.paymentEvent
      .groupBy({
        by: ['psp', 'terminal', 'entity'],
        _count: { _all: true },
        _max: { occurredAt: true },
      })
      .catch(() => []);

    return {
      enabled: this.enabled,
      // Driven by cron on serverless, by an in-process timer otherwise.
      schedule: this.serverless ? 'cron' : 'interval',
      baseUrl: process.env.PAYMAXIS_BASE_URL ?? PAYMAXIS_DEFAULT_BASE_URL,
      pollSeconds: Number(process.env.PAYMAXIS_POLL_SECONDS ?? 60),
      lastRunAt: bySkey.get(LAST_RUN_KEY) ?? null,
      lastOkAt: bySkey.get(LAST_OK_KEY) ?? null,
      lastError: bySkey.get(LAST_ERROR_KEY) || null,
      // Shop ids only — never the keys.
      shops: this.shops.map((s) => ({
        shopId: s.shopId,
        since:
          this.since.get(s.shopId) ?? bySkey.get(this.wmKey(s.shopId)) ?? null,
      })),
      terminals: terminals
        .map((t) => ({
          psp: t.psp,
          terminal: t.terminal,
          entity: t.entity,
          payments: t._count._all,
          lastSeen: t._max.occurredAt,
        }))
        .sort((a, b) => b.payments - a.payments),
    };
  }
}
