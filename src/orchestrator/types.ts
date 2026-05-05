import type { Issue, TrackerAdapter } from '../tracker';
import type { CodexUsageTotals, TokenTelemetryStatus } from '../codex';
import type { StructuredLogger } from '../observability';
import type { PhaseMarker, PhaseMarkerName } from '../observability';
import type { RunTerminalStatus } from '../persistence';

export type TickReason = 'startup' | 'interval' | 'manual_refresh' | 'retry_timer';
export type WorkerExitReason = 'normal' | 'abnormal';
export type RetryDelayType = 'continuation' | 'failure';

export interface RunningEntry {
  issue: Issue;
  identifier: string;
  run_id: string | null;
  worker_handle: unknown;
  monitor_handle: unknown;
  retry_attempt: number;
  workspace_path: string | null;
  worker_host?: string | null;
  provisioner_type: string | null;
  branch_name: string | null;
  repo_root: string | null;
  workspace_exists: boolean;
  workspace_git_status: 'clean' | 'dirty' | 'unknown' | null;
  workspace_provisioned: boolean;
  workspace_is_git_worktree: boolean;
  copy_ignored_applied?: boolean;
  copy_ignored_status?: 'skipped' | 'success' | 'failed' | null;
  copy_ignored_summary?:
    | {
        copied_files: number;
        skipped_existing: number;
        blocked_files: number;
        bytes_copied: number;
        duration_ms: number;
      }
    | null;
  session_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  codex_app_server_pid: string | null;
  turn_count: number;
  last_event: string | null;
  last_event_summary: string | null;
  last_message: string | null;
  awaiting_input_since_ms?: number | null;
  pending_input_preview?: {
    type: string;
    prompt_preview: string | null;
    option_count: number | null;
  } | null;
  stalled_waiting_since_ms?: number | null;
  stalled_waiting_reason?: 'turn_waiting_threshold_exceeded' | null;
  tokens: CodexUsageTotals;
  last_reported_tokens: CodexUsageTotals;
  token_telemetry_status: TokenTelemetryStatus;
  token_telemetry_last_source: string | null;
  token_telemetry_last_at_ms: number | null;
  token_telemetry_turn_started_at_ms: number | null;
  token_telemetry_warning_emitted: boolean;
  recent_events: Array<{
    at_ms: number;
    event: string;
    message: string | null;
  }>;
  started_at_ms: number;
  last_codex_timestamp_ms: number | null;
  current_phase?: PhaseMarkerName | null;
  current_phase_at_ms?: number | null;
  phase_detail?: string | null;
}

export interface RetryEntry {
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at_ms: number;
  error: string | null;
  worker_host: string | null;
  workspace_path: string | null;
  provisioner_type: string | null;
  branch_name: string | null;
  repo_root: string | null;
  workspace_exists: boolean;
  workspace_git_status: 'clean' | 'dirty' | 'unknown' | null;
  workspace_provisioned: boolean;
  workspace_is_git_worktree: boolean;
  copy_ignored_applied?: boolean;
  copy_ignored_status?: 'skipped' | 'success' | 'failed' | null;
  copy_ignored_summary?:
    | {
        copied_files: number;
        skipped_existing: number;
        blocked_files: number;
        bytes_copied: number;
        duration_ms: number;
      }
    | null;
  stop_reason_code: string | null;
  stop_reason_detail: string | null;
  previous_thread_id: string | null;
  previous_session_id: string | null;
  last_phase?: PhaseMarkerName | null;
  last_phase_at_ms?: number | null;
  last_phase_detail?: string | null;
  timer_handle: unknown;
  progress_signals?: {
    commit_sha: string | null;
    checklist_checkpoint: string | null;
    state_marker: string | null;
  };
}

export interface RedispatchProgressSample {
  at_ms: number;
  commit_sha: string | null;
  checklist_checkpoint: string | null;
  state_marker: string | null;
  pr_open: boolean;
}

