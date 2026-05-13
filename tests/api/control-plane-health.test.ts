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
});
