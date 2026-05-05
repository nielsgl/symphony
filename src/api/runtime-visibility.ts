import { CANONICAL_EVENT } from '../observability/events';
import type { BlockedEntry, OperatorActionRecord, RunningEntry } from '../orchestrator/types';

export type TurnControlState = 'agent_turn' | 'operator_turn' | 'blocked_manual_resume';
export type ProgressSignalState = 'advancing' | 'heartbeat_only' | 'stalled_waiting';
export type SnapshotFreshnessState = 'fresh' | 'aging' | 'stale';
export type TokenTelemetryConfidence = 'observed_live' | 'backfilled' | 'missing';
export type NotBlockedExplainerCode =
  | 'active_turn_no_stop_reason'
  | 'within_wait_threshold'
  | 'awaiting_classifier_transition'
  | null;
export type ApiDegradedReasonCode = 'route_not_found' | 'schema_mismatch' | 'upstream_unavailable' | null;

export const SNAPSHOT_FRESH_MS = 5_000;
export const SNAPSHOT_AGING_MS = 30_000;

export function resolveRunningTurnControl(entry: RunningEntry): {
  turn_control_state: TurnControlState;
  turn_control_reason_code: string | null;
  turn_control_since_ms: number | null;
} {
  if (entry.awaiting_input_since_ms) {
    return {
      turn_control_state: 'operator_turn',
      turn_control_reason_code: 'turn_input_required',
      turn_control_since_ms: entry.awaiting_input_since_ms
    };
  }
  return {
    turn_control_state: 'agent_turn',
    turn_control_reason_code: null,
    turn_control_since_ms: entry.last_progress_transition_at_ms ?? entry.started_at_ms
  };
}

export function resolveBlockedTurnControl(entry: BlockedEntry): {
  turn_control_state: TurnControlState;
  turn_control_reason_code: string | null;
  turn_control_since_ms: number | null;
} {
  return {
    turn_control_state: 'blocked_manual_resume',
    turn_control_reason_code: entry.awaiting_operator_reason_code ?? entry.stop_reason_code,
    turn_control_since_ms: entry.awaiting_operator_since_ms ?? entry.blocked_at_ms
  };
}

export function resolveProgressSignal(entry: RunningEntry): {
  progress_signal_state: ProgressSignalState;
  last_progress_transition_at_ms: number | null;
  last_heartbeat_at_ms: number | null;
} {
  if (entry.stalled_waiting_reason) {
    return {
      progress_signal_state: 'stalled_waiting',
      last_progress_transition_at_ms: entry.last_progress_transition_at_ms ?? null,
      last_heartbeat_at_ms: entry.last_heartbeat_at_ms ?? entry.last_codex_timestamp_ms ?? null
    };
  }
  if (entry.last_event === CANONICAL_EVENT.codex.turnWaiting) {
    return {
      progress_signal_state: 'heartbeat_only',
      last_progress_transition_at_ms: entry.last_progress_transition_at_ms ?? null,
      last_heartbeat_at_ms: entry.last_heartbeat_at_ms ?? entry.last_codex_timestamp_ms ?? null
    };
  }
  return {
    progress_signal_state: 'advancing',
    last_progress_transition_at_ms: entry.last_progress_transition_at_ms ?? entry.started_at_ms,
    last_heartbeat_at_ms: entry.last_heartbeat_at_ms ?? null
  };
}

export function resolveNotBlockedExplainer(params: {
  blocked: boolean;
  progress_signal_state: ProgressSignalState;
  awaiting_input: boolean;
  waiting_started_at_ms: number | null;
  now_ms: number;
  stalled_waiting_ms: number;
}): { not_blocked_explainer_code: NotBlockedExplainerCode; not_blocked_explainer_text: string | null } {
  if (params.blocked || params.progress_signal_state === 'advancing') {
    return { not_blocked_explainer_code: null, not_blocked_explainer_text: null };
  }
  if (params.awaiting_input) {
    return {
      not_blocked_explainer_code: 'awaiting_classifier_transition',
      not_blocked_explainer_text: 'The run is awaiting operator input but has not yet transitioned to blocked manual resume.'
    };
  }
  if (params.progress_signal_state === 'heartbeat_only') {
    return {
      not_blocked_explainer_code: 'within_wait_threshold',
      not_blocked_explainer_text: 'The run is emitting waiting heartbeats and remains within the configured blocked-transition threshold.'
    };
  }
  const elapsedMs = params.waiting_started_at_ms ? params.now_ms - params.waiting_started_at_ms : null;
  if (elapsedMs !== null && elapsedMs >= params.stalled_waiting_ms) {
    return {
      not_blocked_explainer_code: 'active_turn_no_stop_reason',
      not_blocked_explainer_text: 'The run is stalled waiting, but no terminal stop reason or manual-resume condition has been emitted.'
    };
  }
  return {
    not_blocked_explainer_code: 'awaiting_classifier_transition',
    not_blocked_explainer_text: 'The run is waiting for the runtime classifier to confirm whether manual intervention is required.'
  };
}

export function resolveSnapshotFreshness(snapshotGeneratedAtMs: number, nowMs: number): {
  snapshot_generated_at_ms: number;
  snapshot_age_ms: number;
  snapshot_freshness_state: SnapshotFreshnessState;
} {
  const ageMs = Math.max(0, nowMs - snapshotGeneratedAtMs);
  return {
    snapshot_generated_at_ms: snapshotGeneratedAtMs,
    snapshot_age_ms: ageMs,
    snapshot_freshness_state: ageMs <= SNAPSHOT_FRESH_MS ? 'fresh' : ageMs <= SNAPSHOT_AGING_MS ? 'aging' : 'stale'
  };
}

export function resolveTokenTelemetryQuality(entry: {
  token_telemetry_status: 'unavailable' | 'pending' | 'available';
  token_telemetry_last_source: string | null;
  token_telemetry_last_at_ms: number | null;
}): {
  token_telemetry_confidence: TokenTelemetryConfidence;
  token_telemetry_source: string | null;
  token_telemetry_last_observed_at_ms: number | null;
} {
  if (entry.token_telemetry_status === 'available') {
    const source = entry.token_telemetry_last_source ?? null;
    return {
      token_telemetry_confidence:
        source === 'codex_home_state_sqlite' || source === 'codex_home_state_sqlite_aggregate' ? 'backfilled' : 'observed_live',
      token_telemetry_source: source,
      token_telemetry_last_observed_at_ms: entry.token_telemetry_last_at_ms ?? null
    };
  }
  return {
    token_telemetry_confidence: 'missing',
    token_telemetry_source: entry.token_telemetry_last_source ?? null,
    token_telemetry_last_observed_at_ms: entry.token_telemetry_last_at_ms ?? null
  };
}

export function cloneOperatorAction(action: OperatorActionRecord): OperatorActionRecord {
  return { ...action };
}

export function createApiDegradedDiagnostics(
  reason: ApiDegradedReasonCode,
  routes: string[]
): { api_degraded_mode: boolean; api_degraded_reason_code: ApiDegradedReasonCode; api_degraded_routes: string[] } {
  return {
    api_degraded_mode: reason !== null,
    api_degraded_reason_code: reason,
    api_degraded_routes: [...routes]
  };
}
