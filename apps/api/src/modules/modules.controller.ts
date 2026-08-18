import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ModulesService } from './modules.service';

@ApiTags('modules')
@Controller()
export class ModulesController {
  constructor(private readonly modules: ModulesService) {}

  /** Real payments. `type=deposit|withdrawal|refund` narrows the list. */
  @Get('transactions')
  transactions(@Query('type') type?: string) {
    return this.modules.transactions(type);
  }

  /** Headline figures for the payment pages, same filter. */
  @Get('payments/stats')
  paymentStats(@Query('type') type?: string) {
    return this.modules.paymentStats(type);
  }

  @Get('gateways')
  gateways() {
    return this.modules.gateways();
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
