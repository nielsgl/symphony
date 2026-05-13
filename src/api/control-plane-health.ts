import type { SnapshotFreshnessState } from './types';
import type { EventLoopHealthSummary } from './event-loop-health';

export type ControlPlaneTransport = 'http' | 'sse';
export type ControlPlaneHealthState = 'ok' | 'slow' | 'large' | 'degraded';

export interface ControlPlaneThresholds {
  slow_ms: number;
  degraded_ms: number;
  slow_request_queue_delay_ms: number;
  degraded_request_queue_delay_ms: number;
  slow_event_loop_delay_ms: number;
  degraded_event_loop_delay_ms: number;
  large_payload_bytes: number;
  degraded_payload_bytes: number;
}

export interface ControlPlaneObservation {
  endpoint: string;
  transport: ControlPlaneTransport;
  observed_at_ms: number;
  duration_ms: number;
  status_code: number | null;
  payload_bytes: number;
  request_queue_delay_ms?: number | null;
  projection_duration_ms?: number | null;
  enrichment_duration_ms?: number | null;
  enrichment_status?: string | null;
  enrichment_degraded?: boolean | null;
  enrichment_reason_code?: string | null;
  serialization_duration_ms?: number | null;
  broadcast_client_count?: number | null;
  snapshot_age_ms?: number | null;
  snapshot_freshness_state?: SnapshotFreshnessState | null;
  snapshot_error_code?: string | null;
  event_loop_delay_ms?: number | null;
  event_loop_utilization?: number | null;
}

export interface ControlPlaneEndpointHealth {
  endpoint: string;
  transport: ControlPlaneTransport;
  sample_count: number;
  health: ControlPlaneHealthState;
  last_observed_at: string | null;
  last_duration_ms: number | null;
  max_duration_ms: number | null;
  avg_duration_ms: number | null;
  last_payload_bytes: number | null;
  max_payload_bytes: number | null;
  avg_payload_bytes: number | null;
  last_request_queue_delay_ms: number | null;
  max_request_queue_delay_ms: number | null;
  avg_request_queue_delay_ms: number | null;
  last_projection_duration_ms: number | null;
  last_enrichment_duration_ms: number | null;
  last_enrichment_status: string | null;
  last_enrichment_degraded: boolean | null;
  last_enrichment_reason_code: string | null;
  last_serialization_duration_ms: number | null;
  last_broadcast_client_count: number | null;
  last_snapshot_age_ms: number | null;
  last_snapshot_freshness_state: SnapshotFreshnessState | null;
  last_snapshot_error_code: string | null;
  last_event_loop_delay_ms: number | null;
  max_event_loop_delay_ms: number | null;
  avg_event_loop_delay_ms: number | null;
  last_event_loop_utilization: number | null;
}

export interface ControlPlaneHealthSummary {
  generated_at: string;
  sample_limit: number;
  thresholds: ControlPlaneThresholds;
  endpoint_count: number;
  worst_health: ControlPlaneHealthState;
  event_loop: EventLoopHealthSummary | null;
  endpoints: ControlPlaneEndpointHealth[];
}

const DEFAULT_SAMPLE_LIMIT = 40;

export const DEFAULT_CONTROL_PLANE_THRESHOLDS: ControlPlaneThresholds = {
  slow_ms: 1000,
  degraded_ms: 5000,
  slow_request_queue_delay_ms: 1000,
  degraded_request_queue_delay_ms: 5000,
  slow_event_loop_delay_ms: 1000,
  degraded_event_loop_delay_ms: 5000,
  large_payload_bytes: 1_000_000,
  degraded_payload_bytes: 5_000_000
};

const HEALTH_RANK: Record<ControlPlaneHealthState, number> = {
  ok: 0,
  slow: 1,
  large: 2,
  degraded: 3
};

function roundMs(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(value);
}

function classifyObservation(
  observation: Pick<
    ControlPlaneObservation,
    'duration_ms' | 'payload_bytes' | 'snapshot_error_code' | 'request_queue_delay_ms' | 'event_loop_delay_ms'
  >,
  thresholds: ControlPlaneThresholds
): ControlPlaneHealthState {
  if (
    observation.snapshot_error_code ||
    observation.duration_ms >= thresholds.degraded_ms ||
    (observation.request_queue_delay_ms ?? 0) >= thresholds.degraded_request_queue_delay_ms ||
    (observation.event_loop_delay_ms ?? 0) >= thresholds.degraded_event_loop_delay_ms ||
    observation.payload_bytes >= thresholds.degraded_payload_bytes
  ) {
    return 'degraded';
  }
  if (observation.payload_bytes >= thresholds.large_payload_bytes) {
    return 'large';
  }
  if (
    observation.duration_ms >= thresholds.slow_ms ||
    (observation.request_queue_delay_ms ?? 0) >= thresholds.slow_request_queue_delay_ms ||
    (observation.event_loop_delay_ms ?? 0) >= thresholds.slow_event_loop_delay_ms
  ) {
    return 'slow';
  }
  return 'ok';
}

