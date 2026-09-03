import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';

import { AdminUnlockGuard } from '../auth/guards/admin-unlock.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { assertCronSecret } from '../common/cron-secret';
import { PspsService } from './psps.service';
import { PspSyncService } from './psp-sync.service';
import { PspBalanceService } from './psp-balance.service';
import type { EndpointConfig } from './psp-connector';

/**
 * Provider connections.
 *
 * THE LINE IS CONFIGURATION, not data. The admin lock guards the things that
 * change how a connection works or reveal how it is wired — the base URL, the
 * key hint, the field mapping, adding and removing a provider. Those are
 * administration, done once, by one person.
 *
 * Everything that moves DATA needs only a session, syncing included. The
 * operations team works these screens every shift, and a passphrase several
 * people need every shift is a passphrase that gets shared — which would be
 * worse than what it protects, since the same passphrase also changes roles
 * and reveals the audit trail.
 *
 * That is safe because of what a sync structurally cannot do: every outbound
 * call is a GET, the method is not configurable, and the credential is
 * decrypted inside this process and never leaves it. An agent pressing Sync
 * refreshes a table. There is no configuration in which it does anything else.
 */
@ApiTags('psps')
@ApiBearerAuth()
@Controller('psps')
export class PspsController {
  constructor(
    private readonly psps: PspsService,
    private readonly sync: PspSyncService,
    private readonly balanceService: PspBalanceService,
  ) {}

  /**
   * Every provider, for the desk. A SESSION is enough.
   *
   * The operations team reads these every shift, and gating them on the admin
   * passphrase would mean the admin passphrase gets shared — which is worse
   * than what it would be protecting, because that same passphrase also
   * changes roles, reveals the audit trail and stores payment credentials.
   *
   * READING is what a session buys. Everything that spends a credential or
   * changes a connection still needs the unlock.
   *
   * Declared before the :id routes: Nest matches in order, and "directory"
   * would otherwise be read as a connection id.
   */
  @UseGuards(JwtAuthGuard)
  @Get('directory')
  directory() {
    return this.sync.directory();
  }

  /** The balances themselves — what the desk reads. Session only. */
  @UseGuards(JwtAuthGuard)
  @Get('balances')
  balances() {
    return this.psps.balances();
  }

  /**
   * The estimated balance for every connection: anchor plus movement.
   *
   * Before the :id routes for the same reason `directory` is.
   */
  @UseGuards(JwtAuthGuard)
  @Get('balance-estimates')
  balanceEstimates() {
    return this.balanceService.balances();
  }

  // ── everything below is behind the admin lock ─────────────────────────

  @UseGuards(JwtAuthGuard, AdminUnlockGuard)
  @Get()
  list() {
    return this.psps.list();
  }

  /** Whether credentials can be stored at all — CREDENTIALS_KEY. */
  @UseGuards(JwtAuthGuard, AdminUnlockGuard)
  @Get('key-status')
  keyStatus() {
    return this.psps.keyStatus();
  }

  @UseGuards(JwtAuthGuard, AdminUnlockGuard)
  @Post()
  create(
    @Body() body: { terminal?: string; provider?: string; label?: string },
  ) {
    return this.psps.create(body ?? {});
  }

