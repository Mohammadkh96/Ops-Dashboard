import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ModulesService } from '../modules/modules.service';
import { NotificationsService } from './notifications.service';

/**
 * What the desk has been told, and the run that tells them.
 *
 * THE RUN IS A POST AND IT IS NOT ON A CRON OF ITS OWN. This account's plan
 * allows one run per schedule per day and refuses an extra cron entry when the
 * deployment is created — silently, which has already cost this project three
 * days. So the unattended pass rides along with the syncs that already run, and
 * this endpoint covers the attended case: the dashboard calls it while somebody
 * has the page open, which is when an alert is most useful anyway.
 */
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly modules: ModulesService,
  ) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get()
  list(@Query('unread') unread?: string, @Query('limit') limit?: string) {
    return this.notifications.list({
      unread: unread === '1' || unread === 'true',
      limit: limit ? Number(limit) : undefined,
    });
  }

  /**
   * Detect now, record what is new, mail what is serious.
   *
   * Safe to call often: a condition already reported inside the cool-off moves
   * a timestamp and sends nothing. That property is the whole design — an
   * alerting layer that mails on every pass is one the desk filters away within
   * a week, and then believes it is working.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('run')
  async run(@Req() req: { user?: { email?: string } }) {
    const detections = await this.modules.incidentDetections();
    const recipients = await this.modules.notifyRecipients();
    const result = await this.notifications.record(detections, recipients);
    return { ranAt: new Date().toISOString(), by: req.user?.email, ...result };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('read')
  read(
    @Body() body: { ids?: string[]; all?: boolean },
    @Req() req: { user?: { email?: string } },
  ) {
    const by = req.user?.email ?? 'unknown';
    return body?.all
      ? this.notifications.markAllRead(by)
      : this.notifications.markRead(body?.ids ?? [], by);
  }
}
