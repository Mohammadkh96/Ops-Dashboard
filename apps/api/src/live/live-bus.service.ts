import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

import type { LiveTick } from './live.types';

/**
 * App-wide fan-out for real-time events.
 *
 * Anything that learns about a payment (today: the Paymaxis webhook) publishes
 * here; the dashboard's SSE endpoint subscribes. Keeping the bus separate means
 * new providers can be added without the dashboard knowing about them.
 */
@Injectable()
export class LiveBus {
  private readonly subject = new Subject<LiveTick>();
  private seq = 0;
  /** Rolling window of recent outcomes, for the success-rate tile. */
  private readonly recent: boolean[] = [];
  private lastVolume = 0;

  /** Publishes an event, stamping the sequence and derived metrics. */
  publish(
    item: LiveTick['queueItem'],
    opts: { settled?: boolean; amount?: number } = {},
  ): LiveTick {
    this.seq += 1;

    if (opts.settled !== undefined) {
      this.recent.push(opts.settled);
      if (this.recent.length > 200) this.recent.shift();
    }
    const ok = this.recent.filter(Boolean).length;
    const successRate = this.recent.length
      ? Number(((ok / this.recent.length) * 100).toFixed(1))
      : 100;

    // Volume delta is expressed relative to the previous event so the tile can
    // animate without the client having to keep a running total.
    const amount = opts.amount ?? 0;
    const volumeDelta = this.lastVolume
      ? Number(((amount - this.lastVolume) / this.lastVolume).toFixed(3))
      : 0;
    if (amount) this.lastVolume = amount;

    const tick: LiveTick = {
      ts: new Date().toISOString(),
      seq: this.seq,
      queueItem: item,
      metrics: { successRate, volumeDelta },
      live: true,
    };
    this.subject.next(tick);
    return tick;
  }

  stream(): Observable<LiveTick> {
    return this.subject.asObservable();
  }

  /** True once any real event has been seen, so the simulator can stand down. */
  hasLiveTraffic(): boolean {
    return this.seq > 0;
  }
}
