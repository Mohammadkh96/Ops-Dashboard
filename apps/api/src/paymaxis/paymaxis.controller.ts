import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { assertCronSecret } from '../common/cron-secret';
import { ModulesService } from '../modules/modules.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymaxisService } from './paymaxis.service';

@ApiTags('paymaxis')
@Controller('paymaxis')
export class PaymaxisController {
  constructor(
    private readonly paymaxis: PaymaxisService,
    private readonly modules: ModulesService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * The unattended notification pass, and why it hangs off THIS cron.
   *
   * An alerting schedule of its own would be a fourth cron entry on a plan
   * that refuses extras when the deployment is created — silently, with no
   * failed build to notice, which has already cost this project three days. So
   * it rides along with a job that already runs.
   *
   * This one rather than the KYC cron for two reasons. Structurally,
   * `ModulesService` owns the detections and already depends on the KYC module
   * for half of them, so asking for them from there closes a circle Nest
   * refuses to build. Practically, this cron is scheduled AFTER the KYC sync —
   * so the pass reads a freshly synced day rather than raising a stall that
   * the sync an hour earlier had already cleared.
   *
   * Never throws: the sync's useful work is done by the time this runs, and a
   * mailer outage must not turn a successful sync into a failed invocation
   * that the platform then retries.
   */
  private async notifyQuietly() {
    try {
      const [detections, recipients] = await Promise.all([
        this.modules.incidentDetections(),
        this.modules.notifyRecipients(),
      ]);
      return await this.notifications.record(detections, recipients);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

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
  backfill(
    @Body() body?: { shop?: string; budgetMs?: number; reset?: boolean },
  ) {
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
    assertCronSecret(auth);
    return {
      ranAt: new Date().toISOString(),
      results: await this.paymaxis.backfillStep(),
    };
  }

  /**
   * Asks the provider whether older payments can be fetched at all, and how.
   *
   * Guarded: it spends outbound calls against the live keys. Read-only — every
   * request it makes is a GET, and the report contains counts, dates and
   * parameter names, never a payment's contents.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('probe-history')
  probeHistory(@Body() body?: { shop?: string; customer?: string }) {
    const shops = this.paymaxis.shops;
    if (!shops.length) return { error: 'PAYMAXIS_SHOPS is not configured' };
    return this.paymaxis.probeHistory(body?.shop, body?.customer);
  }

  /**
   * Tries one specific call against Paymaxis with our key — for checking
   * whatever call the provider's own console turns out to make.
   *
   * Guarded, and read-only: the underlying client can express no verb but GET.
   * Only counts, dates and FIELD NAMES come back, never a payment's values.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('try-call')
  tryCall(
    @Body()
    body: {
      path?: string;
      params?: Record<string, string>;
      shop?: string;
    },
  ) {
    return this.paymaxis.tryCall(
      body?.path ?? '',
      body?.params ?? {},
      body?.shop,
    );
  }

  /**
   * Loads payments from a file exported out of the Paymaxis console.
   *
   * The only route to history older than the provider's rolling 24-hour list.
   * The browser parses the file and posts rows in batches, so nothing is
   * uploaded that this API has not been asked for row by row, and a batch that
   * returns is a batch that is stored.
   *
   * Guarded: it writes payments. Safe to repeat — rows are keyed exactly as
   * polled payments are, so an overlapping export stores nothing twice.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('import')
  import(@Body() body: { rows?: Record<string, unknown>[] }) {
    const rows = body?.rows;
    if (!Array.isArray(rows)) {
      throw new BadRequestException(
        'Send { rows: [...] } — an array of exported rows.',
      );
    }
    return this.paymaxis.importExportRows(rows);
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
    assertCronSecret(auth);
    const shops = this.paymaxis.shops;
    if (!shops.length)
      return { skipped: true, reason: 'PAYMAXIS_SHOPS is not configured' };
    const results = await this.paymaxis.syncAll();
    return {
      ranAt: new Date().toISOString(),
      results,
      notified: await this.notifyQuietly(),
    };
  }
}
