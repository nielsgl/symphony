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
  private closed: boolean;

  constructor(options: RefreshCoalescerOptions) {
    this.refreshSource = options.refreshSource;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.coalesceWindowMs = options.coalesceWindowMs ?? 25;
    this.scheduled = null;
    this.running = false;
    this.followupRequested = false;
    this.closed = false;
  }

  requestRefresh(): ApiRefreshAcceptedResponse {
    const coalesced = this.scheduled !== null || this.running || this.followupRequested;

    if (this.closed) {
      // Server shutdown owns the lifecycle boundary; preserve the response
      // shape for callers that race close, but never schedule post-close work.
    } else if (this.running) {
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

  close(): void {
    this.closed = true;
    this.followupRequested = false;
    if (this.scheduled) {
      clearTimeout(this.scheduled);
      this.scheduled = null;
    }
  }

  private scheduleFlush(): void {
    if (this.closed) {
      return;
    }
    if (this.scheduled) {
      return;
    }

    this.scheduled = setTimeout(() => {
      void this.flushSafely();
    }, this.coalesceWindowMs);
  }

  private async flushSafely(): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      await this.flush();
    } catch {
      // Keep refresh path resilient: callers already received 202 accepted.
    }
  }

  private async flush(): Promise<void> {
    this.scheduled = null;
    if (this.closed) {
      return;
    }
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      await this.refreshSource.tick('manual_refresh');
    } finally {
      this.running = false;
      if (!this.closed && this.followupRequested) {
        this.followupRequested = false;
        this.scheduleFlush();
      }
    }
  }
}
