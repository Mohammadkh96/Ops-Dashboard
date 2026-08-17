import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Both URLs are read straight from process.env rather than through Prisma's
// env() helper, because env() throws while the config file is being LOADED —
// before Prisma knows which command you ran. That made `prisma generate`
// impossible on a fresh clone: generating the client needs no database at all,
// but a missing DATABASE_URL (no .env yet) failed the config load and took the
// whole command down with it. Commands that genuinely need a connection still
// fail without it, with Prisma's own message about the connection string.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
    // Only needed by `prisma migrate diff --from-migrations`.
    ...(process.env.SHADOW_DATABASE_URL
      ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL }
      : {}),
  },
});
