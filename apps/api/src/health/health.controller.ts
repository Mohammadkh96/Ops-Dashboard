import { Controller, Get, Headers, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import {
  allowedOrigins,
  configuredOrigins,
  isOriginAllowed,
} from '../common/cors';
import { pendingMigrations } from '../common/pending-migrations';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    let database: 'up' | 'down' = 'down';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch {
      database = 'down';
    }

    // A reachable database that is behind this build is not healthy: reads work,
    // and the first write to a new column returns a 500 that looks like a bug in
    // whatever button was pressed. Named here so the check that is actually
    // monitored says it, rather than an operator discovering it by accident.
    const pending =
      database === 'up' ? await pendingMigrations(this.prisma) : [];

    return {
      status: database !== 'up' ? 'degraded' : pending.length ? 'behind' : 'ok',
      timestamp: new Date().toISOString(),
      database,
      pendingMigrations: pending,
      ...(pending.length
        ? {
            hint:
              `The database has not applied ${pending.length} migration(s) this build needs. ` +
              'Run: npx prisma migrate deploy (from apps/api). Writes touching new columns will fail until then.',
          }
        : {}),
    };
  }

  /**
   * What the API sees when this browser calls it.
   *
   * A blocked cross-origin request is invisible from both ends: the browser
   * reports "Failed to fetch" with no detail, and the server log shows nothing
   * at all if the preflight never matched a route. This endpoint answers the
   * three questions that actually resolve it — which origin arrived, whether the
   * running configuration admits it, and whether the environment the API needs
   * is present — in one response the dashboard can render as plain sentences.
   *
   * Readable from any origin on purpose. A diagnostic subject to the very
   * misconfiguration it diagnoses reports nothing in exactly the case it is
   * needed — the browser discards the response before the page can read the
   * verdict. Nothing here is confidential: booleans for environment variables,
   * never their values, and an allow-list that is visible in the response
   * headers of every other route anyway. It stays unauthenticated by
   * necessity, since it has to work before sign-in.
   */
  @Get('connectivity')
  async connectivity(
    @Res({ passthrough: true }) res: Response,
    @Headers('origin') origin?: string,
  ) {
    if (!res.getHeader('Access-Control-Allow-Origin')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    const allowed = allowedOrigins();
    return {
      // Absent when the URL is opened directly in a tab rather than fetched.
      origin: origin ?? null,
      originAllowed: origin ? isOriginAllowed(origin, allowed) : null,
      allowedOrigins: allowed,
      webOriginConfigured: configuredOrigins().length > 0,
      env: {
        DATABASE_URL: Boolean(process.env.DATABASE_URL),
        JWT_SECRET: Boolean(process.env.JWT_SECRET),
        PAYMAXIS_SHOPS: Boolean(process.env.PAYMAXIS_SHOPS),
      },
      // Migration names only — no schema contents, nothing confidential, and
      // the one fact that explains a whole class of 500s.
      pendingMigrations: await pendingMigrations(this.prisma),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Reachable only if a preflight succeeded, which a plain GET never proves —
   * a POST carrying a JSON content type is what the sign-in request actually
   * sends, and it is the step that fails when OPTIONS is misrouted.
   */
  @Post('connectivity')
  connectivityPreflight(@Headers('origin') origin?: string) {
    return { preflight: 'ok', origin: origin ?? null };
  }
}
