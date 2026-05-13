import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export interface EventLoopDelaySummary {
  resolution_ms: number;
  min_ms: number | null;
  mean_ms: number | null;
  max_ms: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
}

export interface EventLoopUtilizationSummary {
  idle_ms: number;
  active_ms: number;
  utilization: number;
}

export interface EventLoopHealthSummary {
  observed_at: string;
  sample_window_ms: number;
  delay: EventLoopDelaySummary;
  utilization: EventLoopUtilizationSummary;
}

export interface EventLoopHealthMonitor {
  summarize(nowMs: number, options?: { reset?: boolean }): EventLoopHealthSummary;
  close?(): void;
}

const DEFAULT_RESOLUTION_MS = 20;
const NS_PER_MS = 1_000_000;

function roundMs(value: number): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.round(value));
}

function roundUtilization(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

export class NodeEventLoopHealthMonitor implements EventLoopHealthMonitor {
  private readonly histogram: ReturnType<typeof monitorEventLoopDelay>;
  private readonly resolutionMs: number;
  private lastResetAtMs: number | null;
  private utilizationBaseline: ReturnType<typeof performance.eventLoopUtilization>;

  constructor(options: { resolutionMs?: number; initialObservedAtMs?: number } = {}) {
    const resolutionMs = options.resolutionMs ?? DEFAULT_RESOLUTION_MS;
    this.resolutionMs = resolutionMs;
    this.histogram = monitorEventLoopDelay({ resolution: resolutionMs });
    this.histogram.enable();
    this.lastResetAtMs = options.initialObservedAtMs ?? null;
    this.utilizationBaseline = performance.eventLoopUtilization();
  }

  summarize(nowMs: number, options: { reset?: boolean } = {}): EventLoopHealthSummary {
    const utilization = performance.eventLoopUtilization(this.utilizationBaseline);
    const windowStartedAtMs = this.lastResetAtMs ?? nowMs;
    const summary: EventLoopHealthSummary = {
      observed_at: new Date(nowMs).toISOString(),
      sample_window_ms: Math.max(0, Math.round(nowMs - windowStartedAtMs)),
      delay: {
        resolution_ms: this.resolutionMs,
        min_ms: roundMs(this.histogram.min / NS_PER_MS),
        mean_ms: roundMs(this.histogram.mean / NS_PER_MS),
        max_ms: roundMs(this.histogram.max / NS_PER_MS),
        p50_ms: roundMs(this.histogram.percentile(50) / NS_PER_MS),
        p95_ms: roundMs(this.histogram.percentile(95) / NS_PER_MS),
        p99_ms: roundMs(this.histogram.percentile(99) / NS_PER_MS)
      },
      utilization: {
        idle_ms: roundMs(utilization.idle) ?? 0,
        active_ms: roundMs(utilization.active) ?? 0,
        utilization: roundUtilization(utilization.utilization)
      }
    };

    if (options.reset) {
      this.histogram.reset();
      this.utilizationBaseline = performance.eventLoopUtilization();
      this.lastResetAtMs = nowMs;
    } else if (this.lastResetAtMs === null) {
      this.lastResetAtMs = nowMs;
    }

    return summary;
  }

  close(): void {
    this.histogram.disable();
  }
}
