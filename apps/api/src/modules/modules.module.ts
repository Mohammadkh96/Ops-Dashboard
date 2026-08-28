import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ModulesController } from './modules.controller';
import { ModulesService } from './modules.service';

@Module({
  // For AdminUnlockGuard, which sits in front of the Admin tab's routes. The
  // guard is defined once in AuthModule so "unlocked" means the same thing
  // wherever it is required.
  imports: [AuthModule],
  controllers: [ModulesController],
  providers: [ModulesService],
})
export class ModulesModule {}
