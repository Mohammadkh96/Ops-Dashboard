import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ModulesModule } from '../modules/modules.module';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * The alerting layer, and the only module that depends on both halves.
 *
 * It imports ModulesModule for the detections — payments and KYC already merged
 * there — rather than running its own rules, so the feed cannot disagree with
 * the incident screen it mirrors. Exported because the crons record a pass too:
 * the unattended case rides along with the syncs, since this account's plan
 * refuses a cron entry of its own.
 */
@Module({
  imports: [AuthModule, PrismaModule, ModulesModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
