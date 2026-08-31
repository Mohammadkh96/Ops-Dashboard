import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PspsController } from './psps.controller';
import { PspsService } from './psps.service';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [PspsController],
  providers: [PspsService],
  exports: [PspsService],
})
export class PspsModule {}
