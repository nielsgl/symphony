export interface ThroughputSnapshot {
  current_tps: number;
  avg_tps_60s: number;
  window_seconds: number;
  sparkline_10m: number[];
  sample_count: number;
}

interface ThroughputSample {
  at_ms: number;
  tokens: number;
}

const TEN_MIN_MS = 10 * 60 * 1000;
const FIVE_SEC_MS = 5 * 1000;
const SIXTY_SEC_MS = 60 * 1000;
const SPARKLINE_BUCKETS = 24;

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export class ThroughputTracker {
  private readonly samples: ThroughputSample[] = [];

  observe(sample: ThroughputSample): void {
    if (!Number.isFinite(sample.at_ms) || !Number.isFinite(sample.tokens) || sample.tokens <= 0) {
      return;
    }

    this.samples.push({ at_ms: sample.at_ms, tokens: sample.tokens });
    this.prune(sample.at_ms);
  }

  snapshot(nowMs: number): ThroughputSnapshot {
    this.prune(nowMs);

    const currentTokens = this.sumSince(nowMs - FIVE_SEC_MS);
    const avg60Tokens = this.sumSince(nowMs - SIXTY_SEC_MS);
    const bucketWidthMs = Math.floor(TEN_MIN_MS / SPARKLINE_BUCKETS);
    const sparkline = Array.from({ length: SPARKLINE_BUCKETS }, (_, idx) => {
      const end = nowMs - (SPARKLINE_BUCKETS - idx - 1) * bucketWidthMs;
      const start = end - bucketWidthMs;
      const bucketTokens = this.sumInRange(start, end);
      const seconds = bucketWidthMs / 1000;
      return roundTo(bucketTokens / seconds, 2);
    });

    return {
      current_tps: roundTo(currentTokens / (FIVE_SEC_MS / 1000), 2),
      avg_tps_60s: roundTo(avg60Tokens / (SIXTY_SEC_MS / 1000), 2),
      window_seconds: Math.floor(TEN_MIN_MS / 1000),
      sparkline_10m: sparkline,
      sample_count: this.samples.length
    };
  }

  private sumSince(startMs: number): number {
    return this.samples.reduce((total, sample) => (sample.at_ms >= startMs ? total + sample.tokens : total), 0);
  }

  private sumInRange(startMs: number, endMs: number): number {
    return this.samples.reduce(
      (total, sample) => (sample.at_ms >= startMs && sample.at_ms < endMs ? total + sample.tokens : total),
      0
    );
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - TEN_MIN_MS;
    let idx = 0;
    while (idx < this.samples.length && this.samples[idx].at_ms < cutoff) {
      idx += 1;
    }

    if (idx > 0) {
      this.samples.splice(0, idx);
    }
  }
}
