import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ModulesService } from './modules.service';
import { parseRange } from '../common/range';

@ApiTags('modules')
@Controller()
export class ModulesController {
  constructor(private readonly modules: ModulesService) {}

  /**
   * Real payments. `type=deposit|withdrawal|refund` narrows the list;
   * `range=1h|24h|7d|30d|90d` or `from`/`to` narrows the window.
   */
  @Get('transactions')
  transactions(
    @Query('type') type?: string,
    @Query('range') range?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.modules.transactions(type, parseRange({ range, from, to }));
  }

  /**
   * The available columns and their grouping.
   *
   * Declared before the :id route: Nest matches in declaration order, so
   * "columns" would otherwise be read as a payment id.
   */
  @Get('transactions/columns')
  columns() {
    return this.modules.columns();
  }

  /** Everything stored about one payment, including its real state history. */
  @Get('transactions/:id')
  transaction(@Param('id') id: string) {
    return this.modules.transactionDetail(id);
  }

  /**
   * One client's whole history, by the customer reference on their payments.
   *
   * The page's date filter is deliberately NOT applied here — the client window
   * carries its own optional from/to (ISO instants), and with neither this is
   * everything we hold for them. See clientProfile.
   *
   * Behind the guard, unlike its neighbours: this is the one endpoint that
   * returns a named person's email, phone, KYC status and country alongside
   * their entire payment history, and it answers to any reference you care to
   * try. The dashboard already signs in before it can open a client, so the
   * guard costs nothing there.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('clients/:reference')
  client(
    @Param('reference') reference: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.modules.clientProfile(reference, from, to);
  }

  /** Headline figures for the payment pages, same filters. */
  @Get('payments/stats')
  paymentStats(
    @Query('type') type?: string,
    @Query('range') range?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.modules.paymentStats(type, parseRange({ range, from, to }));
  }

  @Get('gateways')
  gateways(
    @Query('range') range?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.modules.gateways(parseRange({ range, from, to }));
  }

  @Get('compliance/kyc')
  kyc() {
    return this.modules.kycCases();
  }

  @Get('incidents')
  incidents() {
    return this.modules.incidents();
  }

  @Get('operations')
  operations() {
    return this.modules.operations();
  }

  @Get('reports')
  reports() {
    return this.modules.reports();
  }

  @Get('admin/users')
  users() {
    return this.modules.users();
  }

  @Get('admin/audit-logs')
  auditLogs() {
    return this.modules.auditLog();
  }
  // (all handlers return promises where DB-backed; Nest awaits them.)
}
