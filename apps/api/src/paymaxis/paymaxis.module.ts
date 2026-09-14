import { Module } from '@nestjs/common';

import { ModulesModule } from '../modules/modules.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymaxisController } from './paymaxis.controller';
import { PaymaxisService } from './paymaxis.service';

@Module({
  // The daily sync records a notification pass when it finishes — the
  // unattended half of the alerting. It hangs off this cron rather than its
  // own because an extra cron entry is refused at deployment on this plan, and
  // off this one rather than the KYC cron because Modules already depends on
  // Kyc and the circle would not build.
  imports: [ModulesModule, NotificationsModule],
  controllers: [PaymaxisController],
  providers: [PaymaxisService],
})
export class PaymaxisModule {}
