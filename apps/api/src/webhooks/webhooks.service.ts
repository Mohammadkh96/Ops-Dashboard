import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LiveBus } from '../live/live-bus.service';
import type { LiveTick } from '../live/live.types';

function asJson(v: unknown): Prisma.InputJsonValue {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return (v ?? {}) as Prisma.InputJsonValue;
}

/** Reads the first present key from a loosely-typed payload, case-insensitively. */
function pick(obj: Record<string, unknown>, keys: string[]): string {
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    const real = lower.get(k.toLowerCase());
    if (real === undefined) continue;
    const v = obj[real];
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'object') continue;
    return String(v);
  }
  return '';
}

function num(v: string): number {
  const n = Number.parseFloat(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isNaN(n) ? 0 : n;
}

const SETTLED = /complete|success|settle|approv|paid|finish|confirm/i;
const FAILED = /declin|cancel|fail|reject|expire|error|void|chargeback/i;

/**
 * Paymaxis shop -> jurisdiction, so live data slices the same way the
 * reconciliation does. Each shop is a separate merchant account with its own
 * key and its own callback host (5141 -> my.tradin.com, 6321 -> global.tradin.com).
 * Override with PAYMAXIS_SHOP_ENTITIES="5141=Mauritius,6321=Saint Lucia".
 */
const DEFAULT_SHOP_ENTITIES: Record<string, string> = {
  '5141': 'Mauritius',
  '6321': 'Saint Lucia',
};

function entityForShop(shop: string): string {
  if (!shop) return '';
  const overrides = process.env.PAYMAXIS_SHOP_ENTITIES;
  const map = { ...DEFAULT_SHOP_ENTITIES };
  if (overrides) {
    overrides.split(',').forEach((pair) => {
      const [k, v] = pair.split('=').map((x) => x.trim());
      if (k && v) map[k] = v;
    });
  }
  if (map[shop]) return map[shop];
  // Shops are also reported by name ("Cashier_Tradin_SL"), where the _SL suffix
  // is the jurisdiction marker — the same rule the reconciliation engine uses.
  if (/_sl\b|saint\s*lucia/i.test(shop)) return 'Saint Lucia';
  if (/tradin/i.test(shop)) return 'Mauritius';
  return '';
}

export type WebhookOutcome = {
  accepted: boolean;
  signatureOk: boolean;
  reason?: string;
  id?: string;
};

@Injectable()
export class WebhooksService {
  private readonly log = new Logger('Webhooks');

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: LiveBus,
  ) {}

  /** Capture mode stores unverified callbacks so the real payload and signature
   *  header can be observed from live traffic instead of guessed at. */
  private get captureMode(): boolean {
    return process.env.PAYMAXIS_WEBHOOK_CAPTURE === '1';
  }

  /**
   * Verifies an HMAC over the EXACT received bytes. The raw body is required —
   * re-serialising parsed JSON reorders keys and changes whitespace, which
   * breaks every signature scheme.
   */
  private verify(raw: Buffer | undefined, headers: Record<string, string>): { ok: boolean; reason?: string } {
    const key = process.env.PAYMAXIS_SIGNING_KEY;
    if (!key) return { ok: false, reason: 'PAYMAXIS_SIGNING_KEY is not configured' };
    if (!raw?.length) return { ok: false, reason: 'raw body unavailable' };

    const headerName = (process.env.PAYMAXIS_SIGNATURE_HEADER ?? 'x-signature').toLowerCase();
    const provided = headers[headerName];
    if (!provided) return { ok: false, reason: `signature header "${headerName}" absent` };

    const algo = process.env.PAYMAXIS_SIGNATURE_ALGO ?? 'sha256';
    // Accept either encoding — providers differ and the header rarely says which.
    // A fresh Hmac per attempt: digest() finalises the instance, so it cannot
    // be reused for a second encoding.
    for (const enc of ['hex', 'base64'] as const) {
      const expected = createHmac(algo, key).update(raw).digest(enc);
      const a = Buffer.from(expected);
      const b = Buffer.from(provided.trim().replace(/^sha256=/i, ''));
      if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true };
    }
    return { ok: false, reason: 'signature mismatch' };
  }

  async handlePaymaxis(
    raw: Buffer | undefined,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<WebhookOutcome> {
    const { ok, reason } = this.verify(raw, headers);

    if (!ok && !this.captureMode) {
      this.log.warn(`Rejected Paymaxis callback: ${reason}`);
      return { accepted: false, signatureOk: false, reason };
    }
    if (!ok) {
      this.log.warn(
        `Capture mode: storing UNVERIFIED Paymaxis callback (${reason}). ` +
          `Headers seen: ${Object.keys(headers).join(', ')}`,
      );
    }

    // Providers wrap the payment differently; unwrap the common shapes.
    const inner =
      (body.payment as Record<string, unknown>) ??
      (body.data as Record<string, unknown>) ??
      body;

    const paymentId = pick(inner, ['id', 'paymentId', 'payment_id', 'transactionId']);
    const reference = pick(inner, ['referenceId', 'reference_id', 'reference', 'merchantReference']);
    const state = pick(inner, ['state', 'status', 'paymentState']);
    const type = pick(inner, ['type', 'paymentType', 'transactionType']);
    const amount = num(pick(inner, ['amount', 'amountInShopBaseCurrency', 'value']));
    const currency = pick(inner, ['currency', 'currencyCode']);
    const shop = pick(inner, ['shop', 'shopId', 'shopName']);
    const entity = entityForShop(shop);
    const customer = pick(inner, ['customerEmail', 'customerReferenceId', 'customerAccountNumber', 'customer']);
    const occurred = pick(inner, ['updated', 'finalized', 'created', 'timestamp']);
    const eventType = pick(body, ['event', 'eventType', 'type']);

    const settled = SETTLED.test(state) ? true : FAILED.test(state) ? false : undefined;

    let id: string | undefined;
    try {
      const saved = await this.prisma.paymentEvent.create({
        data: {
          provider: 'paymaxis',
          signatureOk: ok,
          eventType: eventType || null,
          paymentId: paymentId || null,
          reference: reference || null,
          shop: shop || null,
          entity: entity || null,
          state: state || null,
          type: type || null,
          amount,
          currency: currency || null,
          customer: customer || null,
          occurredAt: occurred && !Number.isNaN(Date.parse(occurred)) ? new Date(occurred) : null,
          headers: asJson(headers),
          payload: asJson(body),
        },
      });
      id = saved.id;
    } catch (e) {
      // Never fail the callback because our storage hiccuped — the provider
      // would retry, and the event is still broadcast below.
      this.log.error(`Could not persist Paymaxis event: ${(e as Error).message}`);
    }

    const status: LiveTick['queueItem']['status'] =
      settled === true ? 'settled' : settled === false ? 'failed' : 'processing';
    this.bus.publish(
      {
        id: paymentId || reference || 'unknown',
        type: /withdraw/i.test(type) ? 'Withdrawal' : /refund/i.test(type) ? 'Refund' : 'Deposit',
        client: customer || '—',
        amount: amount ? `${currency || '$'}${amount.toLocaleString()}` : '—',
        status,
      },
      { settled, amount },
    );

    return { accepted: true, signatureOk: ok, id, reason };
  }

  /** Most recent events, for the dashboard's initial paint and for debugging. */
  recent(limit = 50) {
    return this.prisma.paymentEvent
      .findMany({ orderBy: { receivedAt: 'desc' }, take: Math.min(limit, 200) })
      .catch(() => []);
  }
}
