import type { OrchestratorState, TickReason } from '../orchestrator';
import type { StructuredLogger } from '../observability';
import type { DurableRunHistoryRecord, PersistenceHealth, UiContinuityState } from '../persistence';
import type { SecurityProfile } from '../security';

export interface RuntimeSnapshotSource {
  getStateSnapshot(): OrchestratorState;
}

export interface RefreshTickSource {
  tick(reason: TickReason): Promise<void>;
}

export interface DiagnosticsSource {
  getActiveProfile(): SecurityProfile;
  getPersistenceHealth(): PersistenceHealth;
  listRunHistory(limit?: number): DurableRunHistoryRecord[];
  getLoggingHealth(): {
    root: string;
    active_file: string;
    rotation: {
      max_bytes: number;
      max_files: number;
    };
    sinks: string[];
  };
  getUiState(): UiContinuityState | null;
  setUiState(state: UiContinuityState): void;
  getPromptFallbackActive(): boolean;
  getRuntimeResolution(): {
    workflow_path: string;
    workflow_dir: string;
    workspace_root: string;
    workspace_root_source: 'workflow' | 'default';
    server: {
      host: string;
      port: number | null;
    };
    provisioner_type: string;
    repo_root: string | null;
    base_ref: string | null;
    branch_name_template: string | null;
  };
  getWorkspaceProvisioner(): {
    provisioner_type: string;
    repo_root: string | null;
    base_ref: string | null;
    branch_name_template: string | null;
    last_provision_result: 'provisioned' | 'reused' | 'skipped' | 'failed' | null;
    last_teardown_result: 'removed' | 'kept' | 'skipped' | 'failed' | null;
    last_error_code: string | null;
    last_verification_result: 'verified' | 'reprovisioned' | 'failed' | null;
    last_cleanup_on_failure_result: 'cleaned' | 'cleanup_failed' | 'not_attempted' | null;
    verification_mode: 'strict' | 'none';
  };
}

export interface LocalApiErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}

export interface ApiStateResponse {
  generated_at: string;
  counts: {
    running: number;
    retrying: number;
    blocked: number;
  };
  running: Array<{
    issue_id: string;
    issue_identifier: string;
    state: string;
    session_id: string | null;
    worker_host: string | null;
    workspace_path: string | null;
    provisioner_type: string | null;
    branch_name: string | null;
    repo_root: string | null;
    workspace_exists: boolean;
    workspace_git_status: 'clean' | 'dirty' | 'unknown' | null;
    workspace_provisioned: boolean;
    workspace_is_git_worktree: boolean;
    thread_id: string | null;
    turn_id: string | null;
    codex_app_server_pid: string | null;
    turn_count: number;
    last_event: string | null;
    last_event_summary: string | null;
    last_message: string | null;
    started_at: string;
    last_event_at: string | null;
    tokens: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      cached_input_tokens?: number;
      reasoning_output_tokens?: number;
      model_context_window?: number;
    };
  }>;
  retrying: Array<{
    issue_id: string;
    issue_identifier: string;
    attempt: number;
    due_at: string;
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
    stop_reason_code: string | null;
    stop_reason_detail: string | null;
    previous_thread_id: string | null;
    previous_session_id: string | null;
  }>;
  blocked: Array<{
    issue_id: string;
    issue_identifier: string;
    attempt: number;
    blocked_at: string;
    worker_host: string | null;
    workspace_path: string | null;
    provisioner_type: string | null;
    branch_name: string | null;
    repo_root: string | null;
    workspace_exists: boolean;
    workspace_git_status: 'clean' | 'dirty' | 'unknown' | null;
    workspace_provisioned: boolean;
    workspace_is_git_worktree: boolean;
    stop_reason_code: string;
    stop_reason_detail: string | null;
    previous_thread_id: string | null;
    previous_session_id: string | null;
    requires_manual_resume: true;
  }>;
  codex_totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cached_input_tokens?: number;
    reasoning_output_tokens?: number;
    model_context_window?: number;
    seconds_running: number;
  };
  rate_limits: Record<string, unknown> | null;
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
    at: string;
    event: string;
    severity: 'info' | 'warn' | 'error';
    issue_identifier?: string;
    session_id?: string;
    detail?: string;
  }>;
}

export type ApiStateErrorCode = 'snapshot_timeout' | 'snapshot_unavailable';

export interface ApiStateErrorResponse {
  generated_at: string;
  error: {
    code: ApiStateErrorCode;
    message: string;
  };
}

export type ApiStateSnapshotResponse = ApiStateResponse | ApiStateErrorResponse;

