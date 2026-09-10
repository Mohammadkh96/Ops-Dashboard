import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { KycService, type VerificationRow } from './kyc.service';

/**
 * Verifications, and who has none.
 *
 * A plain session throughout. Reading who is verified is desk work — the same
 * act as reading a payment ledger — and the import spends no credential at all:
 * the person doing it already has the file.
 */
@ApiTags('kyc')
@Controller('kyc')
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('cases')
  cases(@Query('limit') limit?: string) {
    return this.kyc.cases(limit ? Number(limit) : undefined);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('summary')
  summary() {
    return this.kyc.summary();
  }

  /**
   * Which trading clients have no verification on record.
   *
   * The join this integration was built for, and the one question no screen
   * here could answer before: every payment carries a `CU…` reference, so the
   * people who move money can finally be compared against the people who have
   * been checked.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('coverage')
  coverage() {
    return this.kyc.coverage();
  }

  /**
   * Whether the provider can be read directly, and from when.
   *
   * Asked rather than assumed, so the screen shows a button that works or a
   * sentence naming the variable to set — never a button that leads to a 400.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('provider')
  provider() {
    return this.kyc.providerStatus();
  }

  /**
   * Reads the provider itself, a slice of days at a time.
   *
   * A session, not the admin lock — the same line the payment screens draw.
   * This moves data and moves nothing else: every call it makes is a GET, the
   * method is not configurable, and the token is an environment variable rather
   * than anything typed into the request.
   *
   * The reply carries `nextDate` when the budget ran out mid-range. The caller
   * asks again with it; nothing is lost in between, because every day that was
   * read is already written.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('sync')
  sync(@Body() body: { from?: string; to?: string; budgetMs?: number }) {
    return this.kyc
      .syncFromProvider({
        from: body?.from,
        to: body?.to,
        budgetMs: body?.budgetMs ? Number(body.budgetMs) : undefined,
      })
      .catch((e: unknown) => {
        if (e instanceof HttpException) throw e;
        const why = e instanceof Error ? e.message : String(e);
        throw new BadRequestException(
          `The provider read failed: ${why.slice(0, 600)}`,
        );
      });
  }

  /**
   * A provider export, already reduced to the columns that matter.
   *
   * The browser parses the file and sends these rows; names, dates of birth,
   * passport numbers and addresses are dropped before the request is made. A
   * KYC export should not travel further than the job needs, and the job needs
   * an id, a reference and a verdict.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('import')
  importRows(
    @Body()
    body: {
      rows?: VerificationRow[];
      provider?: string;
      mapping?: Record<string, string>;
    },
  ) {
    // Dates arrive as strings over JSON and are needed as instants.
    const rows = (body?.rows ?? []).map((r) => ({
      ...r,
      at: r.at ? new Date(r.at) : null,
      declineReasons: Array.isArray(r.declineReasons) ? r.declineReasons : [],
    }));
    return this.kyc
      .importVerifications(rows, {
        provider: body?.provider,
        mapping: body?.mapping,
      })
      .catch((e: unknown) => {
        // A bare "Internal server error" is what this returned twice, and it
        // cost two rounds of guessing. Anything the import throws that is not
        // already a considered refusal is re-raised WITH its message, because
        // the alternative is a screen that says nothing and a log nobody can
        // reach from the dashboard.
        //
        // Nothing secret travels this way: the failures here are about the
        // shape of the caller's own file — a value too long for a column, a
        // number where a date belongs, a batch too large for the database to
        // take in one go.
        if (e instanceof HttpException) throw e;
        const why = e instanceof Error ? e.message : String(e);
        const code =
          e && typeof e === 'object' && 'code' in e ? String(e.code) : null;
        throw new BadRequestException(
          `The import failed on this batch of ${rows.length.toLocaleString()}${code ? ` (${code})` : ''}: ${why.slice(0, 600)}`,
        );
      });
  }
}
