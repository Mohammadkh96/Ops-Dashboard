import { Controller, Get, MessageEvent, Query, Sse } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Observable } from 'rxjs';

import { DashboardService } from './dashboard.service';

@ApiTags('dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('summary')
  getSummary() {
    return this.dashboardService.getSummary();
  }

  /**
   * Push transport. Needs a process that stays alive, so it works on any
   * always-on host but not on a serverless platform, where no invocation lives
   * long enough to hold the connection open.
   */
  @Sse('stream')
  stream(): Observable<MessageEvent> {
    return this.dashboardService.liveStream();
  }

  /**
   * Pull transport — same feed, read from the database. Works everywhere,
   * including serverless. Pass the `cursor` from the previous response as
   * `since` to get only what has arrived since.
   */
  @Get('feed')
  feed(@Query('since') since?: string, @Query('limit') limit?: string) {
    return this.dashboardService.liveFeed({
      since,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