export interface BlockedEntry {
  issue_id: string;
  issue_identifier: string;
  attempt: number;
  worker_host: string | null;
  workspace_path: string | null;
  provisioner_type: string | null;
  branch_name: string | null;
  repo_root: string | null;
  workspace_exists: boolean;
  workspace_git_status: 'clean' | 'dirty' | 'unknown' | null;
  workspace_provisioned: boolean;
  workspace_is_git_worktree: boolean;
  copy_ignored_applied?: boolean;
  copy_ignored_status?: 'skipped' | 'success' | 'failed' | null;
  copy_ignored_summary?:
    | {
        copied_files: number;
        skipped_existing: number;
        blocked_files: number;
        bytes_copied: number;
        duration_ms: number;
      }
    | null;
  stop_reason_code: string;
  stop_reason_detail: string | null;
  conflict_files: Array<{
    path: string;
    status: 'staged' | 'unstaged' | 'unknown';
    classification?: 'ephemeral' | 'tracked_ephemeral' | 'unknown_non_ephemeral';
  }>;
  classification_summary?: {
    ephemeral: number;
    tracked_ephemeral: number;
    unknown_non_ephemeral: number;
  };
  resolution_hints: string[];
  previous_thread_id: string | null;
  previous_session_id: string | null;
  last_phase?: PhaseMarkerName | null;
  last_phase_at_ms?: number | null;
  last_phase_detail?: string | null;
  blocked_at_ms: number;
  requires_manual_resume: true;
  awaiting_operator?: true;
  awaiting_operator_reason_code?: string;
  awaiting_operator_since_ms?: number;
  awaiting_operator_resume_nonce?: number;
  attempt_count_window?: number;
  window_minutes?: number;
  last_known_commit_sha?: string | null;
  last_progress_checkpoint_at?: number | null;
  progress_signals?: {
    commit_sha: string | null;
    checklist_checkpoint: string | null;
    state_marker: string | null;
  };
  required_actions?: string[];
  resume_override_reason?: string | null;
  pending_input?: {
    request_id: string | null;
    request_method: string | null;
    prompt_text: string | null;
    questions: Array<{
      id: string;
      prompt?: string;
      options?: Array<{ label: string; value?: string }>;
    }>;
    input_schema_type: 'options' | 'text' | 'unknown';
    input_required_at_ms: number;
  } | null;
  last_input_submit?: {
    submitted_at_ms: number;
    request_id: string;
    resume_mode: 'native' | 'fallback';
    resume_reason_code: string;
  } | null;
  resume_history?: Array<{
    submitted_at_ms: number;
    request_id: string;
    resume_mode: 'native' | 'fallback';
    resume_reason_code: string;
    previous_thread_id: string | null;
    previous_session_id: string | null;
  }>;
  session_console?: Array<{
    at_ms: number;
    event: string;
    message: string | null;
  }>;
  quarantined_events?: Array<{
    at_ms: number;
    event: string;
    message: string | null;
    session_id: string | null;
    thread_id: string | null;
    turn_id: string | null;
    reason: 'awaiting_operator_latch' | 'lineage_mismatch';
  }>;
  quarantined_event_count?: number;
  last_quarantined_event_at_ms?: number | null;
}

export interface CircuitBreakerEntry {
  issue_id: string;
  issue_identifier: string;
  breaker_active: boolean;
  breaker_hit_count: number;
  breaker_window_minutes: number;
  breaker_first_hit_at_ms: number | null;
  breaker_last_hit_at_ms: number | null;
}

export interface OrchestratorState {
  poll_interval_ms: number;
  max_concurrent_agents: number;
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retry_attempts: Map<string, RetryEntry>;
  blocked_inputs: Map<string, BlockedEntry>;
  circuit_breakers: Map<string, CircuitBreakerEntry>;
  redispatch_progress?: Map<string, RedispatchProgressSample[]>;
  phase_timeline?: Map<string, PhaseMarker[]>;
  completed: Set<string>;
  codex_totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cached_input_tokens?: number;
    reasoning_output_tokens?: number;
    model_context_window?: number;
    seconds_running: number;
  };
  codex_rate_limits: Record<string, unknown> | null;
  health: {
    dispatch_validation: 'ok' | 'failed';
    last_error: string | null;
  };
  throughput: {
    current_tps: number;
    avg_tps_60s: number;
    window_seconds: number;
    sparkline_10m: number[];
    sample_count: number;
  };
  recent_runtime_events: Array<{
    at_ms: number;
    event: string;
    severity: 'info' | 'warn' | 'error';
    issue_identifier?: string;
    session_id?: string;
    detail?: string;
  }>;
}

export interface DispatchPreflightResult {
  dispatch_allowed: boolean;
  reason?: string;
}

export interface SpawnWorkerResultSuccess {
  ok: true;
  worker_handle: unknown;
  monitor_handle: unknown;
  workspace_path?: string | null;
  worker_host?: string | null;
  provisioner_type?: string | null;
  branch_name?: string | null;
  repo_root?: string | null;
  workspace_exists?: boolean;
  workspace_git_status?: 'clean' | 'dirty' | 'unknown' | null;
  workspace_provisioned?: boolean;
  workspace_is_git_worktree?: boolean;
  copy_ignored_applied?: boolean;
  copy_ignored_status?: 'skipped' | 'success' | 'failed' | null;
  copy_ignored_summary?:
    | {
        copied_files: number;
        skipped_existing: number;
        blocked_files: number;
        bytes_copied: number;
        duration_ms: number;
      }
    | null;
}

