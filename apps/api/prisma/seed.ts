import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

/** Deterministic PRNG so re-seeding produces the same dataset. */
function rng(seed: number) {
  let s = seed * 9301 + 49297;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

const USERS = [
  { email: 'mohammad@tradin.com', firstName: 'Mohammad', lastName: 'K.', role: 'ADMIN', password: 'OpsOS!2026' },
  { email: 'sara@tradin.com', firstName: 'Sara', lastName: 'Ahmed', role: 'OPERATIONS' },
  { email: 'david@tradin.com', firstName: 'David', lastName: 'Chen', role: 'COMPLIANCE' },
  { email: 'fatima@tradin.com', firstName: 'Fatima', lastName: 'Noor', role: 'SUPPORT' },
  { email: 'yusuf@tradin.com', firstName: 'Yusuf', lastName: 'Ali', role: 'OPERATIONS' },
  { email: 'lina@tradin.com', firstName: 'Lina', lastName: 'Park', role: 'SUPPORT' },
  { email: 'omar@tradin.com', firstName: 'Omar', lastName: 'Haddad', role: 'FINANCE' },
  { email: 'priya@tradin.com', firstName: 'Priya', lastName: 'Rao', role: 'EXECUTIVE' },
  { email: 'analyst@tradin.com', firstName: 'New', lastName: 'Analyst', role: 'READ_ONLY' },
  { email: 'contractor@ext.com', firstName: 'Contractor', lastName: 'X', role: 'AUDITOR', inactive: true },
] as const;

const GATEWAYS = [
  { name: 'ForumPay', provider: 'ForumPay', status: 'DOWN', successRate: 0, avgLatencyMs: 0, todayVolume: 0 },
  { name: 'LimePay', provider: 'LimePay', status: 'OPERATIONAL', successRate: 98.6, avgLatencyMs: 142, todayVolume: 812000 },
  { name: 'Paystrax', provider: 'Paystrax', status: 'OPERATIONAL', successRate: 97.1, avgLatencyMs: 210, todayVolume: 604000 },
  { name: 'Coinbase', provider: 'Coinbase Commerce', status: 'DEGRADED', successRate: 91.4, avgLatencyMs: 480, todayVolume: 388000 },
  { name: 'Stripe', provider: 'Stripe', status: 'OPERATIONAL', successRate: 99.2, avgLatencyMs: 96, todayVolume: 1240000 },
  { name: 'Nuvei', provider: 'Nuvei', status: 'OPERATIONAL', successRate: 96.8, avgLatencyMs: 176, todayVolume: 521000 },
  { name: 'Bridge', provider: 'Bridge', status: 'OPERATIONAL', successRate: 95.3, avgLatencyMs: 233, todayVolume: 274000 },
] as const;

const CLIENT_IDS = ['#48213', '#10042', '#55210', '#22981', '#77120', '#30918', '#66203', '#12844', '#90117', '#40551'];
const COUNTRIES = ['AE', 'DE', 'GB', 'FR', 'SA', 'NG', 'IN', 'SG', 'BR', 'ES'];
const METHODS = ['CARD', 'CRYPTO', 'BANK', 'LOCAL_PAYMENT'] as const;
const CCY = ['USD', 'EUR', 'GBP', 'AED', 'BTC'];
const TX_STATUS = ['APPROVED', 'PROCESSING', 'PENDING', 'REVIEW', 'DECLINED', 'FAILED', 'REFUNDED'] as const;
const RISKS = ['LOW', 'LOW', 'LOW', 'MEDIUM', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

async function main() {
  console.log('Seeding OpsOS database…');

  // Clean (respecting FK order) so the seed is idempotent.
  await prisma.auditLog.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.kycCase.deleteMany();
  await prisma.ticket.deleteMany();
  await prisma.incident.deleteMany();
  await prisma.shift.deleteMany();
  await prisma.client.deleteMany();
  await prisma.paymentGateway.deleteMany();
  await prisma.user.deleteMany();

  // Users
  const defaultHash = await bcrypt.hash('OpsOS!2026', 10);
  const users: Array<Awaited<ReturnType<typeof prisma.user.create>>> = [];
  for (const u of USERS) {
    const passwordHash =
      'password' in u && u.password ? await bcrypt.hash(u.password, 10) : defaultHash;
    users.push(
      await prisma.user.create({
        data: {
          email: u.email,
          firstName: u.firstName,
          lastName: u.lastName,
          role: u.role as never,
          passwordHash,
          isActive: !('inactive' in u && u.inactive),
        },
      }),
    );
  }
  const byName = (n: string) => users.find((u) => `${u.firstName} ${u.lastName}`.startsWith(n));

  // Active shifts for the operations team
  for (const name of ['Sara', 'David', 'Fatima']) {
    const u = byName(name);
    if (u) await prisma.shift.create({ data: { userId: u.id, status: 'ACTIVE' } });
  }

  // Gateways
  const gateways: Array<Awaited<ReturnType<typeof prisma.paymentGateway.create>>> = [];
  for (const g of GATEWAYS) {
    gateways.push(
      await prisma.paymentGateway.create({
        data: {
          name: g.name,
          provider: g.provider,
          status: g.status as never,
          successRate: g.successRate,
          avgLatencyMs: g.avgLatencyMs,
          todayVolume: g.todayVolume,
        },
      }),
    );
  }

  // Clients
  const clients: Array<Awaited<ReturnType<typeof prisma.client.create>>> = [];
  for (let i = 0; i < CLIENT_IDS.length; i++) {
    const r = rng(i + 1);
    clients.push(
      await prisma.client.create({
        data: {
          externalId: CLIENT_IDS[i],
          fullName: `Client ${CLIENT_IDS[i]}`,
          email: `client${CLIENT_IDS[i].replace('#', '')}@example.com`,
          country: COUNTRIES[i % COUNTRIES.length],
          riskLevel: RISKS[Math.floor(r() * RISKS.length)] as never,
          riskScore: Math.floor(r() * 100),
          kycStatus: (['APPROVED', 'PENDING', 'IN_REVIEW', 'EDD_REQUIRED'] as const)[
            Math.floor(r() * 4)
          ] as never,
        },
      }),
    );
  }

  // Transactions (42, deterministic)
  for (let i = 0; i < 42; i++) {
    const r = rng(i + 1);
    const type = r() > 0.55 ? 'WITHDRAWAL' : 'DEPOSIT';
    const amount = Math.round((r() * (type === 'WITHDRAWAL' ? 95000 : 12000) + 120) * 100) / 100;
    const client = clients[Math.floor(r() * clients.length)];
    const gateway = gateways[Math.floor(r() * gateways.length)];
    const hoursAgo = Math.floor(r() * 20);
    await prisma.transaction.create({
      data: {
        reference: `TX-${88200 + i}`,
        clientId: client.id,
        gatewayId: gateway.id,
        type: type as never,
        method: METHODS[Math.floor(r() * METHODS.length)] as never,
        currency: CCY[Math.floor(r() * CCY.length)],
        amount,
        status: TX_STATUS[Math.floor(r() * TX_STATUS.length)] as never,
        riskLevel: RISKS[Math.floor(r() * RISKS.length)] as never,
        country: client.country,
        createdAt: new Date(Date.now() - hoursAgo * 3600_000),
      },
    });
  }

  // KYC cases
  const david = byName('David');
  const sara = byName('Sara');
  const kyc: Array<[string, string, number, string | undefined]> = [
    ['#55210', 'IN_REVIEW', 78, david?.id],
    ['#90117', 'PENDING', 22, undefined],
    ['#40551', 'EDD_REQUIRED', 91, david?.id],
    ['#12844', 'PENDING', 54, undefined],
    ['#66203', 'APPROVED', 18, sara?.id],
    ['#30918', 'REJECTED', 83, david?.id],
    ['#22981', 'IN_REVIEW', 47, sara?.id],
  ];
  for (const [ext, status, score, assignedToId] of kyc) {
    const client = clients.find((c) => c.externalId === ext);
    if (!client) continue;
    await prisma.kycCase.create({
      data: { clientId: client.id, status: status as never, riskScore: score, assignedToId },
    });
  }

  // Tickets
  const tickets: Array<[string, string, string, string, string | undefined]> = [
    ['Withdrawal stuck in review', '#77120', 'ESCALATED', 'URGENT', 'Fatima'],
    ['KYC document rejected — appeal', '#30918', 'IN_PROGRESS', 'HIGH', 'David'],
    ['Deposit not credited (crypto)', '#10042', 'IN_PROGRESS', 'HIGH', 'Sara'],
    ['Duplicate charge dispute', '#22981', 'OPEN', 'MEDIUM', undefined],
    ['Card payment declined repeatedly', '#55210', 'OPEN', 'MEDIUM', 'Yusuf'],
    ['Account statement request', '#66203', 'RESOLVED', 'LOW', 'Fatima'],
  ];
  for (const [subject, ext, status, priority, assigneeName] of tickets) {
    const client = clients.find((c) => c.externalId === ext);
    const assignee = assigneeName ? byName(assigneeName) : undefined;
    await prisma.ticket.create({
      data: {
        subject,
        clientId: client?.id,
        assignedToId: assignee?.id,
        status: status as never,
        priority: priority as never,
        slaDueAt: new Date(Date.now() + 3600_000),
      },
    });
  }

  // Incidents
  const yusuf = byName('Yusuf');
  const incidents: Array<[string, string, string, string, string | undefined]> = [
    ['ForumPay gateway offline', 'All ForumPay deposits failing; ~$180K/hr volume affected', 'CRITICAL', 'INVESTIGATING', yusuf?.id],
    ['Elevated decline rate — Visa EU', 'Card decline rate +14% for EU BINs over 30 min', 'HIGH', 'OPEN', sara?.id],
    ['Webhook delivery delay — Coinbase', 'Deposit confirmations delayed ~40s; no funds at risk', 'MEDIUM', 'INVESTIGATING', david?.id],
    ['Duplicate transaction anomaly', '3 duplicate authorizations auto-voided', 'LOW', 'RESOLVED', sara?.id],
  ];
  for (const [title, description, severity, status, ownerId] of incidents) {
    await prisma.incident.create({
      data: { title, description, severity: severity as never, status: status as never, ownerId },
    });
  }

  // Audit log
  const audits: Array<[string | undefined, string, string, string, string]> = [
    [sara?.id, 'Approved withdrawal', 'Transaction', 'TX-88175', '10.2.4.11'],
    [david?.id, 'Escalated KYC case', 'KycCase', 'k3', '10.2.4.31'],
    [byName('Mohammad')?.id, 'Changed user role', 'User', 'analyst@tradin.com', '10.2.4.2'],
    [byName('Fatima')?.id, 'Resolved ticket', 'Ticket', 'TC-9926', '10.2.4.22'],
    [undefined, 'Auto-voided duplicate', 'Transaction', 'TX-88101', ''],
    [yusuf?.id, 'Declared incident', 'Incident', 'INC-104', '10.2.4.19'],
  ];
  for (const [userId, action, entityType, entityId, ipAddress] of audits) {
    await prisma.auditLog.create({
      data: { userId, action, entityType, entityId, ipAddress: ipAddress || null },
    });
  }

  const counts = {
    users: await prisma.user.count(),
    clients: await prisma.client.count(),
    gateways: await prisma.paymentGateway.count(),
    transactions: await prisma.transaction.count(),
    kycCases: await prisma.kycCase.count(),
    tickets: await prisma.ticket.count(),
    incidents: await prisma.incident.count(),
    auditLogs: await prisma.auditLog.count(),
  };
  console.log('Seed complete:', counts);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
