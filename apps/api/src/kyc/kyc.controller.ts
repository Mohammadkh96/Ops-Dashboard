import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { assertCronSecret } from '../common/cron-secret';
import { KycService } from './kyc.service';

/**
 * Verifications, and who has none.
 *
 * A plain session throughout. Reading who is verified is desk work — the same
 * act as reading a payment ledger — and every call this makes to the provider
 * is a GET.
 *
 * THERE IS NO FILE IMPORT. There was, built on the finding that KYCAID would
 * not enumerate; that was wrong, the provider reads back directly, and a second
 * way in that nobody should use is a second way to be wrong about where the
 * numbers came from.
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
  /**
   * The headline figures, over the period and entity the screen is showing.
   *
   * All three are optional and unset means everything held — but the screen
   * always sends them. The cards used to be totals over all of history sitting
   * above a table that answered to a date range, so the two disagreed by a year
   * and nothing on the page said which was which.
   */
  @Get('summary')
  summary(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('account') account?: string,
  ) {
    return this.kyc.summary({ from, to, account });
  }

  /**
   * Everything KYCAID holds about one verification's applicant, read live.
   *
   * NOT STORED. The table holds the outcome, the jurisdiction and the account
   * reference; the person — name, date of birth, address, document — is
   * fetched when somebody opens the row and kept nowhere. A dashboard that
   * mirrored all of it would be a second copy of every client's identity
   * documents, held to a lower standard than the system that is meant to hold
   * them.
   *
   * Behind the session guard, like the client profile it sits beside, and for
   * the same reason: this answers with a named person.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('cases/:id/applicant')
  applicant(@Param('id') id: string) {
    return this.kyc.applicantDetail(id).catch((e: unknown) => {
      if (e instanceof HttpException) throw e;
      const why = e instanceof Error ? e.message : String(e);
      throw new BadRequestException(
        `The provider could not be asked about this applicant: ${why.slice(0, 400)}`,
      );
    });
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
   * The same read, on a schedule, so nobody has to press anything.
   *
   * Outside the session guard because Vercel Cron issues a plain GET and cannot
   * carry one — which makes CRON_SECRET the whole of its protection, exactly as
   * on the payment sync. Read-only either way: every call it makes is a GET.
   */
  @Get('sync/run')
  @ApiExcludeEndpoint()
  async cronSync(@Headers('authorization') auth?: string) {
    assertCronSecret(auth);
    return {
      ranAt: new Date().toISOString(),
      result: await this.kyc.syncRecent(),
    };
  }
}
