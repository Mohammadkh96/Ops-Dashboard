import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LiveBus } from '../live/live-bus.service';
import { normalizePayment, redactPayload, toQueueItem, unwrapPayment } from '../paymaxis/normalize';

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
   * Every shop has its OWN signing key, and the signature must be checked
   * before the body can be trusted — so the shop is not yet known. Each
   * configured key is therefore tried until one verifies. That is still strict
   * HMAC verification, just against the small set of keys we own.
   */
  private signingKeys(): { label: string; key: string }[] {
    const out: { label: string; key: string }[] = [];
    // "5141=key,6321=key" — preferred, so logs can name the shop.
    const multi = process.env.PAYMAXIS_SIGNING_KEYS;
    if (multi) {
      multi.split(',').forEach((pair) => {
        const i = pair.indexOf('=');
        if (i > 0) out.push({ label: pair.slice(0, i).trim(), key: pair.slice(i + 1).trim() });
        else if (pair.trim()) out.push({ label: 'shop?', key: pair.trim() });
      });
    }
    const single = process.env.PAYMAXIS_SIGNING_KEY;
    if (single) out.push({ label: 'default', key: single });
    return out.filter((k) => k.key);
  }

  private verify(
    raw: Buffer | undefined,
    headers: Record<string, string>,
  ): { ok: boolean; reason?: string; shopHint?: string } {
    const keys = this.signingKeys();
    if (!keys.length) {
      return { ok: false, reason: 'no signing key configured (PAYMAXIS_SIGNING_KEYS)' };
    }
    if (!raw?.length) return { ok: false, reason: 'raw body unavailable' };

    const algo = process.env.PAYMAXIS_SIGNATURE_ALGO ?? 'sha256';
    const configured = process.env.PAYMAXIS_SIGNATURE_HEADER?.toLowerCase();

    // Which header carries the signature is provider-specific and easy to get
    // wrong. Rather than depend on a guess, compute the expected HMAC and look
    // for ANY header whose value equals it. That is not a weakening: a header
    // only "matches" if it already equals an HMAC produced with a key we hold,
    // which an attacker cannot forge. When the header IS configured it is tried
    // first, and the header that matched is reported so it can be pinned.
    const candidates: [string, string][] = configured
      ? Object.entries(headers).filter(([h]) => h.toLowerCase() === configured)
      : [];
    if (!candidates.length) {
      candidates.push(
        ...Object.entries(headers).filter(
          ([h, v]) =>
            typeof v === 'string' &&
            v.length >= 32 && // an HMAC digest is never shorter than this
            !['authorization', 'cookie'].includes(h.toLowerCase()),
        ),
      );
    }
    if (!candidates.length) {
      return { ok: false, reason: 'no header looks like a signature' };
    }

    for (const { label, key } of keys) {
      // Accept either encoding — providers differ and the header rarely says
      // which. A fresh Hmac per attempt: digest() finalises the instance.
      for (const enc of ['hex', 'base64'] as const) {
        const expected = Buffer.from(createHmac(algo, key).update(raw).digest(enc));
        for (const [header, value] of candidates) {
          const given = Buffer.from(String(value).trim().replace(/^sha256=/i, ''));
          if (expected.length === given.length && timingSafeEqual(expected, given)) {
            if (!configured) {
              this.log.log(
                `Signature verified from header "${header}" (${enc}). ` +
                  `Pin it with PAYMAXIS_SIGNATURE_HEADER=${header}`,
              );
            }
            return { ok: true, shopHint: label };
          }
        }
      }
    }
    return {
      ok: false,
      reason:
        `signature matched none of the ${keys.length} configured key(s) ` +
        `across ${candidates.length} candidate header(s)`,
    };
  }

  async handlePaymaxis(
    raw: Buffer | undefined,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<WebhookOutcome> {
    const { ok, reason, shopHint } = this.verify(raw, headers);

    if (!ok && !this.captureMode) {
      this.log.warn(`Rejected Paymaxis callback: ${reason}`);
      return { accepted: false, signatureOk: false, reason };
    }
    if (!ok) {
      this.log.warn(
        `Capture mode: storing UNVERIFIED Paymaxis callback (${reason}). ` +
          `Headers seen: ${Object.keys(headers).join(', ')}`,
      );
    } else if (shopHint && shopHint !== 'default') {
      this.log.log(`Verified Paymaxis callback with the ${shopHint} signing key.`);
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
          externalId: p.externalId || null,
          terminal: p.terminal || null,
          psp: p.psp || null,
          parentPaymentId: p.parentPaymentId || null,
          cryptoTxHash: p.cryptoTxHash || null,
          errorCode: p.errorCode || null,
          errorMessage: p.errorMessage || null,
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
          payload: asJson(redactPayload(body)),
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
