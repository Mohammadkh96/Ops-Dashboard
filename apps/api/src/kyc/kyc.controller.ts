import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
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
    return this.kyc.importVerifications(rows, {
      provider: body?.provider,
      mapping: body?.mapping,
    });
  }
}
