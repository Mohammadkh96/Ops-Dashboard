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

/**
 * Express request augmented with the raw body.
 *
 * `rawBody` is populated by Nest (enabled in bootstrap.ts). `platformRawBody` is
 * the serverless fallback: Vercel's runtime may drain the stream before Nest's
 * parser sees it, in which case the entry point stashes the bytes there.
 */
type RawRequest = Request & { rawBody?: Buffer; platformRawBody?: Buffer };

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
    // Prefer whatever actually holds bytes: on a long-running host that is
    // rawBody, on Vercel it can be the platform fallback.
    const raw = req.rawBody?.length ? req.rawBody : req.platformRawBody;
    const out = await this.webhooks.handlePaymaxis(raw, headers, body ?? {});
    // A bad signature must be refused, otherwise anyone who finds the URL can
    // inject payment events into the dashboard.
    if (!out.accepted)
      throw new UnauthorizedException(out.reason ?? 'invalid signature');
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
