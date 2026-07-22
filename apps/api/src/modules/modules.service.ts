import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Serves the operational module datasets. Where the database has rows they are
 * used and mapped to the frontend's shapes; otherwise representative fallback
 * data is returned so the API is populated (and never errors) in a fresh
 * environment with no database. Shapes mirror the frontend's types.
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

  async transactions() {
    const fallback = this.transactionsFallback();
    return this.safe(async () => {
      const rows = await this.prisma.transaction.findMany({
        include: { client: true, gateway: true },
        orderBy: { createdAt: 'desc' },
        take: 60,
      });
      if (rows.length === 0) return fallback;
      return rows.map((t, i) => ({
        id: `tx-${i + 1}`,
        reference: t.reference,
        client: t.client?.fullName ?? 'Unknown',
        country: t.country ?? t.client?.country ?? '—',
        gateway: t.gateway?.name ?? '—',
        method: this.methodLabel(t.method),
        currency: t.currency,
        amount: Number(t.amount),
        type: t.type === 'WITHDRAWAL' ? 'Withdrawal' : 'Deposit',
        status: this.lower(t.status),
        risk: this.lower(t.riskLevel),
        createdAt: this.hhmm(t.createdAt),
      }));
    }, fallback);
  }

  // -------- gateways --------

  async gateways() {
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
    const fallbackTickets = this.ticketsFallback();
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

    return { tickets, team: this.team, shiftChecklist: this.shiftChecklist };
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
