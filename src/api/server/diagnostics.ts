import { REASON_CODES } from '../../observability';
import { EVENT_VOCABULARY_VERSION } from '../../observability/events';
import { LocalApiError } from '../errors';
import type { SnapshotService } from '../snapshot-service';
import type {
  ApiDiagnosticsResponse,
  ApiRuntimeRestartStatus,
  ApiStateErrorResponse,
  ApiStateResponse,
  LocalApiServerOptions
} from '../types';
import type { StreamDiagnosticsState } from './event-stream';
import { summarizeTokenTelemetry } from './token-enrichment';

export interface TimedDiagnosticsPayload {
  payload: ApiDiagnosticsResponse;
  projectionDurationMs: number | null;
  enrichmentDurationMs: number | null;
  enrichmentStatus: string | null;
  enrichmentDegraded: boolean | null;
  enrichmentReasonCode: string | null;
}

export function buildDiagnosticsPayload(options: {
  diagnosticsSource: LocalApiServerOptions['diagnosticsSource'];
  snapshotSource: LocalApiServerOptions['snapshotSource'];
  snapshotService: SnapshotService;
  nowMs: () => number;
  streamDiagnostics: StreamDiagnosticsState;
  liveClientCount: number;
  controlPlaneSummary: () => ApiDiagnosticsResponse['control_plane'];
  enrichLiveTokenFallbackState: (payload: ApiStateResponse) => ApiDiagnosticsResponse['token_enrichment'];
  readUpdateReadiness?: () => ApiDiagnosticsResponse['runtime_update'];
  readRestartStatus?: () => ApiRuntimeRestartStatus;
}): TimedDiagnosticsPayload {
  if (!options.diagnosticsSource) {
    throw new LocalApiError('diagnostics_unavailable', 'Diagnostics source is not configured', 503);
  }

  const projectionStartedAtMs = options.nowMs();
  let observedDimensions = {
    cached_input_tokens: false,
    reasoning_output_tokens: false,
    model_context_window: false
  };
  let tokenTelemetry: Pick<
    ApiDiagnosticsResponse,
    'token_telemetry_status' | 'token_telemetry_last_source' | 'token_telemetry_last_at_ms'
  > = {
    token_telemetry_status: 'unavailable',
    token_telemetry_last_source: null,
    token_telemetry_last_at_ms: null
  };
  let tokenEnrichment: ApiDiagnosticsResponse['token_enrichment'] = {
    status: 'not_required',
    degraded: false,
    reason_code: null,
    duration_ms: 0
  };
  let drainMode: ApiDiagnosticsResponse['drain_mode'] = {
    active: false,
    entered_at: null,
    entered_at_ms: null,
    updated_at: null,
    updated_at_ms: null,
    reason: null
  };
  let quiescence: ApiDiagnosticsResponse['quiescence'] = {
    safe_to_shutdown: true,
    state: 'safe',
    updated_at: new Date(projectionStartedAtMs).toISOString(),
    updated_at_ms: projectionStartedAtMs,
    blockers: [],
    blocker_counts: {
      active_worker: 0,
      live_codex_app_server_process: 0,
      pending_retry: 0,
      in_flight_tracker_write: 0,
      persistence_history_write: 0,
      unknown_degraded_blocker_source_health: 0,
      stale_runtime: 0,
      unknown_current_build_identity: 0
    },
    warnings: [],
    restart_guidance: {
      safe_to_restart: true,
      recommended_action: 'none',
      pending_work: [],
      detail: 'Runtime is safe to restart.'
    }
  };
  let runtimeIdentity: ApiDiagnosticsResponse['runtime_identity'] = null;
  let projectionDurationMs: number | null = null;
  let enrichmentDurationMs: number | null = null;
  try {
    const snapshot = options.snapshotSource.getStateSnapshot({ includeTranscriptToolCallDiagnostics: false });
    const projected = options.snapshotService.projectState(snapshot);
    runtimeIdentity = projected.runtime_identity;
    drainMode = options.snapshotService.projectDrainMode(snapshot);
    quiescence = options.snapshotService.projectQuiescence(snapshot);
    projectionDurationMs = options.nowMs() - projectionStartedAtMs;
    const enrichmentStartedAtMs = options.nowMs();
    tokenEnrichment = options.enrichLiveTokenFallbackState(projected);
    enrichmentDurationMs = options.nowMs() - enrichmentStartedAtMs;
    tokenEnrichment = {
      ...tokenEnrichment,
      duration_ms: Math.max(0, Math.round(enrichmentDurationMs))
    };
    observedDimensions = {
      cached_input_tokens: typeof projected.codex_totals.cached_input_tokens === 'number',
      reasoning_output_tokens: typeof projected.codex_totals.reasoning_output_tokens === 'number',
      model_context_window: typeof projected.codex_totals.model_context_window === 'number'
    };
    tokenTelemetry = summarizeTokenTelemetry(projected);
  } catch {
    // Diagnostics should remain available even when state snapshotting is degraded.
    projectionDurationMs = options.nowMs() - projectionStartedAtMs;
    tokenEnrichment = {
      status: 'degraded',
      degraded: true,
      reason_code: REASON_CODES.stateProjectionUnavailable,
      duration_ms: 0
    };
  }

  const runtimeResolution = options.diagnosticsSource.getRuntimeResolution();

  const payload: ApiDiagnosticsResponse = {
    runtime_identity: runtimeIdentity,
    drain_mode: drainMode,
    quiescence,
    active_profile: options.diagnosticsSource.getActiveProfile(),
    persistence: options.diagnosticsSource.getPersistenceHealth(),
    logging: options.diagnosticsSource.getLoggingHealth(),
    event_vocabulary_version: EVENT_VOCABULARY_VERSION,
    token_accounting: {
      mode: 'strict_canonical',
      canonical_precedence: [
        'terminal_turn_summary',
        'thread/tokenUsage/updated.params.tokenUsage.total',
        'params.info.total_token_usage',
        'params.info.totalTokenUsage',
        'params.total_token_usage',
        'params.totalTokenUsage',
        'params.usage.total_token_usage',
        'params.usage.totalTokenUsage',
        'last_token_usage',
        'persisted_fallback_usage'
      ],
      excludes_generic_usage_for_totals: true,
      excludes_last_usage_for_totals: false,
      no_telemetry_warning_threshold_ms: 120_000,
      optional_dimensions: [
        'cached_input_tokens',
        'reasoning_output_tokens',
        'model_context_window'
      ],
      observed_dimensions: observedDimensions
    },
    ...tokenTelemetry,
    token_enrichment: tokenEnrichment,
    workflow: {
      prompt_fallback_active: options.diagnosticsSource.getPromptFallbackActive()
    },
    phase_markers: options.diagnosticsSource.getPhaseMarkers
      ? options.diagnosticsSource.getPhaseMarkers()
      : {
          enabled: true,
          timeline_limit: 30,
          last_emit_error_code: null
        },
    breaker_statuses: options.diagnosticsSource.getBreakerStatuses
      ? options.diagnosticsSource.getBreakerStatuses()
      : [],
    blocked_latch: options.diagnosticsSource.getBlockedLatchStats
      ? options.diagnosticsSource.getBlockedLatchStats()
      : {
          blocked_latch_active_count: 0,
          blocked_event_quarantine_total: 0,
          blocked_event_allowlist_total: 0,
          blocked_event_reject_total: 0,
          blocked_latch_violation_total: 0
        },
    stream: {
      live_client_count: options.liveClientCount,
      last_client_connected_at:
        options.streamDiagnostics.lastClientConnectedAtMs === null
          ? null
          : new Date(options.streamDiagnostics.lastClientConnectedAtMs).toISOString(),
      last_client_disconnected_at:
        options.streamDiagnostics.lastClientDisconnectedAtMs === null
          ? null
          : new Date(options.streamDiagnostics.lastClientDisconnectedAtMs).toISOString(),
      last_snapshot_broadcast_at:
        options.streamDiagnostics.lastSnapshotBroadcastAtMs === null
          ? null
          : new Date(options.streamDiagnostics.lastSnapshotBroadcastAtMs).toISOString(),
      last_snapshot_broadcast_latency_ms: options.streamDiagnostics.lastSnapshotBroadcastLatencyMs,
      last_snapshot_broadcast_status: options.streamDiagnostics.lastSnapshotBroadcastStatus,
      last_snapshot_broadcast_error: options.streamDiagnostics.lastSnapshotBroadcastError
    },
    control_plane: options.controlPlaneSummary(),
    runtime_resolution: {
      ...runtimeResolution,
      effective_codex_home: runtimeResolution.effective_codex_home ?? null,
      effective_codex_model: runtimeResolution.effective_codex_model ?? null,
      effective_reasoning_effort: runtimeResolution.effective_reasoning_effort ?? null,
      effective_extra_flags_count: runtimeResolution.effective_extra_flags_count ?? 0,
      codex_resolution_mode: runtimeResolution.codex_resolution_mode ?? 'typed'
    },
    workspace_provisioner: options.diagnosticsSource.getWorkspaceProvisioner(),
    workspace_copy_ignored: options.diagnosticsSource.getWorkspaceCopyIgnored(),
    runtime_update: options.readUpdateReadiness ? options.readUpdateReadiness() : null,
    runtime_restart: options.readRestartStatus
      ? options.readRestartStatus()
      : {
          capability: {
            mode: 'manual_restart_required',
            available: false,
            reason_code: REASON_CODES.runtimeUpdateRestartWrapperUnavailable,
            detail: 'Symphony is not running under the local restart supervisor.'
          },
          phase: 'manual_restart_required',
          attempt_id: null,
          requested_at: null,
          started_at: null,
          completed_at: null,
          failed_at: null,
          old_child_pid: null,
          new_child_pid: null,
          target_commit_sha: null,
          observed_running_commit_sha: null,
          recommended_manual_recovery: 'Restart Symphony with the supported supervisor command or rerun npm run start:dashboard manually.',
          last_error: null
        }
  };
  return {
    payload,
    projectionDurationMs,
    enrichmentDurationMs,
    enrichmentStatus: tokenEnrichment.status,
    enrichmentDegraded: tokenEnrichment.degraded,
    enrichmentReasonCode: tokenEnrichment.reason_code
  };
}
