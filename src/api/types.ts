import type { OrchestratorState, StateSnapshotOptions, TickReason, ToolCallEvidenceSource, ToolCallCompletionStatus } from '../orchestrator';
import type { CodexModelRerouteEvidence, CodexProtocolWarningEvidence } from '../codex';
import type { CodexAppServerThreadActivitySource } from '../codex/app-server-protocol';
import type { OperatorExplainer, OperatorExplainerHint, PhaseMarkerName } from '../observability';
import { REASON_CODES } from '../observability/reason-codes';
import type { StructuredLogger } from '../observability';
import type {
  DurableIdentity,
  DurableRunHistoryRecord,
  ExecutionGraphThreadLineage,
  PersistenceHealth,
  ProjectHistoryTicketSummaryPage,
  TicketTimelineRecord,
  UiContinuityState
} from '../persistence';
import type { SecurityProfile } from '../security';
import type { ControlPlaneHealthRecorder, ControlPlaneHealthSummary, ControlPlaneThresholds } from './control-plane-health';

export type TurnControlState = 'agent_turn' | 'operator_turn' | 'blocked_manual_resume';
export type ProgressSignalState = 'advancing' | 'heartbeat_only' | 'stalled_waiting';
export type SnapshotFreshnessState = 'fresh' | 'aging' | 'stale';
export type TokenTelemetryConfidence = 'observed_live' | 'backfilled' | 'missing';
export type ApiDegradedReasonCode = 'route_not_found' | 'schema_mismatch' | 'upstream_unavailable' | null;
export type NotBlockedExplainerCode =
  | 'active_turn_no_stop_reason'
  | 'within_wait_threshold'
  | 'awaiting_classifier_transition'
  | null;

export interface OperatorActionProjection {
  action: 'cancel' | 'requeue' | 'resume' | 'retry_step' | 'submit_input';
  requested_at_ms: number;
  result: 'accepted' | 'rejected' | 'failed';
  result_code: string | null;
  message: string | null;
  actor?: string | null;
  reason_note?: string | null;
  target_identifiers?: {
    issue_id: string;
    issue_identifier: string | null;
    run_id?: string | null;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    session_id?: string | null;
  };
  pre_state?: Record<string, unknown>;
  post_state?: Record<string, unknown>;
}

export interface VisibilityProjectionFields {
  turn_control_state: TurnControlState;
  turn_control_reason_code: string | null;
  turn_control_since_ms: number | null;
  progress_signal_state: ProgressSignalState;
  last_progress_transition_at_ms: number | null;
  last_heartbeat_at_ms: number | null;
}

export interface TokenTelemetryQualityFields {
  token_telemetry_confidence: TokenTelemetryConfidence;
  token_telemetry_source: string | null;
  token_telemetry_last_observed_at_ms: number | null;
}

export interface SnapshotFreshnessFields {
  snapshot_generated_at_ms: number;
  snapshot_age_ms: number;
  snapshot_freshness_state: SnapshotFreshnessState;
}

export interface ApiDegradedFields {
  api_degraded_mode: boolean;
  api_degraded_reason_code: ApiDegradedReasonCode;
  api_degraded_routes: string[];
}

export interface RuntimeSnapshotSource {
  getStateSnapshot(options?: StateSnapshotOptions): OrchestratorState;
}

export interface RefreshTickSource {
  tick(reason: TickReason): Promise<void>;
}

export interface DiagnosticsSource {
  getActiveProfile(): SecurityProfile;
  getPersistenceHealth(): PersistenceHealth;
  listRunHistory(limit?: number): DurableRunHistoryRecord[];
  reconstructThreadLineage?: (threadId: string) => ExecutionGraphThreadLineage | null;
  reconstructLatestThreadLineageByIssueIdentifier?: (issueIdentifier: string) => ExecutionGraphThreadLineage | null;
  listProjectTicketIdentities?: (
    projectKey: string,
    options?: { limit?: number; offset?: number }
  ) => { items: DurableIdentity[]; limit: number; offset: number; has_more: boolean; total: number };
  listProjectTicketSummaries?: (
    projectKey: string,
    options?: { limit?: number; offset?: number }
  ) => ProjectHistoryTicketSummaryPage;
  getProjectTicketIdentity?: (projectKey: string, ticketKey: string) => DurableIdentity | null;
  reconstructTicketTimeline?: (identity: DurableIdentity) => TicketTimelineRecord;
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
    effective_codex_home?: string | null;
    effective_codex_model?: string | null;
    effective_reasoning_effort?: string | null;
    effective_extra_flags_count?: number;
    codex_resolution_mode?: 'typed' | 'legacy' | 'mixed';
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
    last_integrity_status: 'ok' | 'reconciled' | 'failed' | null;
    last_integrity_reason_code: string | null;
    last_integrity_checked_at: string | null;
    last_integrity_reconciled_at: string | null;
  };
  getWorkspaceCopyIgnored(): {
    enabled: boolean;
    include_file: string;
    from: 'primary_worktree' | 'repo_root';
    conflict_policy: 'skip' | 'overwrite' | 'fail';
    require_gitignored: boolean;
    max_files: number;
    max_total_bytes: number;
    last_status: 'start' | 'success' | 'skipped' | 'failed' | null;
    last_error_code: string | null;
    last_error_message: string | null;
    source_path: string | null;
    copied_files: number;
    skipped_existing: number;
    blocked_files: number;
    bytes_copied: number;
    duration_ms: number;
  };
  getPhaseMarkers?(): {
    enabled: boolean;
    timeline_limit: number;
    last_emit_error_code: string | null;
  };
  getBreakerStatuses?(): Array<{
    issue_id: string;
    issue_identifier: string;
    breaker_active: boolean;
    breaker_hit_count: number;
    breaker_window_minutes: number;
    breaker_first_hit_at: string | null;
    breaker_last_hit_at: string | null;
  }>;
  getBlockedLatchStats?(): {
    blocked_latch_active_count: number;
    blocked_event_quarantine_total: number;
    blocked_event_allowlist_total: number;
    blocked_event_reject_total: number;
    blocked_latch_violation_total: number;
  };
}