function worstHealth(states: ControlPlaneHealthState[]): ControlPlaneHealthState {
  return states.reduce<ControlPlaneHealthState>(
    (worst, state) => (HEALTH_RANK[state] > HEALTH_RANK[worst] ? state : worst),
    'ok'
  );
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export class ControlPlaneHealthRecorder {
  private readonly samples: ControlPlaneObservation[] = [];
  private readonly sampleLimit: number;
  private readonly thresholds: ControlPlaneThresholds;
  private eventLoopSummary: EventLoopHealthSummary | null = null;

  constructor(options: { sampleLimit?: number; thresholds?: Partial<ControlPlaneThresholds> } = {}) {
    this.sampleLimit = options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
    this.thresholds = {
      ...DEFAULT_CONTROL_PLANE_THRESHOLDS,
      ...options.thresholds
    };
  }

  record(observation: ControlPlaneObservation): ControlPlaneHealthState {
    this.samples.push({
      ...observation,
      duration_ms: Math.max(0, Math.round(observation.duration_ms)),
      payload_bytes: Math.max(0, Math.round(observation.payload_bytes)),
      request_queue_delay_ms: roundMs(observation.request_queue_delay_ms),
      projection_duration_ms: roundMs(observation.projection_duration_ms),
      enrichment_duration_ms: roundMs(observation.enrichment_duration_ms),
      serialization_duration_ms: roundMs(observation.serialization_duration_ms),
      event_loop_delay_ms: roundMs(observation.event_loop_delay_ms),
      event_loop_utilization:
        typeof observation.event_loop_utilization === 'number' && Number.isFinite(observation.event_loop_utilization)
          ? Number(Math.max(0, Math.min(1, observation.event_loop_utilization)).toFixed(4))
          : null
    });
    if (this.samples.length > this.sampleLimit) {
      this.samples.splice(0, this.samples.length - this.sampleLimit);
    }
    return classifyObservation(observation, this.thresholds);
  }

  classify(
    observation: Pick<
      ControlPlaneObservation,
      'duration_ms' | 'payload_bytes' | 'snapshot_error_code' | 'request_queue_delay_ms' | 'event_loop_delay_ms'
    >
  ): ControlPlaneHealthState {
    return classifyObservation(observation, this.thresholds);
  }

  recordEventLoop(summary: EventLoopHealthSummary | null): void {
    this.eventLoopSummary = summary ? { ...summary, delay: { ...summary.delay }, utilization: { ...summary.utilization } } : null;
  }

  getThresholds(): ControlPlaneThresholds {
    return { ...this.thresholds };
  }

  summarize(nowMs: number): ControlPlaneHealthSummary {
    const grouped = new Map<string, ControlPlaneObservation[]>();
    for (const sample of this.samples) {
      const key = `${sample.transport}:${sample.endpoint}`;
      const entries = grouped.get(key) ?? [];
      entries.push(sample);
      grouped.set(key, entries);
    }

    const endpoints = Array.from(grouped.values()).map((entries) => {
      const last = entries[entries.length - 1]!;
      const durationValues = entries.map((entry) => entry.duration_ms);
      const payloadValues = entries.map((entry) => entry.payload_bytes);
      const requestQueueDelayValues = entries.flatMap((entry) =>
        typeof entry.request_queue_delay_ms === 'number' ? [entry.request_queue_delay_ms] : []
      );
      const eventLoopDelayValues = entries.flatMap((entry) =>
        typeof entry.event_loop_delay_ms === 'number' ? [entry.event_loop_delay_ms] : []
      );
      const health = worstHealth(entries.map((entry) => classifyObservation(entry, this.thresholds)));
      return {
        endpoint: last.endpoint,
        transport: last.transport,
        sample_count: entries.length,
        health,
        last_observed_at: new Date(last.observed_at_ms).toISOString(),
        last_duration_ms: roundMs(last.duration_ms),
        max_duration_ms: Math.max(...durationValues),
        avg_duration_ms: average(durationValues),
        last_payload_bytes: last.payload_bytes,
        max_payload_bytes: Math.max(...payloadValues),
        avg_payload_bytes: average(payloadValues),
        last_request_queue_delay_ms: roundMs(last.request_queue_delay_ms),
        max_request_queue_delay_ms: requestQueueDelayValues.length > 0 ? Math.max(...requestQueueDelayValues) : null,
        avg_request_queue_delay_ms: average(requestQueueDelayValues),
        last_projection_duration_ms: roundMs(last.projection_duration_ms),
        last_enrichment_duration_ms: roundMs(last.enrichment_duration_ms),
        last_enrichment_status: last.enrichment_status ?? null,
        last_enrichment_degraded: last.enrichment_degraded ?? null,
        last_enrichment_reason_code: last.enrichment_reason_code ?? null,
        last_serialization_duration_ms: roundMs(last.serialization_duration_ms),
        last_broadcast_client_count: last.broadcast_client_count ?? null,
        last_snapshot_age_ms: roundMs(last.snapshot_age_ms),
        last_snapshot_freshness_state: last.snapshot_freshness_state ?? null,
        last_snapshot_error_code: last.snapshot_error_code ?? null,
        last_event_loop_delay_ms: roundMs(last.event_loop_delay_ms),
        max_event_loop_delay_ms: eventLoopDelayValues.length > 0 ? Math.max(...eventLoopDelayValues) : null,
        avg_event_loop_delay_ms: average(eventLoopDelayValues),
        last_event_loop_utilization: last.event_loop_utilization ?? null
      } satisfies ControlPlaneEndpointHealth;
    });

    endpoints.sort((left, right) => {
      const healthDelta = HEALTH_RANK[right.health] - HEALTH_RANK[left.health];
      if (healthDelta !== 0) {
        return healthDelta;
      }
      return (right.max_duration_ms ?? 0) - (left.max_duration_ms ?? 0) || left.endpoint.localeCompare(right.endpoint);
    });

    return {
      generated_at: new Date(nowMs).toISOString(),
      sample_limit: this.sampleLimit,
      thresholds: this.getThresholds(),
      endpoint_count: endpoints.length,
      worst_health: worstHealth(endpoints.map((endpoint) => endpoint.health)),
      event_loop: this.eventLoopSummary,
      endpoints
    };
  }
}
