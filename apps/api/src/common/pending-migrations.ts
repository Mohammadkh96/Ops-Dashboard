import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { PrismaService } from '../prisma/prisma.service';

/**
 * Migrations this build carries that the database has not applied.
 *
 * The gap between the two is silent by nature: the API starts, every existing
 * query works, and the first sign of trouble is a 500 from whichever button
 * happens to write a new column. Naming it at boot and in /health turns "the
 * incident page is broken" into "the database is three migrations behind",
 * which is a different afternoon.
 *
 * Read-only, and never throws: a diagnostic that can take the process down is
 * worse than the condition it reports.
 */
export async function pendingMigrations(
  prisma: PrismaService,
): Promise<string[]> {
  let onDisk: string[];
  try {
    // Both layouts: running from source (src/…) and from the build (dist/src/…),
    // where prisma/ sits beside the package root rather than the module.
    const roots = [
      join(process.cwd(), 'prisma', 'migrations'),
      join(__dirname, '..', '..', '..', 'prisma', 'migrations'),
      join(__dirname, '..', '..', 'prisma', 'migrations'),
    ];
    onDisk = [];
    for (const dir of roots) {
      try {
        onDisk = readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort();
        if (onDisk.length) break;
      } catch {
        /* try the next layout */
      }
    }
  } catch {
    return [];
  }
  if (!onDisk.length) return [];

  try {
    const applied = await prisma.$queryRawUnsafe<{ migration_name: string }[]>(
      // finished_at IS NULL means a migration started and did not complete —
      // still pending as far as the schema is concerned.
      'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL',
    );
    const done = new Set(applied.map((r) => r.migration_name));
    return onDisk.filter((name) => !done.has(name));
  } catch {
    // No _prisma_migrations table at all: either a database that has never been
    // migrated, or one this build cannot read. Both are worth reporting as
    // "everything is pending" rather than as "nothing is".
    return onDisk;
  }
}
