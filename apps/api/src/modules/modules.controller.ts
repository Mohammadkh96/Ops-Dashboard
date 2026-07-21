import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ModulesService } from './modules.service';

@ApiTags('modules')
@Controller()
export class ModulesController {
  constructor(private readonly modules: ModulesService) {}

  @Get('transactions')
  transactions() {
    return this.modules.transactions();
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
}
