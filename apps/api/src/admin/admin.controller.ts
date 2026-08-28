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
  ) {}

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
