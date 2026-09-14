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
   * What the provider actually sends, measured on the rows it sent.
   *
   * Every column here has been argued from the documentation at some point,
   * and the documentation has been wrong twice. This answers "what can we get
   * from this API" with the account's own data: which fields arrive, how often
   * they carry a value, and which of them anything stores.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('fields')
  fields(@Query('limit') limit?: string) {
    return this.kyc.providerFields(limit ? Number(limit) : undefined);
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
   * Which of this verification's checks the provider was satisfied by.
   *
   * The table holds the list of checks that ran and the reason it was declined,
   * with nothing joining the two. This asks the provider directly and gets a
   * verdict per check — so "rejected" becomes "the document was expired, and
   * the face matched", which is the difference between asking the client for
   * one document and putting them through the whole form again.
   *
   * Behind the session guard like everything else here, though there is no
   * person in the reply: ids, booleans, and the provider's note on each check.
   * That is why the screen loads it on opening a row rather than behind a
   * button, as the applicant lookup above it must be.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('cases/:id/checks')
  checks(@Param('id') id: string) {
    return this.kyc.verificationChecks(id).catch((e: unknown) => {
      if (e instanceof HttpException) throw e;
      const why = e instanceof Error ? e.message : String(e);
      throw new BadRequestException(
        `The provider could not be asked about this verification: ${why.slice(0, 400)}`,
      );
    });
  }

  /**
   * Fill in which check failed and what was presented, a batch at a time.
   *
   * TWO REQUESTS PER VERIFICATION, against forty thousand rows — so this is
   * deliberately a walk rather than a job: newest first, never-asked only, a
   * budget per call, and a `remaining` count the screen can show. Call it
   * again until `done`.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('enrich')
  enrich(
    @Body()
    body: {
      from?: string;
      to?: string;
      account?: string;
      limit?: number;
      budgetMs?: number;
    },
  ) {
    return this.kyc.enrich(body ?? {});
  }

  /**
   * Verifications by jurisdiction, with the provider's own accepted list.
   *
   * Separate from `summary` on purpose. The names come from `GET /countries`,
   * which is the one call on this screen that reaches the provider, and the
   * headline cards should not wait on a third party to render a number we hold
   * ourselves. Asked on its own, a slow provider delays one panel.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('countries')
  countries(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('account') account?: string,
  ) {
    return this.kyc.byCountry({ from, to, account });
  }

  /**
   * How much money was moved by people who were never checked.
   *
   * The join this integration exists for, asked as a figure rather than as a
   * list of clients: settled deposits grouped by the payer's KYC standing, with
   * the unverified, the rejected and the lapsed named individually. "Eleven
   * clients have no verification" is a note; "eleven clients funded €40,000
   * with no verification" is a decision somebody has to take today.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('exposure')
  exposure(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('account') account?: string,
  ) {
    return this.kyc.exposure({ from, to, account });
  }

  /**
   * Days inside the loaded range that hold no verifications at all.
   *
   * The sync walks a day at a time, and a day nobody walked is absent rather
   * than empty — indistinguishable on every screen from a day the provider had
   * nothing for. It matters most on the exposure panel, where a client verified
   * on a day that was never fetched is reported as somebody who was never
   * checked, beside the money they deposited.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('gaps')
  gaps() {
    return this.kyc.gaps();
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
    const result = await this.kyc.syncRecent();
    /**
     * And then fill in what the new rows are missing, with what is left of the
     * minute.
     *
     * A SECOND CRON WOULD BE THE OBVIOUS SHAPE and it is the wrong one here:
     * this account is on a plan that allows one run per day per schedule, and
     * an over-frequent or extra cron is refused when the deployment is created
     * — silently, with no failed build to notice. That mistake has already cost
     * this project three days. So the enrichment rides along with the sync it
     * follows, and a short budget keeps the pair inside the function's sixty
     * seconds.
     *
     * A day's verifications are a few hundred at most, so this keeps up
     * unattended. The backlog of forty thousand is walked from the screen,
     * where somebody is watching it.
     */
    const enriched = await this.kyc
      .enrich({ limit: 60, budgetMs: 15_000 })
      .catch((e: unknown) => ({
        error: e instanceof Error ? e.message : String(e),
      }));
    /**
     * NO NOTIFICATION PASS HERE, and the reason is structural rather than a
     * preference. `ModulesService` owns the detections and already depends on
     * this module for the KYC half of them, so a controller here asking it for
     * them closes a circle that Nest refuses to build at boot.
     *
     * The unattended pass runs on the PAYMENT cron instead, which is scheduled
     * after this one for exactly that reason: alerting on a KYC stall an hour
     * before the sync that would have cleared it is a false alarm by design.
     */
    return { ranAt: new Date().toISOString(), result, enriched };
  }
}
