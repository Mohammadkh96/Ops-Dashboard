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
    super({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
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
