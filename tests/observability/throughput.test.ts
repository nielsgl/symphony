import { describe, expect, it } from 'vitest';

import { ThroughputTracker } from '../../src/observability/throughput';

describe('ThroughputTracker', () => {
  it('returns stable zero snapshot when no samples are present', () => {
    const tracker = new ThroughputTracker();
    const snapshot = tracker.snapshot(100_000);

    expect(snapshot.current_tps).toBe(0);
    expect(snapshot.avg_tps_60s).toBe(0);
    expect(snapshot.window_seconds).toBe(600);
    expect(snapshot.sample_count).toBe(0);
    expect(snapshot.sparkline_10m).toHaveLength(24);
    expect(snapshot.sparkline_10m.every((value) => value === 0)).toBe(true);
  });

  it('computes 5s and 60s windows deterministically from token deltas', () => {
    const tracker = new ThroughputTracker();
    tracker.observe({ at_ms: 95_000, tokens: 20 });
    tracker.observe({ at_ms: 96_000, tokens: 10 });
    tracker.observe({ at_ms: 93_000, tokens: 30 });

    const snapshot = tracker.snapshot(100_000);

    expect(snapshot.current_tps).toBe(6);
    expect(snapshot.avg_tps_60s).toBe(1);
    expect(snapshot.sample_count).toBe(3);
    expect(snapshot.sparkline_10m).toHaveLength(24);
  });

  it('prunes samples older than 10 minutes', () => {
    const tracker = new ThroughputTracker();
    tracker.observe({ at_ms: 1_000, tokens: 50 });
    tracker.observe({ at_ms: 700_000, tokens: 10 });

    const snapshot = tracker.snapshot(700_000);

    expect(snapshot.sample_count).toBe(1);
    expect(snapshot.avg_tps_60s).toBeCloseTo(0.17, 2);
  });
});
