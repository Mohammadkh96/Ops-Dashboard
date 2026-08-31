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
  constructor(private readonly psps: PspsService) {}

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

  @UseGuards(JwtAuthGuard, AdminUnlockGuard)
  @Post('refresh')
  refresh() {
    return this.psps.refreshAll();
  }
}
