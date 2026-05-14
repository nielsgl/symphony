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
  summarize(nowMs: number): EventLoopHealthSummary;
  close?(): void;
}

const DEFAULT_RESOLUTION_MS = 20;
const DEFAULT_SAMPLE_INTERVAL_MS = 1000;
const DEFAULT_WINDOW_BUCKET_COUNT = 30;
const NS_PER_MS = 1_000_000;
const NO_SAMPLE_MIN_NS = 9_000_000_000_000_000_000;

interface EventLoopHealthBucket {
  started_at_ms: number;
  ended_at_ms: number;
  delay: EventLoopDelaySummary;
  utilization: EventLoopUtilizationSummary;
}

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

function normalizeDelayValue(valueNs: number, hasSamples: boolean): number | null {
  if (!hasSamples || !Number.isFinite(valueNs) || valueNs >= NO_SAMPLE_MIN_NS) {
    return null;
  }
  return roundMs(valueNs / NS_PER_MS);
}

function readHistogramDelay(
  histogram: ReturnType<typeof monitorEventLoopDelay>,
  resolutionMs: number
): EventLoopDelaySummary {
  const count = (histogram as { count?: number }).count;
  const hasSamples =
    (typeof count === 'number' ? count > 0 : true) &&
    Number.isFinite(histogram.mean) &&
    histogram.min < NO_SAMPLE_MIN_NS &&
    histogram.max > 0;
  return {
    resolution_ms: resolutionMs,
    min_ms: normalizeDelayValue(histogram.min, hasSamples),
    mean_ms: normalizeDelayValue(histogram.mean, hasSamples),
    max_ms: normalizeDelayValue(histogram.max, hasSamples),
    p50_ms: normalizeDelayValue(histogram.percentile(50), hasSamples),
    p95_ms: normalizeDelayValue(histogram.percentile(95), hasSamples),
    p99_ms: normalizeDelayValue(histogram.percentile(99), hasSamples)
  };
}

function summarizeDelayWindow(buckets: EventLoopHealthBucket[], resolutionMs: number): EventLoopDelaySummary {
  const minValues = buckets.flatMap((bucket) => (bucket.delay.min_ms === null ? [] : [bucket.delay.min_ms]));
  const meanValues = buckets.flatMap((bucket) => {
    if (bucket.delay.mean_ms === null) {
      return [];
    }
    return [{ value: bucket.delay.mean_ms, weight: Math.max(0, bucket.ended_at_ms - bucket.started_at_ms) }];
  });
  const maxValues = buckets.flatMap((bucket) => (bucket.delay.max_ms === null ? [] : [bucket.delay.max_ms]));
  const p50Values = buckets.flatMap((bucket) => (bucket.delay.p50_ms === null ? [] : [bucket.delay.p50_ms]));
  const p95Values = buckets.flatMap((bucket) => (bucket.delay.p95_ms === null ? [] : [bucket.delay.p95_ms]));
  const p99Values = buckets.flatMap((bucket) => (bucket.delay.p99_ms === null ? [] : [bucket.delay.p99_ms]));
  const totalMeanWeight = meanValues.reduce((sum, entry) => sum + entry.weight, 0);
  return {
    resolution_ms: resolutionMs,
    min_ms: minValues.length > 0 ? Math.min(...minValues) : null,
    mean_ms:
      meanValues.length > 0 && totalMeanWeight > 0
        ? Math.round(meanValues.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / totalMeanWeight)
        : null,
    max_ms: maxValues.length > 0 ? Math.max(...maxValues) : null,
    p50_ms: p50Values.length > 0 ? Math.max(...p50Values) : null,
    p95_ms: p95Values.length > 0 ? Math.max(...p95Values) : null,
    p99_ms: p99Values.length > 0 ? Math.max(...p99Values) : null
  };
}

function summarizeUtilizationWindow(buckets: EventLoopHealthBucket[]): EventLoopUtilizationSummary {
  const idleMs = buckets.reduce((sum, bucket) => sum + bucket.utilization.idle_ms, 0);
  const activeMs = buckets.reduce((sum, bucket) => sum + bucket.utilization.active_ms, 0);
  return {
    idle_ms: Math.round(idleMs),
    active_ms: Math.round(activeMs),
    utilization: roundUtilization(activeMs + idleMs > 0 ? activeMs / (activeMs + idleMs) : 0)
  };
}

