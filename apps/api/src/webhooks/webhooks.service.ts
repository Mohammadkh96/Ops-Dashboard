import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LiveBus } from '../live/live-bus.service';
import { normalizePayment, toQueueItem, unwrapPayment } from '../paymaxis/normalize';

function asJson(v: unknown): Prisma.InputJsonValue {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return (v ?? {}) as Prisma.InputJsonValue;
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

    const p = normalizePayment(unwrapPayment(body));
    const eventType = String(body.event ?? body.eventType ?? '');

    let id: string | undefined;
    try {
      const saved = await this.prisma.paymentEvent.create({
        data: {
          provider: 'paymaxis',
          signatureOk: ok,
          source: 'webhook',
          dedupeKey: p.dedupeKey,
          eventType: eventType || null,
          paymentId: p.paymentId || null,
          reference: p.reference || null,
          shop: p.shop || null,
          entity: p.entity || null,
          state: p.state || null,
          type: p.type || null,
          amount: p.amount,
          currency: p.currency || null,
          customer: p.customer || null,
          occurredAt: p.occurredAt,
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

    this.bus.publish(toQueueItem(p), { settled: p.settled, amount: p.amount });

    return { accepted: true, signatureOk: ok, id, reason };
  }

  /** Most recent events, for the dashboard's initial paint and for debugging. */
  recent(limit = 50) {
    return this.prisma.paymentEvent
      .findMany({ orderBy: { receivedAt: 'desc' }, take: Math.min(limit, 200) })
      .catch(() => []);
  }
}
