/**
 * Creates (or resets the password of) one login. Nothing else.
 *
 * `prisma db seed` also creates users, but it wipes tables and inserts demo
 * clients, transactions, tickets and incidents — exactly what must not happen
 * to a database holding real payment records. This touches the User table only.
 *
 * The password is read from the environment and is never printed or logged.
 *
 * Usage (PowerShell):
 *   $env:DATABASE_URL="<direct postgres url>"
 *   $env:ADMIN_EMAIL="you@tradin.com"
 *   $env:ADMIN_PASSWORD="<at least 12 characters>"
 *   npx tsx scripts/create-user.ts
 */
import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client';

const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD ?? '';
const role = (process.env.ADMIN_ROLE ?? 'ADMIN').trim().toUpperCase();

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!process.env.DATABASE_URL) fail('Set DATABASE_URL first.');
if (!email || !password) {
  fail('Set ADMIN_EMAIL and ADMIN_PASSWORD. The password is never printed.');
}
// A short password on an admin account is the usual way this becomes the weak
// point of the whole system.
if (password.length < 12) fail('ADMIN_PASSWORD must be at least 12 characters.');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const [firstName, ...rest] = (process.env.ADMIN_NAME ?? 'Ops User').split(' ');
const lastName = rest.join(' ') || '—';

async function main() {
  const passwordHash = await bcrypt.hash(password, 10);
  // Upsert rather than create: re-running resets the password instead of
  // failing, which is what is wanted the day someone is locked out.
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, isActive: true, role: role as never },
    create: {
      email,
      passwordHash,
      firstName,
      lastName,
      role: role as never,
      isActive: true,
    },
  });
  console.log(`User ready: ${user.email} (${user.role})`);
  console.log('Sign in at /login with that address and the password you set.');
}

main()
  .catch((e: unknown) => {
    console.error(`Failed: ${(e as Error)?.message ?? String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
