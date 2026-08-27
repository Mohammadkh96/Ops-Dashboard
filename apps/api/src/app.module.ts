import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { HealthModule } from './health/health.module';
import { ModulesModule } from './modules/modules.module';
import { PrismaModule } from './prisma/prisma.module';
import { ReconModule } from './recon/recon.module';
import { LiveModule } from './live/live.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { PaymaxisModule } from './paymaxis/paymaxis.module';
import { ShiftsModule } from './shifts/shifts.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    HealthModule,
    AuthModule,
    UsersModule,
    DashboardModule,
    ModulesModule,
    ReconModule,
    LiveModule,
    WebhooksModule,
    PaymaxisModule,
    ShiftsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
