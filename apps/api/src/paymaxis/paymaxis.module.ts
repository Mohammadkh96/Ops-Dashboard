import { Module } from '@nestjs/common';

import { PaymaxisController } from './paymaxis.controller';
import { PaymaxisService } from './paymaxis.service';

@Module({
  controllers: [PaymaxisController],
  providers: [PaymaxisService],
})
export class PaymaxisModule {}
