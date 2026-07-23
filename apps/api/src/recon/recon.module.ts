import { Module } from '@nestjs/common';

import { ReconController } from './recon.controller';
import { ReconService } from './recon.service';

@Module({
  controllers: [ReconController],
  providers: [ReconService],
})
export class ReconModule {}
