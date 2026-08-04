import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LiveBus } from '../live/live-bus.service';
import { PaymaxisClient } from './paymaxis.client';
import { normalizePayment, toQueueItem, unwrapPayment } from './normalize';

function asJson(v: unknown): Prisma.InputJsonValue {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return (v ?? {}) as Prisma.InputJsonValue;
}

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
        return { shopId: pair.slice(0, i).trim(), apiKey: pair.slice(i + 1).trim() };
      })
      .filter((s) => s.shopId && s.apiKey);
  }

  get enabled(): boolean {
    return process.env.PAYMAXIS_POLL_ENABLED === '1' && this.shops.length > 0;
  }

  onModuleInit() {
    if (!this.enabled) {
      this.log.log('Polling disabled (set PAYMAXIS_POLL_ENABLED=1 and PAYMAXIS_SHOPS).');
      return;
    }
    const secs = Math.max(15, Number(process.env.PAYMAXIS_POLL_SECONDS ?? 60));
    this.log.log(`Polling ${this.shops.length} shop(s) every ${secs}s (read-only).`);
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

  /** Reads one shop's recent payments and stores/broadcasts only what is new. */
  async syncShop(shop: ShopConfig, overrideSince?: string): Promise<SyncResult> {
    const res: SyncResult = { shop: shop.shopId, fetched: 0, stored: 0, broadcast: 0 };
    const client = new PaymaxisClient(
      process.env.PAYMAXIS_BASE_URL ?? 'https://api.paymaxis.com',
      shop.apiKey,
      process.env.PAYMAXIS_AUTH_HEADER ?? 'X-Api-Key',
    );

    // Default look-back on first run, then advance the watermark.
    const lookbackMins = Number(process.env.PAYMAXIS_LOOKBACK_MINUTES ?? 60);
    const since =
      overrideSince ??
      this.since.get(shop.shopId) ??
      new Date(Date.now() - lookbackMins * 60_000).toISOString();

    const maxPages = Number(process.env.PAYMAXIS_MAX_PAGES ?? 20);
    let page = 0;
    let newest = since;

    try {
      for (; page < maxPages; page++) {
        const { records, hasMore } = await client.listPayments({ updatedSince: since, page });
        if (!records.length) break;
        res.fetched += records.length;

        for (const raw of records) {
          const p = normalizePayment(unwrapPayment(raw));
          if (!p.paymentId && !p.reference) continue; // nothing to key on
          if (p.occurredAt && p.occurredAt.toISOString() > newest) newest = p.occurredAt.toISOString();

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
                  payload: asJson(raw),
                },
              ],
              skipDuplicates: true,
            })
            .catch((e: Error) => {
              this.log.error(`Store failed for ${p.paymentId}: ${e.message}`);
              return { count: 0 };
            });

          if (created.count > 0) {
            res.stored += created.count;
            this.bus.publish(toQueueItem(p), { settled: p.settled, amount: p.amount });
            res.broadcast += 1;
          }
        }
        if (!hasMore) break;
      }
      // Advance only on success, so a failed poll re-reads rather than skipping.
      this.since.set(shop.shopId, newest);
    } catch (e) {
      res.error = (e as Error).message;
      this.log.error(`Sync failed for shop ${shop.shopId}: ${res.error}`);
    }
    return res;
  }

  status() {
    return {
      enabled: this.enabled,
      baseUrl: process.env.PAYMAXIS_BASE_URL ?? 'https://api.paymaxis.com',
      pollSeconds: Number(process.env.PAYMAXIS_POLL_SECONDS ?? 60),
      // Shop ids only — never the keys.
      shops: this.shops.map((s) => ({ shopId: s.shopId, since: this.since.get(s.shopId) ?? null })),
    };
  }
}
