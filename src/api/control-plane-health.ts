import type { SnapshotFreshnessState } from './types';

export type ControlPlaneTransport = 'http' | 'sse';
export type ControlPlaneHealthState = 'ok' | 'slow' | 'large' | 'degraded';

export interface ControlPlaneThresholds {
  slow_ms: number;
  degraded_ms: number;
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
}

export interface ControlPlaneHealthSummary {
  generated_at: string;
  sample_limit: number;
  thresholds: ControlPlaneThresholds;
  endpoint_count: number;
  worst_health: ControlPlaneHealthState;
  endpoints: ControlPlaneEndpointHealth[];
}

const DEFAULT_SAMPLE_LIMIT = 40;

export const DEFAULT_CONTROL_PLANE_THRESHOLDS: ControlPlaneThresholds = {
  slow_ms: 1000,
  degraded_ms: 5000,
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
  observation: Pick<ControlPlaneObservation, 'duration_ms' | 'payload_bytes' | 'snapshot_error_code' | 'enrichment_degraded'>,
  thresholds: ControlPlaneThresholds
): ControlPlaneHealthState {
  if (
    observation.snapshot_error_code ||
    observation.enrichment_degraded ||
    observation.duration_ms >= thresholds.degraded_ms ||
    observation.payload_bytes >= thresholds.degraded_payload_bytes
  ) {
    return 'degraded';
  }
  if (observation.payload_bytes >= thresholds.large_payload_bytes) {
    return 'large';
  }
  if (observation.duration_ms >= thresholds.slow_ms) {
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
      projection_duration_ms: roundMs(observation.projection_duration_ms),
      enrichment_duration_ms: roundMs(observation.enrichment_duration_ms),
      serialization_duration_ms: roundMs(observation.serialization_duration_ms)
    });
    if (this.samples.length > this.sampleLimit) {
      this.samples.splice(0, this.samples.length - this.sampleLimit);
    }
    return classifyObservation(observation, this.thresholds);
  }

  classify(observation: Pick<ControlPlaneObservation, 'duration_ms' | 'payload_bytes' | 'snapshot_error_code'>): ControlPlaneHealthState {
    return classifyObservation(observation, this.thresholds);
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
        last_projection_duration_ms: roundMs(last.projection_duration_ms),
        last_enrichment_duration_ms: roundMs(last.enrichment_duration_ms),
        last_enrichment_status: last.enrichment_status ?? null,
        last_enrichment_degraded: last.enrichment_degraded ?? null,
        last_enrichment_reason_code: last.enrichment_reason_code ?? null,
        last_serialization_duration_ms: roundMs(last.serialization_duration_ms),
        last_broadcast_client_count: last.broadcast_client_count ?? null,
        last_snapshot_age_ms: roundMs(last.snapshot_age_ms),
        last_snapshot_freshness_state: last.snapshot_freshness_state ?? null,
        last_snapshot_error_code: last.snapshot_error_code ?? null
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
      endpoints
    };
  }
}
