import { Global, Module } from '@nestjs/common';

import { LiveBus } from './live-bus.service';

/** Global so any provider integration can publish without extra wiring. */
@Global()
@Module({
  providers: [LiveBus],
  exports: [LiveBus],
})
export class LiveModule {}
