import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import {
  ReconService,
  type PspConfigDto,
  type ReconCaseDto,
} from './recon.service';
import { ReplacePspsDto, SaveCasesDto, SaveRunDto } from './recon.dto';

@ApiTags('reconciliation')
@Controller('recon')
export class ReconController {
  constructor(private readonly recon: ReconService) {}

  @Get('psps')
  getPsps() {
    return this.recon.getPsps();
  }

  @Put('psps')
  replacePsps(@Body() body: ReplacePspsDto) {
    return this.recon.replacePsps((body.psps ?? []) as PspConfigDto[]);
  }

  @Get('cases')
  getCases() {
    return this.recon.getCases();
  }

  @Put('cases')
  saveCases(@Body() body: SaveCasesDto) {
    return this.recon.saveCases((body.cases ?? []) as ReconCaseDto[]);
  }

  @Get('runs')
  listRuns() {
    return this.recon.listRuns();
  }

  @Get('runs/:id')
  getRun(@Param('id') id: string) {
    return this.recon.getRun(id);
  }

  @Post('runs')
  saveRun(@Body() body: SaveRunDto) {
    return this.recon.saveRun(body);
  }
}