export class NodeEventLoopHealthMonitor implements EventLoopHealthMonitor {
  private readonly histogram: ReturnType<typeof monitorEventLoopDelay>;
  private readonly resolutionMs: number;
  private readonly sampleIntervalMs: number;
  private readonly windowBucketCount: number;
  private readonly buckets: EventLoopHealthBucket[] = [];
  private currentBucketStartedAtMs: number | null;
  private sampleHandle: NodeJS.Timeout | null = null;
  private utilizationBaseline: ReturnType<typeof performance.eventLoopUtilization>;
  private readonly nowMs: () => number;

  constructor(
    options: {
      resolutionMs?: number;
      sampleIntervalMs?: number;
      windowBucketCount?: number;
      initialObservedAtMs?: number;
      nowMs?: () => number;
      autoStart?: boolean;
    } = {}
  ) {
    const resolutionMs = options.resolutionMs ?? DEFAULT_RESOLUTION_MS;
    this.resolutionMs = resolutionMs;
    this.sampleIntervalMs = Math.max(1, Math.round(options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS));
    this.windowBucketCount = Math.max(1, Math.round(options.windowBucketCount ?? DEFAULT_WINDOW_BUCKET_COUNT));
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.histogram = monitorEventLoopDelay({ resolution: resolutionMs });
    this.histogram.enable();
    this.currentBucketStartedAtMs = options.initialObservedAtMs ?? this.nowMs();
    this.utilizationBaseline = performance.eventLoopUtilization();
    if (options.autoStart !== false) {
      this.sampleHandle = setInterval(() => {
        this.sample(this.nowMs());
      }, this.sampleIntervalMs);
      this.sampleHandle.unref?.();
    }
  }

  sample(nowMs: number): EventLoopHealthSummary {
    const utilization = performance.eventLoopUtilization(this.utilizationBaseline);
    const bucket: EventLoopHealthBucket = {
      started_at_ms: this.currentBucketStartedAtMs ?? nowMs,
      ended_at_ms: nowMs,
      delay: readHistogramDelay(this.histogram, this.resolutionMs),
      utilization: {
        idle_ms: roundMs(utilization.idle) ?? 0,
        active_ms: roundMs(utilization.active) ?? 0,
        utilization: roundUtilization(utilization.utilization)
      }
    };
    this.buckets.push(bucket);
    if (this.buckets.length > this.windowBucketCount) {
      this.buckets.splice(0, this.buckets.length - this.windowBucketCount);
    }
    this.histogram.reset();
    this.utilizationBaseline = performance.eventLoopUtilization();
    this.currentBucketStartedAtMs = nowMs;
    return this.summarize(nowMs);
  }

  summarize(nowMs: number): EventLoopHealthSummary {
    const openBucket: EventLoopHealthBucket = {
      started_at_ms: this.currentBucketStartedAtMs ?? nowMs,
      ended_at_ms: nowMs,
      delay: readHistogramDelay(this.histogram, this.resolutionMs),
      utilization: (() => {
        const utilization = performance.eventLoopUtilization(this.utilizationBaseline);
        return {
          idle_ms: roundMs(utilization.idle) ?? 0,
          active_ms: roundMs(utilization.active) ?? 0,
          utilization: roundUtilization(utilization.utilization)
        };
      })()
    };
    const windowBuckets = [...this.buckets, openBucket];
    const windowStartedAtMs = windowBuckets[0]?.started_at_ms ?? nowMs;
    return {
      observed_at: new Date(nowMs).toISOString(),
      sample_window_ms: Math.max(0, Math.round(nowMs - windowStartedAtMs)),
      delay: summarizeDelayWindow(windowBuckets, this.resolutionMs),
      utilization: summarizeUtilizationWindow(windowBuckets)
    };
  }

  close(): void {
    if (this.sampleHandle) {
      clearInterval(this.sampleHandle);
      this.sampleHandle = null;
    }
    this.histogram.disable();
  }
}