export interface LocalApiErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}

export interface ApiBudgetProjection {
  budget_usage_tokens: number | null;
  budget_limit_tokens: number | null;
  budget_window_minutes: number;
  budget_status: 'ok' | 'warning' | 'hard_limited' | 'telemetry_unavailable';
  budget_policy: 'block_requires_resume' | 'terminate_attempt' | null;
  budget_message?: string | null;
}

export interface ApiPhaseTimingProjection {
  phase_started_at: string | null;
  phase_elapsed_ms: number | null;
  source: 'symphony_phase_marker' | null;
}

export interface ApiCodexThreadActivityProjection {
  thread_id: string | null;
  updated_at: string | null;
  updated_at_ms: number | null;
  age_ms: number | null;
  source: CodexAppServerThreadActivitySource | null;
  status: 'available' | 'unavailable';
  thread_status: string | null;
}

export interface ApiBlockedRootCauseProjection {
  phase: PhaseMarkerName;
  reason_code: string;
  summary: string;
  detail: string;
  remediation_hint: string | null;
  differs_from_current_operator_block: boolean;
}

export interface ApiCurrentOperatorBlockProjection {
  reason_code: string;
  detail: string | null;
}

export type ApiRetryDueState = 'pending' | 'overdue';

export interface ApiRetryCauseProjection {
  reason_code: string | null;
  detail: string | null;
  operator_detail: string | null;
  headline: string;
  expected_transition: string | null;
  last_phase: PhaseMarkerName | null;
  due_at_ms: number;
  due_state: ApiRetryDueState;
  overdue_ms: number | null;
  retry_wait_ms: number | null;
}

export interface ApiToolCallLedgerEntry {
  call_id: string;
  tool_name: string;
  thread_id: string | null;
  turn_id: string | null;
  session_id: string | null;
  issue_id: string;
  issue_identifier: string;
  run_id: string | null;
  issue_run_id: string | null;
  attempt_id: string | null;
  first_seen_at: string;
  first_seen_at_ms: number;
  last_seen_at: string;
  last_seen_at_ms: number;
  completed_at: string | null;
  completed_at_ms: number | null;
  completion_status: ToolCallCompletionStatus;
  evidence_sources: ToolCallEvidenceSource[];
  start_evidence_source: ToolCallEvidenceSource | null;
  completion_evidence_source: ToolCallEvidenceSource | null;
  last_agent_message: string | null;
}

export interface ApiTranscriptToolCallDiagnostic {
  kind: 'function_call' | 'function_call_output';
  call_id: string;
  tool_name: string | null;
  thread_id: string | null;
  turn_id: string | null;
  session_id: string | null;
  issue_id: string | null;
  issue_identifier: string | null;
  run_id: string | null;
  issue_run_id: string | null;
  attempt_id: string | null;
  codex_app_server_pid: string | null;
  observed_at: string;
  observed_at_ms: number;
  lineage: import('../orchestrator').TranscriptToolCallLineage;
  reason: string;
  active_issue_id: string;
  active_issue_identifier: string;
  active_run_id: string | null;
  active_issue_run_id: string | null;
  active_attempt_id: string | null;
  active_codex_app_server_pid: string | null;
  active_thread_id: string | null;
  active_turn_id: string | null;
  active_session_id: string | null;
}

export interface ApiTranscriptToolCallDiagnosticSummary {
  detailed_diagnostics_available: boolean;
  total_count: number;
  detail_url: string | null;
  newest_observed_at: string | null;
  newest_observed_at_ms: number | null;
  counts_by_lineage: Record<import('../orchestrator').TranscriptToolCallLineage, number>;
  counts_by_kind: Record<'function_call' | 'function_call_output', number>;
  active_missing_tool_output: {
    active: boolean;
    tool_name: string | null;
    call_id: string | null;
    thread_id: string | null;
    turn_id: string | null;
    session_id: string | null;
    evidence_source: import('../orchestrator').ToolCallEvidenceSource | null;
  };
  recovery: {
    active: boolean;
    status: import('../orchestrator').MissingToolOutputRecoveryResult | null;
    attempt_count: number;
    last_result_reason_code: string | null;
    previous_thread_id: string | null;
    replacement_thread_id: string | null;
  };
}

