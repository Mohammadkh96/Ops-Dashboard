import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { WebhooksService } from './webhooks.service';

/** Express request augmented with the raw body (enabled via rawBody in main.ts). */
type RawRequest = Request & { rawBody?: Buffer };

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  /**
   * Paymaxis payment callback.
   *
   * Deliberately untyped: a provider callback is external input whose exact
   * shape is theirs to change, so it is stored raw and mapped defensively
   * rather than validated against a DTO that would reject unknown fields.
   */
  @Post('paymaxis')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async paymaxis(
    @Req() req: RawRequest,
    @Headers() headers: Record<string, string>,
    @Body() body: Record<string, unknown>,
  ) {
    const out = await this.webhooks.handlePaymaxis(req.rawBody, headers, body ?? {});
    // A bad signature must be refused, otherwise anyone who finds the URL can
    // inject payment events into the dashboard.
    if (!out.accepted) throw new UnauthorizedException(out.reason ?? 'invalid signature');
    // 200 with a small ack: providers retry on anything else, and a retry storm
    // is worse than a dropped duplicate.
    return { ok: true, id: out.id, verified: out.signatureOk };
  }

  /** Recent callbacks — used to confirm delivery and to inspect real payloads. */
  @Get('events')
  events(@Query('limit') limit?: string) {
    return this.webhooks.recent(limit ? Number(limit) : 50);
  }
}
