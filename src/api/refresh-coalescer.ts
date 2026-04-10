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
  private followupRequested: boolean;

  constructor(options: RefreshCoalescerOptions) {
    this.refreshSource = options.refreshSource;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.coalesceWindowMs = options.coalesceWindowMs ?? 25;
    this.scheduled = null;
    this.running = false;
    this.followupRequested = false;
  }

  requestRefresh(): ApiRefreshAcceptedResponse {
    const coalesced = this.scheduled !== null || this.running || this.followupRequested;

    if (this.running) {
      // Ensure at least one additional tick after this accepted request.
      this.followupRequested = true;
    } else {
      this.scheduleFlush();
    }

    return {
      queued: true,
      coalesced,
      requested_at: new Date(this.nowMs()).toISOString(),
      operations: ['poll', 'reconcile']
    };
  }

  private scheduleFlush(): void {
    if (this.scheduled) {
      return;
    }

    this.scheduled = setTimeout(() => {
      void this.flushSafely();
    }, this.coalesceWindowMs);
  }

  private async flushSafely(): Promise<void> {
    try {
      await this.flush();
    } catch {
      // Keep refresh path resilient: callers already received 202 accepted.
    }
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
      if (this.followupRequested) {
        this.followupRequested = false;
        this.scheduleFlush();
      }
    }
  }
}
