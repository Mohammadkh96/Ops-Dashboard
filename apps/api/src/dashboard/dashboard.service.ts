import { Injectable, MessageEvent } from '@nestjs/common';
import { filter, interval, map, merge, Observable } from 'rxjs';

import { PrismaService } from '../prisma/prisma.service';
import { LiveBus } from '../live/live-bus.service';
import type { LiveTick } from '../live/live.types';
import {
  isFailedState,
  isSettledState,
  toQueueItem,
} from '../paymaxis/normalize';

const LIVE_TYPES = ['Deposit', 'Withdrawal', 'KYC Review', 'Ticket'] as const;

/**
 * Builds the dashboard summary. Where the database has data it is used;
 * otherwise representative defaults are returned so the dashboard is never
 * empty in a fresh environment.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: LiveBus,
  ) {}

  /**
   * Real KPIs over a rolling 24 hours, derived from ingested payment events.
   *
   * Returns null when no events exist, so a fresh environment keeps the
   * representative defaults instead of showing a dashboard full of zeros.
   *
   * Volume counts SETTLED money only — an attempted-but-declined deposit is not
   * revenue, and counting it would overstate the business. Declines are still
   * measured, in the success rate.
   */
  private async liveMetrics() {
    const dayMs = 86_400_000;
    const now = Date.now();
    const windowStart = new Date(now - dayMs);
    const priorStart = new Date(now - 2 * dayMs);

    const rows = await this.safeQuery(
      () =>
        this.prisma.paymentEvent.findMany({
          where: {
            OR: [
              { occurredAt: { gte: priorStart } },
              {
                AND: [
                  { occurredAt: null },
                  { receivedAt: { gte: priorStart } },
                ],
              },
            ],
          },
          select: {
            occurredAt: true,
            receivedAt: true,
            type: true,
            state: true,
            amount: true,
            entity: true,
            psp: true,
            errorCode: true,
            errorMessage: true,
          },
          take: 50_000,
        }),
      [] as {
        occurredAt: Date | null;
        receivedAt: Date;
        type: string | null;
        state: string | null;
        amount: number;
        entity: string | null;
        psp: string | null;
        errorCode: string | null;
        errorMessage: string | null;
      }[],
    );
    if (!rows.length) return null;

    const at = (r: (typeof rows)[number]) =>
      (r.occurredAt ?? r.receivedAt).getTime();
    const isWithdrawal = (t: string | null) => /withdraw|refund/i.test(t ?? '');

    const sumSettled = (from: number, to: number, withdrawals: boolean) =>
      rows
        .filter(
          (r) =>
            at(r) >= from &&
            at(r) < to &&
            isSettledState(r.state ?? '') &&
            isWithdrawal(r.type) === withdrawals,
        )
        .reduce((s, r) => s + Math.abs(r.amount), 0);

    const wStart = windowStart.getTime();
    const pStart = priorStart.getTime();
    const dep = sumSettled(wStart, now, false);
    const wdr = sumSettled(wStart, now, true);
    const depPrev = sumSettled(pStart, wStart, false);
    const wdrPrev = sumSettled(pStart, wStart, true);

    const current = rows.filter((r) => at(r) >= wStart);
    const settled = current.filter((r) => isSettledState(r.state ?? '')).length;
    const failed = current.filter((r) => isFailedState(r.state ?? '')).length;
    const decided = settled + failed;
    const successRate = decided
      ? Number(((settled / decided) * 100).toFixed(1))
      : 100;

    // Eight 3-hour buckets across the window, so the sparkline shows the shape
    // of the day rather than a meaningless cumulative ramp.
    const spark = (mode: 'all' | 'deposits' | 'withdrawals' | 'net') => {
      const buckets = new Array(8).fill(0) as number[];
      const size = dayMs / 8;
      current.forEach((r) => {
        if (!isSettledState(r.state ?? '')) return;
        const wd = isWithdrawal(r.type);
        if (mode === 'deposits' && wd) return;
        if (mode === 'withdrawals' && !wd) return;
        const i = Math.min(7, Math.floor((at(r) - wStart) / size));
        // Net flow subtracts withdrawals, so its line matches its own tile
        // rather than quietly plotting gross volume.
        buckets[i] +=
          mode === 'net' && wd ? -Math.abs(r.amount) : Math.abs(r.amount);
      });
      return buckets.map((n) => Number(n.toFixed(2)));
    };

    // How much settled activity the PREVIOUS 24h actually contains. A
    // percentage change measured against a nearly-empty prior window is
    // arithmetic rather than information: on the first day of ingest, $57.9K
    // against a prior window holding a few dollars produced "+466760.9%" on
    // the Total Volume tile. `prevV > 0` was not a sufficient guard, because
    // "barely any data" is still greater than zero.
    //
    // Below this floor the tile shows "—", which is the honest answer: there
    // is nothing to compare against yet. It starts reporting on its own once a
    // full prior day exists.
    const priorSettled = rows.filter(
      (r) => at(r) >= pStart && at(r) < wStart && isSettledState(r.state ?? ''),
    ).length;
    const comparable = priorSettled >= 10;

    const pct = (nowV: number, prevV: number) =>
      comparable && prevV > 0
        ? Number((((nowV - prevV) / prevV) * 100).toFixed(1))
        : null;
    // Scale to whatever unit keeps the tile readable.
    const scale = (n: number) =>
      n >= 1e6
        ? { value: Number((n / 1e6).toFixed(2)), unit: 'M' }
        : n >= 1e3
          ? { value: Number((n / 1e3).toFixed(1)), unit: 'K' }
          : { value: Number(n.toFixed(2)), unit: '' };

    const tile = (
      key: string,
      label: string,
      amount: number,
      prev: number,
      tone: string,
      sparkFor: 'all' | 'deposits' | 'withdrawals' | 'net',
    ) => {
      const change = pct(amount, prev);
      const { value, unit } = scale(amount);
      return {
        key,
        label,
        value,
        unit,
        change: change === null ? '—' : `${change >= 0 ? '+' : ''}${change}%`,
        positive: (change ?? 0) >= 0,
        tone,
        spark: spark(sparkFor),
      };
    };

    const byEntity = ['Mauritius', 'Saint Lucia'].map((e) => {
      const scoped = current.filter(
        (r) => r.entity === e && isSettledState(r.state ?? ''),
      );
      return {
        entity: e,
        count: scoped.length,
        volume: Number(
          scoped.reduce((s, r) => s + Math.abs(r.amount), 0).toFixed(2),
        ),
      };
    });

    // Why payments failed, biggest first. This is the most actionable view on a
    // payments dashboard: "Declined by 3DS" and "insufficient funds" call for
    // completely different responses, and a total decline count says neither.
    const reasons = new Map<string, { count: number; amount: number }>();
    current
      .filter((r) => isFailedState(r.state ?? ''))
      .forEach((r) => {
        const label = r.errorMessage || r.errorCode || r.state || 'Unknown';
        const e = reasons.get(label) ?? { count: 0, amount: 0 };
        e.count += 1;
        e.amount += Math.abs(r.amount);
        reasons.set(label, e);
      });
    const declineReasons = [...reasons.entries()]
      .map(([reason, v]) => ({
        reason,
        count: v.count,
        amount: Number(v.amount.toFixed(2)),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    // Per-PSP health, so a single failing provider is visible rather than
    // averaged away in the overall success rate.
    const pspNames = [
      ...new Set(current.map((r) => r.psp).filter(Boolean)),
    ] as string[];
    const byPsp = pspNames
      .map((name) => {
        const scoped = current.filter((r) => r.psp === name);
        const ok = scoped.filter((r) => isSettledState(r.state ?? '')).length;
        const bad = scoped.filter((r) => isFailedState(r.state ?? '')).length;
        return {
          psp: name,
          settled: ok,
          declined: bad,
          successRate:
            ok + bad ? Number(((ok / (ok + bad)) * 100).toFixed(1)) : null,
          volume: Number(
            scoped
              .filter((r) => isSettledState(r.state ?? ''))
              .reduce((s, r) => s + Math.abs(r.amount), 0)
              .toFixed(2),
          ),
        };
      })
      .sort((a, b) => b.volume - a.volume);

    return {
      window: '24h',
      events: current.length,
      declineReasons,
      byPsp,
      today: [
        tile(
          'volume',
          'Total Volume',
          dep + wdr,
          depPrev + wdrPrev,
          'blue',
          'all',
        ),
        tile('deposits', 'Deposits', dep, depPrev, 'green', 'deposits'),
        tile(
          'withdrawals',
          'Withdrawals',
          wdr,
          wdrPrev,
          'magenta',
          'withdrawals',
        ),
        tile('net', 'Net Flow', dep - wdr, depPrev - wdrPrev, 'purple', 'net'),
      ],
      // `unit` so the UI can tell a rate from a tally. Without it the counts
      // rendered as percentages — "207.0%" settled, on a full progress bar.
      performance: [
        { label: 'Success Rate', value: successRate, unit: '%' },
        {
          label: 'Decline Rate',
          value: Number((100 - successRate).toFixed(1)),
          unit: '%',
        },
        { label: 'Settled', value: settled, unit: 'count' },
        { label: 'Declined', value: failed, unit: 'count' },
      ],
      failedPayments: failed,
      byEntity,
      successRate,
      // The deposits/withdrawals chart, from the same 3-hour buckets the
      // sparklines use. Previously this was a hardcoded curve, so the chart
      // disagreed with the tiles above it once real money arrived.
      volumeSeries: (() => {
        const dHist = spark('deposits');
        const wHist = spark('withdrawals');
        const size = dayMs / 8;
        return dHist.map((deposits, i) => ({
          time: new Date(wStart + i * size)
            .toISOString()
            .slice(11, 16), // HH:MM, UTC — same basis as every other figure here
          deposits,
          withdrawals: wHist[i],
        }));
      })(),
    };
  }

  async getSummary() {
    const [
      pendingKyc,
      escalatedTickets,
      highRiskClients,
      gateways,
      onlineShifts,
      live,
    ] = await Promise.all([
      this.safeCount(() =>
        this.prisma.kycCase.count({
          where: { status: { in: ['PENDING', 'IN_REVIEW'] } },
        }),
      ),
      this.safeCount(() =>
        this.prisma.ticket.count({ where: { status: 'ESCALATED' } }),
      ),
      this.safeCount(() =>
        this.prisma.client.count({
          where: { riskLevel: { in: ['HIGH', 'CRITICAL'] } },
        }),
      ),
      this.safeQuery(
        () =>
          this.prisma.paymentGateway.findMany({
            select: { name: true, status: true, avgLatencyMs: true },
            take: 6,
            orderBy: { name: 'asc' },
          }),
        [] as { name: string; status: string; avgLatencyMs: number }[],
      ),
      this.safeCount(() =>
        this.prisma.shift.count({ where: { status: 'ACTIVE' } }),
      ),
      this.liveMetrics(),
    ]);

    // Real events win over the defaults. `live` tells the UI these numbers are
    // measured rather than representative.
    const base = {
      generatedAt: new Date().toISOString(),
      live: !!live,
      window: live?.window ?? null,
      byEntity: live?.byEntity ?? null,
      byPsp: live?.byPsp ?? null,
      declineReasons: live?.declineReasons ?? null,
    };

    // Once real payments exist, every illustrative block has to go.
    //
    // The placeholders make an empty environment look like a product. Beside
    // real money they are a hazard: an invented "gateway offline" alert or a
    // $92,000 withdrawal that does not exist is indistinguishable from a real
    // one, and someone will act on it. Sections with no real source are emptied
    // rather than filled in, so the dashboard shows nothing instead of fiction.
    const demo = !live;

    // The initial queue, from real payments. The live feed takes over from here.
    //
    // One row per payment, showing its LATEST state. A payment progresses
    // through states and each is stored separately — that history is wanted in
    // the database, but in a queue readout it surfaced the same payment id
    // twice, once "processing" and once "failed", which reads as either a
    // duplicate or a contradiction. Reads more than five so there is something
    // left after collapsing them.
    let queue: LiveTick['queueItem'][] | null = null;
    if (live) {
      const newestFirst = (await this.liveFeed({ limit: 25 })).events
        .map((e) => e.queueItem)
        .reverse();
      const seenIds = new Set<string>();
      queue = newestFirst
        .filter((q) => !seenIds.has(q.id) && seenIds.add(q.id))
        .slice(0, 5);
    }

    return {
      ...base,
      // Derived from the measured success rate rather than asserted. A fixed
      // "92 / Healthy" beside a real 59.8% success rate is worse than no score.
      health: live
        ? {
            score: Math.round(live.successRate),
            label:
              live.successRate >= 90
                ? 'Healthy'
                : live.successRate >= 75
                  ? 'Degraded'
                  : 'Needs attention',
            trend: 0,
          }
        : { score: 92, label: 'Healthy', trend: 3 },
      today: live?.today ?? [
        {
          key: 'volume',
          label: 'Total Volume',
          value: 4.82,
          unit: 'M',
          change: '+8.4%',
          positive: true,
          tone: 'blue',
          spark: [3.1, 3.4, 3.2, 3.9, 4.1, 4.0, 4.5, 4.82],
        },
        {
          key: 'deposits',
          label: 'Deposits',
          value: 2.91,
          unit: 'M',
          change: '+12.1%',
          positive: true,
          tone: 'green',
          spark: [1.8, 2.0, 2.1, 2.4, 2.3, 2.6, 2.8, 2.91],
        },
        {
          key: 'withdrawals',
          label: 'Withdrawals',
          value: 1.91,
          unit: 'M',
          change: '-3.2%',
          positive: false,
          tone: 'magenta',
          spark: [2.1, 2.0, 2.05, 1.95, 1.98, 1.9, 1.93, 1.91],
        },
        {
          key: 'revenue',
          label: 'Revenue',
          value: 186.4,
          unit: 'K',
          change: '+5.6%',
          positive: true,
          tone: 'purple',
          spark: [140, 150, 148, 162, 170, 168, 180, 186.4],
        },
      ],
      performance: live?.performance ?? [
        { label: 'Success Rate', value: 97.8 },
        { label: 'Approval Rate', value: 94.2 },
        { label: 'Decline Rate', value: 5.8 },
        { label: 'Refund Rate', value: 1.4 },
      ],
      // `|| 34` reads as a default but behaves as a fabrication: a real count of
      // zero is falsy, so an empty KYC queue displayed as 34 pending cases.
      // Live counts are shown as they are, zero included.
      pendingWork: [
        {
          label: 'Pending KYC',
          value: demo ? pendingKyc || 34 : pendingKyc,
          href: '/compliance',
          tone: 'blue',
        },
        // No compliance-queue or refund-queue model exists yet, so there is
        // nothing to count. Omitted entirely rather than invented.
        ...(demo
          ? [
              {
                label: 'Pending Compliance',
                value: 12,
                href: '/compliance',
                tone: 'purple',
              },
            ]
          : []),
        {
          label: 'Escalated Tickets',
          value: demo ? escalatedTickets || 7 : escalatedTickets,
          href: '/operations',
          tone: 'red',
        },
        {
          label: 'Failed Payments',
          value: live?.failedPayments ?? 19,
          href: '/payments',
          tone: 'orange',
        },
        ...(demo
          ? [
              {
                label: 'Pending Refunds',
                value: 5,
                href: '/payments',
                tone: 'blue',
              },
            ]
          : []),
        {
          label: 'High Risk Clients',
          value: demo ? highRiskClients || 3 : highRiskClients,
          href: '/compliance',
          tone: 'red',
        },
      ],
      // Empty on live data, and that is the correct answer until real alerting
      // exists. A fabricated "gateway offline" or "$92,000 withdrawal flagged"
      // cannot be told apart from a genuine one, and acting on either wastes an
      // operator's time at best. Real alerts belong here once they are derived
      // from measurements — a PSP's success rate collapsing, say — not before.
      alerts: demo
        ? [
            {
              id: 'al-1',
              severity: 'critical',
              title: 'ForumPay gateway offline',
              detail: 'No successful transactions in the last 6 minutes',
              time: '2m ago',
            },
            {
              id: 'al-2',
              severity: 'warning',
              title: 'Decline rate spike — Visa EU',
              detail: 'Decline rate up 14% over rolling 30 min window',
              time: '11m ago',
            },
            {
              id: 'al-3',
              severity: 'warning',
              title: 'Webhook delay — Coinbase Commerce',
              detail: 'Average webhook latency 42s (SLA: 10s)',
              time: '18m ago',
            },
            {
              id: 'al-4',
              severity: 'info',
              title: 'Large withdrawal flagged',
              detail:
                'Client #48213 requested $92,000 withdrawal — pending review',
              time: '26m ago',
            },
          ]
        : [],
      volumeSeries: live?.volumeSeries ?? [
        { time: '00:00', deposits: 120, withdrawals: 80 },
        { time: '03:00', deposits: 90, withdrawals: 60 },
        { time: '06:00', deposits: 140, withdrawals: 95 },
        { time: '09:00', deposits: 310, withdrawals: 180 },
        { time: '12:00', deposits: 420, withdrawals: 260 },
        { time: '15:00', deposits: 380, withdrawals: 240 },
        { time: '18:00', deposits: 290, withdrawals: 210 },
        { time: '21:00', deposits: 210, withdrawals: 150 },
      ],
      liveQueue: queue ?? [
        {
          id: 'TX-88213',
          type: 'Withdrawal',
          client: 'Client #48213',
          amount: '$92,000',
          status: 'review',
        },
        {
          id: 'TX-88214',
          type: 'Deposit',
          client: 'Client #10042',
          amount: '$4,200',
          status: 'processing',
        },
        {
          id: 'KYC-3341',
          type: 'KYC Review',
          client: 'Client #55210',
          amount: '—',
          status: 'pending',
        },
        {
          id: 'TX-88215',
          type: 'Withdrawal',
          client: 'Client #22981',
          amount: '$1,850',
          status: 'processing',
        },
        {
          id: 'TC-9931',
          type: 'Ticket',
          client: 'Client #77120',
          amount: '—',
          status: 'escalated',
        },
      ],
      // Only components this service actually observes.
      //
      // CRM and the trading platform are not monitored from here, and reporting
      // them "operational" with an invented latency answers a question nobody
      // checked — the worst kind of entry on a status board, because it is
      // trusted. They appear in demo mode only. Add them back for real when
      // something here probes them.
      systemStatus: demo
        ? [
            { name: 'Core API', status: 'operational', latency: '84ms' },
            {
              name: 'Payment Gateways',
              status: 'degraded',
              latency: '412ms',
            },
            { name: 'CRM', status: 'operational', latency: '132ms' },
            {
              name: 'Trading Platform (MT5)',
              status: 'operational',
              latency: '61ms',
            },
          ]
        : [
            // True by construction: this response is being served.
            { name: 'Core API', status: 'operational', latency: null },
            // Measured — the query behind `live` succeeded.
            { name: 'Database', status: 'operational', latency: null },
            // Only when there are real gateway records to derive it from.
            ...(gateways.length > 0
              ? [
                  {
                    name: 'Payment Gateways',
                    status: gateways.some((g) => g.status === 'DOWN')
                      ? 'down'
                      : gateways.some((g) => g.status === 'DEGRADED')
                        ? 'degraded'
                        : 'operational',
                    latency: `${Math.round(gateways.reduce((a, g) => a + g.avgLatencyMs, 0) / gateways.length) || 0}ms`,
                  },
                ]
              : []),
          ],
      // Named people with invented workloads. There is no roster to read, and
      // inventing colleagues is the least defensible placeholder of the lot.
      team: demo
        ? {
            online: onlineShifts || 4,
            members: [
              {
                name: 'Sara Ahmed',
                role: 'Operations',
                workload: 4,
                initials: 'SA',
              },
              {
                name: 'David Chen',
                role: 'Compliance',
                workload: 7,
                initials: 'DC',
              },
              {
                name: 'Fatima Noor',
                role: 'Support',
                workload: 2,
                initials: 'FN',
              },
              {
                name: 'Yusuf Ali',
                role: 'Operations',
                workload: 5,
                initials: 'YA',
              },
            ],
          }
        : { online: onlineShifts, members: [] },
    };
  }

  /**
   * Server-Sent Events stream of live operational ticks (a new queue item plus
   * jittered metrics) emitted every 4s. Consumed by the dashboard's live feed.
   */
  /**
   * Real provider events merged with the simulator.
   *
   * Once any real callback has arrived the simulator stands down permanently —
   * a live dashboard must never mix invented rows into real operational data.
   * Set LIVE_SIMULATE=false to disable the simulator outright.
   */
  liveStream(): Observable<MessageEvent> {
    const real = this.bus
      .stream()
      .pipe(map((tick): MessageEvent => ({ data: tick })));

    // Keep-alive. With the simulator off, this stream is silent between real
    // payments — which can be many minutes at night. Reverse proxies and CDNs
    // close an idle connection (Cloudflare at ~100s, most load balancers at 60s),
    // so the dashboard would show "disconnected" during exactly the quiet spells
    // it is meant to sit through. A named event is deliberate: EventSource's
    // onmessage only fires for unnamed events, so the client ignores these with
    // no change on its side.
    const seconds = Math.max(
      5,
      Number(process.env.LIVE_HEARTBEAT_SECONDS ?? 20),
    );
    const heartbeat = interval(seconds * 1000).pipe(
      map((): MessageEvent => ({ type: 'ping', data: '' })),
    );

    if (process.env.LIVE_SIMULATE === 'false') return merge(real, heartbeat);
    const simulated = interval(4000).pipe(
      filter(() => !this.bus.hasLiveTraffic()),
      map((seq): MessageEvent => ({ data: this.makeTick(seq) })),
    );
    return merge(real, simulated, heartbeat);
  }

  /**
   * The same live feed as `liveStream`, but pull instead of push and read from
   * Postgres instead of the in-memory bus.
   *
   * This is what makes the feed work on a serverless platform. There, the
   * webhook that receives a payment and the request that serves the dashboard
   * run in different processes, so an in-memory bus can never carry an event
   * between them — and no invocation lives long enough to hold an SSE
   * connection open. Reading committed rows sidesteps both problems, and has a
   * bonus the stream never had: a browser that was closed overnight can ask for
   * everything it missed rather than starting blank.
   *
   * `cursor` is `receivedAt|id`. The id is part of it because two callbacks can
   * land in the same millisecond, and a timestamp-only cursor would either skip
   * one of them or replay it forever.
   */
  async liveFeed(opts: { since?: string; limit?: number } = {}) {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 25));

    const [atRaw, idRaw] = (opts.since ?? '').split('|');
    const at = atRaw ? new Date(atRaw) : null;
    const cursor =
      at && !Number.isNaN(at.getTime()) ? { at, id: idRaw ?? '' } : null;

    const select = {
      id: true,
      receivedAt: true,
      paymentId: true,
      reference: true,
      type: true,
      state: true,
      amount: true,
      currency: true,
      customer: true,
    } as const;

    const rows = await this.safeQuery(
      () =>
        this.prisma.paymentEvent.findMany({
          where: cursor
            ? {
                OR: [
                  { receivedAt: { gt: cursor.at } },
                  {
                    AND: [{ receivedAt: cursor.at }, { id: { gt: cursor.id } }],
                  },
                ],
              }
            : {},
          // No cursor means a fresh page load: take the newest rows so the feed
          // is populated immediately, then flip them back into reading order.
          // With a cursor, take the oldest unseen rows so nothing is skipped
          // when more arrived than fit in one page.
          orderBy: cursor
            ? [{ receivedAt: 'asc' as const }, { id: 'asc' as const }]
            : [{ receivedAt: 'desc' as const }, { id: 'desc' as const }],
          take: limit,
          select,
        }),
      [] as {
        id: string;
        receivedAt: Date;
        paymentId: string | null;
        reference: string | null;
        type: string | null;
        state: string | null;
        amount: number;
        currency: string | null;
        customer: string | null;
      }[],
    );
    if (!cursor) rows.reverse();

    // Success rate over a rolling window rather than the returned page, which
    // may be a single event — one declined payment must not read as 0%.
    const window = await this.safeQuery(
      () =>
        this.prisma.paymentEvent.findMany({
          orderBy: { receivedAt: 'desc' as const },
          take: 200,
          select: { state: true },
        }),
      [] as { state: string | null }[],
    );
    const settled = window.filter((r) => isSettledState(r.state ?? '')).length;
    const failed = window.filter((r) => isFailedState(r.state ?? '')).length;
    const decided = settled + failed;
    const successRate = decided
      ? Number(((settled / decided) * 100).toFixed(1))
      : 100;

    // No events have ever been ingested. Keep the simulator's behaviour from the
    // SSE path so a freshly deployed dashboard does not look broken before the
    // first callback — and stop the moment real data exists.
    if (!window.length) {
      if (process.env.LIVE_SIMULATE === 'false') {
        return {
          events: [],
          cursor: opts.since ?? null,
          live: false,
          simulated: false,
        };
      }
      // One tick per poll, matching the 4s cadence the stream used.
      return {
        events: [this.makeTick(Math.floor(Date.now() / 4000))],
        cursor: opts.since ?? null,
        live: false,
        simulated: true,
      };
    }

    let prevAmount = 0;
    const events = rows.map((r) => {
      const state = r.state ?? '';
      const volumeDelta =
        prevAmount && r.amount
          ? Number(((r.amount - prevAmount) / prevAmount).toFixed(3))
          : 0;
      if (r.amount) prevAmount = r.amount;
      return {
        ts: r.receivedAt.toISOString(),
        // Monotonic and unique enough for a feed key; the client only uses it
        // to tell one tick from the next.
        seq: r.receivedAt.getTime(),
        queueItem: toQueueItem({
          paymentId: r.paymentId ?? '',
          reference: r.reference ?? '',
          type: r.type ?? '',
          customer: r.customer ?? '',
          amount: r.amount,
          currency: r.currency ?? '',
          settled: isSettledState(state)
            ? true
            : isFailedState(state)
              ? false
              : undefined,
        }),
        metrics: { successRate, volumeDelta },
        live: true,
      };
    });

    const last = rows[rows.length - 1];
    return {
      events,
      // Unchanged when nothing new arrived, so the client keeps polling from the
      // same point instead of losing its place.
      cursor: last
        ? `${last.receivedAt.toISOString()}|${last.id}`
        : (opts.since ?? null),
      live: true,
      simulated: false,
    };
  }

  private makeTick(seq: number) {
    const type = LIVE_TYPES[seq % LIVE_TYPES.length];
    const isMoney = type === 'Deposit' || type === 'Withdrawal';
    const prefix =
      type === 'KYC Review' ? 'KYC' : type === 'Ticket' ? 'TC' : 'TX';
    const status =
      type === 'Ticket'
        ? 'escalated'
        : type === 'KYC Review'
          ? 'pending'
          : isMoney && Math.random() > 0.7
            ? 'review'
            : 'processing';
    return {
      ts: new Date().toISOString(),
      seq,
      queueItem: {
        id: `${prefix}-${88000 + Math.floor(Math.random() * 9999)}`,
        type,
        client: `Client #${10000 + Math.floor(Math.random() * 89999)}`,
        amount: isMoney
          ? `$${(Math.floor(Math.random() * 90) * 100 + 200).toLocaleString()}`
          : '—',
        status,
      },
      metrics: {
        successRate: Number((97.8 + (Math.random() - 0.5) * 0.6).toFixed(1)),
        volumeDelta: Number((Math.random() * 0.04).toFixed(3)),
      },
    };
  }

  private async safeCount(fn: () => Promise<number>): Promise<number> {
    try {
      return await fn();
    } catch {
      return 0;
    }
  }

  private async safeQuery<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  }
}