export interface SpawnWorkerResultFailure {
  ok: false;
  error: string;
}

export type SpawnWorkerResult = SpawnWorkerResultSuccess | SpawnWorkerResultFailure;

export interface OrchestratorPorts {
  tracker: TrackerAdapter;
  dispatchPreflight: () => DispatchPreflightResult;
  spawnWorker: (params: {
    issue: Issue;
    attempt: number | null;
    worker_host?: string | null;
    resume_context?: string | null;
  }) => Promise<SpawnWorkerResult>;
  terminateWorker: (params: {
    issue_id: string;
    worker_handle: unknown;
    cleanup_workspace: boolean;
    reason: string;
  }) => Promise<void>;
  scheduleRetryTimer: (params: {
    issue_id: string;
    due_at_ms: number;
    callback: () => Promise<void>;
  }) => unknown;
  cancelRetryTimer: (timer_handle: unknown) => void;
  submitBlockedIssueInputNative?: (params: {
    issue_id: string;
    issue_identifier: string;
    request_id: string;
    request_method: string | null;
    previous_thread_id: string | null;
    previous_session_id: string | null;
    answer: { question_id?: string; option_label?: string; text?: string };
  }) => Promise<{
    applied: boolean;
    code:
      | 'native_applied'
      | 'session_expired'
      | 'request_not_found'
      | 'transport_unsupported'
      | 'native_submit_failed';
    message?: string;
    resume_context?: string;
  }>;
  resolveProgressSignals?: (params: {
    issue: Issue | null;
    issue_id: string;
    branch_name: string | null;
    repo_root: string | null;
    fallback_state_marker: string | null;
  }) => Promise<{
    commit_sha: string | null;
    checklist_checkpoint: string | null;
    state_marker: string | null;
  }>;
  notifyObservers?: () => void;
}

export interface PhaseMarkerSettings {
  enabled: boolean;
  timeline_limit: number;
  last_emit_error_code: string | null;
}

export interface OrchestratorPersistencePort {
  startRun: (params: { issue_id: string; issue_identifier: string }) => Promise<string>;
  recordSession: (params: { run_id: string; session_id: string }) => Promise<void>;
  recordEvent: (params: {
    run_id: string;
    timestamp_ms: number;
    event: string;
    message: string | null;
  }) => Promise<void>;
  completeRun: (params: { run_id: string; terminal_status: RunTerminalStatus; error_code?: string | null }) => Promise<void>;
  upsertBreaker?: (params: {
    issue_id: string;
    issue_identifier: string;
    breaker_active: boolean;
    breaker_hit_count: number;
    breaker_window_minutes: number;
    breaker_first_hit_at: string | null;
    breaker_last_hit_at: string | null;
  }) => Promise<void>;
  deleteBreaker?: (issue_id: string) => Promise<void>;
  upsertBlockedInput?: (issue_id: string, payload: string) => Promise<void>;
  deleteBlockedInput?: (issue_id: string) => Promise<void>;
}

export interface WorkerObservabilityEvent {
  timestamp_ms: number;
  event: string;
  thread_id?: string;
  turn_id?: string;
  session_id?: string;
  codex_app_server_pid?: number | null;
  detail?: string;
  usage?: CodexUsageTotals;
  token_telemetry_status?: TokenTelemetryStatus;
  token_telemetry_last_source?: string | null;
  token_telemetry_last_at_ms?: number | null;
  rate_limits?: Record<string, unknown> | null;
}

export interface OrchestratorConfig {
  poll_interval_ms: number;
  max_concurrent_agents: number;
  max_concurrent_agents_by_state: Record<string, number>;
  max_retry_backoff_ms: number;
  respawn_window_minutes?: number;
  respawn_max_attempts_without_progress?: number;
  active_states: string[];
  terminal_states: string[];
  github_linking_mode?: 'off' | 'warn' | 'required' | string;
  stall_timeout_ms: number;
  no_telemetry_warning_threshold_ms?: number;
  running_wait_stall_threshold_ms?: number;
  phase_markers_enabled?: boolean;
  phase_timeline_limit?: number;
  worker_hosts?: string[];
  max_concurrent_agents_per_host?: number | null;
}

export interface OrchestratorOptions {
  config: OrchestratorConfig;
  ports: OrchestratorPorts;
  persistence?: OrchestratorPersistencePort;
  nowMs?: () => number;
  logger?: StructuredLogger;
}