  @UseGuards(JwtAuthGuard, AdminUnlockGuard)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body()
    body: {
      label?: string;
      provider?: string;
      baseUrl?: string;
      authMode?: string;
      authName?: string;
      ledgerSource?: string;
      apiKey?: string;
      apiSecret?: string;
      endpoints?: Record<string, EndpointConfig>;
      movementRules?: unknown;
      enabled?: boolean;
    },
  ) {
    return this.psps.update(id, body ?? {});
  }

  @UseGuards(JwtAuthGuard, AdminUnlockGuard)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.psps.remove(id);
  }

  /**
   * Calls the provider now.
   *
   * A POST because it makes an outbound request with a live credential — that
   * is not a safe, cacheable read however much it looks like one from here.
   */
  @UseGuards(JwtAuthGuard, AdminUnlockGuard)
  @Post(':id/test')
  test(@Param('id') id: string, @Query('capability') capability?: string) {
    return this.psps.test(id, capability || 'balance');
  }

  /**
   * Asks the provider where its token endpoint is.
   *
   * A POST because it makes an outbound call, like the test beside it — though
   * unlike the test it spends no credential at all. Behind the admin lock
   * anyway: it is part of configuring a connection, and it names hosts.
   */
  @UseGuards(JwtAuthGuard, AdminUnlockGuard)
  @Post(':id/discover-token')
  discoverToken(@Param('id') id: string) {
    return this.psps.discoverToken(id);
  }

  /**
   * The provider's own transaction list, read live.
   *
   * A POST for the same reason the test is: it spends a real credential on an
   * outbound call, which is not the safe cacheable read it resembles. Behind
   * the admin lock with everything else that touches a credential.
   */
  @UseGuards(JwtAuthGuard, AdminUnlockGuard)
  @Post(':id/transactions')
  transactions(@Param('id') id: string, @Query('limit') limit?: string) {
    const n = Number(limit);
    return this.psps.transactions(
      id,
      Number.isInteger(n) && n > 0 ? Math.min(n, 200) : 50,
    );
  }

  /**
   * Reads the provider's ledger into our own table, page by page.
   *
   * A SESSION is enough: this is fetching data, which is the desk's job, and
   * it is a GET-only read whose credential never leaves the server.
   *
   * Incremental by default: providers return newest first, so a page with
   * nothing new means everything older is already stored, and a routine
   * refresh costs one call rather than fifty. `full=1` reads to the end, which
   * is what a first run and a repair need — bounded by the page cap and time
   * budget in the service, so no one press can run away at a provider.
   */
  @UseGuards(JwtAuthGuard)
  @Post(':id/sync')
  syncOne(@Param('id') id: string, @Query('full') full?: string) {
    return this.sync.sync(id, { full: full === '1' || full === 'true' });
  }

  /**
   * A ledger from a file exported out of the provider's portal.
   *
   * A session, like the sync: it is fetching data, and it spends no
   * credential at all — the person doing it already had the file.
   */
  @UseGuards(JwtAuthGuard)
  @Post(':id/import')
  importRows(
    @Param('id') id: string,
    @Body() body: { rows?: Record<string, unknown>[] },
  ) {
    return this.sync.importRows(id, body?.rows ?? []);
  }

  /** The stored transactions. Session only — see `directory`. */
  @UseGuards(JwtAuthGuard)
  @Get(':id/ledger')
  ledger(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('status') status?: string,
    @Query('direction') direction?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
  ) {
    return this.sync.list(id, {
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
      status,
      direction,
      from,
      to,
      search,
    });
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/ledger-summary')
  ledgerSummary(@Param('id') id: string) {
    return this.sync.summary(id);
  }

  /** One connection's estimated balance, with the anchor it is built on. */
  @UseGuards(JwtAuthGuard)
  @Get(':id/balance')
  balance(@Param('id') id: string) {
    return this.balanceService.balance(id);
  }

  /**
   * Records what the provider's portal actually says.
   *
   * A SESSION, deliberately. Typing in what the portal shows is the same act as
   * reading a ledger — the desk does it whenever somebody has the portal open,
   * and putting it behind the admin passphrase would mean either the passphrase
   * gets shared or the balance never gets corrected. The second is worse: an
   * estimate nobody re-anchors is an estimate that drifts for ever.
   *
   * It cannot destroy anything. Anchors accumulate; a wrong one is superseded
   * by the next, and every one of them stays in the history with who entered
   * it.
   */
  @UseGuards(JwtAuthGuard)
  @Post(':id/anchor')
  setAnchor(
    @Param('id') id: string,
    @Body()
    body: {
      amount?: number;
      currency?: string;
      takenAt?: string;
      note?: string;
    },
    @Req() req: { user?: { email?: string } },
  ) {
    return this.balanceService.setAnchor(id, body ?? {}, req?.user?.email);
  }

  /** Every balance entered, with the drift each one revealed. Session. */
  @UseGuards(JwtAuthGuard)
  /**
   * Re-anchors to the provider's own last reading.
   *
   * A session, not the admin lock: it spends no credential and types no figure
   * — it takes one the provider already gave us. Reading a balance off a portal
   * and typing it in is desk work, and so is this.
   */
  @UseGuards(JwtAuthGuard)
  @Post(':id/anchor-from-provider')
  anchorFromProvider(
    @Param('id') id: string,
    @Req() req: { user?: { email?: string } },
  ) {
    return this.balanceService.anchorFromProvider(id, req.user?.email);
  }

  @Get(':id/anchors')
  anchors(@Param('id') id: string) {
    return this.balanceService.history(id);
  }

  /**
   * The direction and status words this terminal actually uses.
   *
   * Behind the admin lock because it exists to fill in the movement rules,
   * which are configuration. Unlike `fields` it carries no example values, only
   * the provider's vocabulary and how often each word appears.
   */
  @UseGuards(JwtAuthGuard, AdminUnlockGuard)
  @Get(':id/vocabulary')
  vocabulary(@Param('id') id: string) {
    return this.balanceService.vocabulary(id);
  }

  /**
   * The fields this provider actually sends, with how often each is filled.
   *
   * Behind the admin lock because it is configuration work and it shows
   * example VALUES — a payer's email is in there, and that is not something to
   * put in front of every signed-in agent.
   */
  @UseGuards(JwtAuthGuard, AdminUnlockGuard)
  @Get(':id/fields')
  fields(@Param('id') id: string) {
    return this.sync.fields(id);
  }

  /** Re-reads every enabled connection's balance. Data, so a session. */
  @UseGuards(JwtAuthGuard)
  @Post('refresh')
  refresh() {
    return this.psps.refreshAll();
  }

  /**
   * Reads every provider's new transactions. For a scheduler.
   *
   * Why it exists: without it, a payment sits at ForumPay until somebody opens
   * the dashboard and presses Sync, which makes the ledger — and the balance
   * computed from it — as current as the last person to think of it rather
   * than as current as the provider.
   *
   * A GET because Vercel Cron issues GETs and cannot send a body, and outside
   * the JWT guard because a scheduler carries no session. That makes
   * CRON_SECRET the whole of its protection, so it refuses to run at all when
   * the secret is unset rather than defaulting to open.
   *
   * Incremental only — there is no way to ask this one for a full re-read. A
   * scheduled full sync would page an entire ledger every run and would
   * eventually get us rate-limited by a payment provider.
   */
  @Get('sync-all')
  @ApiExcludeEndpoint()
  cronSyncAll(@Headers('authorization') auth?: string) {
    assertCronSecret(auth);
    return this.sync.syncAll();
  }
}
