import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../generated/prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    // One connection per instance on serverless.
    //
    // The default pool holds up to 10 connections. That is right for a single
    // long-running process and wrong for a platform that runs many concurrent
    // instances of the same function: 20 instances would ask for 200
    // connections and exhaust a Postgres server that allows ~100, at which
    // point every request fails with "too many clients". An instance handles
    // one request at a time, so one connection each is all it can use anyway.
    //
    // This does not remove the need for a pooled DATABASE_URL (PgBouncer, Neon's
    // pooler, Supabase's transaction pooler) — it just stops each instance from
    // multiplying the problem.
    const serverless = !!process.env.VERCEL;
    super({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL,
        ...(serverless ? { max: 1 } : {}),
      }),
    });
  }

  async onModuleInit() {
    // Don't crash the app if the database is unreachable — endpoints fall back
    // to representative data, and /api/health reports the DB as down.
    try {
      await this.$connect();
    } catch (error) {
      this.logger.warn(
        `Database unavailable at startup; serving fallback data. ${
          error instanceof Error ? error.message : ''
        }`,
      );
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
