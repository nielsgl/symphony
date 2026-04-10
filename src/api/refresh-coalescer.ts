import type { ApiRefreshAcceptedResponse, RefreshTickSource } from './types';

export interface RefreshCoalescerOptions {
  refreshSource: RefreshTickSource;
  nowMs?: () => number;
  coalesceWindowMs?: number;
}

export class RefreshCoalescer {
  private readonly refreshSource: RefreshTickSource;
  private readonly nowMs: () => number;
  private readonly coalesceWindowMs: number;

  private scheduled: ReturnType<typeof setTimeout> | null;
  private running: boolean;

  constructor(options: RefreshCoalescerOptions) {
    this.refreshSource = options.refreshSource;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.coalesceWindowMs = options.coalesceWindowMs ?? 25;
    this.scheduled = null;
    this.running = false;
  }

  requestRefresh(): ApiRefreshAcceptedResponse {
    const coalesced = this.scheduled !== null || this.running;

    if (!this.scheduled && !this.running) {
      this.scheduled = setTimeout(() => {
        void this.flush();
      }, this.coalesceWindowMs);
    }

    return {
      queued: true,
      coalesced,
      requested_at: new Date(this.nowMs()).toISOString(),
      operations: ['poll', 'reconcile']
    };
  }

  private async flush(): Promise<void> {
    this.scheduled = null;
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      await this.refreshSource.tick('manual_refresh');
    } finally {
      this.running = false;
    }
  }
}
