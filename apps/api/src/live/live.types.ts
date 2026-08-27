/** One real-time operational event pushed to the dashboard over SSE. */
export type LiveTick = {
  ts: string;
  seq: number;
  queueItem: {
    id: string;
    type: string;
    client: string;
    amount: string;
    status:
      'processing' | 'review' | 'pending' | 'escalated' | 'settled' | 'failed';
    /**
     * The provider's own name for the state — "Awaiting Webhook", "Checkout".
     * `status` above is the colour bucket, which is too coarse to act on:
     * several genuinely different situations collapse onto one word. Optional
     * because the simulator has no provider behind it to quote.
     */
    stateLabel?: string | null;
  };
  metrics: { successRate: number; volumeDelta: number };
  /** True when this came from a real provider callback rather than the simulator. */
  live?: boolean;
};