export interface ApiIssueResponse {
  issue_identifier: string;
  issue_id: string;
  status: 'running' | 'retrying' | 'blocked';
  workspace: {
    path: string | null;
    host: string | null;
  };
  attempts: {
    restart_count: number;
    current_retry_attempt: number;
  };
  running: {
    session_id: string | null;
    worker_host: string | null;
    workspace_path: string | null;
    provisioner_type: string | null;
    branch_name: string | null;
    repo_root: string | null;
    workspace_exists: boolean;
    workspace_git_status: 'clean' | 'dirty' | 'unknown' | null;
    workspace_provisioned: boolean;
    workspace_is_git_worktree: boolean;
    thread_id: string | null;
    turn_id: string | null;
    codex_app_server_pid: string | null;
    turn_count: number;
    state: string;
    started_at: string;
    last_event: string | null;
    last_event_summary: string | null;
    last_message: string | null;
    last_event_at: string | null;
    tokens: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      cached_input_tokens?: number;
      reasoning_output_tokens?: number;
      model_context_window?: number;
    };
  } | null;
  retry: {
    attempt: number;
    due_at: string;
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
    stop_reason_code: string | null;
    stop_reason_detail: string | null;
    previous_thread_id: string | null;
    previous_session_id: string | null;
  } | null;
  blocked: {
    attempt: number;
    blocked_at: string;
    worker_host: string | null;
    workspace_path: string | null;
    provisioner_type: string | null;
    branch_name: string | null;
    repo_root: string | null;
    workspace_exists: boolean;
    workspace_git_status: 'clean' | 'dirty' | 'unknown' | null;
    workspace_provisioned: boolean;
    workspace_is_git_worktree: boolean;
    stop_reason_code: string;
    stop_reason_detail: string | null;
    previous_thread_id: string | null;
    previous_session_id: string | null;
    requires_manual_resume: true;
  } | null;
  recent_events: Array<{
    at: string;
    event: string;
    message: string | null;
  }>;
  last_error: string | null;
  logs: {
    codex_session_logs: string[];
  };
  tracked: Record<string, unknown>;
}

export interface ApiRefreshAcceptedResponse {
  queued: true;
  coalesced: boolean;
  requested_at: string;
  operations: ['poll', 'reconcile'];
}

export type ApiEventType = 'state_snapshot' | 'refresh_accepted' | 'runtime_health_changed' | 'heartbeat';

export interface ApiEventEnvelope {
  event_id: number;
  generated_at: string;
  type: ApiEventType;
  payload: unknown;
}

export interface LocalApiServerOptions {
  host?: string;
  port?: number;
  snapshotSource: RuntimeSnapshotSource;
  refreshSource: RefreshTickSource;
  diagnosticsSource?: DiagnosticsSource;
  workflowControlSource?: {
    switchWorkflowPath: (workflowPath: string) => Promise<{
      workflow_path: string;
      applied: boolean;
      error?: string;
    }>;
    forceReload: () => Promise<{
      workflow_path: string;
      applied: boolean;
      error?: string;
    }>;
  };
  issueControlSource?: {
    resumeBlockedIssue: (issueIdentifier: string) => Promise<
      { ok: true; issue_id: string } | { ok: false; code: string; message: string }
    >;
  };
  dashboardConfig?: {
    dashboard_enabled: boolean;
    refresh_ms: number;
    render_interval_ms: number;
  };
  nowMs?: () => number;
  logger?: StructuredLogger;
}

export interface ApiDiagnosticsResponse {
  active_profile: SecurityProfile;
  persistence: PersistenceHealth;
  logging: {
    root: string;
    active_file: string;
    rotation: {
      max_bytes: number;
      max_files: number;
    };
    sinks: string[];
  };
  event_vocabulary_version: string;
  token_accounting: {
    mode: 'strict_canonical';
    canonical_precedence: [
      'thread/tokenUsage/updated.params.tokenUsage.total',
      'params.info.total_token_usage',
      'params.info.totalTokenUsage',
      'params.total_token_usage',
      'params.totalTokenUsage'
    ];
    excludes_generic_usage_for_totals: true;
    excludes_last_usage_for_totals: true;
    optional_dimensions: ['cached_input_tokens', 'reasoning_output_tokens', 'model_context_window'];
    observed_dimensions: {
      cached_input_tokens: boolean;
      reasoning_output_tokens: boolean;
      model_context_window: boolean;
    };
  };
  workflow: {
    prompt_fallback_active: boolean;
  };
  runtime_resolution: {
    workflow_path: string;
    workflow_dir: string;
    workspace_root: string;
    workspace_root_source: 'workflow' | 'default';
    server: {
      host: string;
      port: number | null;
    };
    provisioner_type: string;
    repo_root: string | null;
    base_ref: string | null;
    branch_name_template: string | null;
  };
  workspace_provisioner: {
    provisioner_type: string;
    repo_root: string | null;
    base_ref: string | null;
    branch_name_template: string | null;
    last_provision_result: 'provisioned' | 'reused' | 'skipped' | 'failed' | null;
    last_teardown_result: 'removed' | 'kept' | 'skipped' | 'failed' | null;
    last_error_code: string | null;
    last_verification_result: 'verified' | 'reprovisioned' | 'failed' | null;
    last_cleanup_on_failure_result: 'cleaned' | 'cleanup_failed' | 'not_attempted' | null;
    verification_mode: 'strict' | 'none';
  };
}
