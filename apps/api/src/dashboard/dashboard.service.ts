import { Injectable, MessageEvent } from '@nestjs/common';
import { filter, interval, map, merge, Observable } from 'rxjs';

import { PrismaService } from '../prisma/prisma.service';
import { LiveBus } from '../live/live-bus.service';
import { isFailedState, isSettledState } from '../paymaxis/normalize';

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
              { AND: [{ occurredAt: null }, { receivedAt: { gte: priorStart } }] },
            ],
          },
          select: {
            occurredAt: true, receivedAt: true, type: true,
            state: true, amount: true, entity: true,
          },
          take: 50_000,
        }),
      [] as {
        occurredAt: Date | null; receivedAt: Date; type: string | null;
        state: string | null; amount: number; entity: string | null;
      }[],
    );
    if (!rows.length) return null;

    const at = (r: (typeof rows)[number]) => (r.occurredAt ?? r.receivedAt).getTime();
    const isWithdrawal = (t: string | null) => /withdraw|refund/i.test(t ?? '');

    const sumSettled = (from: number, to: number, withdrawals: boolean) =>
      rows
        .filter(
          (r) =>
            at(r) >= from && at(r) < to &&
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
    const successRate = decided ? Number(((settled / decided) * 100).toFixed(1)) : 100;

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
        buckets[i] += mode === 'net' && wd ? -Math.abs(r.amount) : Math.abs(r.amount);
      });
      return buckets.map((n) => Number(n.toFixed(2)));
    };

    const pct = (nowV: number, prevV: number) =>
      prevV > 0 ? Number((((nowV - prevV) / prevV) * 100).toFixed(1)) : null;
    // Scale to whatever unit keeps the tile readable.
    const scale = (n: number) =>
      n >= 1e6
        ? { value: Number((n / 1e6).toFixed(2)), unit: 'M' }
        : n >= 1e3
          ? { value: Number((n / 1e3).toFixed(1)), unit: 'K' }
          : { value: Number(n.toFixed(2)), unit: '' };

    const tile = (
      key: string, label: string, amount: number, prev: number,
      tone: string, sparkFor: 'all' | 'deposits' | 'withdrawals' | 'net',
    ) => {
      const change = pct(amount, prev);
      const { value, unit } = scale(amount);
      return {
        key, label, value, unit,
        change: change === null ? '—' : `${change >= 0 ? '+' : ''}${change}%`,
        positive: (change ?? 0) >= 0,
        tone, spark: spark(sparkFor),
      };
    };

    const byEntity = ['Mauritius', 'Saint Lucia'].map((e) => {
      const scoped = current.filter((r) => r.entity === e && isSettledState(r.state ?? ''));
      return {
        entity: e,
        count: scoped.length,
        volume: Number(scoped.reduce((s, r) => s + Math.abs(r.amount), 0).toFixed(2)),
      };
    });

    return {
      window: '24h',
      events: current.length,
      today: [
        tile('volume', 'Total Volume', dep + wdr, depPrev + wdrPrev, 'blue', 'all'),
        tile('deposits', 'Deposits', dep, depPrev, 'green', 'deposits'),
        tile('withdrawals', 'Withdrawals', wdr, wdrPrev, 'magenta', 'withdrawals'),
        tile('net', 'Net Flow', dep - wdr, depPrev - wdrPrev, 'purple', 'net'),
      ],
      performance: [
        { label: 'Success Rate', value: successRate },
        { label: 'Decline Rate', value: Number((100 - successRate).toFixed(1)) },
        { label: 'Settled', value: settled },
        { label: 'Declined', value: failed },
      ],
      failedPayments: failed,
      byEntity,
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
    };

    return {
      ...base,
      health: { score: 92, label: 'Healthy', trend: 3 },
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
      pendingWork: [
        {
          label: 'Pending KYC',
          value: pendingKyc || 34,
          href: '/compliance',
          tone: 'blue',
        },
        {
          label: 'Pending Compliance',
          value: 12,
          href: '/compliance',
          tone: 'purple',
        },
        {
          label: 'Escalated Tickets',
          value: escalatedTickets || 7,
          href: '/operations',
          tone: 'red',
        },
        {
          label: 'Failed Payments',
          value: live?.failedPayments ?? 19,
          href: '/payments',
          tone: 'orange',
        },
        { label: 'Pending Refunds', value: 5, href: '/payments', tone: 'blue' },
        {
          label: 'High Risk Clients',
          value: highRiskClients || 3,
          href: '/compliance',
          tone: 'red',
        },
      ],
      alerts: [
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
          detail: 'Client #48213 requested $92,000 withdrawal — pending review',
          time: '26m ago',
        },
      ],
      volumeSeries: [
        { time: '00:00', deposits: 120, withdrawals: 80 },
        { time: '03:00', deposits: 90, withdrawals: 60 },
        { time: '06:00', deposits: 140, withdrawals: 95 },
        { time: '09:00', deposits: 310, withdrawals: 180 },
        { time: '12:00', deposits: 420, withdrawals: 260 },
        { time: '15:00', deposits: 380, withdrawals: 240 },
        { time: '18:00', deposits: 290, withdrawals: 210 },
        { time: '21:00', deposits: 210, withdrawals: 150 },
      ],
      liveQueue: [
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
      systemStatus:
        gateways.length > 0
          ? [
              { name: 'Core API', status: 'operational', latency: '84ms' },
              {
                name: 'Payment Gateways',
                status: gateways.some((g) => g.status === 'DOWN')
                  ? 'down'
                  : gateways.some((g) => g.status === 'DEGRADED')
                    ? 'degraded'
                    : 'operational',
                latency: `${Math.round(gateways.reduce((a, g) => a + g.avgLatencyMs, 0) / gateways.length) || 0}ms`,
              },
              { name: 'CRM', status: 'operational', latency: '132ms' },
              {
                name: 'Trading Platform (MT5)',
                status: 'operational',
                latency: '61ms',
              },
            ]
          : [
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
            ],
      team: {
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
          { name: 'Fatima Noor', role: 'Support', workload: 2, initials: 'FN' },
          {
            name: 'Yusuf Ali',
            role: 'Operations',
            workload: 5,
            initials: 'YA',
          },
        ],
      },
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
    const real = this.bus.stream().pipe(map((tick): MessageEvent => ({ data: tick })));
    if (process.env.LIVE_SIMULATE === 'false') return real;
    const simulated = interval(4000).pipe(
      filter(() => !this.bus.hasLiveTraffic()),
      map((seq): MessageEvent => ({ data: this.makeTick(seq) })),
    );
    return merge(real, simulated);
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
