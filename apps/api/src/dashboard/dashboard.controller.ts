import { Controller, Get, MessageEvent, Query, Sse } from '@nestjs/common';

import { parseRange } from '../common/range';
import { ApiTags } from '@nestjs/swagger';
import { Observable } from 'rxjs';

import { DashboardService } from './dashboard.service';

@ApiTags('dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  /**
   * `range=1h|24h|7d|30d|90d`, or explicit `from`/`to` ISO timestamps.
   * Everything in the response — tiles, sparklines, PSP and entity breakdowns,
   * decline reasons — reflects that window.
   */
  @Get('summary')
  getSummary(
    @Query('range') range?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.dashboardService.getSummary(parseRange({ range, from, to }));
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
