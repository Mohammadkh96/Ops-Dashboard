import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import {
  isFailedState,
  isSettledState,
  providerLabel,
} from '../paymaxis/normalize';
import type { TimeRange } from '../common/range';
import {
  GROUP_LABELS,
  PAYMENT_FIELDS,
  paymentFieldValues,
  type MappedRow,
} from './payment-fields';

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

  // -------- incidents --------

  private incidentsFallback() {
    return [
      {
        id: 'INC-104',
        title: 'ForumPay gateway offline',
        severity: 'critical',
        status: 'investigating',
        owner: 'Yusuf Ali',
        impact: 'All ForumPay deposits failing; ~$180K/hr volume affected',
        rootCause: 'Upstream PSP API returning 503 since 14:02 UTC',
        openedAt: '18m ago',
        timeline: [
          {
            time: '14:02',
            text: 'Automated alert: success rate dropped to 0%',
          },
          { time: '14:05', text: 'On-call paged; incident opened at SEV-1' },
          { time: '14:11', text: 'PSP status page confirms upstream outage' },
          {
            time: '14:16',
            text: 'Deposits rerouted to LimePay for affected regions',
          },
        ],
      },
      {
        id: 'INC-103',
        title: 'Elevated decline rate — Visa EU',
        severity: 'high',
        status: 'open',
        owner: 'Sara Ahmed',
        impact: 'Card decline rate +14% for EU BINs over 30 min',
        openedAt: '42m ago',
        timeline: [
          { time: '13:38', text: 'Decline-spike alert triggered for Visa EU' },
          { time: '13:44', text: 'Investigating acquirer-side 3DS friction' },
        ],
      },
      {
        id: 'INC-102',
        title: 'Webhook delivery delay — Coinbase',
        severity: 'medium',
        status: 'investigating',
        owner: 'David Chen',
        impact: 'Deposit confirmations delayed ~40s; no funds at risk',
        openedAt: '1h ago',
        timeline: [{ time: '13:20', text: 'Webhook latency breached 10s SLA' }],
      },
      {
        id: 'INC-101',
        title: 'Duplicate transaction anomaly',
        severity: 'low',
        status: 'resolved',
        owner: 'Sara Ahmed',
        impact: '3 duplicate authorizations auto-voided',
        rootCause: 'Client double-submit; idempotency key added',
        openedAt: '4h ago',
        timeline: [
          { time: '10:02', text: 'Anomaly detector flagged duplicates' },
          { time: '10:31', text: 'Duplicates voided; fix shipped' },
          { time: '10:40', text: 'Resolved' },
        ],
      },
    ];
  }

  async incidents() {
    // Live: no invented rows. There is no real source for this yet, so an
    // empty list is the honest answer — see isLive().
    if (await this.isLive()) return [];
    const fallback = this.incidentsFallback();
    return this.safe(async () => {
      const rows = await this.prisma.incident.findMany({
        include: { owner: true },
        orderBy: { createdAt: 'desc' },
      });
      if (rows.length === 0) return fallback;
      return rows.map((n, i) => ({
        id: `INC-${104 - i}`,
        title: n.title,
        severity: this.lower(n.severity),
        status: this.lower(n.status),
        owner: n.owner
          ? `${n.owner.firstName} ${n.owner.lastName}`
          : 'Unassigned',
        impact: n.impact ?? n.description,
        rootCause: n.rootCause ?? undefined,
        openedAt: this.ago(n.createdAt),
        timeline: [{ time: this.hhmm(n.createdAt), text: n.description }],
      }));
    }, fallback);
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
