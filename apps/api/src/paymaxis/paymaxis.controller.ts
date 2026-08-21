import { timingSafeEqual } from 'node:crypto';

import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PaymaxisService } from './paymaxis.service';

/** Constant-time compare so a wrong secret cannot be discovered byte by byte. */
function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

@ApiTags('paymaxis')
@Controller('paymaxis')
export class PaymaxisController {
  constructor(private readonly paymaxis: PaymaxisService) {}

  /**
   * Config and watermark state. Never exposes API keys.
   *
   * Behind the guard: it reports shop ids, every terminal in use and the number
   * of payments each has taken, which is commercial information even though it
   * is not a credential. It was reachable unauthenticated, which was an
   * oversight rather than a decision — nothing needs it before sign-in.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('status')
  status() {
    return this.paymaxis.status();
  }

  /** How fresh the data is, without triggering a pull. */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('freshness')
  freshness() {
    return this.paymaxis.freshness();
  }

  /**
   * Pulls anything new, if a pull is due, and reports freshness either way.
   *
   * Called by the dashboard itself while a tab is open — the only scheduler that
   * exists on a serverless host between the once-a-day cron runs. Behind the JWT
   * guard because it spends outbound calls against the live Paymaxis keys, and
   * rate limited in the service so an open tab per desk does not become a
   * request per desk.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('refresh')
  refresh(@Body() body?: { force?: boolean }) {
    // `force` marks the request as one a person made by pressing Refresh, which
    // gets a shorter floor than the automatic minute-by-minute poll.
    return this.paymaxis.refresh({ force: body?.force === true });
  }

  /** Where the historical import has reached, without moving it. */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('backfill')
  backfillStatus() {
    return this.paymaxis.backfillStatus();
  }

  /**
   * Walks the payment list one bounded slice further back.
   *
   * The poll only ever reaches forward, so this is the only way payments older
   * than the day polling started arrive at all. One call does one step and
   * returns; the caller loops. That is deliberate — the walk has to survive a
   * host that kills a request at 60 seconds, and a step that returns is a step
   * whose progress is safely on disk.
   *
   * Guarded: it spends outbound calls against the live keys, and `reset` throws
   * away a cursor that may represent hours of walking.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('backfill')
  backfill(@Body() body?: { shop?: string; budgetMs?: number; reset?: boolean }) {
    const shops = this.paymaxis.shops;
    if (!shops.length) return { error: 'PAYMAXIS_SHOPS is not configured' };
    return this.paymaxis.backfillStep({
      shopId: body?.shop,
      budgetMs: body?.budgetMs,
      reset: body?.reset === true,
    });
  }

  /**
   * The same step, reachable by GET for a scheduler — the walk continues by
   * itself between visits to the dashboard. Same CRON_SECRET guard as the sync:
   * without it this would be an unauthenticated endpoint making outbound calls
   * with the live keys.
   */
  @Get('backfill/run')
  @ApiExcludeEndpoint()
  async cronBackfill(@Headers('authorization') auth?: string) {
    const expected = process.env.CRON_SECRET;
    if (!expected)
      throw new UnauthorizedException('CRON_SECRET is not configured');
    const presented = (auth ?? '').replace(/^Bearer\s+/i, '');
    if (!presented || !secretMatches(presented, expected)) {
      throw new UnauthorizedException('invalid cron secret');
    }
    return {
      ranAt: new Date().toISOString(),
      results: await this.paymaxis.backfillStep(),
    };
  }

  /**
   * Runs one read-only sync now and reports what happened. Lets the connection
   * be proved from a terminal before anything is scheduled or deployed.
   */
  @Post('sync')
  sync(@Body() body: { since?: string }) {
    const shops = this.paymaxis.shops;
    if (!shops.length) return { error: 'PAYMAXIS_SHOPS is not configured' };
    return Promise.all(
      shops.map((s) => this.paymaxis.syncShop(s, body?.since)),
    );
  }

  /**
   * Same sync, reachable by GET so a scheduler can call it — Vercel Cron issues
   * GET requests and cannot send a body.
   *
   * Guarded by CRON_SECRET, which Vercel presents as `Authorization: Bearer …`.
   * Without the guard this would be an unauthenticated endpoint that makes
   * outbound calls with the live Paymaxis keys, so it refuses to run at all when
   * the secret is unset rather than defaulting to open.
   */
  @Get('sync')
  @ApiExcludeEndpoint()
  async cronSync(@Headers('authorization') auth?: string) {
    const expected = process.env.CRON_SECRET;
    if (!expected)
      throw new UnauthorizedException('CRON_SECRET is not configured');
    const presented = (auth ?? '').replace(/^Bearer\s+/i, '');
    if (!presented || !secretMatches(presented, expected)) {
      throw new UnauthorizedException('invalid cron secret');
    }
    const shops = this.paymaxis.shops;
    if (!shops.length)
      return { skipped: true, reason: 'PAYMAXIS_SHOPS is not configured' };
    return {
      ranAt: new Date().toISOString(),
      results: await this.paymaxis.syncAll(),
    };
  }
}
