import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { PaymaxisService } from './paymaxis.service';

@ApiTags('paymaxis')
@Controller('paymaxis')
export class PaymaxisController {
  constructor(private readonly paymaxis: PaymaxisService) {}

  /** Config and watermark state. Never exposes API keys. */
  @Get('status')
  status() {
    return this.paymaxis.status();
  }

  /**
   * Runs one read-only sync now and reports what happened. Lets the connection
   * be proved from a terminal before anything is scheduled or deployed.
   */
  @Post('sync')
  sync(@Body() body: { since?: string }) {
    const shops = this.paymaxis.shops;
    if (!shops.length) return { error: 'PAYMAXIS_SHOPS is not configured' };
    return Promise.all(shops.map((s) => this.paymaxis.syncShop(s, body?.since)));
  }
}
