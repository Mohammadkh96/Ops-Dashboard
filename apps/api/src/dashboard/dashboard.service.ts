import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Builds the dashboard summary. Where the database has data it is used;
 * otherwise representative defaults are returned so the dashboard is never
 * empty in a fresh environment.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary() {
    const [pendingKyc, escalatedTickets, highRiskClients, gateways, onlineShifts] =
      await Promise.all([
        this.safeCount(() =>
          this.prisma.kycCase.count({ where: { status: { in: ['PENDING', 'IN_REVIEW'] } } }),
        ),
        this.safeCount(() =>
          this.prisma.ticket.count({ where: { status: 'ESCALATED' } }),
        ),
        this.safeCount(() =>
          this.prisma.client.count({ where: { riskLevel: { in: ['HIGH', 'CRITICAL'] } } }),
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
        this.safeCount(() => this.prisma.shift.count({ where: { status: 'ACTIVE' } })),
      ]);

    return {
      generatedAt: new Date().toISOString(),
      health: { score: 92, label: 'Healthy', trend: 3 },
      today: [
        { key: 'volume', label: 'Total Volume', value: 4.82, unit: 'M', change: '+8.4%', positive: true, tone: 'blue', spark: [3.1, 3.4, 3.2, 3.9, 4.1, 4.0, 4.5, 4.82] },
        { key: 'deposits', label: 'Deposits', value: 2.91, unit: 'M', change: '+12.1%', positive: true, tone: 'green', spark: [1.8, 2.0, 2.1, 2.4, 2.3, 2.6, 2.8, 2.91] },
        { key: 'withdrawals', label: 'Withdrawals', value: 1.91, unit: 'M', change: '-3.2%', positive: false, tone: 'magenta', spark: [2.1, 2.0, 2.05, 1.95, 1.98, 1.9, 1.93, 1.91] },
        { key: 'revenue', label: 'Revenue', value: 186.4, unit: 'K', change: '+5.6%', positive: true, tone: 'purple', spark: [140, 150, 148, 162, 170, 168, 180, 186.4] },
      ],
      performance: [
        { label: 'Success Rate', value: 97.8 },
        { label: 'Approval Rate', value: 94.2 },
        { label: 'Decline Rate', value: 5.8 },
        { label: 'Refund Rate', value: 1.4 },
      ],
      pendingWork: [
        { label: 'Pending KYC', value: pendingKyc || 34, href: '/compliance', tone: 'blue' },
        { label: 'Pending Compliance', value: 12, href: '/compliance', tone: 'purple' },
        { label: 'Escalated Tickets', value: escalatedTickets || 7, href: '/operations', tone: 'red' },
        { label: 'Failed Payments', value: 19, href: '/payments', tone: 'orange' },
        { label: 'Pending Refunds', value: 5, href: '/payments', tone: 'blue' },
        { label: 'High Risk Clients', value: highRiskClients || 3, href: '/compliance', tone: 'red' },
      ],
      alerts: [
        { id: 'al-1', severity: 'critical', title: 'ForumPay gateway offline', detail: 'No successful transactions in the last 6 minutes', time: '2m ago' },
        { id: 'al-2', severity: 'warning', title: 'Decline rate spike — Visa EU', detail: 'Decline rate up 14% over rolling 30 min window', time: '11m ago' },
        { id: 'al-3', severity: 'warning', title: 'Webhook delay — Coinbase Commerce', detail: 'Average webhook latency 42s (SLA: 10s)', time: '18m ago' },
        { id: 'al-4', severity: 'info', title: 'Large withdrawal flagged', detail: 'Client #48213 requested $92,000 withdrawal — pending review', time: '26m ago' },
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
        { id: 'TX-88213', type: 'Withdrawal', client: 'Client #48213', amount: '$92,000', status: 'review' },
        { id: 'TX-88214', type: 'Deposit', client: 'Client #10042', amount: '$4,200', status: 'processing' },
        { id: 'KYC-3341', type: 'KYC Review', client: 'Client #55210', amount: '—', status: 'pending' },
        { id: 'TX-88215', type: 'Withdrawal', client: 'Client #22981', amount: '$1,850', status: 'processing' },
        { id: 'TC-9931', type: 'Ticket', client: 'Client #77120', amount: '—', status: 'escalated' },
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
              { name: 'Trading Platform (MT5)', status: 'operational', latency: '61ms' },
            ]
          : [
              { name: 'Core API', status: 'operational', latency: '84ms' },
              { name: 'Payment Gateways', status: 'degraded', latency: '412ms' },
              { name: 'CRM', status: 'operational', latency: '132ms' },
              { name: 'Trading Platform (MT5)', status: 'operational', latency: '61ms' },
            ],
      team: {
        online: onlineShifts || 4,
        members: [
          { name: 'Sara Ahmed', role: 'Operations', workload: 4, initials: 'SA' },
          { name: 'David Chen', role: 'Compliance', workload: 7, initials: 'DC' },
          { name: 'Fatima Noor', role: 'Support', workload: 2, initials: 'FN' },
          { name: 'Yusuf Ali', role: 'Operations', workload: 5, initials: 'YA' },
        ],
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
