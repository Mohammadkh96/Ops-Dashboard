import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { AdminUnlockGuard } from '../auth/guards/admin-unlock.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PspsService } from './psps.service';
import { PspSyncService } from './psp-sync.service';
import type { EndpointConfig } from './psp-connector';

/**
 * Provider connections.
 *
 * Everything that touches a credential is behind BOTH guards — a session and
 * the Admin tab unlocked. These are live payment-provider keys; being signed in
 * on a machine somebody walked away from must not be enough to add one, change
 * one, or make the server call a provider with one.
 *
 * The two READ routes are separate and only need a session: the desk needs to
 * see balances at the start of a shift, and making an agent hold the admin
 * passphrase to read a number would mean the admin passphrase gets shared.
 */
@ApiTags('psps')
@ApiBearerAuth()
@Controller('psps')
export class PspsController {
  constructor(
    private readonly psps: PspsService,
    private readonly sync: PspSyncService,
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
      apiKey?: string;
      apiSecret?: string;
      endpoints?: Record<string, EndpointConfig>;
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
   * Incremental by default: providers return newest first, so a page with
   * nothing new means everything older is already stored, and a routine
   * refresh costs one call rather than fifty. `full=1` reads to the end, which
   * is what a first run and a repair need.
   */
  @UseGuards(JwtAuthGuard, AdminUnlockGuard)
  @Post(':id/sync')
  syncOne(@Param('id') id: string, @Query('full') full?: string) {
    return this.sync.sync(id, { full: full === '1' || full === 'true' });
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

  @UseGuards(JwtAuthGuard, AdminUnlockGuard)
  @Post('refresh')
  refresh() {
    return this.psps.refreshAll();
  }
}
