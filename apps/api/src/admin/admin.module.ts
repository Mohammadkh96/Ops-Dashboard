import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminController } from './admin.controller';
import { AdminUsersService } from './admin-users.service';
import { IntegrationsService } from './integrations.service';

@Module({
  // AuthModule for AdminUnlockGuard, so "unlocked" is defined in one place.
  imports: [AuthModule, PrismaModule],
  controllers: [AdminController],
  providers: [AdminUsersService, IntegrationsService],
})
export class AdminModule {}
