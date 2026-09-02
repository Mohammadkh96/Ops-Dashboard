import 'dotenv/config';
import { defineConfig } from 'prisma/config';

import { migrationUrl } from './scripts/direct-url.mjs';

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
    // The DIRECT connection, never the pooled one. Every command that reads
    // this config is a schema command, and a schema command takes an advisory
    // lock that a connection pooler cannot hold — see scripts/direct-url.mjs.
    // The API's own runtime is unaffected: it reads DATABASE_URL itself.
    url: migrationUrl().url ?? '',
    // Only needed by `prisma migrate diff --from-migrations`.
    ...(process.env.SHADOW_DATABASE_URL
      ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL }
      : {}),
  },
});