export interface ApiDiagnosticPageMetadata {
  total_available_count: number;
  included_count: number;
  limit: number;
  offset: number;
  has_more: boolean;
  truncated: boolean;
  oldest_observed_at: string | null;
  oldest_observed_at_ms: number | null;
  newest_observed_at: string | null;
  newest_observed_at_ms: number | null;
}

export interface ApiIssueRuntimeDiagnosticsResponse extends SnapshotFreshnessFields, ApiDegradedFields {
  issue_identifier: string;
  issue_id: string;
  status: 'running' | 'retrying' | 'blocked';
  generated_at: string;
  diagnostics_endpoint: string;
  transcript_tool_call_diagnostics: {
    metadata: ApiDiagnosticPageMetadata;
    records: ApiTranscriptToolCallDiagnostic[];
  };
  tool_call_ledger: {
    metadata: ApiDiagnosticPageMetadata;
    records: ApiToolCallLedgerEntry[];
  };
  missing_tool_output: {
    tool_name: string;
    call_id: string;
    thread_id: string | null;
    turn_id: string | null;
    session_id: string | null;
    elapsed_wait_ms: number;
    last_agent_message: string | null;
    evidence_source?: 'worker_event' | 'app_server_protocol' | 'session_transcript';
    recommended_actions: string[];
  } | null;
  recovery: import('../orchestrator').MissingToolOutputRecoveryState | null;
  missing_tool_output_recovery: import('./missing-tool-output-recovery').MissingToolOutputRecoveryEvidence | null;
}

