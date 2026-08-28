import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminController } from './admin.controller';
import { AdminUsersService } from './admin-users.service';

@Module({
  // AuthModule for AdminUnlockGuard, so "unlocked" is defined in one place.
  imports: [AuthModule, PrismaModule],
  controllers: [AdminController],
  providers: [AdminUsersService],
})
export class AdminModule {}
