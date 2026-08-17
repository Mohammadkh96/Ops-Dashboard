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
      process.env.PAYMAXIS_AUTH_HEADER ?? 'X-Api-Key',
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

    try {
      for (; page < maxPages; page++) {
        const { records, hasMore } = await client.listPayments({
          updatedSince: since,
          page,
        });
        if (!records.length) break;
        res.fetched += records.length;

        for (const raw of records) {
          const p = normalizePayment(unwrapPayment(raw));
          if (!p.paymentId && !p.reference) continue; // nothing to key on
          if (p.occurredAt && p.occurredAt.toISOString() > newest)
            newest = p.occurredAt.toISOString();

          // createMany + skipDuplicates makes the unique dedupeKey the arbiter,
          // so a re-poll of unchanged payments stores nothing and — critically —
          // broadcasts nothing. Without this the feed would repeat every cycle.
          const created = await this.prisma.paymentEvent
            .createMany({
              data: [
                {
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
              ],
              skipDuplicates: true,
            })
            .catch((e: unknown) => {
              this.log.error(`Store failed for ${p.paymentId}: ${errText(e)}`);
              return { count: 0 };
            });

          if (created.count > 0) {
            res.stored += created.count;
            this.bus.publish(toQueueItem(p), {
              settled: p.settled,
              amount: p.amount,
            });
            res.broadcast += 1;
          }
        }
        if (!hasMore) break;
      }
      // Advance only on success, so a failed poll re-reads rather than skipping.
      await this.saveSince(shop.shopId, newest);
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
    return {
      enabled: this.enabled,
      // Driven by cron on serverless, by an in-process timer otherwise.
      schedule: this.serverless ? 'cron' : 'interval',
      baseUrl: process.env.PAYMAXIS_BASE_URL ?? PAYMAXIS_DEFAULT_BASE_URL,
      pollSeconds: Number(process.env.PAYMAXIS_POLL_SECONDS ?? 60),
      // Shop ids only — never the keys.
      shops: this.shops.map((s) => ({
        shopId: s.shopId,
        since:
          this.since.get(s.shopId) ?? bySkey.get(this.wmKey(s.shopId)) ?? null,
      })),
    };
  }
}
