import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { KycModule } from '../kyc/kyc.module';
import { ModulesController } from './modules.controller';
import { ModulesService } from './modules.service';

@Module({
  // For AdminUnlockGuard, which sits in front of the Admin tab's routes. The
  // guard is defined once in AuthModule so "unlocked" means the same thing
  // wherever it is required.
  // KycModule for the verification-side detections. They join the payment ones
  // on the Incidents screen rather than getting a page of their own: the desk
  // works one list, and the quieter of two pages is the one nobody opens.
  imports: [AuthModule, KycModule],
  controllers: [ModulesController],
  providers: [ModulesService],
})
export class ModulesModule {}
