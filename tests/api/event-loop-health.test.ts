import { describe, expect, it } from 'vitest';

import { NodeEventLoopHealthMonitor } from '../../src/api/event-loop-health';

describe('NodeEventLoopHealthMonitor', () => {
  it('normalizes no-sample histogram values before the first meaningful sample', () => {
    const monitor = new NodeEventLoopHealthMonitor({
      autoStart: false,
      initialObservedAtMs: Date.parse('2026-05-13T15:04:00.000Z'),
      nowMs: () => Date.parse('2026-05-13T15:04:00.000Z')
    });

    try {
      const summary = monitor.summarize(Date.parse('2026-05-13T15:04:00.000Z'));

      expect(summary.sample_window_ms).toBe(0);
      expect(summary.delay).toMatchObject({
        min_ms: null,
        mean_ms: null,
        max_ms: null,
        p50_ms: null,
        p95_ms: null,
        p99_ms: null
      });
    } finally {
      monitor.close();
    }
  });

  it('keeps a bounded rolling sample window independent of summary reads', () => {
    const monitor = new NodeEventLoopHealthMonitor({
      autoStart: false,
      initialObservedAtMs: 1_000,
      sampleIntervalMs: 1_000,
      windowBucketCount: 2,
      nowMs: () => 1_000
    });

    try {
      const firstSummary = monitor.summarize(1_500);
      const secondSummary = monitor.summarize(1_500);
      monitor.sample(2_000);
      monitor.sample(3_000);
      monitor.sample(4_000);
      const rollingSummary = monitor.summarize(4_000);

      expect(secondSummary).toEqual(firstSummary);
      expect(rollingSummary.sample_window_ms).toBe(2_000);
    } finally {
      monitor.close();
    }
  });
});
