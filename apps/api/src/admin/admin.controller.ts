import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { AdminUnlockGuard } from '../auth/guards/admin-unlock.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminUsersService, ROLES } from './admin-users.service';
import { IntegrationsService } from './integrations.service';
import { StorageService } from './storage.service';

type Req = { user?: { userId: string; email: string } };

/**
 * Administering accounts.
 *
 * Every route needs BOTH guards: a session, and the Admin tab unlocked. The
 * lock is not decoration on the front end — this is where it is enforced, and a
 * request that arrives without the unlock header is refused whatever the
 * browser was showing when it was sent.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminUnlockGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly users: AdminUsersService,
    private readonly integrations: IntegrationsService,
    private readonly storage: StorageService,
  ) {}

  /**
   * What the database is spending its space on.
   *
   * WRITTEN BECAUSE IT RAN OUT. A hosted plan has a hard ceiling and reaching
   * it degrades nothing gracefully: every write fails with `53100 could not
   * extend file`, the syncs read and store zero, and the screens keep showing
   * yesterday's data as though nothing were wrong. That failure looked for
   * hours like a provider problem and a missing client, because nothing said
   * the disk was full.
   */
  @Get('storage')
  storageReport() {
    return this.storage.report();
  }

  /**
   * Drop the stored provider JSON for rows older than a cutoff.
   *
   * DRY RUN UNLESS `apply` IS TRUE. This is irreversible without re-fetching
   * from the providers, and the difference between "show me" and "do it" must
   * not be one character in a query string.
   *
   * Every mapped column survives — amounts, states, references, verdicts,
   * prices, dates. What goes is the unparsed original, which matters only for
   * a field nobody has mapped yet.
   *
   * `mode` decides how much of it goes, and defaults to the smaller loss:
   * `slim` keeps the payload keys the screens read — so the detail drawer
   * still shows the method, the description, the billing address and the
   * customer — and drops the rest of what the provider sent. `null` empties
   * the payload outright and takes the verification JSON with it; that is the
   * one for a database that is full today.
   */
  @Post('storage/prune')
  prune(
    @Body()
    body: {
      olderThanDays?: number;
      apply?: boolean;
      mode?: 'slim' | 'null';
    },
  ) {
    return this.storage.prune({
      olderThanDays: body?.olderThanDays ?? 90,
      apply: body?.apply === true,
      mode: body?.mode === 'null' ? 'null' : 'slim',
    });
  }

  /**
   * What this dashboard is actually connected to.
   *
   * Behind the lock with everything else here, even though it carries no
   * secrets: it names which provider accounts this deployment talks to and how
   * fresh the data is, which is not a thing to hand to anybody who can reach
   * the URL.
   */
  @Get('integrations')
  integrationList() {
    return this.integrations.list();
  }

  /** The roles that exist, so the form is never out of step with the enum. */
  @Get('roles')
  roles() {
    return ROLES;
  }

  @Get('accounts')
  list() {
    return this.users.list();
  }

  @Post('accounts')
  create(
    @Req() req: Req,
    @Body()
    body: {
      email?: string;
      firstName?: string;
      lastName?: string;
      role?: string;
      password?: string;
    },
  ) {
    return this.users.create(req.user?.userId ?? '', body ?? {});
  }

  @Patch('accounts/:id')
  update(
    @Req() req: Req,
    @Param('id') id: string,
    @Body()
    body: {
      role?: string;
      isActive?: boolean;
      firstName?: string;
      lastName?: string;
    },
  ) {
    return this.users.update(req.user?.userId ?? '', id, body ?? {});
  }

  @Post('accounts/:id/password')
  setPassword(
    @Req() req: Req,
    @Param('id') id: string,
    @Body() body: { password?: string },
  ) {
    return this.users.setPassword(
      req.user?.userId ?? '',
      id,
      body?.password ?? '',
    );
  }

  @Post('accounts/:id/password/clear')
  clearPassword(@Req() req: Req, @Param('id') id: string) {
    return this.users.clearPassword(req.user?.userId ?? '', id);
  }
}
