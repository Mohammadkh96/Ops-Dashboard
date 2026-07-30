/** One real-time operational event pushed to the dashboard over SSE. */
export type LiveTick = {
  ts: string;
  seq: number;
  queueItem: {
    id: string;
    type: string;
    client: string;
    amount: string;
    status: 'processing' | 'review' | 'pending' | 'escalated' | 'settled' | 'failed';
  };
  metrics: { successRate: number; volumeDelta: number };
  /** True when this came from a real provider callback rather than the simulator. */
  live?: boolean;
};
