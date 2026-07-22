import { Controller, Get, MessageEvent, Sse } from '@nestjs/common';
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

  @Sse('stream')
  stream(): Observable<MessageEvent> {
    return this.dashboardService.liveStream();
  }
}