export interface ApiStateResponse extends SnapshotFreshnessFields, ApiDegradedFields {
  generated_at: string;
  counts: {
    running: number;
    retrying: number;
    blocked: number;
    stopped: number;
    running_stalled_waiting_count: number;
    running_awaiting_input_count: number;
  };
  retry_status: {
    total: number;
    overdue_count: number;
    pending_count: number;
    entries: Array<{
      issue_id: string;
      issue_identifier: string;
      attempt: number;
      due_at: string;
      due_at_ms: number;
      due_state: ApiRetryDueState;
      overdue_ms: number | null;
      retry_wait_ms: number | null;
      reason_code: string | null;
      detail: string | null;
      operator_detail: string | null;
      headline: string;
      expected_transition: string | null;
      last_phase: PhaseMarkerName | null;
    }>;
  };
  running: Array<ApiBudgetProjection & {
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
    copy_ignored_applied: boolean;
    copy_ignored_status: 'skipped' | 'success' | 'failed' | null;
    copy_ignored_summary: {
      copied_files: number;
      skipped_existing: number;
      blocked_files: number;
      bytes_copied: number;
      duration_ms: number;
    } | null;
    thread_id: string | null;
    turn_id: string | null;
    codex_app_server_pid: string | null;
    turn_count: number;
    last_event: string | null;
    last_event_summary: string | null;
    last_message: string | null;
    awaiting_input: boolean;
    awaiting_input_since_ms: number | null;
    pending_input_preview: {
      type: string;
      prompt_preview: string | null;
      option_count: number | null;
    } | null;
    stalled_waiting: boolean;
    stalled_waiting_since_ms: number | null;
    stalled_waiting_reason: typeof REASON_CODES.turnWaitingThresholdExceeded | null;
    current_phase: PhaseMarkerName | null;
    current_phase_at: string | null;
    phase_elapsed_ms: number | null;
    phase_timing: ApiPhaseTimingProjection;
    phase_detail: string | null;
    started_at: string;
    last_event_at: string | null;
    codex_thread_activity: ApiCodexThreadActivityProjection;
    token_telemetry_status: 'unavailable' | 'pending' | 'available';
    token_telemetry_last_source: string | null;
    token_telemetry_last_at_ms: number | null;
    token_telemetry_confidence: TokenTelemetryConfidence;
    token_telemetry_source: string | null;
    token_telemetry_last_observed_at_ms: number | null;
    turn_control_state: TurnControlState;
    turn_control_reason_code: string | null;
    turn_control_since_ms: number | null;
    progress_signal_state: ProgressSignalState;
    last_progress_transition_at_ms: number | null;
    last_heartbeat_at_ms: number | null;
    quarantined_event_count: number;
    last_quarantined_event_at: string | null;
    ownership_conflict: {
      reason: 'pre_session_identity_conflict' | 'ownership_conflict';
      detected_at: string;
      detected_at_ms: number;
      event: string;
      event_codex_app_server_pid: string | null;
      active_codex_app_server_pid: string | null;
      event_worker_instance_id: string | null;
      active_worker_instance_id: string | null;
      event_thread_id: string | null;
      event_turn_id: string | null;
      event_session_id: string | null;
    } | null;
    current_blocker_class: string | null;
    time_since_progress: number | null;
    last_successful_step: string | null;
    transcript_tool_call_diagnostic_summary: ApiTranscriptToolCallDiagnosticSummary;
    not_blocked_explainer_code: NotBlockedExplainerCode;
    not_blocked_explainer_text: string | null;
    operator_actions: OperatorActionProjection[];
    rate_limits: Record<string, unknown> | null;
    protocol_warnings: CodexProtocolWarningEvidence[];
    model_reroute: CodexModelRerouteEvidence | null;
    requested_model: string | null;
    effective_model: string | null;
    tokens: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      cached_input_tokens?: number;
      reasoning_output_tokens?: number;
      model_context_window?: number;
    };
    recovery: import('../orchestrator').MissingToolOutputRecoveryState | null;
    missing_tool_output_recovery: import('./missing-tool-output-recovery').MissingToolOutputRecoveryEvidence | null;
    operator_explainer_hint: OperatorExplainerHint | null;
  }>;
  retrying: Array<ApiBudgetProjection & {
    issue_id: string;
    issue_identifier: string;
    attempt: number;
    due_at: string;
    due_at_ms: number;
    due_state: ApiRetryDueState;
    overdue_ms: number | null;
    retry_wait_ms: number | null;
    retry_cause: ApiRetryCauseProjection;
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
    copy_ignored_applied: boolean;
    copy_ignored_status: 'skipped' | 'success' | 'failed' | null;
    copy_ignored_summary: {
      copied_files: number;
      skipped_existing: number;
      blocked_files: number;
      bytes_copied: number;
      duration_ms: number;
    } | null;
    stop_reason_code: string | null;
    stop_reason_detail: string | null;
    previous_thread_id: string | null;
    previous_session_id: string | null;
    last_phase: PhaseMarkerName | null;
    last_phase_at: string | null;
    last_phase_detail: string | null;
    operator_explainer_hint: OperatorExplainerHint | null;
    recovery: import('../orchestrator').MissingToolOutputRecoveryState | null;
    missing_tool_output_recovery: import('./missing-tool-output-recovery').MissingToolOutputRecoveryEvidence | null;
    transcript_tool_call_diagnostic_summary: ApiTranscriptToolCallDiagnosticSummary;
  }>;
  blocked: Array<ApiBudgetProjection & {
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
    copy_ignored_applied: boolean;
    copy_ignored_status: 'skipped' | 'success' | 'failed' | null;
    copy_ignored_summary: {
      copied_files: number;
      skipped_existing: number;
      blocked_files: number;
      bytes_copied: number;
      duration_ms: number;
    } | null;
    stop_reason_code: string;
    stop_reason_detail: string | null;
    worker_termination_result: import('../orchestrator').WorkerTerminationResult | null;
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
    last_phase: PhaseMarkerName | null;
    last_phase_at: string | null;
    last_phase_detail: string | null;
    root_cause: ApiBlockedRootCauseProjection | null;
    current_operator_block: ApiCurrentOperatorBlockProjection;
    pending_input: {
      request_id: string | null;
      request_method: string | null;
      prompt_text: string | null;
      questions: Array<{
        id: string;
        prompt?: string;
        options?: Array<{ label: string; value?: string }>;
      }>;
      input_schema_type: 'options' | 'text' | 'unknown';
      input_required_at: string;
    } | null;
    tool_output_wait: {
      tool_name: string;
      call_id: string;
      thread_id: string | null;
      turn_id: string | null;
      session_id: string | null;
      elapsed_wait_ms: number;
      last_agent_message: string | null;
      evidence_source?: 'worker_event' | 'app_server_protocol' | 'session_transcript';
      recommended_actions: string[];
    } | null;
    transcript_tool_call_diagnostic_summary: ApiTranscriptToolCallDiagnosticSummary;
    last_input_submit: {
      submitted_at: string;
      request_id: string;
      resume_mode: 'native' | 'fallback';
      resume_reason_code: string;
    } | null;
    resume_history: Array<{
      submitted_at: string;
      request_id: string;
      resume_mode: 'native' | 'fallback';
      resume_reason_code: string;
      previous_thread_id: string | null;
      previous_session_id: string | null;
    }>;
    session_console: Array<{
      at: string;
      event: string;
      message: string | null;
      reason_code?: string | null;
      request_method?: string | null;
      request_category?: string | null;
      tool_call_id?: string | null;
      tool_name?: string | null;
      protocol_warning?: CodexProtocolWarningEvidence;
      model_reroute?: CodexModelRerouteEvidence | null;
      requested_model?: string | null;
      effective_model?: string | null;
    }>;
    requires_manual_resume: true;
    awaiting_operator: true;
    awaiting_operator_reason_code: string;
    awaiting_operator_since: string;
    awaiting_operator_resume_nonce: number;
    quarantined_event_count: number;
    last_quarantined_event_at: string | null;
    ownership_conflict: {
      reason: 'pre_session_identity_conflict' | 'ownership_conflict';
      detected_at: string;
      detected_at_ms: number;
      event: string;
      event_codex_app_server_pid: string | null;
      active_codex_app_server_pid: string | null;
      event_worker_instance_id: string | null;
      active_worker_instance_id: string | null;
      event_thread_id: string | null;
      event_turn_id: string | null;
      event_session_id: string | null;
    } | null;
    breaker_active: boolean;
    breaker_hit_count: number;
    breaker_window_minutes: number;
    breaker_first_hit_at: string | null;
    breaker_last_hit_at: string | null;
    attempt_count_window?: number;
    window_minutes?: number;
    last_known_commit_sha?: string | null;
    last_progress_checkpoint_at?: string | null;
    progress_signals?: {
      commit_sha: string | null;
      checklist_checkpoint: string | null;
      state_marker: string | null;
      tracker_comment_created?: boolean;
      tracker_status_transition?: string | null;
      agent_review_handoff?: string | null;
      tracker_started_state?: string | null;
    };
    required_actions?: string[];
    resume_override_reason?: string | null;
    turn_control_state: TurnControlState;
    turn_control_reason_code: string | null;
    turn_control_since_ms: number | null;
    progress_signal_state: ProgressSignalState;
    last_progress_transition_at_ms: number | null;
    last_heartbeat_at_ms: number | null;
    operator_actions: OperatorActionProjection[];
    recovery: import('../orchestrator').MissingToolOutputRecoveryState | null;
    missing_tool_output_recovery: import('./missing-tool-output-recovery').MissingToolOutputRecoveryEvidence | null;
    operator_explainer_hint: OperatorExplainerHint | null;
  }>;
  stopped_runs: Array<{
    run_id: string;
    issue_id: string;
    issue_identifier: string;
    terminal_status: string;
    terminal_reason_code: string | null;
    terminal_reason_detail: string | null;
    root_cause_status: string | null;
    root_cause_reason_code: string | null;
    root_cause_reason_detail: string | null;
    root_cause_at: string | null;
    thread_id: string | null;
    turn_id: string | null;
    session_id: string | null;
    last_relevant_at: string;
    active_issue_present: boolean;
    recovery_status: 'inspect_forensics' | 'resume_available' | 'resume_unavailable' | 'active_issue_present' | 'capability_mismatch';
    resume_valid: boolean;
    resume_disabled_reason: string | null;
    capability_mismatch: boolean;
    capability_warning: ThreadDiagnosticsCapabilityWarning | null;
    actions: {
      inspect_forensics_url: string;
      inspect_thread_url: string | null;
      resume_url: string | null;
      acknowledge_supported: true;
      copy_thread_id_supported: boolean;
      copy_session_id_supported: boolean;
    };
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
    reason_code?: string | null;
    request_method?: string | null;
    request_category?: string | null;
    tool_call_id?: string | null;
    tool_name?: string | null;
    protocol_warning?: CodexProtocolWarningEvidence;
    model_reroute?: CodexModelRerouteEvidence | null;
    requested_model?: string | null;
    effective_model?: string | null;
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

export interface ApiIssueResponse extends SnapshotFreshnessFields, ApiDegradedFields {
  issue_identifier: string;
  issue_id: string;
  status: 'running' | 'retrying' | 'blocked';
  operator_actions: OperatorActionProjection[];
  operator_explainer: OperatorExplainer;
  workspace: {
    path: string | null;
    host: string | null;
  };
  attempts: {
    restart_count: number;
    current_retry_attempt: number;
  };
  running: (ApiBudgetProjection & {
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
    copy_ignored_applied: boolean;
    copy_ignored_status: 'skipped' | 'success' | 'failed' | null;
    copy_ignored_summary: {
      copied_files: number;
      skipped_existing: number;
      blocked_files: number;
      bytes_copied: number;
      duration_ms: number;
    } | null;
    thread_id: string | null;
    turn_id: string | null;
    codex_app_server_pid: string | null;
    turn_count: number;
    state: string;
    started_at: string;
    last_event: string | null;
    last_event_summary: string | null;
    last_message: string | null;
    awaiting_input: boolean;
    awaiting_input_since_ms: number | null;
    pending_input_preview: {
      type: string;
      prompt_preview: string | null;
      option_count: number | null;
    } | null;
    stalled_waiting: boolean;
    stalled_waiting_since_ms: number | null;
    stalled_waiting_reason: typeof REASON_CODES.turnWaitingThresholdExceeded | null;
    current_phase: PhaseMarkerName | null;
    current_phase_at: string | null;
    phase_elapsed_ms: number | null;
    phase_timing: ApiPhaseTimingProjection;
    phase_detail: string | null;
    last_event_at: string | null;
    codex_thread_activity: ApiCodexThreadActivityProjection;
    token_telemetry_status: 'unavailable' | 'pending' | 'available';
    token_telemetry_last_source: string | null;
    token_telemetry_last_at_ms: number | null;
    token_telemetry_confidence: TokenTelemetryConfidence;
    token_telemetry_source: string | null;
    token_telemetry_last_observed_at_ms: number | null;
    turn_control_state: TurnControlState;
    turn_control_reason_code: string | null;
    turn_control_since_ms: number | null;
    progress_signal_state: ProgressSignalState;
    last_progress_transition_at_ms: number | null;
    last_heartbeat_at_ms: number | null;
    quarantined_event_count: number;
    last_quarantined_event_at: string | null;
    not_blocked_explainer_code: NotBlockedExplainerCode;
    not_blocked_explainer_text: string | null;
    operator_actions: OperatorActionProjection[];
    transcript_tool_call_diagnostic_summary: ApiTranscriptToolCallDiagnosticSummary;
    rate_limits: Record<string, unknown> | null;
    protocol_warnings: CodexProtocolWarningEvidence[];
    model_reroute: CodexModelRerouteEvidence | null;
    requested_model: string | null;
    effective_model: string | null;
    tokens: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      cached_input_tokens?: number;
      reasoning_output_tokens?: number;
      model_context_window?: number;
    };
    recovery: import('../orchestrator').MissingToolOutputRecoveryState | null;
    missing_tool_output_recovery: import('./missing-tool-output-recovery').MissingToolOutputRecoveryEvidence | null;
  }) | null;
  retry: (ApiBudgetProjection & {
    attempt: number;
    due_at: string;
    due_at_ms: number;
    due_state: ApiRetryDueState;
    overdue_ms: number | null;
    retry_wait_ms: number | null;
    retry_cause: ApiRetryCauseProjection;
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
    copy_ignored_applied: boolean;
    copy_ignored_status: 'skipped' | 'success' | 'failed' | null;
    copy_ignored_summary: {
      copied_files: number;
      skipped_existing: number;
      blocked_files: number;
      bytes_copied: number;
      duration_ms: number;
    } | null;
    stop_reason_code: string | null;
    stop_reason_detail: string | null;
    previous_thread_id: string | null;
    previous_session_id: string | null;
    last_phase: PhaseMarkerName | null;
    last_phase_at: string | null;
    last_phase_detail: string | null;
    missing_tool_output_recovery: import('./missing-tool-output-recovery').MissingToolOutputRecoveryEvidence | null;
  }) | null;
  blocked: (ApiBudgetProjection & {
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
    copy_ignored_applied: boolean;
    copy_ignored_status: 'skipped' | 'success' | 'failed' | null;
    copy_ignored_summary: {
      copied_files: number;
      skipped_existing: number;
      blocked_files: number;
      bytes_copied: number;
      duration_ms: number;
    } | null;
    stop_reason_code: string;
    stop_reason_detail: string | null;
    worker_termination_result: import('../orchestrator').WorkerTerminationResult | null;
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
    last_phase: PhaseMarkerName | null;
    last_phase_at: string | null;
    last_phase_detail: string | null;
    root_cause: ApiBlockedRootCauseProjection | null;
    current_operator_block: ApiCurrentOperatorBlockProjection;
    pending_input: {
      request_id: string | null;
      request_method: string | null;
      prompt_text: string | null;
      questions: Array<{
        id: string;
        prompt?: string;
        options?: Array<{ label: string; value?: string }>;
      }>;
      input_schema_type: 'options' | 'text' | 'unknown';
      input_required_at: string;
    } | null;
    tool_output_wait: {
      tool_name: string;
      call_id: string;
      thread_id: string | null;
      turn_id: string | null;
      session_id: string | null;
      elapsed_wait_ms: number;
      last_agent_message: string | null;
      evidence_source?: 'worker_event' | 'app_server_protocol' | 'session_transcript';
      recommended_actions: string[];
    } | null;
    transcript_tool_call_diagnostic_summary: ApiTranscriptToolCallDiagnosticSummary;
    last_input_submit: {
      submitted_at: string;
      request_id: string;
      resume_mode: 'native' | 'fallback';
      resume_reason_code: string;
    } | null;
    resume_history: Array<{
      submitted_at: string;
      request_id: string;
      resume_mode: 'native' | 'fallback';
      resume_reason_code: string;
      previous_thread_id: string | null;
      previous_session_id: string | null;
    }>;
    session_console: Array<{
      at: string;
      event: string;
      message: string | null;
      reason_code?: string | null;
      request_method?: string | null;
      request_category?: string | null;
      tool_call_id?: string | null;
      tool_name?: string | null;
      protocol_warning?: CodexProtocolWarningEvidence;
      model_reroute?: CodexModelRerouteEvidence | null;
      requested_model?: string | null;
      effective_model?: string | null;
    }>;
    requires_manual_resume: true;
    awaiting_operator: true;
    awaiting_operator_reason_code: string;
    awaiting_operator_since: string;
    awaiting_operator_resume_nonce: number;
    quarantined_event_count: number;
    last_quarantined_event_at: string | null;
    breaker_active: boolean;
    breaker_hit_count: number;
    breaker_window_minutes: number;
    breaker_first_hit_at: string | null;
    breaker_last_hit_at: string | null;
    attempt_count_window?: number;
    window_minutes?: number;
    last_known_commit_sha?: string | null;
    last_progress_checkpoint_at?: string | null;
    progress_signals?: {
      commit_sha: string | null;
      checklist_checkpoint: string | null;
      state_marker: string | null;
      tracker_comment_created?: boolean;
      tracker_status_transition?: string | null;
      agent_review_handoff?: string | null;
      tracker_started_state?: string | null;
    };
    required_actions?: string[];
    resume_override_reason?: string | null;
    turn_control_state: TurnControlState;
    turn_control_reason_code: string | null;
    turn_control_since_ms: number | null;
    progress_signal_state: ProgressSignalState;
    last_progress_transition_at_ms: number | null;
    last_heartbeat_at_ms: number | null;
    operator_actions: OperatorActionProjection[];
    recovery: import('../orchestrator').MissingToolOutputRecoveryState | null;
    missing_tool_output_recovery: import('./missing-tool-output-recovery').MissingToolOutputRecoveryEvidence | null;
  }) | null;
  phase_timeline: Array<{
    at: string;
    phase: PhaseMarkerName;
    detail: string | null;
    attempt: number;
    thread_id: string | null;
    session_id: string | null;
  }>;
  recent_events: Array<{
    at: string;
    event: string;
    message: string | null;
    reason_code?: string | null;
    request_method?: string | null;
    request_category?: string | null;
    tool_call_id?: string | null;
    tool_name?: string | null;
    protocol_warning?: CodexProtocolWarningEvidence;
    model_reroute?: CodexModelRerouteEvidence | null;
    requested_model?: string | null;
    effective_model?: string | null;
  }>;
  stale_events: Array<{
    at: string;
    event: string;
    message: string | null;
    codex_app_server_pid: string | null;
    session_id: string | null;
    thread_id: string | null;
    turn_id: string | null;
    active_codex_app_server_pid: string | null;
    worker_instance_id: string | null;
    active_worker_instance_id: string | null;
    run_id: string | null;
    issue_run_id: string | null;
    attempt_id: string | null;
    active_run_id: string | null;
    active_issue_run_id: string | null;
    active_attempt_id: string | null;
    active_session_id: string | null;
    active_thread_id: string | null;
    active_turn_id: string | null;
    reason: 'lineage_mismatch' | 'worker_identity_mismatch' | 'inactive_worker_pid' | 'terminal_residue';
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

export type ThreadDiagnosticsStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'stalled';

export type ThreadDiagnosticsBlockerClassification =
  | typeof REASON_CODES.missingToolOutput
  | 'stalled_waiting'
  | 'tool_waiting_long'
  | 'tracker_transition_pending'
  | 'input_required_pending'
  | 'codex_no_progress'
  | 'workspace_integrity_conflict'
  | 'retry_backoff_wait';

export interface ThreadDiagnosticsEvent {
  at_ms: number;
  event: string;
  reason_code: string | null;
  reason_detail: string | null;
  request_method?: string | null;
  request_category?: string | null;
  tool_call_id?: string | null;
  tool_name?: string | null;
  protocol_warning?: CodexProtocolWarningEvidence;
  model_reroute?: CodexModelRerouteEvidence | null;
  requested_model?: string | null;
  effective_model?: string | null;
  thread_id: string;
  turn_id: string | null;
  session_id: string | null;
}

export interface ThreadDiagnosticsPhaseSpan {
  phase: string;
  started_at_ms: number;
  ended_at_ms: number | null;
  duration_ms: number | null;
  status: string;
  reason_code: string | null;
  reason_detail: string | null;
}

export interface ThreadDiagnosticsToolSpan {
  tool_name: string;
  turn_id: string | null;
  started_at_ms: number;
  ended_at_ms: number | null;
  duration_ms: number | null;
  status: string;
  reason_code: string | null;
  reason_detail: string | null;
}

export interface ThreadDiagnosticsWaitSpan {
  started_at_ms: number;
  ended_at_ms: number | null;
  duration_ms: number | null;
  status: string;
  reason_code: string | null;
  reason_detail: string | null;
}

export interface ThreadDiagnosticsBlocker {
  classification: ThreadDiagnosticsBlockerClassification;
  reason_code: string | null;
  reason_detail: string | null;
  time_since_progress: number | null;
  actionability: 'none' | 'recommended' | 'required';
  recommended_actions: string[];
  expected_auto_transition: string | null;
  tool_output_wait?: import('../orchestrator').BlockedEntry['tool_output_wait'];
  missing_tool_output_recovery?: import('./missing-tool-output-recovery').MissingToolOutputRecoveryEvidence | null;
}

export interface ThreadDiagnosticsCapabilityWarning {
  reason_code: string;
  source_environment: 'console_tui';
  attempted_tool_name: string | null;
  call_id: string | null;
  thread_id: string;
  turn_id: string | null;
  unsupported_capability_message: string;
  recommended_recovery_action: string;
}

export interface ThreadDiagnosticsResponse {
  thread_id: string;
  issue_identifier: string;
  attempt: number;
  status: ThreadDiagnosticsStatus;
  timeline: ThreadDiagnosticsEvent[];
  phase_spans: ThreadDiagnosticsPhaseSpan[];
  tool_spans: ThreadDiagnosticsToolSpan[];
  wait_spans: ThreadDiagnosticsWaitSpan[];
  capability_warnings: ThreadDiagnosticsCapabilityWarning[];
  current_blocker: ThreadDiagnosticsBlocker | null;
  last_meaningful_progress_at_ms: number | null;
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
    cancelCurrentTurn?: (
      issueIdentifier: string,
      params: { actor?: string; reason_note?: string; confirmed?: boolean }
    ) => Promise<{ ok: true; issue_id: string } | { ok: false; code: string; message: string }>;
    requeueIssue?: (
      issueIdentifier: string,
      params: { actor?: string; reason_note?: string; confirmed?: boolean }
    ) => Promise<{ ok: true; issue_id: string; retry_attempt: number } | { ok: false; code: string; message: string }>;
    retryLastFailedStep?: (
      issueIdentifier: string,
      params: { actor?: string; reason_note?: string }
    ) => Promise<{ ok: true; issue_id: string; retry_attempt: number } | { ok: false; code: string; message: string }>;
    resumeBlockedIssue: (issueIdentifier: string, params?: { resume_override_reason?: string; actor?: string; reason_note?: string }) => Promise<
      { ok: true; issue_id: string } | { ok: false; code: string; message: string }
    >;
    cancelBlockedIssue: (issueIdentifier: string, params?: { cancel_reason?: string; actor?: string; reason_note?: string; confirmed?: boolean }) => Promise<
      { ok: true; issue_id: string; moved_to_state: string } | { ok: false; code: string; message: string }
    >;
    submitBlockedIssueInput: (params: {
      issueIdentifier: string;
      request_id: string;
      actor?: string;
      reason_note: string;
      answer: { question_id?: string; option_label?: string; text?: string };
    }) => Promise<
      | {
          ok: true;
          issue_id: string;
          request_id: string;
          resume_mode: 'native' | 'fallback';
          resume_reason_code: string;
          requested_at: string;
          request_lineage: { previous_thread_id: string | null; previous_session_id: string | null };
        }
      | { ok: false; code: string; message: string }
    >;
  };
  dashboardConfig?: {
    dashboard_enabled: boolean;
    refresh_ms: number;
    render_interval_ms: number;
    phase_stale_warn_ms?: number;
  };
  nowMs?: () => number;
  logger?: StructuredLogger;
  codexStateDbPath?: string;
  controlPlaneHealth?: {
    sampleLimit?: number;
    thresholds?: Partial<ControlPlaneThresholds>;
  };
  controlPlaneHealthRecorder?: ControlPlaneHealthRecorder;
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
    ];
    excludes_generic_usage_for_totals: true;
    excludes_last_usage_for_totals: false;
    no_telemetry_warning_threshold_ms: number;
    optional_dimensions: ['cached_input_tokens', 'reasoning_output_tokens', 'model_context_window'];
    observed_dimensions: {
      cached_input_tokens: boolean;
      reasoning_output_tokens: boolean;
      model_context_window: boolean;
    };
  };
  token_telemetry_status: 'unavailable' | 'pending' | 'available';
  token_telemetry_last_source: string | null;
  token_telemetry_last_at_ms: number | null;
  token_enrichment: {
    status: 'not_required' | 'available' | 'degraded';
    degraded: boolean;
    reason_code: string | null;
    duration_ms: number;
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
    effective_codex_home: string | null;
    effective_codex_model: string | null;
    effective_reasoning_effort: string | null;
    effective_extra_flags_count: number;
    codex_resolution_mode: 'typed' | 'legacy' | 'mixed';
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
  workspace_copy_ignored: {
    enabled: boolean;
    include_file: string;
    from: 'primary_worktree' | 'repo_root';
    conflict_policy: 'skip' | 'overwrite' | 'fail';
    require_gitignored: boolean;
    max_files: number;
    max_total_bytes: number;
    last_status: 'start' | 'success' | 'skipped' | 'failed' | null;
    last_error_code: string | null;
    last_error_message: string | null;
    source_path: string | null;
    copied_files: number;
    skipped_existing: number;
    blocked_files: number;
    bytes_copied: number;
    duration_ms: number;
  };
  phase_markers: {
    enabled: boolean;
    timeline_limit: number;
    last_emit_error_code: string | null;
  };
  breaker_statuses: Array<{
    issue_id: string;
    issue_identifier: string;
    breaker_active: boolean;
    breaker_hit_count: number;
    breaker_window_minutes: number;
    breaker_first_hit_at: string | null;
    breaker_last_hit_at: string | null;
  }>;
  blocked_latch: {
    blocked_latch_active_count: number;
    blocked_event_quarantine_total: number;
    blocked_event_allowlist_total: number;
    blocked_event_reject_total: number;
    blocked_latch_violation_total: number;
  };
  stream: {
    live_client_count: number;
    last_client_connected_at: string | null;
    last_client_disconnected_at: string | null;
    last_snapshot_broadcast_at: string | null;
    last_snapshot_broadcast_latency_ms: number | null;
    last_snapshot_broadcast_status: 'ok' | 'failed' | 'no_clients' | null;
    last_snapshot_broadcast_error: string | null;
  };
  control_plane: ControlPlaneHealthSummary;
}
