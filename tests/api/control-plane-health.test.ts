import { describe, expect, it } from 'vitest';

import { ControlPlaneHealthRecorder } from '../../src/api/control-plane-health';
import { REASON_CODES } from '../../src/observability/reason-codes';

describe('ControlPlaneHealthRecorder', () => {
  it('keeps token-only enrichment degradation out of dispatch-relevant route health', () => {
    const recorder = new ControlPlaneHealthRecorder();

    const health = recorder.record({
      endpoint: '/api/v1/state',
      transport: 'http',
      observed_at_ms: Date.parse('2026-05-13T15:00:00.000Z'),
      duration_ms: 40,
      status_code: 200,
      payload_bytes: 20_000,
      enrichment_status: 'degraded',
      enrichment_degraded: true,
      enrichment_reason_code: REASON_CODES.liveTokenFallbackNotOnHotPath
    });
    const summary = recorder.summarize(Date.parse('2026-05-13T15:00:01.000Z'));

    expect(health).toBe('ok');
    expect(summary.worst_health).toBe('ok');
    expect(summary.endpoints[0]).toMatchObject({
      health: 'ok',
      last_enrichment_status: 'degraded',
      last_enrichment_degraded: true,
      last_enrichment_reason_code: REASON_CODES.liveTokenFallbackNotOnHotPath
    });
  });

  it('still degrades route health for real snapshot errors', () => {
    const recorder = new ControlPlaneHealthRecorder();

    const health = recorder.record({
      endpoint: '/api/v1/state',
      transport: 'http',
      observed_at_ms: Date.parse('2026-05-13T15:01:00.000Z'),
      duration_ms: 40,
      status_code: 200,
      payload_bytes: 20_000,
      snapshot_error_code: 'state_projection_unavailable'
    });
    const summary = recorder.summarize(Date.parse('2026-05-13T15:01:01.000Z'));

    expect(health).toBe('degraded');
    expect(summary.worst_health).toBe('degraded');
    expect(summary.endpoints[0]).toMatchObject({
      health: 'degraded',
      last_snapshot_error_code: 'state_projection_unavailable'
    });
  });

  it('classifies queued requests separately from slow projection work', () => {
    const recorder = new ControlPlaneHealthRecorder();

    const health = recorder.record({
      endpoint: '/api/v1/state',
      transport: 'http',
      observed_at_ms: Date.parse('2026-05-13T15:04:00.000Z'),
      duration_ms: 7,
      status_code: 200,
      payload_bytes: 20_000,
      request_queue_delay_ms: 5_250,
      projection_duration_ms: 5,
      serialization_duration_ms: 1
    });
    const summary = recorder.summarize(Date.parse('2026-05-13T15:04:01.000Z'));

    expect(health).toBe('degraded');
    expect(summary.worst_health).toBe('degraded');
    expect(summary.endpoints[0]).toMatchObject({
      health: 'degraded',
      last_duration_ms: 7,
      last_request_queue_delay_ms: 5250,
      max_request_queue_delay_ms: 5250,
      last_projection_duration_ms: 5,
      last_serialization_duration_ms: 1
    });
  });

  it('surfaces recent event-loop delay without requiring slow handler duration', () => {
    const recorder = new ControlPlaneHealthRecorder();
    recorder.recordEventLoop({
      observed_at: '2026-05-13T15:04:00.000Z',
      sample_window_ms: 1000,
      delay: {
        resolution_ms: 20,
        min_ms: 0,
        mean_ms: 250,
        max_ms: 4100,
        p50_ms: 20,
        p95_ms: 3900,
        p99_ms: 4100
      },
      utilization: {
        idle_ms: 10,
        active_ms: 990,
        utilization: 0.99
      }
    });

    const health = recorder.record({
      endpoint: '/api/v1/state',
      transport: 'http',
      observed_at_ms: Date.parse('2026-05-13T15:04:01.000Z'),
      duration_ms: 7,
      status_code: 200,
      payload_bytes: 20_000,
      request_queue_delay_ms: 0,
      event_loop_delay_ms: 4100,
      event_loop_utilization: 0.99,
      projection_duration_ms: 5,
      serialization_duration_ms: 1
    });
    const summary = recorder.summarize(Date.parse('2026-05-13T15:04:02.000Z'));

    expect(health).toBe('slow');
    expect(summary.event_loop).toMatchObject({
      sample_window_ms: 1000,
      delay: { max_ms: 4100, p95_ms: 3900 },
      utilization: { utilization: 0.99 }
    });
    expect(summary.endpoints[0]).toMatchObject({
      health: 'slow',
      last_duration_ms: 7,
      last_event_loop_delay_ms: 4100,
      last_event_loop_utilization: 0.99
    });
  });
});
