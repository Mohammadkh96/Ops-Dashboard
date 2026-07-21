import * as bcrypt from 'bcrypt';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const gateways = [
  { name: 'ForumPay', provider: 'ForumPay' },
  { name: 'LimePay', provider: 'LimePay' },
  { name: 'Paystrax', provider: 'Paystrax' },
  { name: 'Coinbase Commerce', provider: 'Coinbase' },
  { name: 'Stripe', provider: 'Stripe' },
  { name: 'Nuvei', provider: 'Nuvei' },
  { name: 'Bridge', provider: 'Bridge' },
];

async function main() {
  const passwordHash = await bcrypt.hash('OpsOS!2026', 10);

  await prisma.user.upsert({
    where: { email: 'mohammad@tradin.com' },
    update: {},
    create: {
      email: 'mohammad@tradin.com',
      passwordHash,
      firstName: 'Mohammad',
      lastName: 'K.',
      role: 'ADMIN',
    },
  });

  for (const gateway of gateways) {
    await prisma.paymentGateway.upsert({
      where: { name: gateway.name },
      update: {},
      create: gateway,
    });
  }

  console.log('Seed complete.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
