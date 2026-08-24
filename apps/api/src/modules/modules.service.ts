import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import {
  isFailedState,
  isSettledState,
  providerLabel,
} from '../paymaxis/normalize';
import { parseInstant, type TimeRange } from '../common/range';
import {
  GROUP_LABELS,
  PAYMENT_FIELDS,
  paymentFieldValues,
  type MappedRow,
} from './payment-fields';
import { dbError } from '../common/db-error';
import { buildClientProfile } from './client-profile';
import {
  detectIncidents,
  type Detection,
  type DetectRow,
} from './incident-detect';
import { buildSuccessRate, type SuccessRow } from './success-rate';

/**
 * Serves the operational module datasets.
 *
 * Representative fallback data keeps a fresh environment from looking broken,
 * but every fallback is gated on isLive(): once real payments exist, invented
 * rows are never served, because beside real money they cannot be told apart
 * from it.
 */
@Injectable()
export class ModulesService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly clients = [
    '#48213',
    '#10042',
    '#55210',
    '#22981',
    '#77120',
    '#30918',
    '#66203',
    '#12844',
    '#90117',
    '#40551',
  ];
  private readonly countries = [
    'AE',
    'DE',
    'GB',
    'FR',
    'SA',
    'NG',
    'IN',
    'SG',
    'BR',
    'ES',
  ];
  private readonly gatewayNames = [
    'ForumPay',
    'LimePay',
    'Paystrax',
    'Coinbase',
    'Stripe',
    'Nuvei',
    'Bridge',
  ];
  private readonly methods = ['Card', 'Crypto', 'Bank', 'Local'];
  private readonly ccy = ['USD', 'EUR', 'GBP', 'AED', 'BTC'];
  private readonly txStatuses = [
    'approved',
    'processing',
    'pending',
    'review',
    'declined',
    'failed',
    'refunded',
  ];
  private readonly risks = [
    'low',
    'low',
    'low',
    'medium',
    'medium',
    'high',
    'critical',
  ];

  private seeded(n: number) {
    let s = n * 9301 + 49297;
    return () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
  }

  // -------- shared mappers --------

  private lower(v: string) {
    return v.toLowerCase();
  }

  private methodLabel(m: string) {
    return m === 'LOCAL_PAYMENT' ? 'Local' : m[0] + m.slice(1).toLowerCase();
  }

  private kycLabel(s: string) {
    return s === 'APPROVED' ? 'approved_kyc' : s.toLowerCase();
  }

  private ticketStatus(s: string) {
    return s.toLowerCase();
  }

  private hhmm(d: Date) {
    return d.toISOString().slice(11, 16);
  }

  private ago(d: Date) {
    const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  }

  /**
   * For writes, where there is no honest fallback: the caller asked for a
   * change, so either it happened or they need to know exactly why it did not.
   */
  private async safeOrThrow<T>(fn: () => Promise<T>, doing: string): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw dbError(e, doing);
    }
  }

  private async safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  }

  // -------- transactions --------

  private transactionsFallback() {
    return Array.from({ length: 42 }, (_, i) => {
      const r = this.seeded(i + 1);
      const type = r() > 0.55 ? 'Withdrawal' : 'Deposit';
      const amount =
        Math.round(
          (r() * (type === 'Withdrawal' ? 95000 : 12000) + 120) * 100,
        ) / 100;
      return {
        id: `tx-${i + 1}`,
        reference: `TX-${88200 + i}`,
        client: `Client ${this.clients[Math.floor(r() * this.clients.length)]}`,
        country: this.countries[Math.floor(r() * this.countries.length)],
        gateway: this.gatewayNames[Math.floor(r() * this.gatewayNames.length)],
        method: this.methods[Math.floor(r() * this.methods.length)],
        currency: this.ccy[Math.floor(r() * this.ccy.length)],
        amount,
        type,
        status: this.txStatuses[Math.floor(r() * this.txStatuses.length)],
        risk: this.risks[Math.floor(r() * this.risks.length)],
        createdAt: `${String(Math.floor(r() * 23)).padStart(2, '0')}:${String(Math.floor(r() * 59)).padStart(2, '0')}`,
      };
    });
  }

  /**
   * The field catalogue: which columns exist, what to call them, how to group
   * them. Served rather than duplicated in the frontend so the table, the
   * drawer and the export cannot drift from what the API actually returns.
   */
  columns() {
    return { groups: GROUP_LABELS, fields: PAYMENT_FIELDS };
  }

  /**
   * Rows inside a window, preferring when the payment actually happened over
   * when we heard about it. A callback can arrive minutes after the event, and
   * filtering on arrival time would put a payment in the wrong day.
   */
  private inRange(r: TimeRange) {
    return {
      OR: [
        { occurredAt: { gte: r.from, lte: r.to } },
        {
          AND: [
            { occurredAt: null },
            { receivedAt: { gte: r.from, lte: r.to } },
          ],
        },
      ],
    };
  }

  /**
   * True once any real payment has been ingested.
   *
   * Every fallback in this file is gated on it. Invented rows make an empty
   * environment look like a product, and are indistinguishable from real ones
   * the moment actual money is on the screen.
   */
  private async isLive(): Promise<boolean> {
    return (await this.safe(() => this.prisma.paymentEvent.count(), 0)) > 0;
  }

  /**
   * Paymaxis payment method -> the four buckets the Method filter offers.
   *
   * Wallets count as Card because that is how they settle and how they appear
   * on a card statement — Google Pay landing under "Local" put it in the same
   * group as a bank-transfer rail, which is wrong for anyone reconciling
   * against an acquirer.
   */
  private paymentMethodBucket(
    raw: unknown,
  ): 'Card' | 'Crypto' | 'Bank' | 'Local' {
    const s = String(raw ?? '').toUpperCase();
    if (/CRYPTO|COIN|USDT|BTC|ETH/.test(s)) return 'Crypto';
    if (/BANK|SEPA|WIRE|TRANSFER/.test(s)) return 'Bank';
    if (/CARD|GOOGLE_?PAY|APPLE_?PAY|WALLET/.test(s)) return 'Card';
    return 'Local';
  }

  /**
   * Real payments, newest first.
   *
   * Reads PaymentEvent — where Paymaxis data actually lands — rather than the
   * Transaction table, which nothing writes to and which therefore always fell
   * through to 42 invented rows.
   *
   * A payment is stored once per state it passes through, which is right for an
   * audit trail and wrong for a ledger view: the same payment would appear
   * several times, at different statuses. Collapsed here to its latest state.
   */
  async transactions(kind?: string, range?: TimeRange) {
    if (!(await this.isLive())) return this.transactionsFallback();

    const rows = await this.safe(
      () =>
        this.prisma.paymentEvent.findMany({
          where: range ? this.inRange(range) : {},
          orderBy: [{ occurredAt: 'desc' }, { receivedAt: 'desc' }],
          take: 400,
          select: {
            id: true,
            paymentId: true,
            reference: true,
            externalId: true,
            customer: true,
            entity: true,
            psp: true,
            terminal: true,
            currency: true,
            amount: true,
            type: true,
            state: true,
            occurredAt: true,
            receivedAt: true,
            // Read for the full field set behind each row: the drawer and the
            // column picker offer everything Paymaxis sent, not the nine
            // columns the table happens to show by default.
            parentPaymentId: true,
            cryptoTxHash: true,
            errorCode: true,
            errorMessage: true,
            shop: true,
            source: true,
            signatureOk: true,
            // paymentMethod is only in the raw payload; reading it here avoids
            // a schema change and works on everything already stored.
            payload: true,
          },
        }),
      [],
    );

    const wanted = (kind ?? '').toLowerCase();
    const seen = new Set<string>();
    const out: ReturnType<typeof this.mapPaymentRow>[] = [];

    for (const r of rows) {
      const identity = r.paymentId || r.reference || r.id;
      if (seen.has(identity)) continue; // newest state wins
      seen.add(identity);
      const row = this.mapPaymentRow(r);
      if (wanted && row.type.toLowerCase() !== wanted) continue;
      out.push(row);
      if (out.length >= 150) break;
    }
    return out;
  }

  /**
   * One client's history, keyed by the customer reference the provider sends.
   *
   * Deliberately NOT filtered by the dashboard's selected window: "Total
   * Deposits" means what this client has ever paid in, and a lifetime figure
   * that quietly changed when someone clicked 24h would be worse than no
   * figure. The window still applies to the table this was opened from.
   *
   * The client window carries its own optional from/to instead, because
   * narrowing a client's history is a different question ("what did they do
   * last week?") asked at a different moment. Absent them, this is everything
   * we hold.
   *
   * @param from inclusive ISO instant; the client's whole history when absent.
   * @param to   inclusive ISO instant.
   */
  async clientProfile(reference: string, from?: string, to?: string) {
    const gte = parseInstant(from);
    const lte = parseInstant(to);
    const windowed = Boolean(gte || lte);
    const where = {
      customer: reference,
      ...(windowed
        ? { occurredAt: { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } }
        : {}),
    };

    // A hard cap protects the request, so the count is read separately: a
    // truncated total must be able to SAY it is truncated rather than quietly
    // report a smaller number under the same label.
    const EVENT_CAP = 5000;
    const [rows, events, span] = await Promise.all([
      this.safe(
        () =>
          this.prisma.paymentEvent.findMany({
            where,
            orderBy: [{ occurredAt: 'desc' }, { receivedAt: 'desc' }],
            take: EVENT_CAP,
          }),
        [],
      ),
      this.safe(() => this.prisma.paymentEvent.count({ where }), 0),
      // What we hold for this client overall, whatever the window — so the
      // window control can say how far back there is anything to look at.
      this.safe(
        () =>
          this.prisma.paymentEvent.aggregate({
            where: { customer: reference },
            _min: { occurredAt: true },
            _max: { occurredAt: true },
          }),
        null as { _min: { occurredAt: Date | null }; _max: { occurredAt: Date | null } } | null,
      ),
    ]);
    // An empty window is a real answer ("nothing that week"), not a missing
    // client — but a reference we have never seen still returns null.
    if (!rows.length && !windowed) return null;

    // Collapse to one row per payment, newest state first — the same rule the
    // table uses. Summing every stored state would count a payment once for
    // each state it passed through.
    const seen = new Set<string>();
    const latest = rows.filter((r) => {
      const identity = r.paymentId || r.reference || r.id;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });

    return buildClientProfile(reference, latest as MappedRow[], {
      from: gte ? gte.toISOString() : null,
      to: lte ? lte.toISOString() : null,
      truncated: events > EVENT_CAP,
      heldFrom: span?._min.occurredAt ? span._min.occurredAt.toISOString() : null,
      heldTo: span?._max.occurredAt ? span._max.occurredAt.toISOString() : null,
    });
  }

  /**
   * Headline figures for the Payments / Deposits / Withdrawals pages, over a
   * rolling 24 hours.
   *
   * Those pages carried hardcoded tiles — "$2.91M today", "$1,240 average" —
   * which stayed fixed no matter what the table underneath them showed. Returns
   * null when there is no real data, so the caller can show nothing rather than
   * zeros pretending to be measurements.
   *
   * Volume counts settled money only: an attempted deposit that was declined is
   * not revenue, and averaging it in understates the size of a real one.
   */
  async paymentStats(kind?: string, range?: TimeRange) {
    if (!(await this.isLive())) return null;

    const rows = await this.safe(
      () =>
        this.prisma.paymentEvent.findMany({
          where: range ? this.inRange(range) : {},
          select: {
            paymentId: true, reference: true, id: true,
            amount: true, currency: true, type: true, state: true,
            psp: true, occurredAt: true, receivedAt: true,
          },
          take: 50_000,
        }),
      [],
    );

    // One entry per payment at its latest state, so a payment that went
    // PENDING then COMPLETED is counted once rather than twice.
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const key = r.paymentId || r.reference || r.id;
      const prev = latest.get(key);
      const at = (x: (typeof rows)[number]) =>
        (x.occurredAt ?? x.receivedAt).getTime();
      if (!prev || at(r) > at(prev)) latest.set(key, r);
    }

    const wanted = (kind ?? '').toLowerCase();
    const scoped = [...latest.values()].filter((r) => {
      if (!wanted) return true;
      const t = r.type ?? '';
      const label = /refund/i.test(t)
        ? 'refund'
        : /withdraw|payout/i.test(t)
          ? 'withdrawal'
          : 'deposit';
      return label === wanted;
    });

    const settled = scoped.filter((r) => isSettledState(r.state ?? ''));
    const declined = scoped.filter((r) => isFailedState(r.state ?? ''));
    const volume = settled.reduce((s, r) => s + Math.abs(r.amount), 0);
    const decided = settled.length + declined.length;

    const byPsp = new Map<string, number>();
    settled.forEach((r) =>
      byPsp.set(r.psp ?? '—', (byPsp.get(r.psp ?? '—') ?? 0) + Math.abs(r.amount)),
    );
    const topPsp = [...byPsp.entries()].sort((a, b) => b[1] - a[1])[0];

    return {
      window: range?.label ?? 'all',
      currency: settled[0]?.currency ?? scoped[0]?.currency ?? '',
      volume: Number(volume.toFixed(2)),
      count: scoped.length,
      settled: settled.length,
      declined: declined.length,
      average: settled.length ? Number((volume / settled.length).toFixed(2)) : 0,
      largest: settled.length
        ? Number(Math.max(...settled.map((r) => Math.abs(r.amount))).toFixed(2))
        : 0,
      successRate: decided
        ? Number(((settled.length / decided) * 100).toFixed(1))
        : null,
      topPsp: topPsp ? { psp: topPsp[0], volume: Number(topPsp[1].toFixed(2)) } : null,
    };
  }

  /**
   * Everything known about one payment.
   *
   * The row detail panel showed six fields and an invented three-step timeline
   * whose entries all carried the same timestamp. Far more is already stored —
   * the provider's whole payload is kept verbatim precisely so nothing is lost
   * to a mapping gap — including billing address, country, the PSP's own
   * reference, the on-chain hash and the decline reason.
   *
   * The timeline is real: a payment is stored once per state it passes through,
   * so its history is simply the rows sharing its id, oldest first. That is a
   * genuine audit trail of when it was created, when it was declined and why.
   */
  async transactionDetail(id: string) {
    const anchor = await this.safe(
      () => this.prisma.paymentEvent.findUnique({ where: { id } }),
      null,
    );
    if (!anchor) return null;

    const key = anchor.paymentId || anchor.reference;
    const history = key
      ? await this.safe(
          () =>
            this.prisma.paymentEvent.findMany({
              where: anchor.paymentId
                ? { paymentId: anchor.paymentId }
                : { reference: anchor.reference },
              orderBy: [{ occurredAt: 'asc' }, { receivedAt: 'asc' }],
              select: {
                id: true, state: true, errorCode: true, errorMessage: true,
                amount: true, occurredAt: true, receivedAt: true, source: true,
              },
            }),
          [],
        )
      : [];

    const payload = (anchor.payload ?? {}) as Record<string, unknown>;
    const billing = (payload.billingAddress ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

    return {
      id: anchor.id,
      // Identity: three different references, all of which get used when
      // chasing a payment with a provider or a bank.
      paymentId: anchor.paymentId,
      reference: anchor.reference,
      externalId: anchor.externalId,
      parentPaymentId: anchor.parentPaymentId,
      cryptoTxHash: anchor.cryptoTxHash,

      type: anchor.type,
      state: providerLabel(anchor.state),
      amount: Math.abs(anchor.amount),
      currency: anchor.currency,
      method:
        providerLabel(
          typeof payload.paymentMethod === 'string'
            ? payload.paymentMethod
            : null,
        ) ?? this.paymentMethodBucket(payload.paymentMethod),
      description: str(payload.description),

      customer: anchor.customer,
      customerEmail: str(
        (payload.customer as Record<string, unknown>)?.['email'],
      ),
      country: str(billing.countryCode ?? billing.country),
      billingAddress: {
        country: str(billing.countryCode ?? billing.country),
        state: str(billing.state),
        city: str(billing.city),
        addressLine1: str(billing.addressLine1 ?? billing.address),
        addressLine2: str(billing.addressLine2),
        postalCode: str(billing.postalCode ?? billing.zip),
      },

      entity: anchor.entity,
      shop: anchor.shop,
      psp: anchor.psp,
      terminal: anchor.terminal,

      errorCode: anchor.errorCode,
      errorMessage: anchor.errorMessage,

      occurredAt: anchor.occurredAt,
      receivedAt: anchor.receivedAt,
      source: anchor.source,
      signatureOk: anchor.signatureOk,

      // The whole catalogue, so the drawer can show every field Paymaxis sent
      // rather than the dozen someone thought to map. Grouped by the UI using
      // the same specs the column picker reads.
      fields: paymentFieldValues(anchor as MappedRow),

      history: history.map((h) => ({
        state: providerLabel(h.state),
        amount: Math.abs(h.amount),
        errorCode: h.errorCode,
        errorMessage: h.errorMessage,
        at: h.occurredAt ?? h.receivedAt,
        source: h.source,
      })),

      // The provider's own payload, already stripped of card and identity data
      // on ingest. Kept available because a field nobody mapped yet is exactly
      // what someone needs when a payment behaves oddly.
      raw: payload,
    };
  }

  private mapPaymentRow(r: {
    id: string;
    paymentId: string | null;
    reference: string | null;
    externalId: string | null;
    customer: string | null;
    entity: string | null;
    psp: string | null;
    terminal: string | null;
    currency: string | null;
    amount: number;
    type: string | null;
    state: string | null;
    occurredAt: Date | null;
    receivedAt: Date;
    payload: unknown;
  }) {
    const state = r.state ?? '';
    const t = r.type ?? '';
    const type = /refund/i.test(t)
      ? 'Refund'
      : /withdraw|payout/i.test(t)
        ? 'Withdrawal'
        : 'Deposit';

    const status = isSettledState(state)
      ? 'approved'
      : isFailedState(state)
        ? 'declined'
        : /pending|processing|checkout|await/i.test(state)
          ? 'pending'
          : 'processing';

    const payload = (r.payload ?? {}) as Record<string, unknown>;

    return {
      id: r.id,
      reference: r.paymentId || r.reference || r.externalId || r.id,
      client: r.customer || '—',
      // The jurisdiction the payment belongs to. Not the customer's country,
      // which Paymaxis does not give us — better an accurate different fact
      // than a guessed one.
      country: r.entity || '—',
      gateway: r.psp || r.terminal || '—',
      method: this.paymentMethodBucket(payload.paymentMethod),
      methodLabel:
        providerLabel(
          typeof payload.paymentMethod === 'string'
            ? payload.paymentMethod
            : null,
        ) ?? this.paymentMethodBucket(payload.paymentMethod),
      currency: r.currency || '',
      amount: Math.abs(r.amount),
      type,
      // Two different things, both needed: `status` is the four-way bucket the
      // badge colours by, `stateLabel` is what Paymaxis actually called it. The
      // bucket alone turned "Awaiting Webhook" into "Pending", which reads as
      // "the customer has not paid yet" when it means "the PSP owes us a
      // callback".
      status,
      state: state || null,
      stateLabel: providerLabel(state),
      // Everything Paymaxis sent about this payment, under the catalogue's
      // keys. The table shows a handful by default and lets the reader add any
      // of the rest; sending them with the row avoids a request per column.
      fields: paymentFieldValues(r as MappedRow),
      // No risk scoring exists. The column showed a fabricated level for every
      // row; null renders as "—" so it is plainly absent rather than invented.
      risk: null,
      createdAt: this.hhmm(r.occurredAt ?? r.receivedAt),
    };
  }

  // -------- gateways --------

  /**
   * PSP health, measured from real payments.
   *
   * The fallback listed gateways we do not use (Stripe, Nuvei, Coinbase) with
   * invented success rates and latencies, next to real ones — so a genuinely
   * failing provider was indistinguishable from decoration. Built from the last
   * 24 hours of PaymentEvent instead, one row per PSP that actually processed
   * something.
   *
   * Latency and webhook failures are reported as zero because nothing measures
   * them yet; they are not guessed at.
   */
  async gatewaysLive(range?: TimeRange) {
    const rows = await this.safe(
      () =>
        this.prisma.paymentEvent.findMany({
          where: range ? this.inRange(range) : {},
          select: {
            psp: true, state: true, amount: true,
            occurredAt: true, receivedAt: true,
          },
          take: 50_000,
        }),
      [],
    );

    const names = [...new Set(rows.map((r) => r.psp).filter(Boolean))] as string[];
    return names
      .map((name, i) => {
        const scoped = rows.filter((r) => r.psp === name);
        const ok = scoped.filter((r) => isSettledState(r.state ?? ''));
        const bad = scoped.filter((r) => isFailedState(r.state ?? ''));
        const decided = ok.length + bad.length;
        const successRate = decided
          ? Number(((ok.length / decided) * 100).toFixed(1))
          : 0;
        // Eight buckets across the window, so the trend is visible whatever
        // period was asked for.
        const span = range ? range.to.getTime() - range.from.getTime() : 86_400_000;
        const size = span / 8;
        const start = range ? range.from.getTime() : Date.now() - span;
        const spark = Array.from({ length: 8 }, (_, b) => {
          const inBucket = scoped.filter((r) => {
            const t = (r.occurredAt ?? r.receivedAt).getTime();
            return t >= start + b * size && t < start + (b + 1) * size;
          });
          const g = inBucket.filter((r) => isSettledState(r.state ?? '')).length;
          const f = inBucket.filter((r) => isFailedState(r.state ?? '')).length;
          return g + f ? Number(((g / (g + f)) * 100).toFixed(1)) : 0;
        });
        return {
          id: `psp-${i + 1}`,
          name,
          status:
            successRate >= 90
              ? ('operational' as const)
              : successRate >= 70
                ? ('degraded' as const)
                : ('down' as const),
          successRate,
          avgLatencyMs: 0,
          todayVolume: Number(
            ok.reduce((a, r) => a + Math.abs(r.amount), 0).toFixed(2),
          ),
          webhookFailures: 0,
          spark,
        };
      })
      .sort((a, b) => b.todayVolume - a.todayVolume);
  }

  async gateways(range?: TimeRange) {
    if (await this.isLive()) return this.gatewaysLive(range);
    const fallback = [
      {
        id: 'g1',
        name: 'ForumPay',
        status: 'down',
        successRate: 0,
        avgLatencyMs: 0,
        todayVolume: 0,
        webhookFailures: 14,
        spark: [98, 97, 96, 40, 0, 0, 0, 0],
      },
      {
        id: 'g2',
        name: 'LimePay',
        status: 'operational',
        successRate: 98.6,
        avgLatencyMs: 142,
        todayVolume: 812000,
        webhookFailures: 0,
        spark: [96, 97, 98, 98, 99, 98, 99, 98.6],
      },
      {
        id: 'g3',
        name: 'Paystrax',
        status: 'operational',
        successRate: 97.1,
        avgLatencyMs: 210,
        todayVolume: 604000,
        webhookFailures: 1,
        spark: [95, 96, 97, 96, 97, 98, 97, 97.1],
      },
      {
        id: 'g4',
        name: 'Coinbase',
        status: 'degraded',
        successRate: 91.4,
        avgLatencyMs: 480,
        todayVolume: 388000,
        webhookFailures: 6,
        spark: [97, 96, 94, 92, 90, 91, 90, 91.4],
      },
      {
        id: 'g5',
        name: 'Stripe',
        status: 'operational',
        successRate: 99.2,
        avgLatencyMs: 96,
        todayVolume: 1240000,
        webhookFailures: 0,
        spark: [99, 99, 98, 99, 99, 99, 99, 99.2],
      },
      {
        id: 'g6',
        name: 'Nuvei',
        status: 'operational',
        successRate: 96.8,
        avgLatencyMs: 176,
        todayVolume: 521000,
        webhookFailures: 2,
        spark: [95, 96, 97, 96, 97, 96, 97, 96.8],
      },
      {
        id: 'g7',
        name: 'Bridge',
        status: 'operational',
        successRate: 95.3,
        avgLatencyMs: 233,
        todayVolume: 274000,
        webhookFailures: 3,
        spark: [94, 95, 96, 95, 94, 95, 96, 95.3],
      },
    ];
    return this.safe(async () => {
      const rows = await this.prisma.paymentGateway.findMany({
        orderBy: { name: 'asc' },
      });
      if (rows.length === 0) return fallback;
      return rows.map((g, i) => ({
        id: g.id,
        name: g.name,
        status: g.status.toLowerCase(),
        successRate: g.successRate,
        avgLatencyMs: g.avgLatencyMs,
        todayVolume: Number(g.todayVolume),
        webhookFailures: fallback[i % fallback.length].webhookFailures,
        spark: fallback[i % fallback.length].spark,
      }));
    }, fallback);
  }

  // -------- KYC --------

  private kycFallback() {
    return [
      {
        id: 'k1',
        client: 'Client #55210',
        country: 'NG',
        status: 'in_review',
        risk: 'high',
        riskScore: 78,
        documents: 4,
        submittedAt: '2h ago',
        assignee: 'David Chen',
      },
      {
        id: 'k2',
        client: 'Client #90117',
        country: 'AE',
        status: 'pending',
        risk: 'low',
        riskScore: 22,
        documents: 3,
        submittedAt: '3h ago',
        assignee: 'Unassigned',
      },
      {
        id: 'k3',
        client: 'Client #40551',
        country: 'BR',
        status: 'edd_required',
        risk: 'critical',
        riskScore: 91,
        documents: 6,
        submittedAt: '5h ago',
        assignee: 'David Chen',
      },
      {
        id: 'k4',
        client: 'Client #12844',
        country: 'IN',
        status: 'pending',
        risk: 'medium',
        riskScore: 54,
        documents: 2,
        submittedAt: '6h ago',
        assignee: 'Unassigned',
      },
      {
        id: 'k5',
        client: 'Client #66203',
        country: 'GB',
        status: 'approved_kyc',
        risk: 'low',
        riskScore: 18,
        documents: 4,
        submittedAt: '1d ago',
        assignee: 'Sara Ahmed',
      },
      {
        id: 'k6',
        client: 'Client #30918',
        country: 'SA',
        status: 'rejected',
        risk: 'high',
        riskScore: 83,
        documents: 5,
        submittedAt: '1d ago',
        assignee: 'David Chen',
      },
      {
        id: 'k7',
        client: 'Client #22981',
        country: 'DE',
        status: 'in_review',
        risk: 'medium',
        riskScore: 47,
        documents: 3,
        submittedAt: '1d ago',
        assignee: 'Sara Ahmed',
      },
    ];
  }

  async kycCases() {
    // Live: no invented rows. There is no real source for this yet, so an
    // empty list is the honest answer — see isLive().
    if (await this.isLive()) return [];
    const fallback = this.kycFallback();
    return this.safe(async () => {
      const rows = await this.prisma.kycCase.findMany({
        include: { client: true, assignedTo: true },
        orderBy: { submittedAt: 'desc' },
      });
      if (rows.length === 0) return fallback;
      return rows.map((c, i) => ({
        id: `k${i + 1}`,
        client: c.client?.fullName ?? 'Unknown',
        country: c.client?.country ?? '—',
        status: this.kycLabel(c.status),
        risk: this.lower(c.client?.riskLevel ?? 'LOW'),
        riskScore: c.riskScore,
        documents: 2 + (c.riskScore % 5),
        submittedAt: this.ago(c.submittedAt),
        assignee: c.assignedTo
          ? `${c.assignedTo.firstName} ${c.assignedTo.lastName}`
          : 'Unassigned',
      }));
    }, fallback);
  }

  /**
   * The payment overview: volume and outcome, over a window of its own.
   *
   * Deliberately not tied to the page's global range. The overview answers "how
   * is a period going" and is read against yesterday, last week, a specific
   * afternoon somebody is asking about — a question that moves independently of
   * whichever rows the table below happens to be showing.
   */
  async successRate(from?: string, to?: string) {
    const gte = parseInstant(from);
    const lte = parseInstant(to);
    const where =
      gte || lte
        ? {
            OR: [
              {
                occurredAt: {
                  ...(gte ? { gte } : {}),
                  ...(lte ? { lte } : {}),
                },
              },
              {
                AND: [
                  { occurredAt: null },
                  {
                    receivedAt: {
                      ...(gte ? { gte } : {}),
                      ...(lte ? { lte } : {}),
                    },
                  },
                ],
              },
            ],
          }
        : {};

    const events = await this.safe(
      () =>
        this.prisma.paymentEvent.findMany({
          where,
          orderBy: [{ occurredAt: 'desc' }, { receivedAt: 'desc' }],
          select: {
            id: true, paymentId: true, reference: true,
            type: true, state: true, amount: true, currency: true,
          },
          take: 20_000,
        }),
      [],
    );

    // Latest state per payment — the same rule every other figure uses. Counting
    // each stored state would report one payment as pending AND completed, and
    // the success rate would move whenever a provider sent an extra callback.
    const seen = new Set<string>();
    const rows: SuccessRow[] = [];
    for (const e of events) {
      const identity = e.paymentId || e.reference || e.id;
      if (seen.has(identity)) continue;
      seen.add(identity);
      rows.push({ type: e.type, state: e.state, amount: e.amount, currency: e.currency });
    }

    return buildSuccessRate(rows, {
      settled: isSettledState,
      from: gte ? gte.toISOString() : null,
      to: lte ? lte.toISOString() : null,
    });
  }

  // -------- incidents --------
  //
  // Two sources, both real. DETECTED comes from the payment data itself and
  // lives only while the condition holds; DECLARED is a row somebody opened,
  // and stays until it is resolved. There is no third source: the four invented
  // incidents this page used to show made an operations screen that could not be
  // believed, which is worse than one that is empty.

  /** Latest-state payments over the detector's baseline window. */
  private async detectorRows(now: Date): Promise<DetectRow[]> {
    const from = new Date(now.getTime() - 25 * 60 * 60_000);
    const rows = await this.safe(
      () =>
        this.prisma.paymentEvent.findMany({
          // A callback can arrive after the event it describes, so a payment
          // with no provider timestamp is placed by when we received it rather
          // than dropped — dropping it would hide exactly the kind of payment
          // these rules exist to catch.
          where: {
            OR: [
              { occurredAt: { gte: from } },
              { AND: [{ occurredAt: null }, { receivedAt: { gte: from } }] },
            ],
          },
          orderBy: [{ occurredAt: 'desc' }, { receivedAt: 'desc' }],
          select: {
            id: true, paymentId: true, reference: true, customer: true,
            psp: true, state: true, type: true, amount: true, currency: true,
            occurredAt: true, receivedAt: true,
          },
          take: 20_000,
        }),
      [],
    );
    // One row per payment, latest state first — the same rule every other
    // figure uses. Counting each state a payment passed through would report a
    // completed payment as a pending one as well.
    const seen = new Set<string>();
    const out: DetectRow[] = [];
    for (const r of rows) {
      const identity = r.paymentId || r.reference || r.id;
      if (seen.has(identity)) continue;
      seen.add(identity);
      out.push({
        // What a person would quote to the provider, in the order they would
        // recognise it.
        reference: r.paymentId || r.reference || r.id,
        customer: r.customer,
        psp: r.psp,
        state: r.state,
        type: r.type,
        amount: r.amount,
        currency: r.currency,
        at: r.occurredAt ?? r.receivedAt,
      });
    }
    return out;
  }

  /** Conditions the payment data is reporting right now. */
  async incidentDetections(): Promise<Detection[]> {
    const now = new Date();
    const [rows, last] = await Promise.all([
      this.detectorRows(now),
      this.safe(
        () =>
          this.prisma.paymentEvent.aggregate({ _max: { occurredAt: true } }),
        null as { _max: { occurredAt: Date | null } } | null,
      ),
    ]);
    if (!rows.length && !last?._max.occurredAt) return [];
    return detectIncidents({
      rows,
      now,
      lastEventAt: last?._max.occurredAt ?? null,
      pollConfigured: Boolean((process.env.PAYMAXIS_SHOPS ?? '').trim()),
      settled: isSettledState,
      failed: isFailedState,
    });
  }

  private incidentView(n: {
    id: string; ref: number; title: string; description: string;
    severity: string; status: string; impact: string | null;
    rootCause: string | null; resolution: string | null;
    evidence: unknown; timeline: unknown; createdAt: Date;
    owner: { firstName: string; lastName: string } | null;
  }) {
    const timeline = Array.isArray(n.timeline)
      ? (n.timeline as { at?: string; text?: string; by?: string }[])
      : [];
    // Stored as { lines, samples }. An array is the older shape, from before
    // the payments themselves were captured.
    const ev = (n.evidence ?? null) as
      | { lines?: string[]; samples?: unknown[]; sampleTotal?: number }
      | string[]
      | null;
    const lines = Array.isArray(ev) ? ev : (ev?.lines ?? []);
    const samples = Array.isArray(ev) ? [] : (ev?.samples ?? []);
    const sampleTotal = Array.isArray(ev) ? 0 : (ev?.sampleTotal ?? samples.length);
    return {
      // Stable for the incident's whole life: the list used to number by
      // position, so an incident's reference changed whenever an older one was
      // opened and no handover note could point at it.
      id: `INC-${n.ref}`,
      key: n.id,
      source: 'declared' as const,
      title: n.title,
      severity: this.lower(n.severity),
      status: this.lower(n.status),
      owner: n.owner ? `${n.owner.firstName} ${n.owner.lastName}` : 'Unassigned',
      impact: n.impact ?? n.description,
      rootCause: n.rootCause ?? undefined,
      resolution: n.resolution ?? undefined,
      evidence: lines,
      // Captured when it was declared: the condition may be long over, and the
      // references are what the provider and the customers are asked about.
      samples,
      sampleTotal,
      openedAt: this.ago(n.createdAt),
      timeline: timeline.map((t) => ({
        time: t.at ? this.hhmm(new Date(t.at)) : '',
        text: [t.text, t.by ? `— ${t.by}` : ''].filter(Boolean).join(' '),
      })),
    };
  }

  async incidents() {
    const declared = await this.safe(
      () =>
        this.prisma.incident.findMany({
          include: { owner: true },
          orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
          take: 100,
        }),
      [],
    );
    const open = new Set(
      declared
        .filter((d) => d.status === 'OPEN' || d.status === 'INVESTIGATING')
        .map((d) => d.signature)
        .filter(Boolean) as string[],
    );

    const detections = await this.incidentDetections();
    // A condition already declared is not also listed as a detection: it is the
    // same event, and showing it twice doubles the count on the tiles.
    const fresh = detections.filter((d) => !open.has(d.signature));

    // A condition that is still true after its incident was closed comes back —
    // hiding a live outage because somebody pressed Resolve is the one failure
    // this page must not have. It says so rather than appearing from nowhere.
    const closed = new Map(
      declared
        .filter((d) => d.signature && (d.status === 'RESOLVED' || d.status === 'CLOSED'))
        .map((d): [string, (typeof declared)[number]] => [d.signature as string, d]),
    );

    return [
      ...fresh.map((d) => ({
        id: d.signature,
        key: d.signature,
        source: 'detected' as const,
        title: d.title,
        severity: d.severity,
        status: 'open' as const,
        owner: 'Unassigned',
        impact: d.impact,
        samples: d.samples,
        sampleTotal: d.sampleTotal,
        evidence: closed.has(d.signature)
          ? [
              `Declared as INC-${closed.get(d.signature)?.ref} and closed ${this.ago(
                closed.get(d.signature)?.resolvedAt ??
                  (closed.get(d.signature)?.updatedAt as Date),
              )}, but the data still shows the condition.`,
              ...d.evidence,
            ]
          : d.evidence,
        psp: d.psp,
        openedAt: d.since ? this.ago(new Date(d.since)) : 'now',
        timeline: d.since
          ? [{ time: this.hhmm(new Date(d.since)), text: 'Condition first seen in the payment data' }]
          : [],
      })),
      ...declared.map((n) => this.incidentView(n)),
    ];
  }

  /**
   * Opens an incident. Declaring a live detection carries its evidence across,
   * because the condition is transient and there would be nothing left to check
   * the decision against an hour later.
   */
  async declareIncident(input: {
    title?: string;
    severity?: string;
    impact?: string;
    signature?: string;
    by?: string;
  }) {
    const now = new Date();
    let title = (input.title ?? '').trim();
    let severity = (input.severity ?? 'MEDIUM').toUpperCase();
    let impact = (input.impact ?? '').trim();
    let evidence: {
      lines: string[];
      samples: unknown[];
      sampleTotal: number;
    } = { lines: [], samples: [], sampleTotal: 0 };

    if (input.signature) {
      const match = (await this.incidentDetections()).find(
        (d) => d.signature === input.signature,
      );
      if (match) {
        title = title || match.title;
        severity = (input.severity ?? match.severity).toUpperCase();
        impact = impact || match.impact;
        // The payments too, not just the counts: the condition is transient and
        // an hour from now there is no way to reconstruct which ones they were.
        evidence = {
          lines: match.evidence,
          samples: match.samples,
          sampleTotal: match.sampleTotal,
        };
      }
    }
    if (!title) throw new BadRequestException('title is required');

    const data = {
      title,
      description: impact || title,
      impact: impact || null,
      severity: severity as never,
      source: input.signature ? 'DETECTED' : 'DECLARED',
      evidence: evidence as never,
      timeline: [
        {
          at: now.toISOString(),
          text: input.signature
            ? 'Declared from a detected condition; evidence captured'
            : 'Incident declared',
          by: input.by ?? 'Unknown',
        },
      ] as never,
    };

    // The same live condition declared twice is one incident, reopened — not a
    // second row competing with the first.
    try {
      if (input.signature) {
        return await this.prisma.incident.upsert({
          where: { signature: input.signature },
          create: { ...data, signature: input.signature },
          update: { status: 'OPEN', resolvedAt: null },
          include: { owner: true },
        });
      }
      return await this.prisma.incident.create({ data, include: { owner: true } });
    } catch (e) {
      // Never a bare 500: "Internal server error" on this button is
      // indistinguishable between a bug, a dropped connection, and an
      // unapplied migration — which is the common one, and the one with a
      // two-minute fix.
      throw dbError(e, 'Declaring the incident');
    }
  }

  /** Moves an incident on, and records that it moved. */
  async updateIncident(
    id: string,
    input: {
      status?: string;
      rootCause?: string;
      resolution?: string;
      note?: string;
      by?: string;
    },
  ) {
    const current = await this.safeOrThrow(
      () => this.prisma.incident.findUnique({ where: { id } }),
      'Reading the incident',
    );
    if (!current) throw new NotFoundException('incident not found');

    const status = input.status ? input.status.toUpperCase() : undefined;
    const entries = Array.isArray(current.timeline)
      ? (current.timeline as unknown[])
      : [];
    const at = new Date().toISOString();
    const added: { at: string; text: string; by: string }[] = [];
    if (status && status !== current.status) {
      added.push({ at, text: `Status → ${status.toLowerCase()}`, by: input.by ?? 'Unknown' });
    }
    if (input.note?.trim()) {
      added.push({ at, text: input.note.trim(), by: input.by ?? 'Unknown' });
    }
    if (input.resolution?.trim()) {
      added.push({ at, text: `Resolution: ${input.resolution.trim()}`, by: input.by ?? 'Unknown' });
    }

    return this.safeOrThrow(
      () => this.prisma.incident.update({
      where: { id },
      data: {
        ...(status ? { status: status as never } : {}),
        ...(input.rootCause !== undefined ? { rootCause: input.rootCause } : {}),
        ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
        // resolvedAt is set on the transition, not on every later edit.
        ...(status === 'RESOLVED' || status === 'CLOSED'
          ? { resolvedAt: current.resolvedAt ?? new Date() }
          : status
            ? { resolvedAt: null }
            : {}),
        timeline: [...entries, ...added] as never,
      },
      include: { owner: true },
      }),
      'Updating the incident',
    );
  }

  // -------- operations (tickets from DB; team + checklist representative) --------

  private ticketsFallback() {
    return [
      {
        id: 'TC-9931',
        subject: 'Withdrawal stuck in review',
        client: 'Client #77120',
        assignee: 'Fatima Noor',
        status: 'escalated',
        priority: 'urgent',
        slaRemaining: '12m',
        slaBreached: false,
        updatedAt: '3m ago',
      },
      {
        id: 'TC-9930',
        subject: 'KYC document rejected — appeal',
        client: 'Client #30918',
        assignee: 'David Chen',
        status: 'in_progress',
        priority: 'high',
        slaRemaining: '48m',
        slaBreached: false,
        updatedAt: '14m ago',
      },
      {
        id: 'TC-9929',
        subject: 'Deposit not credited (crypto)',
        client: 'Client #10042',
        assignee: 'Sara Ahmed',
        status: 'in_progress',
        priority: 'high',
        slaRemaining: '1h 20m',
        slaBreached: false,
        updatedAt: '22m ago',
      },
      {
        id: 'TC-9928',
        subject: 'Duplicate charge dispute',
        client: 'Client #22981',
        assignee: 'Unassigned',
        status: 'open',
        priority: 'medium',
        slaRemaining: 'Overdue 18m',
        slaBreached: true,
        updatedAt: '31m ago',
      },
      {
        id: 'TC-9927',
        subject: 'Card payment declined repeatedly',
        client: 'Client #55210',
        assignee: 'Yusuf Ali',
        status: 'open',
        priority: 'medium',
        slaRemaining: '2h 05m',
        slaBreached: false,
        updatedAt: '44m ago',
      },
      {
        id: 'TC-9926',
        subject: 'Account statement request',
        client: 'Client #66203',
        assignee: 'Fatima Noor',
        status: 'resolved',
        priority: 'low',
        slaRemaining: '—',
        slaBreached: false,
        updatedAt: '1h ago',
      },
    ];
  }

  private readonly team = [
    {
      name: 'Sara Ahmed',
      role: 'Operations',
      presence: 'online',
      active: 4,
      handledToday: 37,
      avgHandleMin: 6.2,
      initials: 'SA',
    },
    {
      name: 'David Chen',
      role: 'Compliance',
      presence: 'online',
      active: 7,
      handledToday: 21,
      avgHandleMin: 11.4,
      initials: 'DC',
    },
    {
      name: 'Fatima Noor',
      role: 'Support',
      presence: 'online',
      active: 2,
      handledToday: 44,
      avgHandleMin: 4.1,
      initials: 'FN',
    },
    {
      name: 'Yusuf Ali',
      role: 'Operations',
      presence: 'away',
      active: 5,
      handledToday: 29,
      avgHandleMin: 7.8,
      initials: 'YA',
    },
    {
      name: 'Lina Park',
      role: 'Support',
      presence: 'offline',
      active: 0,
      handledToday: 33,
      avgHandleMin: 5.0,
      initials: 'LP',
    },
  ];

  private readonly shiftChecklist = [
    { label: 'Review overnight alerts', done: true },
    { label: 'Clear escalated tickets queue', done: true },
    { label: 'Reconcile PSP settlements', done: false },
    { label: 'Approve pending large withdrawals', done: false },
    { label: 'Post handover notes', done: false },
  ];

  async operations() {
    // No ticketing system feeds this yet, so on live data the queue is empty
    // rather than populated with invented tickets and named assignees.
    const live = await this.isLive();
    const fallbackTickets = live ? [] : this.ticketsFallback();
    const tickets = await this.safe(async () => {
      const rows = await this.prisma.ticket.findMany({
        include: { client: true, assignedTo: true },
        orderBy: { createdAt: 'desc' },
      });
      if (rows.length === 0) return fallbackTickets;
      return rows.map((t, i) => {
        const breached = t.slaDueAt ? t.slaDueAt.getTime() < Date.now() : false;
        return {
          id: `TC-${9931 - i}`,
          subject: t.subject,
          client: t.client?.fullName ?? '—',
          assignee: t.assignedTo
            ? `${t.assignedTo.firstName} ${t.assignedTo.lastName}`
            : 'Unassigned',
          status: this.ticketStatus(t.status),
          priority: this.lower(t.priority),
          slaRemaining:
            t.status === 'RESOLVED' || t.status === 'CLOSED'
              ? '—'
              : breached
                ? 'Overdue'
                : 'On track',
          slaBreached:
            breached && t.status !== 'RESOLVED' && t.status !== 'CLOSED',
          updatedAt: this.ago(t.createdAt),
        };
      });
    }, fallbackTickets);

    // The roster and shift checklist are invented — there is no HR source and
    // no shift system. Named colleagues with fabricated handling stats are the
    // least defensible placeholder here, so on live data both are empty.
    return {
      tickets,
      team: live ? [] : this.team,
      shiftChecklist: live ? [] : this.shiftChecklist,
    };
  }

  // -------- reports (representative; not a persisted entity) --------

  reports() {
    return {
      templates: [
        {
          id: 'r1',
          name: 'Daily Operations Summary',
          description:
            'Volume, success rate, incidents and pending work for the day.',
          formats: ['PDF', 'Excel'],
        },
        {
          id: 'r2',
          name: 'PSP Performance',
          description:
            'Per-gateway success, latency, downtime and webhook failures.',
          formats: ['PDF', 'Excel'],
        },
        {
          id: 'r3',
          name: 'Compliance & KYC',
          description:
            'KYC throughput, EDD cases, sanctions/PEP screening outcomes.',
          formats: ['PDF'],
        },
        {
          id: 'r4',
          name: 'Financial Reconciliation',
          description:
            'Deposits, withdrawals, refunds and settlement reconciliation.',
          formats: ['Excel'],
        },
        {
          id: 'r5',
          name: 'Executive Overview',
          description: 'KPIs, trends and risk posture for leadership.',
          formats: ['PDF'],
        },
        {
          id: 'r6',
          name: 'Incident Report',
          description: 'Timeline, impact, root cause and preventive actions.',
          formats: ['PDF'],
        },
      ],
      generated: [
        {
          id: 'gr1',
          name: 'Daily Operations Summary — Jul 21',
          format: 'PDF',
          size: '1.2 MB',
          by: 'Mohammad K.',
          at: '08:12',
        },
        {
          id: 'gr2',
          name: 'PSP Performance — Jul 20',
          format: 'Excel',
          size: '486 KB',
          by: 'Sara Ahmed',
          at: 'Yesterday',
        },
        {
          id: 'gr3',
          name: 'Financial Reconciliation — Jul 20',
          format: 'Excel',
          size: '912 KB',
          by: 'Finance bot',
          at: 'Yesterday',
        },
        {
          id: 'gr4',
          name: 'Executive Overview — Week 29',
          format: 'PDF',
          size: '2.4 MB',
          by: 'Mohammad K.',
          at: 'Mon',
        },
      ],
      scheduled: [
        {
          id: 'sr1',
          name: 'Daily Operations Summary',
          cadence: 'Daily · 08:00',
          nextRun: 'Tomorrow 08:00',
          recipients: 6,
        },
        {
          id: 'sr2',
          name: 'PSP Performance',
          cadence: 'Weekly · Mon',
          nextRun: 'Mon 07:00',
          recipients: 3,
        },
        {
          id: 'sr3',
          name: 'Executive Overview',
          cadence: 'Weekly · Mon',
          nextRun: 'Mon 07:00',
          recipients: 4,
        },
      ],
    };
  }

  // -------- users --------

  async users() {
    // Real accounts exist the moment anyone can sign in, so an empty list here
    // means something is wrong rather than "not set up yet".
    if (await this.isLive()) {
      return this.safe(
        () =>
          this.prisma.user
            .findMany({ orderBy: { createdAt: 'asc' } })
            .then((rows) =>
              rows.map((u, i) => ({
                id: `u-${i + 1}`,
                name: `${u.firstName} ${u.lastName}`.trim(),
                email: u.email,
                role: this.lower(u.role),
                status: u.isActive ? 'active' : 'disabled',
                lastActive: this.ago(u.updatedAt),
              })),
            ),
        [],
      );
    }
    const fallback = [
      {
        id: 'u1',
        name: 'Mohammad K.',
        email: 'mohammad@tradin.com',
        role: 'Admin',
        status: 'active',
        lastActive: 'now',
        initials: 'MK',
      },
      {
        id: 'u2',
        name: 'Sara Ahmed',
        email: 'sara@tradin.com',
        role: 'Operations',
        status: 'active',
        lastActive: '2m ago',
        initials: 'SA',
      },
      {
        id: 'u3',
        name: 'David Chen',
        email: 'david@tradin.com',
        role: 'Compliance',
        status: 'active',
        lastActive: '5m ago',
        initials: 'DC',
      },
      {
        id: 'u4',
        name: 'Fatima Noor',
        email: 'fatima@tradin.com',
        role: 'Support',
        status: 'active',
        lastActive: '1m ago',
        initials: 'FN',
      },
      {
        id: 'u5',
        name: 'Yusuf Ali',
        email: 'yusuf@tradin.com',
        role: 'Operations',
        status: 'active',
        lastActive: '18m ago',
        initials: 'YA',
      },
      {
        id: 'u6',
        name: 'Lina Park',
        email: 'lina@tradin.com',
        role: 'Support',
        status: 'active',
        lastActive: '3h ago',
        initials: 'LP',
      },
      {
        id: 'u7',
        name: 'Omar Haddad',
        email: 'omar@tradin.com',
        role: 'Finance',
        status: 'active',
        lastActive: '1d ago',
        initials: 'OH',
      },
      {
        id: 'u8',
        name: 'Priya Rao',
        email: 'priya@tradin.com',
        role: 'Executive',
        status: 'active',
        lastActive: '2d ago',
        initials: 'PR',
      },
      {
        id: 'u9',
        name: 'New Analyst',
        email: 'analyst@tradin.com',
        role: 'Read Only',
        status: 'invited',
        lastActive: '—',
        initials: 'NA',
      },
      {
        id: 'u10',
        name: 'Contractor X',
        email: 'contractor@ext.com',
        role: 'Auditor',
        status: 'suspended',
        lastActive: '12d ago',
        initials: 'CX',
      },
    ];
    return this.safe(async () => {
      const rows = await this.prisma.user.findMany({
        orderBy: { createdAt: 'asc' },
      });
      if (rows.length === 0) return fallback;
      const titleRole = (r: string) =>
        r
          .split('_')
          .map((p) => p[0] + p.slice(1).toLowerCase())
          .join(' ');
      return rows.map((u) => ({
        id: u.id,
        name: `${u.firstName} ${u.lastName}`.trim(),
        email: u.email,
        role: titleRole(u.role),
        status: u.isActive ? 'active' : 'suspended',
        lastActive: 'recently',
        initials: `${u.firstName[0] ?? ''}${u.lastName[0] ?? ''}`.toUpperCase(),
      }));
    }, fallback);
  }

  // -------- audit log --------

  private auditFallback() {
    return [
      {
        id: 'a1',
        user: 'Sara Ahmed',
        action: 'Approved withdrawal',
        entityType: 'Transaction',
        entityId: 'TX-88175',
        ip: '10.2.4.11',
        at: '14:22:07',
      },
      {
        id: 'a2',
        user: 'David Chen',
        action: 'Escalated KYC case',
        entityType: 'KycCase',
        entityId: 'k3',
        ip: '10.2.4.31',
        at: '14:18:42',
      },
      {
        id: 'a3',
        user: 'Mohammad K.',
        action: 'Changed user role',
        entityType: 'User',
        entityId: 'u9',
        ip: '10.2.4.2',
        at: '14:05:19',
      },
      {
        id: 'a4',
        user: 'Fatima Noor',
        action: 'Resolved ticket',
        entityType: 'Ticket',
        entityId: 'TC-9926',
        ip: '10.2.4.22',
        at: '13:58:03',
      },
      {
        id: 'a5',
        user: 'System',
        action: 'Auto-voided duplicate',
        entityType: 'Transaction',
        entityId: 'TX-88101',
        ip: '—',
        at: '13:40:55',
      },
      {
        id: 'a6',
        user: 'Yusuf Ali',
        action: 'Declared incident',
        entityType: 'Incident',
        entityId: 'INC-104',
        ip: '10.2.4.19',
        at: '14:02:11',
      },
      {
        id: 'a7',
        user: 'Mohammad K.',
        action: 'Suspended user',
        entityType: 'User',
        entityId: 'u10',
        ip: '10.2.4.2',
        at: '12:31:44',
      },
      {
        id: 'a8',
        user: 'Sara Ahmed',
        action: 'Added internal note',
        entityType: 'Transaction',
        entityId: 'TX-88160',
        ip: '10.2.4.11',
        at: '12:15:30',
      },
    ];
  }

  async auditLog() {
    // Live: no invented rows. There is no real source for this yet, so an
    // empty list is the honest answer — see isLive().
    if (await this.isLive()) return [];
    const fallback = this.auditFallback();
    return this.safe(async () => {
      const rows = await this.prisma.auditLog.findMany({
        include: { user: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      if (rows.length === 0) return fallback;
      return rows.map((a) => ({
        id: a.id,
        user: a.user ? `${a.user.firstName} ${a.user.lastName}` : 'System',
        action: a.action,
        entityType: a.entityType,
        entityId: a.entityId,
        ip: a.ipAddress ?? '—',
        at: a.createdAt.toISOString().slice(11, 19),
      }));
    }, fallback);
  }
}
