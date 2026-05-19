import type { Issue } from '../tracker';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StructuredLogger } from '../observability';
import { CANONICAL_EVENT } from '../observability/events';
import { REASON_CODES } from '../observability/reason-codes';
import { parseDynamicToolCapabilityMismatchDetail } from '../observability/dynamic-tool-capability';
import { isKnownPhaseMarker, isTerminalPhaseMarker, phaseMarkerOrder, type PhaseMarker, type PhaseMarkerName } from '../observability';
import { ThroughputTracker } from '../observability/throughput';
import { redactUnknown } from '../security/redaction';
import {
  availableGlobalSlots,
  computeFailureBackoffMs,
  isActiveState,
  isTerminalState,
  nextAttempt,
  shouldDispatchIssue,
  sortCandidatesForDispatch
} from './decisions';
import type {
  BlockedEntry,
  BudgetRuntimeProjection,
  CircuitBreakerEntry,
  DispatchBackpressureState,
  MissingToolOutputRecoveryState,
  OperatorActionRecord,
  OrchestratorOptions,
  OrchestratorState,
  OutstandingToolCall,
  PhaseMarkerSettings,
  ProgressSignals,
  RedispatchProgressSample,
  RetryDelayType,
  RetryEntry,
  RunningEntry,
  ReleasedWorkerRecord,
  StateSnapshotOptions,
  TickReason,
  ToolCallLedgerEntry,
  ToolCallLedgerObservation,
  QuarantinedWorkerEventReason,
  TranscriptToolCallDiagnostic,
  TranscriptToolCallDiagnosticStats,
  TranscriptToolCallLineage,
  WorkerCompletionReason,
  WorkerExitDetails,
  WorkerObservabilityEvent,
  WorkerExitReason,
  WorkerTerminationResult
} from './types';
import type { ControlPlaneEndpointHealth, ControlPlaneHealthState, ControlPlaneHealthSummary } from '../api/control-plane-health';

const DEFAULT_INACTIVE_WORKER_PID_TTL_MS = 60 * 60 * 1000;
const DEFAULT_BACKPRESSURE_RETRY_DELAY_MS = 30_000;
const DEFAULT_BACKPRESSURE_MIN_RUNNING_AGENTS = 1;
const DEFAULT_BACKPRESSURE_CONTROL_PLANE_HEALTH: ControlPlaneHealthState = 'degraded';
const DEFAULT_BACKPRESSURE_CONTROL_PLANE_STALE_AFTER_MS = 60_000;
const CODEX_SESSION_TRANSCRIPT_CANDIDATE_CACHE_TTL_MS = 15_000;
const CODEX_SESSION_TRANSCRIPT_MAX_CANDIDATE_FILES = 40;
const CODEX_SESSION_TRANSCRIPT_MAX_DISCOVERY_FILES = 20;
const CODEX_SESSION_TRANSCRIPT_MAX_PROBE_BYTES = 256 * 1024;
const CODEX_SESSION_TRANSCRIPT_MAX_SCAN_BYTES = 256 * 1024;
const CODEX_SESSION_TRANSCRIPT_MAX_FILE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CODEX_SESSION_TRANSCRIPT_MAX_WALL_CLOCK_MS = 20;
const CODEX_SESSION_TRANSCRIPT_MAX_DEPTH = 5;

const CONTROL_PLANE_HEALTH_RANK: Record<ControlPlaneHealthState, number> = {
  ok: 0,
  slow: 1,
  large: 2,
  degraded: 3
};

interface ScheduleRetryParams {
  issue_id: string;
  identifier: string;
  attempt: number;
  issue_run_id?: string | null;
  previous_attempt_id?: string | null;
  delay_type: RetryDelayType;
  error?: string | null;
  worker_host?: string | null;
  workspace_path?: string | null;
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
  stop_reason_code?: string | null;
  stop_reason_detail?: string | null;
  previous_thread_id?: string | null;
  previous_turn_id?: string | null;
  previous_session_id?: string | null;
  last_progress_checkpoint_at?: number | null;
  issue_snapshot?: Issue | null;
  progress_signals?: ProgressSignals;
  recover_workspace_attempt_residue?: boolean;
  budget?: BudgetRuntimeProjection;
  recovery?: MissingToolOutputRecoveryState | null;
  delay_ms?: number;
}

interface WorkspaceConflictContext {
  detail: string;
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
}

interface DispatchGraphContext {
  issue_run_id?: string | null;
  previous_attempt_id?: string | null;
  recover_workspace_attempt_residue?: boolean;
}

interface AppServerLiteSummary {
  payload_class:
    | 'protocol_lifecycle'
    | 'protocol_request_response'
    | 'assistant_text'
    | 'tool_payload'
    | 'command_output'
    | 'filesystem_change'
    | 'environment'
    | 'account'
    | 'conversation_transcript'
    | 'unknown';
  summary: string;
  summary_fields: Record<string, unknown>;
  unavailable_reason_code?: string | null;
}

type WorkerActivityState = 'advancing' | 'active_but_opaque' | 'heartbeat_only' | 'stale';

interface WorkerActivityClassification {
  latest_meaningful_progress_at_ms: number | null;
  latest_liveness_at_ms: number | null;
  latest_thread_activity_at_ms: number | null;
  activity_state: WorkerActivityState;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readTimestampMs(value: Record<string, unknown> | null): number | null {
  if (!value) {
    return null;
  }
  for (const key of ['timestamp_ms', 'timestampMs', 'created_at_ms', 'createdAtMs', 'at_ms', 'atMs']) {
    const numeric = value[key];
    if (typeof numeric === 'number' && Number.isFinite(numeric)) {
      return numeric;
    }
  }
  for (const key of ['timestamp', 'created_at', 'createdAt', 'time']) {
    const text = readString(value[key]);
    if (!text) {
      continue;
    }
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function appServerLiteSourceEventId(workerEvent: WorkerObservabilityEvent): string {
  const hash = createHash('sha256')
    .update(workerEvent.event)
    .update('\0')
    .update(String(workerEvent.timestamp_ms))
    .update('\0')
    .update(workerEvent.thread_id ?? '')
    .update('\0')
    .update(workerEvent.turn_id ?? '')
    .update('\0')
    .update(workerEvent.session_id ?? '')
    .update('\0')
    .update(workerEvent.tool_call_id ?? '')
    .update('\0')
    .update(workerEvent.request_method ?? '')
    .digest('hex')
    .slice(0, 20);
  return `worker_event:${hash}`;
}

function appServerLiteSummaryForWorkerEvent(workerEvent: WorkerObservabilityEvent): AppServerLiteSummary | null {
  const baseFields: Record<string, unknown> = {
    event: workerEvent.event,
    reason_code: workerEvent.reason_code ?? null,
    thread_id_available: Boolean(workerEvent.thread_id),
    turn_id_available: Boolean(workerEvent.turn_id),
    session_id_available: Boolean(workerEvent.session_id)
  };

  if (workerEvent.request_method || workerEvent.request_category) {
    return {
      payload_class: 'protocol_request_response',
      summary: `${workerEvent.event}: ${workerEvent.request_method ?? 'unknown method'}`,
      summary_fields: {
        ...baseFields,
        protocol_event_category: 'request_response',
        request_method: workerEvent.request_method ?? null,
        request_category: workerEvent.request_category ?? null
      }
    };
  }

  if (workerEvent.protocol_warning) {
    return {
      payload_class: 'protocol_lifecycle',
      summary: `${workerEvent.protocol_warning.reason_code}: ${workerEvent.protocol_warning.method}`,
      summary_fields: {
        ...baseFields,
        protocol_event_category: 'warning',
        method: workerEvent.protocol_warning.method,
        warning_reason_code: workerEvent.protocol_warning.reason_code,
        severity: workerEvent.protocol_warning.severity
      }
    };
  }

  if (workerEvent.model_reroute) {
    return {
      payload_class: 'protocol_lifecycle',
      summary: `${workerEvent.model_reroute.reason_code}: model rerouted`,
      summary_fields: {
        ...baseFields,
        protocol_event_category: 'model_signal',
        requested_model: workerEvent.model_reroute.requested_model,
        effective_model: workerEvent.model_reroute.effective_model,
        model_reason_code: workerEvent.model_reroute.reason_code
      }
    };
  }

  if (workerEvent.usage || workerEvent.rate_limits || workerEvent.token_telemetry_status) {
    return {
      payload_class: 'protocol_lifecycle',
      summary: `${workerEvent.event}: token/rate/model telemetry`,
      summary_fields: {
        ...baseFields,
        protocol_event_category: 'token_rate_signal',
        usage: workerEvent.usage ?? null,
        token_telemetry_status: workerEvent.token_telemetry_status ?? null,
        token_telemetry_last_source: workerEvent.token_telemetry_last_source ?? null,
        rate_limits: workerEvent.rate_limits ?? null,
        requested_model: workerEvent.requested_model ?? null,
        effective_model: workerEvent.effective_model ?? null
      }
    };
  }

  if (workerEvent.tool_call_id || workerEvent.tool_name || workerEvent.event === CANONICAL_EVENT.codex.dynamicToolCapabilityMismatch) {
    return {
      payload_class: 'tool_payload',
      summary: `${workerEvent.event}: ${workerEvent.tool_name ?? workerEvent.tool_call_id ?? 'tool event'}`,
      summary_fields: {
        ...baseFields,
        protocol_event_category: 'dynamic_tool',
        tool_call_id: workerEvent.tool_call_id ?? null,
        tool_name: workerEvent.tool_name ?? null,
        evidence_source: workerEvent.tool_call_evidence_source ?? null
      },
      unavailable_reason_code: 'tool_payload_payload_not_stored'
    };
  }

  if (
    workerEvent.event === CANONICAL_EVENT.codex.turnStarted ||
    workerEvent.event === CANONICAL_EVENT.codex.turnCompleted ||
    workerEvent.event === CANONICAL_EVENT.codex.turnFailed ||
    workerEvent.event === CANONICAL_EVENT.codex.turnCancelled ||
    workerEvent.event === CANONICAL_EVENT.codex.turnInputRequired
  ) {
    return {
      payload_class: 'protocol_lifecycle',
      summary: workerEvent.event,
      summary_fields: {
        ...baseFields,
        protocol_event_category: 'terminal_event',
        terminal_source: workerEvent.terminal_source ?? null
      }
    };
  }

  return null;
}

function workerTerminationResultContext(result: WorkerTerminationResult | null | undefined): Record<string, unknown> {
  if (!result) {
    return {
      worker_termination_result: null
    };
  }
  return {
    worker_termination_result: result.result,
    worker_termination_reason_code: result.reason_code,
    worker_termination_detail: result.detail,
    worker_cancellation_supported: result.cancellation_supported,
    worker_cancellation_requested: result.cancellation_requested,
    worker_settled: result.worker_settled,
    graceful_exit_observed: result.graceful_exit_observed,
    forced_kill_requested: result.forced_kill_requested,
    forced_kill_settled: result.forced_kill_settled,
    cleanup_requested: result.cleanup_requested,
    cleanup_succeeded: result.cleanup_succeeded
  };
}

function workerTerminationResultDetail(prefix: string, result: WorkerTerminationResult): string {
  const fields = [
    `termination_result=${result.result}`,
    `termination_reason_code=${result.reason_code}`,
    `termination_detail=${result.detail ?? 'none'}`,
    `cancellation_supported=${result.cancellation_supported}`,
    `cancellation_requested=${result.cancellation_requested}`,
    `worker_settled=${result.worker_settled ?? 'unknown'}`,
    `graceful_exit_observed=${result.graceful_exit_observed ?? 'unknown'}`,
    `forced_kill_requested=${result.forced_kill_requested}`,
    `forced_kill_settled=${result.forced_kill_settled ?? 'unknown'}`,
    `cleanup_requested=${result.cleanup_requested}`,
    `cleanup_succeeded=${result.cleanup_succeeded ?? 'unknown'}`
  ];
  return `${prefix} ${fields.join(' ')}`;
}

function workerTerminationExceptionResult(error: unknown): WorkerTerminationResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    cancellation_supported: false,
    cancellation_requested: true,
    worker_settled: null,
    graceful_exit_observed: null,
    forced_kill_requested: false,
    forced_kill_settled: null,
    cleanup_requested: false,
    cleanup_succeeded: null,
    result: 'unknown',
    reason_code: REASON_CODES.workerCancelUnknown,
    detail: `Worker termination failed before returning typed outcome: ${message}`
  };
}

function cloneWorkerTerminationResult(result: WorkerTerminationResult): WorkerTerminationResult {
  return { ...result };
}

function cloneIssue(issue: Issue): Issue {
  return {
    ...issue,
    labels: [...issue.labels],
    blocked_by: issue.blocked_by.map((blocker) => ({
      id: blocker.id,
      identifier: blocker.identifier,
      state: blocker.state
    })),
    created_at: issue.created_at ? new Date(issue.created_at.getTime()) : null,
    updated_at: issue.updated_at ? new Date(issue.updated_at.getTime()) : null
  };
}

function cloneDispatchBackpressureState(state: DispatchBackpressureState): DispatchBackpressureState {
  return { ...state };
}

function emptyDispatchBackpressureState(retryDelayMs = DEFAULT_BACKPRESSURE_RETRY_DELAY_MS): DispatchBackpressureState {
  return {
    active: false,
    reason_code: null,
    reason_detail: null,
    source: null,
    observed_at_ms: null,
    retry_delay_ms: retryDelayMs
  };
}

const emptyTranscriptToolCallDiagnosticStats = (): TranscriptToolCallDiagnosticStats => ({
  total_count: 0,
  newest_observed_at_ms: null,
  counts_by_lineage: {
    active_owned: 0,
    prior_stale: 0,
    external_manual: 0,
    unattributed: 0
  },
  counts_by_kind: {
    function_call: 0,
    function_call_output: 0
  }
});

function summarizeTranscriptToolCallDiagnostics(
  diagnostics: TranscriptToolCallDiagnostic[] | undefined
): TranscriptToolCallDiagnosticStats {
  const stats = emptyTranscriptToolCallDiagnosticStats();
  for (const diagnostic of diagnostics ?? []) {
    stats.total_count += 1;
    stats.counts_by_lineage[diagnostic.lineage] += 1;
    stats.counts_by_kind[diagnostic.kind] += 1;
    stats.newest_observed_at_ms =
      stats.newest_observed_at_ms === null
        ? diagnostic.observed_at_ms
        : Math.max(stats.newest_observed_at_ms, diagnostic.observed_at_ms);
  }
  return stats;
}

function cloneTranscriptToolCallDiagnostics(
  diagnostics: TranscriptToolCallDiagnostic[] | undefined,
  options: Required<StateSnapshotOptions>
): {
  transcript_tool_call_diagnostics?: TranscriptToolCallDiagnostic[];
  transcript_tool_call_diagnostic_stats?: TranscriptToolCallDiagnosticStats;
} {
  if (options.includeTranscriptToolCallDiagnostics) {
    return {
      transcript_tool_call_diagnostics: (diagnostics ?? []).map((diagnostic) => ({
        ...diagnostic
      })),
      transcript_tool_call_diagnostic_stats: undefined
    };
  }
  return {
    transcript_tool_call_diagnostics: undefined,
    transcript_tool_call_diagnostic_stats: summarizeTranscriptToolCallDiagnostics(diagnostics)
  };
}

function cloneRunningEntry(entry: RunningEntry, options: Required<StateSnapshotOptions>): RunningEntry {
  return {
    ...entry,
    issue: cloneIssue(entry.issue),
    tokens: { ...entry.tokens },
    last_reported_tokens: { ...entry.last_reported_tokens },
    persisted_turn_ids: [...(entry.persisted_turn_ids ?? [])],
    pending_persisted_turn_ids: [...(entry.pending_persisted_turn_ids ?? [])],
    recent_events: entry.recent_events.map((event) => ({ ...event })),
    quarantined_events: (entry.quarantined_events ?? []).map((event) => ({ ...event })),
    quarantined_event_count: entry.quarantined_event_count ?? 0,
    last_quarantined_event_at_ms: entry.last_quarantined_event_at_ms ?? null,
    copy_ignored_summary: entry.copy_ignored_summary ? { ...entry.copy_ignored_summary } : null,
    awaiting_input_since_ms: entry.awaiting_input_since_ms ?? null,
    pending_input_preview: entry.pending_input_preview ? { ...entry.pending_input_preview } : null,
    stalled_waiting_since_ms: entry.stalled_waiting_since_ms ?? null,
    stalled_waiting_reason: entry.stalled_waiting_reason ?? null,
    running_waiting_started_at_ms: entry.running_waiting_started_at_ms ?? null,
    last_progress_transition_at_ms: entry.last_progress_transition_at_ms ?? null,
    last_heartbeat_at_ms: entry.last_heartbeat_at_ms ?? null,
    heartbeat_only_event_emitted: entry.heartbeat_only_event_emitted ?? false,
    running_wait_stall_event_emitted: entry.running_wait_stall_event_emitted ?? false,
    progress_signals: entry.progress_signals ? { ...entry.progress_signals } : undefined,
    codex_thread_activity_at_ms: entry.codex_thread_activity_at_ms ?? null,
    codex_thread_activity_source: entry.codex_thread_activity_source ?? null,
    codex_thread_activity_status: entry.codex_thread_activity_status ?? null,
    current_phase: entry.current_phase,
    current_phase_at_ms: entry.current_phase_at_ms,
    phase_detail: entry.phase_detail,
    tool_call_ledger: Object.fromEntries(
      Object.entries(entry.tool_call_ledger ?? {}).map(([callId, call]) => [
        callId,
        {
          ...call,
          evidence_sources: [...call.evidence_sources]
        }
      ])
    ),
    outstanding_tool_calls: Object.fromEntries(
      Object.entries(entry.outstanding_tool_calls ?? {}).map(([callId, call]) => [callId, { ...call }])
    ),
    ...cloneTranscriptToolCallDiagnostics(entry.transcript_tool_call_diagnostics, options),
    codex_session_transcript_scan_offsets: { ...(entry.codex_session_transcript_scan_offsets ?? {}) },
    recovery: entry.recovery ? { ...entry.recovery } : null,
    termination: entry.termination ? { ...entry.termination } : null,
    ownership_conflict: entry.ownership_conflict ? { ...entry.ownership_conflict } : null,
    budget: entry.budget ? { ...entry.budget } : undefined
  };
}

function cloneOperatorAction(entry: OperatorActionRecord): OperatorActionRecord {
  return { ...entry };
}

function cloneReleasedWorkerRecord(entry: ReleasedWorkerRecord): ReleasedWorkerRecord {
  return { ...entry };
}

function normalizeOperatorReasonNote(reason_note: string | null | undefined): string | null {
  const trimmed = reason_note?.trim();
  return trimmed ? trimmed : null;
}

function reasonNoteRequiredFailure(): { ok: false; code: string; message: string } {
  return { ok: false, code: 'reason_note_required', message: 'reason_note is required' };
}

function cloneRetryEntry(entry: RetryEntry): RetryEntry {
  return {
    issue_id: entry.issue_id,
    identifier: entry.identifier,
    attempt: entry.attempt,
    issue_run_id: entry.issue_run_id ?? null,
    previous_attempt_id: entry.previous_attempt_id ?? null,
    due_at_ms: entry.due_at_ms,
    error: entry.error,
    worker_host: entry.worker_host,
    workspace_path: entry.workspace_path,
    provisioner_type: entry.provisioner_type,
    branch_name: entry.branch_name,
    repo_root: entry.repo_root,
    workspace_exists: entry.workspace_exists,
    workspace_git_status: entry.workspace_git_status,
    workspace_provisioned: entry.workspace_provisioned,
    workspace_is_git_worktree: entry.workspace_is_git_worktree,
    copy_ignored_applied: entry.copy_ignored_applied,
    copy_ignored_status: entry.copy_ignored_status,
    copy_ignored_summary: entry.copy_ignored_summary ? { ...entry.copy_ignored_summary } : null,
    stop_reason_code: entry.stop_reason_code,
    stop_reason_detail: entry.stop_reason_detail,
    previous_thread_id: entry.previous_thread_id,
    previous_turn_id: entry.previous_turn_id ?? null,
    previous_session_id: entry.previous_session_id,
    last_progress_checkpoint_at: entry.last_progress_checkpoint_at ?? null,
    last_phase: entry.last_phase,
    last_phase_at_ms: entry.last_phase_at_ms,
    last_phase_detail: entry.last_phase_detail,
    timer_handle: entry.timer_handle,
    progress_signals: entry.progress_signals ? { ...entry.progress_signals } : undefined,
    recover_workspace_attempt_residue: entry.recover_workspace_attempt_residue ?? false,
    budget: entry.budget ? { ...entry.budget } : undefined,
    recovery: entry.recovery ? { ...entry.recovery } : null
  };
}

function cloneBlockedEntry(entry: BlockedEntry, options: Required<StateSnapshotOptions>): BlockedEntry {
  return {
    issue_id: entry.issue_id,
    issue_identifier: entry.issue_identifier,
    attempt: entry.attempt,
    issue_run_id: entry.issue_run_id ?? null,
    previous_attempt_id: entry.previous_attempt_id ?? null,
    worker_host: entry.worker_host,
    workspace_path: entry.workspace_path,
    provisioner_type: entry.provisioner_type,
    branch_name: entry.branch_name,
    repo_root: entry.repo_root,
    workspace_exists: entry.workspace_exists,
    workspace_git_status: entry.workspace_git_status,
    workspace_provisioned: entry.workspace_provisioned,
    workspace_is_git_worktree: entry.workspace_is_git_worktree,
    copy_ignored_applied: entry.copy_ignored_applied,
    copy_ignored_status: entry.copy_ignored_status,
    copy_ignored_summary: entry.copy_ignored_summary ? { ...entry.copy_ignored_summary } : null,
    stop_reason_code: entry.stop_reason_code,
    stop_reason_detail: entry.stop_reason_detail,
    conflict_files: (entry.conflict_files ?? []).map((file) => ({ ...file })),
    classification_summary: entry.classification_summary ? { ...entry.classification_summary } : undefined,
    resolution_hints: [...(entry.resolution_hints ?? [])],
    previous_thread_id: entry.previous_thread_id,
    previous_turn_id: entry.previous_turn_id ?? null,
    previous_session_id: entry.previous_session_id,
    last_phase: entry.last_phase,
    last_phase_at_ms: entry.last_phase_at_ms,
    last_phase_detail: entry.last_phase_detail,
    blocked_at_ms: entry.blocked_at_ms,
    requires_manual_resume: true,
    awaiting_operator: true,
    awaiting_operator_reason_code: entry.awaiting_operator_reason_code ?? entry.stop_reason_code,
    awaiting_operator_since_ms: entry.awaiting_operator_since_ms ?? entry.blocked_at_ms,
    awaiting_operator_resume_nonce: entry.awaiting_operator_resume_nonce ?? 0,
    attempt_count_window: entry.attempt_count_window,
    window_minutes: entry.window_minutes,
    last_known_commit_sha: entry.last_known_commit_sha ?? null,
    last_progress_checkpoint_at: entry.last_progress_checkpoint_at ?? null,
    progress_signals: entry.progress_signals ? { ...entry.progress_signals } : undefined,
    required_actions: [...(entry.required_actions ?? [])],
    resume_override_reason: entry.resume_override_reason ?? null,
    budget: entry.budget ? { ...entry.budget } : undefined,
    pending_input: entry.pending_input
      ? {
          ...entry.pending_input,
          questions: entry.pending_input.questions.map((question) => ({
            ...question,
            options: question.options ? question.options.map((option) => ({ ...option })) : undefined
          }))
        }
      : null,
    tool_output_wait: entry.tool_output_wait
      ? {
          ...entry.tool_output_wait,
          recommended_actions: [...entry.tool_output_wait.recommended_actions]
        }
      : null,
    ...cloneTranscriptToolCallDiagnostics(entry.transcript_tool_call_diagnostics, options),
    session_console: (entry.session_console ?? []).map((event) => ({ ...event })),
    quarantined_events: (entry.quarantined_events ?? []).map((event) => ({ ...event })),
    quarantined_event_count: entry.quarantined_event_count ?? 0,
    last_quarantined_event_at_ms: entry.last_quarantined_event_at_ms ?? null,
    recovery: entry.recovery ? { ...entry.recovery } : null,
    worker_termination_result: entry.worker_termination_result
      ? cloneWorkerTerminationResult(entry.worker_termination_result)
      : null
  };
}

function cloneCircuitBreakerEntry(entry: CircuitBreakerEntry): CircuitBreakerEntry {
  return { ...entry };
}

function humanizeWorkerEvent(event: WorkerObservabilityEvent): string {
  const base = event.event.replace(/[._/]+/g, ' ').trim();
  if (event.detail && event.detail.trim().length > 0) {
    return `${base}: ${event.detail.trim()}`;
  }

  return base;
}

function normalizeCodexAppServerPid(pid: number | string | null | undefined): string | null {
  return pid === undefined || pid === null ? null : String(pid);
}

function normalizeWorkerInstanceId(workerInstanceId: string | null | undefined): string | null {
  const trimmed = workerInstanceId?.trim();
  return trimmed ? trimmed : null;
}

function severityForRuntimeEvent(eventName: string): 'info' | 'warn' | 'error' {
  if (eventName.includes('failed') || eventName.includes('error')) {
    return 'error';
  }
  if (eventName.includes('retry') || eventName.includes('validation') || eventName.includes('unsupported')) {
    return 'warn';
  }
  return 'info';
}

function asIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function truncateLogValue(value: string, maxLength = 240): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function persistenceErrorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return truncateLogValue(String(redactUnknown(error.message)));
  }
  if (typeof error === 'string') {
    return truncateLogValue(String(redactUnknown(error)));
  }
  return null;
}

function persistenceErrorName(error: unknown): string | null {
  return error instanceof Error ? error.name : null;
}

function persistenceErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : null;
}

function classifyPersistenceFailure(error: unknown): string {
  const message = persistenceErrorMessage(error)?.toLowerCase() ?? '';
  const code = persistenceErrorCode(error)?.toLowerCase() ?? '';
  if (message.includes('foreign key') || message.includes('does not exist')) {
    return 'referential_integrity';
  }
  if (message.includes('unique') || message.includes('constraint') || code.includes('constraint')) {
    return 'constraint_violation';
  }
  if (message.includes('monotonic') || message.includes('ended_at')) {
    return 'timestamp_ordering';
  }
  return 'write_failed';
}

function normalizeStateName(state: string): string {
  return state.trim().toLowerCase();
}

function defaultBudgetProjection(windowMinutes = 1440): BudgetRuntimeProjection {
  return {
    budget_usage_tokens: null,
    budget_limit_tokens: null,
    budget_window_minutes: windowMinutes,
    budget_status: 'ok',
    budget_policy: null,
    budget_message: null
  };
}

type BudgetScope = 'per_run_total_tokens' | 'per_issue_rolling_tokens';

interface BudgetCandidate {
  scope: BudgetScope;
  usage: number;
  limit: number;
  warning_threshold: number;
  status: Exclude<BudgetRuntimeProjection['budget_status'], 'telemetry_unavailable'>;
}

function budgetScopeLabel(scope: BudgetScope): string {
  return scope === 'per_issue_rolling_tokens' ? 'rolling issue budget' : 'per-run budget';
}

function budgetStatusRank(status: BudgetCandidate['status']): number {
  switch (status) {
    case 'hard_limited':
      return 2;
    case 'warning':
      return 1;
    case 'ok':
      return 0;
  }
}

export class OrchestratorCore {
  private readonly config: OrchestratorOptions['config'];
  private readonly ports: OrchestratorOptions['ports'];
  private readonly nowMs: () => number;
  private readonly logger?: StructuredLogger;
  private readonly persistence?: OrchestratorOptions['persistence'];
  private readonly phaseSettings: PhaseMarkerSettings;
  private readonly throughputTracker: ThroughputTracker;

  private readonly state: OrchestratorState;
  private readonly executionGraphPersistenceQueues = new WeakMap<RunningEntry, Promise<void>>();
  private readonly persistedPhaseSpanKeys = new WeakMap<RunningEntry, Set<string>>();
  private hostRoundRobinIndex: number;
  private serializedOperation: Promise<void>;

  constructor(options: OrchestratorOptions) {
    this.config = options.config;
    this.config.no_telemetry_warning_threshold_ms = this.config.no_telemetry_warning_threshold_ms ?? 120_000;
    this.config.progress_heartbeat_only_warn_ms = this.config.progress_heartbeat_only_warn_ms ?? 120_000;
    this.config.progress_stalled_waiting_ms = this.config.progress_stalled_waiting_ms ?? this.config.running_wait_stall_threshold_ms ?? 300_000;
    this.config.running_wait_stall_threshold_ms = this.config.progress_stalled_waiting_ms;
    this.config.worker_opaque_activity_hard_timeout_ms = this.config.worker_opaque_activity_hard_timeout_ms ?? 1_800_000;
    this.config.inactive_worker_pid_ttl_ms = this.config.inactive_worker_pid_ttl_ms ?? DEFAULT_INACTIVE_WORKER_PID_TTL_MS;
    this.ports = options.ports;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.logger = options.logger;
    this.persistence = options.persistence;
    this.phaseSettings = {
      enabled: options.config.phase_markers_enabled !== false,
      timeline_limit: Math.max(1, options.config.phase_timeline_limit ?? 30),
      last_emit_error_code: null
    };

    this.state = {
      poll_interval_ms: this.config.poll_interval_ms,
      max_concurrent_agents: this.config.max_concurrent_agents,
      running: new Map(),
      claimed: new Set(),
      retry_attempts: new Map(),
      blocked_inputs: new Map(),
      operator_actions: new Map(),
      circuit_breakers: new Map(),
      redispatch_progress: new Map(),
      phase_timeline: new Map(),
      budget_usage_samples: new Map(),
      inactive_worker_pids: new Map(),
      released_workers: new Map(),
      completed: new Set(),
      codex_totals: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        seconds_running: 0
      },
      codex_rate_limits: null,
      health: {
        dispatch_validation: 'ok',
        last_error: null,
        dispatch_backpressure: emptyDispatchBackpressureState(this.getBackpressureRetryDelayMs())
      },
      throughput: {
        current_tps: 0,
        avg_tps_60s: 0,
        window_seconds: 600,
        sparkline_10m: Array.from({ length: 24 }, () => 0),
        sample_count: 0
      },
      recent_runtime_events: []
    };
    this.hostRoundRobinIndex = 0;
    this.throughputTracker = new ThroughputTracker();
    this.serializedOperation = Promise.resolve();
  }

  getStateSnapshot(options: StateSnapshotOptions = {}): OrchestratorState {
    const snapshotOptions: Required<StateSnapshotOptions> = {
      includeTranscriptToolCallDiagnostics: options.includeTranscriptToolCallDiagnostics ?? true
    };
    return {
      ...this.state,
      snapshot_generated_at_ms: this.nowMs(),
      running: new Map(
        Array.from(this.state.running.entries()).map(([issueId, entry]) => [issueId, cloneRunningEntry(entry, snapshotOptions)])
      ),
      claimed: new Set(this.state.claimed.values()),
      retry_attempts: new Map(
        Array.from(this.state.retry_attempts.entries()).map(([issueId, entry]) => [issueId, cloneRetryEntry(entry)])
      ),
      blocked_inputs: new Map(
        Array.from(this.state.blocked_inputs.entries()).map(([issueId, entry]) => [issueId, cloneBlockedEntry(entry, snapshotOptions)])
      ),
      operator_actions: new Map(
        Array.from((this.state.operator_actions ?? new Map<string, OperatorActionRecord[]>()).entries()).map(([issueId, entries]) => [
          issueId,
          entries.map((entry) => cloneOperatorAction(entry))
        ])
      ),
      circuit_breakers: new Map(
        Array.from(this.state.circuit_breakers.entries()).map(([issueId, entry]) => [issueId, cloneCircuitBreakerEntry(entry)])
      ),
      redispatch_progress: new Map(
        Array.from((this.state.redispatch_progress ?? new Map<string, RedispatchProgressSample[]>()).entries()).map(([issueId, entries]) => [
          issueId,
          entries.map((entry) => ({ ...entry }))
        ])
      ),
      phase_timeline: new Map(
        Array.from((this.state.phase_timeline ?? new Map<string, PhaseMarker[]>()).entries()).map(([issueId, markers]) => [
          issueId,
          markers.map((marker: PhaseMarker) => ({ ...marker }))
        ])
      ),
      budget_usage_samples: new Map(
        Array.from((this.state.budget_usage_samples ?? new Map<string, Array<{ at_ms: number; total_tokens: number }>>()).entries()).map(([issueId, samples]) => [
          issueId,
          samples.map((sample) => ({ ...sample }))
        ])
      ),
      inactive_worker_pids: new Map(
        Array.from(
          (
            this.state.inactive_worker_pids ??
            new Map<
              string,
              Array<{
                pid: string;
                recorded_at_ms: number;
                reason: string;
                thread_id: string | null;
                turn_id: string | null;
                session_id: string | null;
              }>
            >()
          ).entries()
        ).map(([issueId, entries]) => [issueId, entries.map((entry) => ({ ...entry }))])
      ),
      released_workers: new Map(
        Array.from((this.state.released_workers ?? new Map<string, ReleasedWorkerRecord[]>()).entries()).map(
          ([issueId, entries]) => [issueId, entries.map((entry) => cloneReleasedWorkerRecord(entry))]
        )
      ),
      completed: new Set(this.state.completed.values()),
      codex_totals: { ...this.state.codex_totals },
      codex_rate_limits: this.state.codex_rate_limits ? { ...this.state.codex_rate_limits } : null,
      health: {
        ...this.state.health,
        dispatch_backpressure: cloneDispatchBackpressureState(
          this.state.health.dispatch_backpressure ?? emptyDispatchBackpressureState(this.getBackpressureRetryDelayMs())
        )
      },
      throughput: this.throughputTracker.snapshot(this.nowMs()),
      recent_runtime_events: this.state.recent_runtime_events.map((event) => ({ ...event }))
    };
  }

  applyRuntimeConfig(config: {
    poll_interval_ms: number;
    max_concurrent_agents: number;
    max_concurrent_agents_by_state: Record<string, number>;
    max_retry_backoff_ms: number;
    respawn_window_minutes: number;
    respawn_max_attempts_without_progress: number;
    active_states: string[];
    terminal_states: string[];
    handoff_states?: string[];
    fresh_dispatch_states?: string[];
    github_linking_mode?: 'off' | 'warn' | 'required' | string;
    stall_timeout_ms: number;
    no_telemetry_warning_threshold_ms?: number;
    running_wait_stall_threshold_ms?: number;
    progress_heartbeat_only_warn_ms?: number;
    progress_stalled_waiting_ms?: number;
    worker_opaque_activity_hard_timeout_ms?: number;
    inactive_worker_pid_ttl_ms?: number;
    worker_hosts?: string[];
    max_concurrent_agents_per_host?: number | null;
    phase_markers_enabled?: boolean;
    phase_timeline_limit?: number;
    budget?: OrchestratorOptions['config']['budget'];
    dispatch_backpressure?: OrchestratorOptions['config']['dispatch_backpressure'];
  }): void {
    this.config.poll_interval_ms = config.poll_interval_ms;
    this.config.max_concurrent_agents = config.max_concurrent_agents;
    this.config.max_concurrent_agents_by_state = { ...config.max_concurrent_agents_by_state };
    this.config.max_retry_backoff_ms = config.max_retry_backoff_ms;
    this.config.respawn_window_minutes = config.respawn_window_minutes;
    this.config.respawn_max_attempts_without_progress = config.respawn_max_attempts_without_progress;
    this.config.active_states = [...config.active_states];
    this.config.terminal_states = [...config.terminal_states];
    this.config.handoff_states = [...(config.handoff_states ?? [])];
    this.config.fresh_dispatch_states = [...(config.fresh_dispatch_states ?? [])];
    this.config.github_linking_mode = config.github_linking_mode ?? 'off';
    this.config.stall_timeout_ms = config.stall_timeout_ms;
    this.config.no_telemetry_warning_threshold_ms = config.no_telemetry_warning_threshold_ms ?? 120_000;
    this.config.progress_heartbeat_only_warn_ms = config.progress_heartbeat_only_warn_ms ?? 120_000;
    this.config.progress_stalled_waiting_ms = config.progress_stalled_waiting_ms ?? config.running_wait_stall_threshold_ms ?? 300_000;
    this.config.running_wait_stall_threshold_ms = this.config.progress_stalled_waiting_ms;
    this.config.worker_opaque_activity_hard_timeout_ms = config.worker_opaque_activity_hard_timeout_ms ?? 1_800_000;
    this.config.inactive_worker_pid_ttl_ms = config.inactive_worker_pid_ttl_ms ?? DEFAULT_INACTIVE_WORKER_PID_TTL_MS;
    this.config.worker_hosts = config.worker_hosts ? [...config.worker_hosts] : [];
    this.config.max_concurrent_agents_per_host = config.max_concurrent_agents_per_host ?? null;
    this.config.phase_markers_enabled = config.phase_markers_enabled ?? true;
    this.config.phase_timeline_limit = config.phase_timeline_limit ?? 30;
    this.config.budget = config.budget;
    this.config.dispatch_backpressure = config.dispatch_backpressure;
    this.phaseSettings.enabled = this.config.phase_markers_enabled !== false;
    this.phaseSettings.timeline_limit = Math.max(1, this.config.phase_timeline_limit ?? 30);

    this.state.poll_interval_ms = config.poll_interval_ms;
    this.state.max_concurrent_agents = config.max_concurrent_agents;
    this.state.health.dispatch_backpressure = {
      ...(this.state.health.dispatch_backpressure ?? emptyDispatchBackpressureState(this.getBackpressureRetryDelayMs())),
      retry_delay_ms: this.getBackpressureRetryDelayMs()
    };
  }

  async tick(reason: TickReason): Promise<void> {
    await this.runSerializedOperation(() => this.tickOnce(reason));
  }

  private getBackpressureRetryDelayMs(): number {
    const configured = this.config.dispatch_backpressure?.retry_delay_ms;
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
      return Math.trunc(configured);
    }
    return DEFAULT_BACKPRESSURE_RETRY_DELAY_MS;
  }

  private isBackpressureEnabled(): boolean {
    return this.config.dispatch_backpressure?.enabled !== false;
  }

  private classifyControlPlaneEndpointLastHealth(
    endpoint: ControlPlaneEndpointHealth,
    summary: ControlPlaneHealthSummary
  ): ControlPlaneHealthState {
    if (endpoint.last_snapshot_error_code) {
      return 'degraded';
    }
    const duration = endpoint.last_duration_ms ?? 0;
    const payload = endpoint.last_payload_bytes ?? 0;
    if (duration >= summary.thresholds.degraded_ms || payload >= summary.thresholds.degraded_payload_bytes) {
      return 'degraded';
    }
    if (payload >= summary.thresholds.large_payload_bytes) {
      return 'large';
    }
    if (duration >= summary.thresholds.slow_ms) {
      return 'slow';
    }
    return 'ok';
  }

  private evaluateControlPlaneBackpressure(): DispatchBackpressureState | null {
    const summary = this.ports.getControlPlaneHealth?.();
    if (!summary || summary.endpoints.length === 0) {
      return null;
    }

    const staleAfterMs =
      this.config.dispatch_backpressure?.control_plane_stale_after_ms ?? DEFAULT_BACKPRESSURE_CONTROL_PLANE_STALE_AFTER_MS;
    const threshold = this.config.dispatch_backpressure?.control_plane_health ?? DEFAULT_BACKPRESSURE_CONTROL_PLANE_HEALTH;
    const thresholdRank = CONTROL_PLANE_HEALTH_RANK[threshold] ?? CONTROL_PLANE_HEALTH_RANK.degraded;
    const nowMs = this.nowMs();

    let selected:
      | {
          endpoint: ControlPlaneEndpointHealth;
          health: ControlPlaneHealthState;
          observedAtMs: number;
        }
      | null = null;

    for (const endpoint of summary.endpoints) {
      if (!endpoint.last_observed_at) {
        continue;
      }
      const observedAtMs = Date.parse(endpoint.last_observed_at);
      if (!Number.isFinite(observedAtMs) || nowMs - observedAtMs > staleAfterMs) {
        continue;
      }
      const health = this.classifyControlPlaneEndpointLastHealth(endpoint, summary);
      if (CONTROL_PLANE_HEALTH_RANK[health] < thresholdRank) {
        continue;
      }
      if (!selected || CONTROL_PLANE_HEALTH_RANK[health] > CONTROL_PLANE_HEALTH_RANK[selected.health]) {
        selected = { endpoint, health, observedAtMs };
      }
    }

    if (!selected) {
      return null;
    }

    const reasonDetail = [
      `source=control_plane`,
      `endpoint=${selected.endpoint.endpoint}`,
      `transport=${selected.endpoint.transport}`,
      `health=${selected.health}`,
      `duration_ms=${selected.endpoint.last_duration_ms ?? 'unknown'}`,
      `payload_bytes=${selected.endpoint.last_payload_bytes ?? 'unknown'}`
    ].join(' ');

    return {
      active: true,
      reason_code: REASON_CODES.dispatchBackpressureControlPlane,
      reason_detail: reasonDetail,
      source: 'control_plane',
      observed_at_ms: selected.observedAtMs,
      retry_delay_ms: this.getBackpressureRetryDelayMs()
    };
  }

  private evaluateHostLoadBackpressure(): DispatchBackpressureState | null {
    const threshold = this.config.dispatch_backpressure?.host_load_per_cpu;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0) {
      return null;
    }

    const configuredLoad = this.ports.getHostLoad?.();
    const load = configuredLoad ?? {
      load_average_1m: os.loadavg()[0] ?? 0,
      cpu_count: os.cpus().length
    };
    const cpuCount = Math.max(1, Math.trunc(load.cpu_count));
    const loadPerCpu = load.load_average_1m / cpuCount;
    if (!Number.isFinite(loadPerCpu) || loadPerCpu < threshold) {
      return null;
    }

    return {
      active: true,
      reason_code: REASON_CODES.dispatchBackpressureHostLoad,
      reason_detail: [
        `source=host_load`,
        `load_average_1m=${Math.round(load.load_average_1m * 100) / 100}`,
        `cpu_count=${cpuCount}`,
        `load_per_cpu=${Math.round(loadPerCpu * 100) / 100}`,
        `threshold_per_cpu=${threshold}`
      ].join(' '),
      source: 'host_load',
      observed_at_ms: this.nowMs(),
      retry_delay_ms: this.getBackpressureRetryDelayMs()
    };
  }

  private evaluateDispatchBackpressure(): DispatchBackpressureState {
    const retryDelayMs = this.getBackpressureRetryDelayMs();
    const minRunningAgents = Math.max(
      0,
      Math.trunc(this.config.dispatch_backpressure?.min_running_agents ?? DEFAULT_BACKPRESSURE_MIN_RUNNING_AGENTS)
    );

    if (!this.isBackpressureEnabled() || this.state.running.size < minRunningAgents) {
      return emptyDispatchBackpressureState(retryDelayMs);
    }

    return this.evaluateControlPlaneBackpressure() ?? this.evaluateHostLoadBackpressure() ?? emptyDispatchBackpressureState(retryDelayMs);
  }

  private recordDispatchBackpressure(issue: Issue, backpressure: DispatchBackpressureState, attempt: number | null): void {
    this.state.health.dispatch_backpressure = cloneDispatchBackpressureState(backpressure);
    this.state.health.last_error = `dispatch backpressure active for ${issue.identifier}: ${backpressure.reason_code}`;
    this.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.orchestration.dispatchBackpressureActive,
      message: 'dispatch delayed by local backpressure',
      context: {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        retry_attempt: attempt ?? 0,
        reason_code: backpressure.reason_code,
        reason_detail: backpressure.reason_detail,
        source: backpressure.source,
        retry_delay_ms: backpressure.retry_delay_ms
      }
    });
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.orchestration.dispatchBackpressureActive,
      severity: 'warn',
      issue_identifier: issue.identifier,
      detail: `${backpressure.reason_code}: ${backpressure.reason_detail ?? 'dispatch delayed'}`
    });
  }

  private async delayDispatchForBackpressure(issue: Issue, attempt: number | null, backpressure: DispatchBackpressureState): Promise<void> {
    this.recordDispatchBackpressure(issue, backpressure, attempt);
    await this.scheduleRetry({
      issue_id: issue.id,
      identifier: issue.identifier,
      attempt: attempt ?? 1,
      delay_type: 'backpressure',
      delay_ms: backpressure.retry_delay_ms,
      error: 'dispatch delayed by local backpressure',
      worker_host: null,
      workspace_path: null,
      provisioner_type: null,
      branch_name: null,
      repo_root: null,
      workspace_exists: false,
      workspace_git_status: null,
      workspace_provisioned: false,
      workspace_is_git_worktree: false,
      copy_ignored_applied: false,
      copy_ignored_status: null,
      copy_ignored_summary: null,
      stop_reason_code: backpressure.reason_code,
      stop_reason_detail: backpressure.reason_detail,
      issue_snapshot: issue
    });
  }

  private async delayRetryForBackpressure(
    issue: Issue,
    retryEntry: RetryEntry,
    backpressure: DispatchBackpressureState,
    freshDispatch: boolean
  ): Promise<void> {
    this.recordDispatchBackpressure(issue, backpressure, retryEntry.attempt);
    await this.scheduleRetry({
      issue_id: issue.id,
      identifier: issue.identifier,
      attempt: retryEntry.attempt,
      issue_run_id: freshDispatch ? null : retryEntry.issue_run_id,
      previous_attempt_id: freshDispatch ? null : retryEntry.previous_attempt_id,
      delay_type: 'backpressure',
      delay_ms: backpressure.retry_delay_ms,
      error: 'dispatch delayed by local backpressure',
      worker_host: freshDispatch ? null : retryEntry.worker_host ?? null,
      workspace_path: freshDispatch ? null : retryEntry.workspace_path ?? null,
      provisioner_type: freshDispatch ? null : retryEntry.provisioner_type ?? null,
      branch_name: freshDispatch ? null : retryEntry.branch_name ?? null,
      repo_root: freshDispatch ? null : retryEntry.repo_root ?? null,
      workspace_exists: freshDispatch ? false : retryEntry.workspace_exists,
      workspace_git_status: freshDispatch ? null : retryEntry.workspace_git_status,
      workspace_provisioned: freshDispatch ? false : retryEntry.workspace_provisioned,
      workspace_is_git_worktree: freshDispatch ? false : retryEntry.workspace_is_git_worktree,
      copy_ignored_applied: freshDispatch ? false : retryEntry.copy_ignored_applied,
      copy_ignored_status: freshDispatch ? null : retryEntry.copy_ignored_status,
      copy_ignored_summary: freshDispatch ? null : retryEntry.copy_ignored_summary,
      stop_reason_code: backpressure.reason_code,
      stop_reason_detail: backpressure.reason_detail,
      previous_thread_id: freshDispatch ? null : retryEntry.previous_thread_id ?? null,
      previous_turn_id: freshDispatch ? null : retryEntry.previous_turn_id ?? null,
      previous_session_id: freshDispatch ? null : retryEntry.previous_session_id ?? null,
      progress_signals: retryEntry.progress_signals,
      recover_workspace_attempt_residue: freshDispatch ? false : retryEntry.recover_workspace_attempt_residue ?? false,
      budget: retryEntry.budget,
      recovery: retryEntry.recovery,
      issue_snapshot: issue
    });
  }

  private async tickOnce(reason: TickReason): Promise<void> {
    await this.reconcileRunningIssues();
    await this.reconcileBlockedInputs();

    const previousDispatchValidation = this.state.health.dispatch_validation;
    const preflight = this.ports.dispatchPreflight();
    if (!preflight.dispatch_allowed) {
      this.state.health.dispatch_validation = 'failed';
      this.state.health.last_error = preflight.reason ?? 'dispatch preflight rejected dispatch';
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.orchestration.dispatchValidationFailed,
        message: this.state.health.last_error,
        context: {
          reason: this.state.health.last_error,
          tick_reason: reason
        }
      });
      this.recordRuntimeEvent({
        event: CANONICAL_EVENT.orchestration.dispatchValidationFailed,
        severity: 'warn',
        detail: this.state.health.last_error ?? undefined
      });
      this.ports.notifyObservers?.();
      return;
    }

    this.state.health.dispatch_validation = 'ok';
    if (previousDispatchValidation === 'failed') {
      this.logger?.log({
        level: 'info',
        event: CANONICAL_EVENT.orchestration.dispatchValidationRecovered,
        message: 'dispatch validation recovered',
        context: {
          tick_reason: reason
        }
      });
      this.recordRuntimeEvent({
        event: CANONICAL_EVENT.orchestration.dispatchValidationRecovered,
        severity: 'info'
      });
    }
    this.state.health.last_error = null;
    this.state.health.dispatch_backpressure = emptyDispatchBackpressureState(this.getBackpressureRetryDelayMs());

    let candidates: Issue[];
    try {
      candidates = await this.ports.tracker.fetch_candidate_issues();
    } catch (error) {
      this.state.health.last_error = 'failed to fetch candidate issues';
      this.logger?.log({
        level: 'error',
        event: CANONICAL_EVENT.tracker.candidateFetchFailed,
        message: 'failed to fetch candidate issues',
        context: {
          tick_reason: reason,
          error: error instanceof Error ? error.message : 'unknown'
        }
      });
      this.recordRuntimeEvent({
        event: CANONICAL_EVENT.tracker.candidateFetchFailed,
        severity: 'error',
        detail: error instanceof Error ? error.message : 'unknown'
      });
      this.ports.notifyObservers?.();
      return;
    }

    const sortedCandidates = sortCandidatesForDispatch(candidates);
    const githubLinkingMode = this.config.github_linking_mode ?? 'off';
    let missingGithubLinkCount = 0;

    for (const issue of sortedCandidates) {
      if (availableGlobalSlots(this.state) <= 0) {
        break;
      }

      if (this.state.blocked_inputs.has(issue.id)) {
        continue;
      }

      if (this.state.circuit_breakers.get(issue.id)?.breaker_active) {
        continue;
      }

      const eligibility = shouldDispatchIssue(issue, this.state, this.config);
      if (!eligibility.eligible) {
        if (eligibility.reason === 'already_running' || eligibility.reason === 'already_claimed') {
          this.recordDuplicateDispatchSkipped(issue, 0);
        }
        continue;
      }

      if (githubLinkingMode !== 'off' && issue.has_github_issue_link !== true) {
        missingGithubLinkCount += 1;
        this.logger?.log({
          level: githubLinkingMode === 'required' ? 'warn' : 'info',
          event: CANONICAL_EVENT.tracker.githubIssueLinkMissing,
          message:
            githubLinkingMode === 'required'
              ? `issue ${issue.identifier} is missing a linked GitHub issue; dispatch skipped`
              : `issue ${issue.identifier} is missing a linked GitHub issue`,
          context: {
            issue_id: issue.id,
            issue_identifier: issue.identifier,
            github_linking_mode: githubLinkingMode
          }
        });
        this.recordRuntimeEvent({
          event: CANONICAL_EVENT.tracker.githubIssueLinkMissing,
          severity: githubLinkingMode === 'required' ? 'warn' : 'info',
          issue_identifier: issue.identifier,
          detail:
            githubLinkingMode === 'required'
              ? 'missing_link_required_dispatch_skipped'
              : 'missing_link_warning_only'
        });
        if (githubLinkingMode === 'required') {
          continue;
        }
      }

      const backpressure = this.evaluateDispatchBackpressure();
      if (backpressure.active) {
        await this.delayDispatchForBackpressure(issue, null, backpressure);
        break;
      }

      await this.dispatchIssue(issue, null);
    }

    if (githubLinkingMode === 'required' && missingGithubLinkCount > 0) {
      this.state.health.last_error = `${missingGithubLinkCount} candidate issue(s) missing linked GitHub issue`;
    }

    this.ports.notifyObservers?.();
  }

  private async runSerializedOperation(operation: () => Promise<void>): Promise<void> {
    const run = this.serializedOperation.then(operation, operation);
    this.serializedOperation = run.catch(() => undefined);
    await run;
  }

  private workerInstanceIdFromHandle(workerHandle: unknown): string | null {
    const record = asRecord(workerHandle);
    return normalizeWorkerInstanceId(readString(record?.worker_instance_id));
  }

  onWorkerEvent(issue_id: string, workerEvent: WorkerObservabilityEvent): void {
    const runningEntry = this.state.running.get(issue_id);
    if (!runningEntry) {
      const blockedEntry = this.state.blocked_inputs.get(issue_id);
      if (blockedEntry?.awaiting_operator) {
        this.quarantineBlockedWorkerEvent(blockedEntry, workerEvent, 'awaiting_operator_latch');
      }
      return;
    }

    const staleReason = this.staleWorkerEventReasonForRunningEntry(issue_id, runningEntry, workerEvent);
    if (staleReason) {
      this.recordStaleRunningWorkerEvent(issue_id, runningEntry, workerEvent, staleReason);
      return;
    }

    runningEntry.last_codex_timestamp_ms = workerEvent.timestamp_ms;
    runningEntry.last_event = workerEvent.event;
    runningEntry.last_event_summary = humanizeWorkerEvent(workerEvent);
    runningEntry.last_message = workerEvent.detail ?? null;
    this.captureWorkerProgressSignal(runningEntry, workerEvent);
    if (
      workerEvent.codex_thread_activity_at_ms !== undefined &&
      workerEvent.codex_thread_activity_at_ms !== null &&
      (!workerEvent.thread_id || !runningEntry.thread_id || workerEvent.thread_id === runningEntry.thread_id)
    ) {
      runningEntry.codex_thread_activity_at_ms = workerEvent.codex_thread_activity_at_ms;
      runningEntry.codex_thread_activity_source = workerEvent.codex_thread_activity_source ?? 'app_server_protocol_thread_updated_at';
      runningEntry.codex_thread_activity_status = workerEvent.codex_thread_activity_status ?? null;
    }
    if (workerEvent.event === CANONICAL_EVENT.codex.turnInputRequired) {
      runningEntry.awaiting_input_since_ms = workerEvent.timestamp_ms;
      runningEntry.pending_input_preview = {
        type: REASON_CODES.turnInputRequired,
        prompt_preview: workerEvent.detail ?? null,
        option_count: null
      };
    }
    if (workerEvent.event === CANONICAL_EVENT.codex.turnWaiting) {
      const thresholdMs = this.config.progress_stalled_waiting_ms ?? this.config.running_wait_stall_threshold_ms ?? 300_000;
      runningEntry.last_heartbeat_at_ms = workerEvent.timestamp_ms;
      if (runningEntry.running_waiting_started_at_ms === undefined || runningEntry.running_waiting_started_at_ms === null) {
        runningEntry.running_waiting_started_at_ms = workerEvent.timestamp_ms;
        runningEntry.running_wait_stall_event_emitted = false;
        runningEntry.heartbeat_only_event_emitted = false;
      }
      if (
        (runningEntry.stalled_waiting_since_ms === undefined || runningEntry.stalled_waiting_since_ms === null) &&
        thresholdMs > 0
      ) {
        runningEntry.stalled_waiting_since_ms = runningEntry.running_waiting_started_at_ms + thresholdMs;
      }
      runningEntry.stalled_waiting_reason = null;
      this.maybeEmitHeartbeatOnly(issue_id, runningEntry, workerEvent.timestamp_ms);
    } else if (this.shouldResetRunningWaitEpisode(workerEvent.event)) {
      this.resetRunningWaitEpisode(runningEntry, workerEvent.timestamp_ms);
    } else if (this.isMeaningfulWorkerProgressEvent(workerEvent)) {
      runningEntry.last_progress_transition_at_ms = workerEvent.timestamp_ms;
    }

    if (workerEvent.thread_id && !runningEntry.thread_id) {
      runningEntry.thread_id = workerEvent.thread_id;
    }

    if (workerEvent.turn_id) {
      runningEntry.turn_id = workerEvent.turn_id;
    }

    if (workerEvent.codex_app_server_pid !== undefined && workerEvent.codex_app_server_pid !== null) {
      runningEntry.codex_app_server_pid = String(workerEvent.codex_app_server_pid);
    }

    if (!workerEvent.session_id && runningEntry.thread_id && runningEntry.turn_id) {
      workerEvent.session_id = `${runningEntry.thread_id}-${runningEntry.turn_id}`;
    }

    if (workerEvent.session_id) {
      const hadSessionId = runningEntry.session_id;
      runningEntry.session_id = workerEvent.session_id;
      if (runningEntry.run_id && hadSessionId !== workerEvent.session_id) {
        void this.persistence
          ?.recordSession({
            run_id: runningEntry.run_id,
            session_id: workerEvent.session_id
          })
          .catch(() => {
            this.logger?.log({
              level: 'warn',
              event: CANONICAL_EVENT.persistence.recordSessionFailed,
              message: `failed to persist session for ${runningEntry.identifier}`,
              context: {
                issue_id,
                issue_identifier: runningEntry.identifier,
                session_id: workerEvent.session_id
              }
            });
          });
      }
    }

    this.captureMissingToolOutputRecoveryReplacementLineage(runningEntry, workerEvent);
    this.updateOutstandingToolCalls(runningEntry, workerEvent);

    if (workerEvent.event === CANONICAL_EVENT.codex.turnStarted) {
      runningEntry.turn_count += 1;
      runningEntry.token_telemetry_status = 'pending';
      runningEntry.token_telemetry_turn_started_at_ms = workerEvent.timestamp_ms;
      runningEntry.token_telemetry_warning_emitted = false;
    }

    const usageThreadMatches =
      !workerEvent.thread_id || !runningEntry.thread_id || workerEvent.thread_id === runningEntry.thread_id;
    if (workerEvent.usage && usageThreadMatches) {
      const usage = workerEvent.usage;
      const inputDelta = Math.max(0, usage.input_tokens - runningEntry.last_reported_tokens.input_tokens);
      const outputDelta = Math.max(0, usage.output_tokens - runningEntry.last_reported_tokens.output_tokens);
      const totalDelta = Math.max(0, usage.total_tokens - runningEntry.last_reported_tokens.total_tokens);
      this.state.codex_totals.input_tokens += inputDelta;
      this.state.codex_totals.output_tokens += outputDelta;
      this.state.codex_totals.total_tokens += totalDelta;
      if (
        typeof usage.cached_input_tokens === 'number' &&
        typeof runningEntry.last_reported_tokens.cached_input_tokens === 'number'
      ) {
        this.state.codex_totals.cached_input_tokens =
          (this.state.codex_totals.cached_input_tokens ?? 0) +
          Math.max(0, usage.cached_input_tokens - runningEntry.last_reported_tokens.cached_input_tokens);
      } else if (typeof usage.cached_input_tokens === 'number' && this.state.codex_totals.cached_input_tokens === undefined) {
        this.state.codex_totals.cached_input_tokens = usage.cached_input_tokens;
      }
      if (
        typeof usage.reasoning_output_tokens === 'number' &&
        typeof runningEntry.last_reported_tokens.reasoning_output_tokens === 'number'
      ) {
        this.state.codex_totals.reasoning_output_tokens =
          (this.state.codex_totals.reasoning_output_tokens ?? 0) +
          Math.max(0, usage.reasoning_output_tokens - runningEntry.last_reported_tokens.reasoning_output_tokens);
      } else if (
        typeof usage.reasoning_output_tokens === 'number' &&
        this.state.codex_totals.reasoning_output_tokens === undefined
      ) {
        this.state.codex_totals.reasoning_output_tokens = usage.reasoning_output_tokens;
      }
      if (typeof usage.model_context_window === 'number') {
        this.state.codex_totals.model_context_window = usage.model_context_window;
      }
      runningEntry.tokens = { ...usage };
      runningEntry.last_reported_tokens = { ...usage };
      runningEntry.token_telemetry_status = workerEvent.token_telemetry_status ?? 'available';
      runningEntry.token_telemetry_last_source = workerEvent.token_telemetry_last_source ?? 'worker_event_usage';
      runningEntry.token_telemetry_last_at_ms = workerEvent.token_telemetry_last_at_ms ?? workerEvent.timestamp_ms;
      if (totalDelta > 0) {
        this.resetRunningWaitEpisode(runningEntry, runningEntry.token_telemetry_last_at_ms);
      }
      if (totalDelta > 0) {
        this.throughputTracker.observe({
          at_ms: workerEvent.timestamp_ms,
          tokens: totalDelta
        });
      }
      runningEntry.budget = this.computeBudgetProjection(issue_id, usage.total_tokens, 'available');
    }

    if (workerEvent.token_telemetry_status && !workerEvent.usage) {
      runningEntry.token_telemetry_status = workerEvent.token_telemetry_status;
      runningEntry.token_telemetry_last_source =
        workerEvent.token_telemetry_last_source ?? runningEntry.token_telemetry_last_source;
      runningEntry.token_telemetry_last_at_ms =
        workerEvent.token_telemetry_last_at_ms ?? runningEntry.token_telemetry_last_at_ms;
    }

    if (this.isTerminalTurnEvent(workerEvent.event) && !workerEvent.usage && runningEntry.token_telemetry_status === 'pending') {
      runningEntry.token_telemetry_status = 'unavailable';
    }

    this.maybeEmitTokenTelemetryWarning(runningEntry, workerEvent.timestamp_ms);
    this.maybeEmitBudgetTelemetryUnavailable(runningEntry, workerEvent);
    this.maybeEnforceBudget(issue_id, runningEntry, workerEvent.timestamp_ms);

    if (workerEvent.rate_limits) {
      this.state.codex_rate_limits = { ...workerEvent.rate_limits };
      runningEntry.rate_limits = { ...workerEvent.rate_limits };
    }

    if (workerEvent.protocol_warnings) {
      runningEntry.protocol_warnings = workerEvent.protocol_warnings.map((warning) => ({ ...warning }));
    } else if (workerEvent.protocol_warning) {
      runningEntry.protocol_warnings = [...(runningEntry.protocol_warnings ?? []), { ...workerEvent.protocol_warning }];
    }

    if (workerEvent.model_reroute !== undefined) {
      runningEntry.model_reroute = workerEvent.model_reroute ? { ...workerEvent.model_reroute } : null;
    }
    if (workerEvent.requested_model !== undefined) {
      runningEntry.requested_model = workerEvent.requested_model ?? null;
    }
    if (workerEvent.effective_model !== undefined) {
      runningEntry.effective_model = workerEvent.effective_model ?? null;
    }

    runningEntry.recent_events.push({
      at_ms: workerEvent.timestamp_ms,
      event: workerEvent.event,
      message: workerEvent.detail ?? null,
      ...(workerEvent.reason_code !== undefined ? { reason_code: workerEvent.reason_code } : {}),
      ...(workerEvent.request_method !== undefined ? { request_method: workerEvent.request_method } : {}),
      ...(workerEvent.request_category !== undefined ? { request_category: workerEvent.request_category } : {}),
      ...(workerEvent.tool_call_id !== undefined ? { tool_call_id: workerEvent.tool_call_id } : {}),
      ...(workerEvent.tool_name !== undefined ? { tool_name: workerEvent.tool_name } : {}),
      ...(workerEvent.protocol_warning !== undefined ? { protocol_warning: { ...workerEvent.protocol_warning } } : {}),
      ...(workerEvent.model_reroute !== undefined
        ? { model_reroute: workerEvent.model_reroute ? { ...workerEvent.model_reroute } : null }
        : {}),
      ...(workerEvent.requested_model !== undefined ? { requested_model: workerEvent.requested_model } : {}),
      ...(workerEvent.effective_model !== undefined ? { effective_model: workerEvent.effective_model } : {})
    });
    if (runningEntry.recent_events.length > 20) {
      runningEntry.recent_events.splice(0, runningEntry.recent_events.length - 20);
    }

    if (runningEntry.run_id) {
      void this.persistence
        ?.recordEvent({
          run_id: runningEntry.run_id,
          timestamp_ms: workerEvent.timestamp_ms,
          event: workerEvent.event,
          message: workerEvent.detail ?? null,
          reason_code: workerEvent.reason_code ?? null,
          request_method: workerEvent.request_method ?? null,
          request_category: workerEvent.request_category ?? null
        })
          .catch(() => {
            this.logger?.log({
              level: 'warn',
              event: CANONICAL_EVENT.persistence.recordEventFailed,
              message: `failed to persist worker event for ${runningEntry.identifier}`,
              context: {
                issue_id,
                issue_identifier: runningEntry.identifier,
                session_id: runningEntry.session_id
              }
            });
          });
    }

    const turnAlreadyObserved = this.beginExecutionGraphWorkerTurnObservation(runningEntry, workerEvent);
    this.queuePersistExecutionGraphWorkerEvent(issue_id, runningEntry, workerEvent, turnAlreadyObserved);

    this.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.orchestration.workerEvent,
      message: workerEvent.event,
      context: {
        issue_id,
        issue_identifier: runningEntry.identifier,
        session_id: runningEntry.session_id,
        thread_id: runningEntry.thread_id,
        turn_id: runningEntry.turn_id,
        worker_host: runningEntry.worker_host,
        codex_app_server_pid: runningEntry.codex_app_server_pid,
        event: workerEvent.event,
        event_summary: runningEntry.last_event_summary,
        reason_code: workerEvent.reason_code ?? null,
        request_method: workerEvent.request_method ?? null,
        request_category: workerEvent.request_category ?? null
      }
    });
    this.recordRuntimeEvent({
      event: workerEvent.event,
      severity: severityForRuntimeEvent(workerEvent.event),
      issue_identifier: runningEntry.identifier,
      session_id: runningEntry.session_id ?? undefined,
      detail: workerEvent.detail,
      ...(workerEvent.reason_code !== undefined ? { reason_code: workerEvent.reason_code } : {}),
      ...(workerEvent.request_method !== undefined ? { request_method: workerEvent.request_method } : {}),
      ...(workerEvent.request_category !== undefined ? { request_category: workerEvent.request_category } : {}),
      ...(workerEvent.tool_call_id !== undefined ? { tool_call_id: workerEvent.tool_call_id } : {}),
      ...(workerEvent.tool_name !== undefined ? { tool_name: workerEvent.tool_name } : {}),
      ...(workerEvent.protocol_warning !== undefined ? { protocol_warning: { ...workerEvent.protocol_warning } } : {}),
      ...(workerEvent.model_reroute !== undefined
        ? { model_reroute: workerEvent.model_reroute ? { ...workerEvent.model_reroute } : null }
        : {}),
      ...(workerEvent.requested_model !== undefined ? { requested_model: workerEvent.requested_model } : {}),
      ...(workerEvent.effective_model !== undefined ? { effective_model: workerEvent.effective_model } : {})
    });
    if (!this.emitExplicitPhaseMarker(issue_id, workerEvent)) {
      this.emitMappedPhaseMarker(issue_id, workerEvent);
    }

    if (
      workerEvent.event === CANONICAL_EVENT.codex.turnWaiting ||
      runningEntry.running_waiting_started_at_ms != null ||
      this.hasOutstandingToolCallEvidence(runningEntry)
    ) {
      void this.maybeClassifyRunningWaitStall(issue_id, runningEntry, workerEvent.timestamp_ms);
    }
  }

  private staleWorkerEventReasonForRunningEntry(
    issueId: string,
    runningEntry: RunningEntry,
    workerEvent: WorkerObservabilityEvent
  ): QuarantinedWorkerEventReason | null {
    const eventPid = normalizeCodexAppServerPid(workerEvent.codex_app_server_pid);
    const eventWorkerInstanceId = normalizeWorkerInstanceId(workerEvent.worker_instance_id);
    if (
      eventWorkerInstanceId &&
      runningEntry.worker_instance_id &&
      eventWorkerInstanceId !== runningEntry.worker_instance_id
    ) {
      return 'worker_identity_mismatch';
    }

    if (eventPid && this.isInactiveWorkerPidForIssue(issueId, eventPid)) {
      return 'inactive_worker_pid';
    }

    if (!eventPid && this.isInactiveWorkerLineageForIssue(issueId, workerEvent)) {
      return 'lineage_mismatch';
    }

    if (eventPid && runningEntry.codex_app_server_pid && eventPid !== runningEntry.codex_app_server_pid) {
      return 'worker_identity_mismatch';
    }

    if (runningEntry.thread_id && workerEvent.thread_id && workerEvent.thread_id !== runningEntry.thread_id) {
      return 'lineage_mismatch';
    }

    if (this.isSameThreadContinuationTurnStart(runningEntry, workerEvent)) {
      return null;
    }

    if (this.isSameThreadRecoveryTurnStart(runningEntry, workerEvent)) {
      return null;
    }

    if (this.isPreviousRecoveryTurnEvent(runningEntry, workerEvent)) {
      return 'lineage_mismatch';
    }

    if (this.isTerminalTurnResidue(runningEntry, workerEvent)) {
      return 'terminal_residue';
    }

    if (runningEntry.turn_id && workerEvent.turn_id && workerEvent.turn_id !== runningEntry.turn_id) {
      return 'lineage_mismatch';
    }

    return runningEntry.session_id && workerEvent.session_id && workerEvent.session_id !== runningEntry.session_id
      ? 'lineage_mismatch'
      : null;
  }

  private isSameThreadContinuationTurnStart(
    runningEntry: RunningEntry,
    workerEvent: WorkerObservabilityEvent
  ): boolean {
    const turnId = workerEvent.turn_id;
    return (
      workerEvent.event === CANONICAL_EVENT.codex.turnStarted &&
      runningEntry.last_event === CANONICAL_EVENT.codex.turnCompleted &&
      Boolean(runningEntry.thread_id) &&
      workerEvent.thread_id === runningEntry.thread_id &&
      typeof turnId === 'string' &&
      !(runningEntry.persisted_turn_ids ?? []).includes(turnId) &&
      !(runningEntry.pending_persisted_turn_ids ?? []).includes(turnId)
    );
  }

  private isTerminalTurnResidue(runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent): boolean {
    if (!runningEntry.last_event || !this.isTerminalTurnEvent(runningEntry.last_event)) {
      return false;
    }
    if (workerEvent.event === CANONICAL_EVENT.codex.turnStarted) {
      return false;
    }

    const sameTurn = Boolean(runningEntry.turn_id) && workerEvent.turn_id === runningEntry.turn_id;
    const sameSession = Boolean(runningEntry.session_id) && workerEvent.session_id === runningEntry.session_id;
    const sameThread =
      !runningEntry.thread_id || !workerEvent.thread_id || workerEvent.thread_id === runningEntry.thread_id;
    const eventPid = normalizeCodexAppServerPid(workerEvent.codex_app_server_pid);
    const sameWorkerPid = Boolean(runningEntry.codex_app_server_pid) && eventPid === runningEntry.codex_app_server_pid;
    const hasEventLineage = Boolean(workerEvent.thread_id || workerEvent.turn_id || workerEvent.session_id || eventPid);
    return sameThread && (sameTurn || sameSession || sameWorkerPid || !hasEventLineage);
  }

  private isSameThreadRecoveryTurnStart(runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent): boolean {
    const turnId = workerEvent.turn_id;
    return (
      workerEvent.event === CANONICAL_EVENT.codex.turnStarted &&
      runningEntry.recovery?.last_result === 'started' &&
      Boolean(runningEntry.thread_id) &&
      workerEvent.thread_id === runningEntry.thread_id &&
      typeof turnId === 'string' &&
      turnId !== runningEntry.turn_id
    );
  }

  private captureMissingToolOutputRecoveryReplacementLineage(
    runningEntry: RunningEntry,
    workerEvent: WorkerObservabilityEvent
  ): void {
    const recovery = runningEntry.recovery ?? null;
    if (!recovery || recovery.last_result !== 'started' || workerEvent.event !== CANONICAL_EVENT.codex.turnStarted) {
      return;
    }

    const replacementTurnId = workerEvent.turn_id ?? runningEntry.turn_id ?? null;
    if (!replacementTurnId || replacementTurnId === recovery.previous_turn_id) {
      return;
    }

    const replacementThreadId = workerEvent.thread_id ?? runningEntry.thread_id ?? recovery.previous_thread_id ?? null;
    if (recovery.previous_thread_id && replacementThreadId && replacementThreadId !== recovery.previous_thread_id) {
      return;
    }

    runningEntry.recovery = {
      ...recovery,
      replacement_thread_id: replacementThreadId,
      replacement_turn_id: replacementTurnId,
      replacement_session_id: workerEvent.session_id ?? runningEntry.session_id ?? null
    };
  }

  private isPreviousRecoveryTurnEvent(runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent): boolean {
    const recovery = runningEntry.recovery;
    if (!recovery || recovery.last_result !== 'started') {
      return false;
    }

    const matchesPreviousTurn = Boolean(recovery.previous_turn_id) && workerEvent.turn_id === recovery.previous_turn_id;
    const matchesPreviousSession =
      Boolean(recovery.previous_session_id) && workerEvent.session_id === recovery.previous_session_id;
    if (!matchesPreviousTurn && !matchesPreviousSession) {
      return false;
    }

    if (recovery.previous_thread_id && workerEvent.thread_id && workerEvent.thread_id !== recovery.previous_thread_id) {
      return false;
    }

    return true;
  }

  private recordStaleRunningWorkerEvent(
    issueId: string,
    runningEntry: RunningEntry,
    workerEvent: WorkerObservabilityEvent,
    reason: QuarantinedWorkerEventReason
  ): void {
    const quarantinedEvent = {
      at_ms: workerEvent.timestamp_ms,
      event: workerEvent.event,
      message: workerEvent.detail ?? null,
      codex_app_server_pid: normalizeCodexAppServerPid(workerEvent.codex_app_server_pid),
      worker_instance_id: normalizeWorkerInstanceId(workerEvent.worker_instance_id),
      session_id: workerEvent.session_id ?? null,
      thread_id: workerEvent.thread_id ?? null,
      turn_id: workerEvent.turn_id ?? null,
      active_codex_app_server_pid: runningEntry.codex_app_server_pid ?? null,
      active_worker_instance_id: runningEntry.worker_instance_id ?? null,
      run_id: null,
      issue_run_id: null,
      attempt_id: null,
      active_run_id: runningEntry.run_id ?? null,
      active_issue_run_id: runningEntry.issue_run_id ?? null,
      active_attempt_id: runningEntry.attempt_id ?? null,
      active_session_id: runningEntry.session_id ?? null,
      active_thread_id: runningEntry.thread_id ?? null,
      active_turn_id: runningEntry.turn_id ?? null,
      reason
    };
    runningEntry.quarantined_events = [...(runningEntry.quarantined_events ?? []), quarantinedEvent].slice(-40);
    runningEntry.quarantined_event_count = (runningEntry.quarantined_event_count ?? 0) + 1;
    runningEntry.last_quarantined_event_at_ms = workerEvent.timestamp_ms;

    this.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.orchestration.staleWorkerEventIgnored,
      message: 'stale worker event ignored for active run',
      context: {
        issue_id: issueId,
        issue_identifier: runningEntry.identifier,
        active_thread_id: runningEntry.thread_id,
        event_thread_id: workerEvent.thread_id ?? null,
        active_turn_id: runningEntry.turn_id,
        event_turn_id: workerEvent.turn_id ?? null,
        active_session_id: runningEntry.session_id,
        event_session_id: workerEvent.session_id ?? null,
        active_codex_app_server_pid: runningEntry.codex_app_server_pid,
        event_codex_app_server_pid: normalizeCodexAppServerPid(workerEvent.codex_app_server_pid),
        active_worker_instance_id: runningEntry.worker_instance_id ?? null,
        event_worker_instance_id: normalizeWorkerInstanceId(workerEvent.worker_instance_id),
        active_run_id: runningEntry.run_id ?? null,
        active_issue_run_id: runningEntry.issue_run_id ?? null,
        active_attempt_id: runningEntry.attempt_id ?? null,
        event: workerEvent.event,
        reason: quarantinedEvent.reason
      }
    });
    this.maybeRecordOwnershipConflict(runningEntry, workerEvent, reason);
    this.ports.notifyObservers?.();
  }

  private maybeRecordOwnershipConflict(
    runningEntry: RunningEntry,
    workerEvent: WorkerObservabilityEvent,
    reason: QuarantinedWorkerEventReason
  ): void {
    if (reason !== 'worker_identity_mismatch' && reason !== 'inactive_worker_pid') {
      return;
    }
    if (runningEntry.session_id || runningEntry.thread_id || runningEntry.turn_id) {
      return;
    }

    const eventPid = normalizeCodexAppServerPid(workerEvent.codex_app_server_pid);
    const eventWorkerInstanceId = normalizeWorkerInstanceId(workerEvent.worker_instance_id);
    if (!eventPid && !eventWorkerInstanceId) {
      return;
    }

    runningEntry.ownership_conflict = {
      reason: 'pre_session_identity_conflict',
      detected_at_ms: workerEvent.timestamp_ms,
      event: workerEvent.event,
      event_codex_app_server_pid: eventPid,
      active_codex_app_server_pid: runningEntry.codex_app_server_pid ?? null,
      event_worker_instance_id: eventWorkerInstanceId,
      active_worker_instance_id: runningEntry.worker_instance_id ?? null,
      event_thread_id: workerEvent.thread_id ?? null,
      event_turn_id: workerEvent.turn_id ?? null,
      event_session_id: workerEvent.session_id ?? null
    };
    this.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.orchestration.ownershipConflictDetected,
      message: 'active worker ownership conflict detected',
      context: {
        issue_id: runningEntry.issue.id,
        issue_identifier: runningEntry.identifier,
        conflict_reason: runningEntry.ownership_conflict.reason,
        active_run_id: runningEntry.run_id ?? null,
        active_issue_run_id: runningEntry.issue_run_id ?? null,
        active_attempt_id: runningEntry.attempt_id ?? null,
        active_worker_instance_id: runningEntry.worker_instance_id ?? null,
        active_codex_app_server_pid: runningEntry.codex_app_server_pid ?? null,
        event_worker_instance_id: eventWorkerInstanceId,
        event_codex_app_server_pid: eventPid,
        event: workerEvent.event
      }
    });
  }

  private isInactiveWorkerPidForIssue(issueId: string, pid: string): boolean {
    return this.pruneInactiveWorkerPidsForIssue(issueId).some((entry) => entry.pid === pid);
  }

  private isInactiveWorkerLineageForIssue(issueId: string, workerEvent: WorkerObservabilityEvent): boolean {
    const inactiveEntries = this.pruneInactiveWorkerPidsForIssue(issueId);
    if (inactiveEntries.length === 0) {
      return false;
    }

    return inactiveEntries.some((entry) => {
      const turnMatches = Boolean(entry.turn_id) && workerEvent.turn_id === entry.turn_id;
      const sessionMatches = Boolean(entry.session_id) && workerEvent.session_id === entry.session_id;
      if (!turnMatches && !sessionMatches) {
        return false;
      }
      return !entry.thread_id || !workerEvent.thread_id || workerEvent.thread_id === entry.thread_id;
    });
  }

  private rememberInactiveWorkerPid(runningEntry: RunningEntry, reason: string): void {
    const pid = runningEntry.codex_app_server_pid;
    if (!pid && !runningEntry.thread_id && !runningEntry.turn_id && !runningEntry.session_id) {
      return;
    }
    const issueId = runningEntry.issue.id;
    const existing = this.pruneInactiveWorkerPidsForIssue(issueId);
    const next = [
      ...existing.filter((entry) => !(entry.pid === (pid ?? '') && entry.turn_id === (runningEntry.turn_id ?? null))),
      {
        pid: pid ?? '',
        recorded_at_ms: this.nowMs(),
        reason,
        thread_id: runningEntry.thread_id ?? null,
        turn_id: runningEntry.turn_id ?? null,
        session_id: runningEntry.session_id ?? null
      }
    ].slice(-20);
    if (!this.state.inactive_worker_pids) {
      this.state.inactive_worker_pids = new Map();
    }
    this.state.inactive_worker_pids.set(issueId, next);
  }

  private rememberReleasedWorker(runningEntry: RunningEntry, reason: string, cleanupWorkspace: boolean): void {
    const issueId = runningEntry.issue.id;
    const existing = this.state.released_workers?.get(issueId) ?? [];
    const next = [
      ...existing,
      {
        released_at_ms: this.nowMs(),
        reason,
        cleanup_workspace: cleanupWorkspace,
        worker_instance_id: runningEntry.worker_instance_id ?? null,
        codex_app_server_pid: runningEntry.codex_app_server_pid ?? null,
        thread_id: runningEntry.thread_id ?? null,
        turn_id: runningEntry.turn_id ?? null,
        session_id: runningEntry.session_id ?? null
      }
    ].slice(-20);
    if (!this.state.released_workers) {
      this.state.released_workers = new Map();
    }
    this.state.released_workers.set(issueId, next);
  }

  private findReleasedWorkerRecord(issueId: string, details: WorkerExitDetails): ReleasedWorkerRecord | null {
    const released = this.state.released_workers?.get(issueId) ?? [];
    if (released.length === 0) {
      return null;
    }
    const workerInstanceId = normalizeWorkerInstanceId(details.worker_instance_id);
    const pid = normalizeCodexAppServerPid(details.codex_app_server_pid);
    return (
      released.find((entry) => {
        if (workerInstanceId && entry.worker_instance_id === workerInstanceId) {
          return true;
        }
        if (pid && entry.codex_app_server_pid === pid) {
          return true;
        }
        if (details.turn_id && entry.turn_id === details.turn_id) {
          return true;
        }
        if (details.session_id && entry.session_id === details.session_id) {
          return true;
        }
        return false;
      }) ?? null
    );
  }

  private pruneInactiveWorkerPidsForIssue(issueId: string): Array<{
    pid: string;
    recorded_at_ms: number;
    reason: string;
    thread_id: string | null;
    turn_id: string | null;
    session_id: string | null;
  }> {
    const entries = this.state.inactive_worker_pids?.get(issueId) ?? [];
    if (entries.length === 0) {
      return [];
    }

    const nowMs = this.nowMs();
    const ttlMs = Math.max(0, this.config.inactive_worker_pid_ttl_ms ?? DEFAULT_INACTIVE_WORKER_PID_TTL_MS);
    const activeEntries = entries.filter(
      (entry) => Number.isFinite(entry.recorded_at_ms) && nowMs - entry.recorded_at_ms < ttlMs
    );
    if (activeEntries.length === entries.length) {
      return entries;
    }

    if (!this.state.inactive_worker_pids) {
      this.state.inactive_worker_pids = new Map();
    }
    if (activeEntries.length > 0) {
      this.state.inactive_worker_pids.set(issueId, activeEntries);
    } else {
      this.state.inactive_worker_pids.delete(issueId);
    }
    return activeEntries;
  }

  private async persistExecutionGraphWorkerEvent(
    issueId: string,
    runningEntry: RunningEntry,
    workerEvent: WorkerObservabilityEvent,
    turnAlreadyObserved: boolean
  ): Promise<void> {
    if (!this.persistence || !runningEntry.issue_run_id || !runningEntry.attempt_id) {
      return;
    }

    let operation = 'unknown';
    try {
      const at = asIso(workerEvent.timestamp_ms);
      const threadId = workerEvent.thread_id ?? runningEntry.thread_id;
      const turnId = workerEvent.turn_id ?? runningEntry.turn_id;

      if (threadId && runningEntry.persisted_thread_id !== threadId) {
        operation = 'appendThread';
        await this.persistence.appendThread?.({
          attempt_id: runningEntry.attempt_id,
          thread_id: threadId,
          started_at: at,
          status: 'running',
          reason_code: REASON_CODES.codexSessionStarted,
          reason_detail: workerEvent.session_id ?? runningEntry.session_id
        });
        runningEntry.persisted_thread_id = threadId;
        await this.persistTicketEvidenceReferenceForThread(runningEntry, workerEvent, threadId, at);
      }

      if (threadId && turnId && !turnAlreadyObserved) {
        operation = 'appendTurn';
        await this.persistence.appendTurn?.({
          thread_id: threadId,
          turn_id: turnId,
          turn_index: Math.max(0, runningEntry.turn_count - 1),
          started_at: at,
          status: this.executionGraphStatusForWorkerEvent(workerEvent.event),
          reason_code: this.reasonCodeForWorkerEvent(workerEvent.event),
          reason_detail: workerEvent.detail ?? null
        });
        this.markExecutionGraphWorkerTurnPersisted(runningEntry, turnId);
      }

      if (turnId) {
        const phase = this.phaseSpanNameForWorkerEvent(workerEvent.event);
        if (phase) {
          const phaseSpanKey = `${turnId}\0${phase}\0${at}`;
          const persistedPhaseSpanKeys = this.phaseSpanKeysForRunningEntry(runningEntry);
          if (!persistedPhaseSpanKeys.has(phaseSpanKey)) {
            operation = 'appendPhaseSpan';
            await this.persistence.appendPhaseSpan?.({
              turn_id: turnId,
              phase,
              started_at: at,
              ended_at: at,
              status: this.executionGraphStatusForWorkerEvent(workerEvent.event),
              reason_code: this.reasonCodeForWorkerEvent(workerEvent.event),
              reason_detail: workerEvent.detail ?? null
            });
            persistedPhaseSpanKeys.add(phaseSpanKey);
          }
        }

        const toolName = this.toolNameForWorkerEvent(workerEvent);
        if (toolName) {
          operation = 'appendToolSpan';
          await this.persistence.appendToolSpan?.({
            turn_id: turnId,
            tool_name: toolName,
            started_at: at,
            ended_at: at,
            status: this.executionGraphStatusForWorkerEvent(workerEvent.event),
            reason_code: this.reasonCodeForWorkerEvent(workerEvent.event),
            reason_detail: workerEvent.detail ?? null
          });
        }
      }

      const toStatus = this.transitionStatusForWorkerEvent(workerEvent.event);
      if (toStatus) {
        operation = 'appendStateTransition';
        await this.persistence.appendStateTransition?.({
          issue_run_id: runningEntry.issue_run_id,
          attempt_id: runningEntry.attempt_id,
          thread_id: threadId ?? null,
          turn_id: turnId ?? null,
          from_status: null,
          to_status: toStatus,
          transitioned_at: at,
          status: this.executionGraphStatusForWorkerEvent(workerEvent.event),
          reason_code: this.reasonCodeForWorkerEvent(workerEvent.event),
          reason_detail: workerEvent.detail ?? null
        });
      }

      if (this.shouldPersistTokenModelFact(workerEvent)) {
        operation = 'appendTokenModelFact';
        await this.persistence.appendTokenModelFact?.({
          issue_run_id: runningEntry.issue_run_id,
          attempt_id: runningEntry.attempt_id,
          thread_id: threadId ?? null,
          turn_id: turnId ?? null,
          requested_model: workerEvent.requested_model ?? runningEntry.requested_model ?? null,
          effective_model: workerEvent.effective_model ?? runningEntry.effective_model ?? null,
          model_source: this.tokenModelFactSource(workerEvent),
          input_tokens: workerEvent.usage?.input_tokens ?? null,
          output_tokens: workerEvent.usage?.output_tokens ?? null,
          cached_input_tokens: workerEvent.usage?.cached_input_tokens ?? null,
          reasoning_output_tokens: workerEvent.usage?.reasoning_output_tokens ?? null,
          total_tokens: workerEvent.usage?.total_tokens ?? null,
          model_context_window: workerEvent.usage?.model_context_window ?? null,
          telemetry_confidence: this.tokenModelFactConfidence(workerEvent),
          observed_at: workerEvent.token_telemetry_last_at_ms ? asIso(workerEvent.token_telemetry_last_at_ms) : at
        });
      }

      const appServerLiteSummary = appServerLiteSummaryForWorkerEvent(workerEvent);
      if (appServerLiteSummary && this.persistence.appendAppServerEvent) {
        operation = 'appendAppServerEvent';
        await this.persistence.appendAppServerEvent({
          issue_run_id: runningEntry.issue_run_id,
          attempt_id: runningEntry.attempt_id,
          thread_id: threadId ?? null,
          turn_id: turnId ?? null,
          observed_at: at,
          source_event_id: appServerLiteSourceEventId(workerEvent),
          source_event_name: workerEvent.event,
          payload_class: appServerLiteSummary.payload_class,
          summary: appServerLiteSummary.summary,
          summary_fields: appServerLiteSummary.summary_fields,
          unavailable_reason_code: appServerLiteSummary.unavailable_reason_code ?? null
        });
      }
    } catch (error) {
      const failedTurnId = workerEvent.turn_id ?? runningEntry.turn_id;
      if (failedTurnId) {
        this.clearPendingExecutionGraphWorkerTurn(runningEntry, failedTurnId);
      }
      await this.recordHistoryWriteFailure(operation, this.reasonCodeForWorkerEvent(workerEvent.event), error);
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.persistence.recordEventFailed,
        message: `failed to persist execution graph event for ${runningEntry.identifier}`,
        context: this.executionGraphPersistenceFailureContext(issueId, runningEntry, workerEvent, operation, error)
      });
    }
  }

  private queuePersistExecutionGraphWorkerEvent(
    issueId: string,
    runningEntry: RunningEntry,
    workerEvent: WorkerObservabilityEvent,
    turnAlreadyObserved: boolean
  ): void {
    const previous = this.executionGraphPersistenceQueues.get(runningEntry) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.persistExecutionGraphWorkerEvent(issueId, runningEntry, workerEvent, turnAlreadyObserved));
    this.executionGraphPersistenceQueues.set(runningEntry, next);
    void next
      .finally(() => {
        if (this.executionGraphPersistenceQueues.get(runningEntry) === next) {
          this.executionGraphPersistenceQueues.delete(runningEntry);
        }
      })
      .catch(() => undefined);
  }

  private shouldPersistTokenModelFact(workerEvent: WorkerObservabilityEvent): boolean {
    return Boolean(
      workerEvent.usage ||
        workerEvent.model_reroute !== undefined ||
        workerEvent.requested_model !== undefined ||
        workerEvent.effective_model !== undefined
    );
  }

  private tokenModelFactSource(workerEvent: WorkerObservabilityEvent): string {
    return (
      workerEvent.token_telemetry_last_source ??
      workerEvent.model_reroute?.source ??
      (workerEvent.usage ? 'worker_event_usage' : 'worker_event_model')
    );
  }

  private tokenModelFactConfidence(workerEvent: WorkerObservabilityEvent): 'observed_live' | 'backfilled' | 'missing' {
    if (workerEvent.token_telemetry_status === 'unavailable') {
      return 'missing';
    }
    return workerEvent.usage || workerEvent.model_reroute || workerEvent.requested_model || workerEvent.effective_model
      ? 'observed_live'
      : 'missing';
  }

  private phaseSpanKeysForRunningEntry(runningEntry: RunningEntry): Set<string> {
    let keys = this.persistedPhaseSpanKeys.get(runningEntry);
    if (!keys) {
      keys = new Set();
      this.persistedPhaseSpanKeys.set(runningEntry, keys);
    }
    return keys;
  }

  private beginExecutionGraphWorkerTurnObservation(runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent): boolean {
    const observedTurnId = workerEvent.turn_id ?? runningEntry.turn_id;
    const persistedTurnIds = (runningEntry.persisted_turn_ids ??= []);
    const pendingTurnIds = (runningEntry.pending_persisted_turn_ids ??= []);
    const turnAlreadyObserved = Boolean(
      observedTurnId && (persistedTurnIds.includes(observedTurnId) || pendingTurnIds.includes(observedTurnId))
    );
    if (observedTurnId && !turnAlreadyObserved) {
      pendingTurnIds.push(observedTurnId);
    }
    return turnAlreadyObserved;
  }

  private markExecutionGraphWorkerTurnPersisted(runningEntry: RunningEntry, turnId: string): void {
    const persistedTurnIds = (runningEntry.persisted_turn_ids ??= []);
    if (!persistedTurnIds.includes(turnId)) {
      persistedTurnIds.push(turnId);
    }
    this.clearPendingExecutionGraphWorkerTurn(runningEntry, turnId);
  }

  private clearPendingExecutionGraphWorkerTurn(runningEntry: RunningEntry, turnId: string): void {
    const pending = runningEntry.pending_persisted_turn_ids;
    if (!pending) {
      return;
    }
    runningEntry.pending_persisted_turn_ids = pending.filter((entry) => entry !== turnId);
  }

  private async recordHistoryWriteFailure(operation: string, reasonCode: string, error: unknown): Promise<void> {
    try {
      await this.persistence?.recordHistoryWriteFailure?.({
        operation,
        reason_code: reasonCode,
        detail: persistenceErrorMessage(error)
      });
    } catch {
      // The original write failure remains the primary diagnostic.
    }
  }

  private executionGraphPersistenceFailureContext(
    issueId: string,
    runningEntry: RunningEntry,
    workerEvent: WorkerObservabilityEvent,
    operation: string,
    error: unknown
  ): Record<string, string | number | boolean | null> {
    return {
      issue_id: issueId,
      issue_identifier: runningEntry.identifier,
      session_id: runningEntry.session_id,
      active_thread_id: runningEntry.thread_id,
      active_turn_id: runningEntry.turn_id,
      event_thread_id: workerEvent.thread_id ?? null,
      event_turn_id: workerEvent.turn_id ?? null,
      event_timestamp: asIso(workerEvent.timestamp_ms),
      event: workerEvent.event,
      persistence_operation: operation,
      failure_kind: classifyPersistenceFailure(error),
      error_name: persistenceErrorName(error),
      error_code: persistenceErrorCode(error),
      error_message: persistenceErrorMessage(error)
    };
  }

  private executionGraphStatusForWorkerEvent(eventName: string): 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' {
    switch (eventName) {
      case CANONICAL_EVENT.codex.turnCompleted:
      case CANONICAL_EVENT.codex.toolCallCompleted:
        return 'succeeded';
      case CANONICAL_EVENT.codex.turnFailed:
      case CANONICAL_EVENT.codex.toolCallFailed:
      case CANONICAL_EVENT.codex.dynamicToolCapabilityMismatch:
      case CANONICAL_EVENT.codex.unsupportedToolCall:
        return 'failed';
      case CANONICAL_EVENT.codex.turnInputRequired:
        return 'blocked';
      case CANONICAL_EVENT.codex.turnCancelled:
        return 'cancelled';
      default:
        return 'running';
    }
  }

  private reasonCodeForWorkerEvent(eventName: string): string {
    if (eventName === CANONICAL_EVENT.codex.dynamicToolCapabilityMismatch) {
      return REASON_CODES.unsupportedDynamicToolConsoleResume;
    }
    return eventName.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  }

  private phaseSpanNameForWorkerEvent(eventName: string): string | null {
    switch (eventName) {
      case CANONICAL_EVENT.codex.promptSent:
        return 'prompt_sent';
      case CANONICAL_EVENT.codex.phasePlanning:
      case CANONICAL_EVENT.codex.turnWaiting:
        return 'planning';
      case CANONICAL_EVENT.codex.phaseImplementation:
        return 'implementation';
      case CANONICAL_EVENT.codex.phaseValidation:
      case CANONICAL_EVENT.codex.turnCompleted:
        return 'validation';
      case CANONICAL_EVENT.codex.turnFailed:
        return 'failed';
      case CANONICAL_EVENT.codex.turnInputRequired:
        return 'blocked_input';
      default:
        return null;
    }
  }

  private toolNameForWorkerEvent(workerEvent: WorkerObservabilityEvent): string | null {
    if (
      workerEvent.event !== CANONICAL_EVENT.codex.toolCallCompleted &&
      workerEvent.event !== CANONICAL_EVENT.codex.toolCallStarted &&
      workerEvent.event !== CANONICAL_EVENT.codex.toolCallFailed &&
      workerEvent.event !== CANONICAL_EVENT.codex.dynamicToolCapabilityMismatch &&
      workerEvent.event !== CANONICAL_EVENT.codex.unsupportedToolCall
    ) {
      return null;
    }
    const explicit = workerEvent.tool_name?.trim();
    if (explicit) {
      return explicit;
    }
    const mismatch = parseDynamicToolCapabilityMismatchDetail(workerEvent.detail);
    if (mismatch?.attempted_tool_name) {
      return mismatch.attempted_tool_name;
    }
    const detail = workerEvent.detail?.trim();
    return detail && detail.length > 0 ? detail : 'unknown_tool';
  }

  private transitionStatusForWorkerEvent(eventName: string): string | null {
    switch (eventName) {
      case CANONICAL_EVENT.codex.turnStarted:
        return 'running';
      case CANONICAL_EVENT.codex.turnInputRequired:
        return 'blocked';
      case CANONICAL_EVENT.codex.turnCompleted:
        return 'succeeded';
      case CANONICAL_EVENT.codex.turnFailed:
        return 'failed';
      case CANONICAL_EVENT.codex.turnCancelled:
        return 'cancelled';
      default:
        return null;
    }
  }

  private normalStopForWorkerCompletion(
    completionReason: WorkerCompletionReason | null,
    refreshedState: string | null
  ): {
    reason_code: string;
    detail: string;
    message: string;
    cleanup_workspace: boolean;
  } | null {
    switch (completionReason) {
      case REASON_CODES.handoffStateReached:
        return {
          reason_code: REASON_CODES.handoffStateReached,
          detail: refreshedState
            ? `worker completed after refreshed issue reached handoff state: ${refreshedState}`
            : 'worker completed after refreshed issue reached a handoff state',
          message: 'worker exit handled: completed at handoff state',
          cleanup_workspace: false
        };
      case REASON_CODES.freshDispatchStateRouted:
        return {
          reason_code: REASON_CODES.freshDispatchStateRouted,
          detail: refreshedState
            ? `worker completed after fresh-dispatch state routed issue to: ${refreshedState}`
            : 'worker completed after fresh-dispatch state routed issue',
          message: 'worker exit handled: fresh-dispatch state routed',
          cleanup_workspace: false
        };
      case REASON_CODES.issueLeftActiveStates:
        return {
          reason_code: REASON_CODES.issueLeftActiveStates,
          detail: refreshedState
            ? `worker completed after refreshed issue left active states: ${refreshedState}`
            : 'worker completed after refreshed issue left active states',
          message: 'worker exit handled: completed after issue left active states',
          cleanup_workspace: false
        };
      case REASON_CODES.issueStateMissing:
        return {
          reason_code: REASON_CODES.issueStateMissing,
          detail: 'worker completed but tracker refresh did not return the issue',
          message: 'worker exit handled: completed after missing issue refresh',
          cleanup_workspace: false
        };
      case REASON_CODES.terminalStateReached:
        return {
          reason_code: REASON_CODES.terminalStateReached,
          detail: refreshedState
            ? `worker completed after refreshed issue reached terminal state: ${refreshedState}`
            : 'worker completed after refreshed issue reached a terminal state',
          message: 'worker exit handled: completed at terminal state',
          cleanup_workspace: true
        };
      case REASON_CODES.maxTurnsReached:
      case REASON_CODES.issueStateRefreshFailed:
      case null:
        return null;
    }
  }

  private async persistExecutionGraphStateTransition(
    runningEntry: RunningEntry,
    toStatus: string,
    status: 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'retrying',
    reasonCode: string,
    reasonDetail: string | null
  ): Promise<void> {
    if (!this.persistence || !runningEntry.issue_run_id) {
      return;
    }

    try {
      await this.persistence.appendStateTransition?.({
        issue_run_id: runningEntry.issue_run_id,
        attempt_id: runningEntry.attempt_id,
        thread_id: runningEntry.thread_id,
        turn_id: runningEntry.turn_id,
        from_status: null,
        to_status: toStatus,
        transitioned_at: asIso(this.nowMs()),
        status,
        reason_code: reasonCode,
        reason_detail: reasonDetail
      });
    } catch (error) {
      await this.recordHistoryWriteFailure('appendStateTransition.executionGraph', reasonCode, error);
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.persistence.recordEventFailed,
        message: `failed to persist execution graph transition for ${runningEntry.identifier}`,
        context: {
          issue_id: runningEntry.issue.id,
          issue_identifier: runningEntry.identifier,
          session_id: runningEntry.session_id,
          thread_id: runningEntry.thread_id,
          turn_id: runningEntry.turn_id,
          reason_code: reasonCode
        }
      });
    }
  }

  private async persistTicketEvidenceReferenceForThread(
    runningEntry: RunningEntry,
    workerEvent: WorkerObservabilityEvent,
    threadId: string,
    recordedAt: string
  ): Promise<void> {
    if (!this.persistence?.appendTicketEvidenceReference || !runningEntry.issue_run_id || !runningEntry.attempt_id) {
      return;
    }

    try {
      await this.persistence.appendTicketEvidenceReference({
        issue_run_id: runningEntry.issue_run_id,
        attempt_id: runningEntry.attempt_id,
        thread_id: threadId,
        turn_id: workerEvent.turn_id ?? runningEntry.turn_id ?? null,
        evidence_kind: 'codex_thread',
        uri: `codex-thread:${threadId}`,
        title: 'Codex thread observed',
        metadata: {
          session_id: workerEvent.session_id ?? runningEntry.session_id ?? null,
          event: workerEvent.event
        },
        recorded_at: recordedAt
      });
    } catch (error) {
      await this.recordHistoryWriteFailure('appendTicketEvidenceReference', this.reasonCodeForWorkerEvent(workerEvent.event), error);
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.persistence.recordEventFailed,
        message: `failed to persist ticket evidence reference for ${runningEntry.identifier}`,
        context: {
          issue_id: runningEntry.issue.id,
          issue_identifier: runningEntry.identifier,
          issue_run_id: runningEntry.issue_run_id,
          attempt_id: runningEntry.attempt_id,
          thread_id: threadId,
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  private async persistOperationalFactsForIssue(issue: Issue, runningEntry: RunningEntry, observedAt: string): Promise<void> {
    if (!this.persistence || !runningEntry.issue_run_id) {
      return;
    }

    const trackerKind = issue.tracker_meta?.tracker_kind ?? 'unknown';
    const assigneeIdentifier = this.firstNonEmpty(issue.tracker_meta?.assignee?.id, issue.tracker_meta?.assignee?.name);
    const projectIdentifier = this.firstNonEmpty(issue.tracker_meta?.project?.slug, issue.tracker_meta?.project?.id, issue.tracker_meta?.project?.name);
    const teamIdentifier = this.firstNonEmpty(issue.tracker_meta?.team?.key, issue.tracker_meta?.team?.id, issue.tracker_meta?.team?.name);
    try {
      await this.persistence.appendTrackerTicketSnapshot?.({
        issue_run_id: runningEntry.issue_run_id,
        attempt_id: runningEntry.attempt_id ?? null,
        thread_id: runningEntry.thread_id ?? null,
        turn_id: runningEntry.turn_id ?? null,
        tracker_kind: trackerKind,
        remote_issue_id: issue.id,
        human_issue_identifier: issue.identifier,
        title: issue.title,
        tracker_status: issue.state,
        labels: issue.labels,
        assignee_status: assigneeIdentifier ? 'available' : issue.tracker_meta?.assignee === null ? 'unavailable' : 'unknown',
        assignee_identifier: assigneeIdentifier,
        assignee_reason: assigneeIdentifier ? null : issue.tracker_meta?.assignee === null ? 'tracker_assignee_unavailable' : 'tracker_assignee_unobserved',
        project_status: projectIdentifier ? 'available' : issue.tracker_meta?.project === null ? 'unavailable' : 'unknown',
        project_identifier: projectIdentifier,
        project_reason: projectIdentifier ? null : issue.tracker_meta?.project === null ? 'tracker_project_unavailable' : 'tracker_project_unobserved',
        team_status: teamIdentifier ? 'available' : issue.tracker_meta?.team === null ? 'unavailable' : 'unknown',
        team_identifier: teamIdentifier,
        team_reason: teamIdentifier ? null : issue.tracker_meta?.team === null ? 'tracker_team_unavailable' : 'tracker_team_unobserved',
        observed_at: observedAt
      });
      await this.persistTicketReference({
        runningEntry,
        reference_kind: 'branch',
        availability: issue.branch_name ? 'available' : 'unavailable',
        uri: issue.branch_name ? `git-branch:${issue.branch_name}` : null,
        label: issue.branch_name,
        external_id: issue.branch_name,
        state: issue.branch_name ? 'observed' : 'unavailable',
        metadata: issue.branch_name ? { branch_name: issue.branch_name } : { reason: 'tracker_branch_unavailable' },
        observed_at: observedAt
      });
      const prLinks = issue.tracker_meta?.pr_links ?? [];
      if (prLinks.length === 0) {
        await this.persistTicketReference({
          runningEntry,
          reference_kind: 'pull_request',
          availability: 'unknown',
          uri: null,
          label: null,
          external_id: null,
          state: null,
          metadata: { reason: 'tracker_pr_unobserved' },
          observed_at: observedAt
        });
        await this.persistTicketReference({
          runningEntry,
          reference_kind: 'review',
          availability: 'unknown',
          uri: null,
          label: null,
          external_id: null,
          state: null,
          metadata: { reason: 'review_state_unobserved' },
          observed_at: observedAt
        });
        await this.persistTicketReference({
          runningEntry,
          reference_kind: 'merge',
          availability: 'unknown',
          uri: null,
          label: null,
          external_id: null,
          state: null,
          metadata: { reason: 'merge_state_unobserved' },
          observed_at: observedAt
        });
      }
      for (const pr of prLinks) {
        await this.persistTicketReference({
          runningEntry,
          reference_kind: 'pull_request',
          availability: 'available',
          uri: pr.url,
          label: `PR #${pr.number}`,
          external_id: String(pr.number),
          state: pr.state,
          metadata: { merged: pr.merged, repository: issue.tracker_meta?.repository ?? null },
          observed_at: observedAt
        });
        await this.persistTicketReference({
          runningEntry,
          reference_kind: 'review',
          availability: 'unknown',
          uri: pr.url,
          label: `PR #${pr.number}`,
          external_id: String(pr.number),
          state: null,
          metadata: { reason: 'review_state_unobserved' },
          observed_at: observedAt
        });
        await this.persistTicketReference({
          runningEntry,
          reference_kind: 'merge',
          availability: pr.merged ? 'available' : 'unknown',
          uri: pr.url,
          label: `PR #${pr.number}`,
          external_id: String(pr.number),
          state: pr.merged ? 'merged' : pr.state,
          metadata: { merged: pr.merged },
          observed_at: observedAt
        });
      }
    } catch (error) {
      await this.recordHistoryWriteFailure('appendOperationalHistoryFacts', REASON_CODES.dispatchStarted, error);
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.persistence.recordEventFailed,
        message: `failed to persist operational history facts for ${issue.identifier}`,
        context: {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          issue_run_id: runningEntry.issue_run_id,
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  private async persistTicketReference(params: {
    runningEntry: RunningEntry;
    reference_kind: 'branch' | 'pull_request' | 'review' | 'merge' | 'evidence';
    availability: 'available' | 'unavailable' | 'unknown';
    uri: string | null;
    label: string | null;
    external_id: string | null;
    state: string | null;
    metadata: Record<string, unknown> | null;
    observed_at: string;
  }): Promise<void> {
    await this.persistence?.appendTicketReference?.({
      issue_run_id: params.runningEntry.issue_run_id ?? null,
      attempt_id: params.runningEntry.attempt_id ?? null,
      thread_id: params.runningEntry.thread_id ?? null,
      turn_id: params.runningEntry.turn_id ?? null,
      reference_kind: params.reference_kind,
      availability: params.availability,
      uri: params.uri,
      label: params.label,
      external_id: params.external_id,
      state: params.state,
      metadata: params.metadata,
      observed_at: params.observed_at
    });
  }

  private async persistExecutionGraphRetryTransition(
    retryEntry: RetryEntry,
    toStatus: string,
    status: 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'retrying',
    reasonCode: string,
    reasonDetail: string | null
  ): Promise<void> {
    if (!this.persistence || !retryEntry.issue_run_id) {
      return;
    }

    try {
      await this.persistence.appendStateTransition?.({
        issue_run_id: retryEntry.issue_run_id,
        attempt_id: retryEntry.previous_attempt_id,
        thread_id: retryEntry.previous_thread_id,
        turn_id: retryEntry.previous_turn_id ?? null,
        from_status: null,
        to_status: toStatus,
        transitioned_at: asIso(this.nowMs()),
        status,
        reason_code: reasonCode,
        reason_detail: reasonDetail
      });
    } catch (error) {
      await this.recordHistoryWriteFailure('appendStateTransition.retry', reasonCode, error);
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.persistence.recordEventFailed,
        message: `failed to persist execution graph retry transition for ${retryEntry.identifier}`,
        context: {
          issue_id: retryEntry.issue_id,
          issue_identifier: retryEntry.identifier,
          thread_id: retryEntry.previous_thread_id,
          reason_code: reasonCode
        }
      });
    }
  }

  private async persistPreSpawnExecutionGraphAttempt(params: {
    issue: Issue;
    attempt: number | null;
    graphContext: DispatchGraphContext;
    status: 'failed' | 'blocked';
    reasonCode: string;
    reasonDetail: string | null;
  }): Promise<DispatchGraphContext> {
    if (!this.persistence) {
      return params.graphContext;
    }

    try {
      const startedAt = asIso(this.nowMs());
      const issueRunId =
        params.graphContext.issue_run_id ??
        (await this.persistence.appendIssueRun?.({
          issue_id: params.issue.id,
          issue_identifier: params.issue.identifier,
          started_at: startedAt,
          status: 'running',
          reason_code: REASON_CODES.dispatchStarted,
          reason_detail: 'dispatch attempt started'
        })) ??
        null;
      if (!issueRunId) {
        return params.graphContext;
      }

      const attemptId =
        (await this.persistence.appendAttempt?.({
          issue_run_id: issueRunId,
          attempt_number: params.attempt ?? 0,
          started_at: startedAt,
          ended_at: startedAt,
          status: params.status,
          reason_code: params.reasonCode,
          reason_detail: params.reasonDetail
        })) ?? null;

      if (attemptId) {
        await this.persistence.appendStateTransition?.({
          issue_run_id: issueRunId,
          attempt_id: attemptId,
          from_status: null,
          to_status: params.status,
          transitioned_at: startedAt,
          status: params.status,
          reason_code: params.reasonCode,
          reason_detail: params.reasonDetail
        });
        await this.persistence.appendStateTransition?.({
          issue_run_id: issueRunId,
          attempt_id: attemptId,
          from_status: params.status,
          to_status: 'retrying',
          transitioned_at: startedAt,
          status: 'retrying',
          reason_code: params.reasonCode,
          reason_detail: params.reasonDetail
        });
        if (params.status === 'failed') {
          await this.persistence.appendTicketTerminalOutcome?.({
            issue_run_id: issueRunId,
            attempt_id: attemptId,
            outcome: 'failed',
            reason_code: params.reasonCode,
            reason_detail: params.reasonDetail,
            recorded_at: startedAt
          });
        } else {
          await this.persistence.appendTicketBlocker?.({
            issue_run_id: issueRunId,
            attempt_id: attemptId,
            blocker_type: 'orchestration_blocker',
            status: 'active',
            reason_code: params.reasonCode,
            reason_detail: params.reasonDetail,
            blocked_at: startedAt
          });
        }
      }

      return {
        issue_run_id: issueRunId,
        previous_attempt_id: attemptId ?? params.graphContext.previous_attempt_id ?? null
      };
    } catch (error) {
      await this.recordHistoryWriteFailure('persistPreSpawnExecutionGraphAttempt', params.reasonCode, error);
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.persistence.recordEventFailed,
        message: `failed to persist pre-spawn execution graph attempt for ${params.issue.identifier}`,
        context: {
          issue_id: params.issue.id,
          issue_identifier: params.issue.identifier,
          reason_code: params.reasonCode
        }
      });
      return params.graphContext;
    }
  }

  private budgetConfigured(): boolean {
    return Boolean(
      this.config.budget &&
        (typeof this.config.budget.per_run_total_tokens === 'number' ||
          typeof this.config.budget.per_issue_rolling_tokens === 'number')
    );
  }

  private pruneBudgetSamples(issueId: string, nowMs: number): Array<{ at_ms: number; total_tokens: number }> {
    const windowMinutes = this.config.budget?.rolling_window_minutes ?? 1440;
    const windowMs = Math.max(1, windowMinutes) * 60_000;
    const budgetSamples = this.state.budget_usage_samples ?? new Map<string, Array<{ at_ms: number; total_tokens: number }>>();
    this.state.budget_usage_samples = budgetSamples;
    const samples = (budgetSamples.get(issueId) ?? []).filter((sample) => nowMs - sample.at_ms <= windowMs);
    budgetSamples.set(issueId, samples);
    return samples;
  }

  private selectBudgetCandidate(issueId: string, currentAttemptTokens: number): BudgetCandidate | null {
    const budget = this.config.budget;
    if (!budget) {
      return null;
    }

    const currentUsage = Math.max(0, currentAttemptTokens);
    const samples = this.pruneBudgetSamples(issueId, this.nowMs());
    const rollingUsage = samples.reduce((sum, sample) => sum + sample.total_tokens, 0) + currentUsage;
    const candidates: BudgetCandidate[] = [];
    const addCandidate = (scope: BudgetScope, usage: number, limit: number) => {
      const warningThreshold = Math.ceil(limit * budget.warning_threshold_ratio);
      candidates.push({
        scope,
        usage,
        limit,
        warning_threshold: warningThreshold,
        status: usage >= limit ? 'hard_limited' : usage >= warningThreshold ? 'warning' : 'ok'
      });
    };
    if (typeof budget.per_run_total_tokens === 'number') {
      addCandidate('per_run_total_tokens', currentUsage, budget.per_run_total_tokens);
    }
    if (typeof budget.per_issue_rolling_tokens === 'number') {
      addCandidate('per_issue_rolling_tokens', rollingUsage, budget.per_issue_rolling_tokens);
    }
    const [selected] = candidates.sort((a, b) => {
      const statusDelta = budgetStatusRank(b.status) - budgetStatusRank(a.status);
      if (statusDelta !== 0) {
        return statusDelta;
      }
      const ratioDelta = b.usage / b.limit - a.usage / a.limit;
      if (ratioDelta !== 0) {
        return ratioDelta;
      }
      return a.scope.localeCompare(b.scope);
    });
    return selected ?? null;
  }

  private computeBudgetProjection(
    issueId: string,
    currentAttemptTokens: number,
    telemetryStatus: 'available' | 'pending' | 'unavailable',
    forcedStatus?: BudgetRuntimeProjection['budget_status'],
    forcedMessage?: string | null
  ): BudgetRuntimeProjection {
    const budget = this.config.budget;
    if (!budget) {
      return defaultBudgetProjection();
    }

    const selected = this.selectBudgetCandidate(issueId, currentAttemptTokens);
    let status: BudgetRuntimeProjection['budget_status'] = 'ok';
    if (forcedStatus) {
      status = forcedStatus;
    } else if (this.budgetConfigured() && telemetryStatus === 'unavailable') {
      status = 'telemetry_unavailable';
    } else if (selected) {
      status = selected.status;
    }

    return {
      budget_usage_tokens: this.budgetConfigured() && telemetryStatus !== 'unavailable' ? selected?.usage ?? null : null,
      budget_limit_tokens: selected?.limit ?? null,
      budget_window_minutes: budget.rolling_window_minutes,
      budget_status: status,
      budget_policy: this.budgetConfigured() ? budget.hard_limit_policy : null,
      budget_message: forcedMessage ?? null
    };
  }

  private maybeEmitBudgetTelemetryUnavailable(runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent): void {
    if (!this.budgetConfigured()) {
      return;
    }
    if (!this.isTerminalTurnEvent(workerEvent.event) || runningEntry.token_telemetry_status !== 'unavailable') {
      return;
    }
    runningEntry.budget = this.computeBudgetProjection(
      runningEntry.issue.id,
      runningEntry.tokens.total_tokens,
      'unavailable',
      'telemetry_unavailable',
      'Budget accounting unavailable because runtime token telemetry was not reported.'
    );
    this.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.budget.telemetryUnavailable,
      message: 'budget telemetry unavailable',
      context: {
        issue_id: runningEntry.issue.id,
        issue_identifier: runningEntry.identifier
      }
    });
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.budget.telemetryUnavailable,
      severity: 'warn',
      issue_identifier: runningEntry.identifier,
      session_id: runningEntry.session_id ?? undefined,
      detail: 'runtime token telemetry unavailable for budget accounting'
    });
  }

  private maybeEnforceBudget(issueId: string, runningEntry: RunningEntry, timestampMs: number): void {
    if (!this.budgetConfigured()) {
      return;
    }
    if (runningEntry.token_telemetry_status !== 'available') {
      return;
    }
    const budget = this.config.budget;
    if (!budget || runningEntry.budget_hard_limit_enforced) {
      return;
    }

    const projection = this.computeBudgetProjection(issueId, runningEntry.tokens.total_tokens, 'available');
    runningEntry.budget = projection;
    if (projection.budget_status === 'warning' && !runningEntry.budget_warning_emitted) {
      runningEntry.budget_warning_emitted = true;
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.budget.warningThresholdCrossed,
        message: 'budget warning threshold crossed',
        context: {
          issue_id: issueId,
          issue_identifier: runningEntry.identifier,
          budget_usage_tokens: projection.budget_usage_tokens,
          budget_limit_tokens: projection.budget_limit_tokens,
          budget_policy: projection.budget_policy
        }
      });
      this.recordRuntimeEvent({
        event: CANONICAL_EVENT.budget.warningThresholdCrossed,
        severity: 'warn',
        issue_identifier: runningEntry.identifier,
        session_id: runningEntry.session_id ?? undefined,
        detail: `usage=${projection.budget_usage_tokens} limit=${projection.budget_limit_tokens}`
      });
    }

    if (projection.budget_status !== 'hard_limited') {
      return;
    }

    const triggeringCandidate = this.selectBudgetCandidate(issueId, runningEntry.tokens.total_tokens);
    runningEntry.budget_hard_limit_enforced = true;
    const scopeDetail = triggeringCandidate ? `${budgetScopeLabel(triggeringCandidate.scope)} ` : '';
    const detail = `Budget hard limit exceeded: ${scopeDetail}usage ${projection.budget_usage_tokens} tokens, limit ${projection.budget_limit_tokens} tokens.`;
    runningEntry.budget = {
      ...projection,
      budget_message:
        budget.hard_limit_policy === 'block_requires_resume'
          ? `${detail} Continuation blocked until manual resume.`
          : `${detail} Attempt terminated by budget policy.`
    };
    this.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.budget.hardLimitExceeded,
      message: 'budget hard limit exceeded',
      context: {
        issue_id: issueId,
        issue_identifier: runningEntry.identifier,
        budget_usage_tokens: projection.budget_usage_tokens,
        budget_limit_tokens: projection.budget_limit_tokens,
        budget_policy: projection.budget_policy
      }
    });
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.budget.hardLimitExceeded,
      severity: 'warn',
      issue_identifier: runningEntry.identifier,
      session_id: runningEntry.session_id ?? undefined,
      detail: runningEntry.budget?.budget_message ?? detail
    });
    this.enforceBudgetHardLimit(issueId, runningEntry, timestampMs).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const failureDetail = `Budget hard limit cleanup failed: ${message}`;
      this.state.health.last_error = failureDetail;
      this.logger?.log({
        level: 'error',
        event: CANONICAL_EVENT.budget.hardLimitExceeded,
        message: 'budget hard limit cleanup failed',
        context: {
          issue_id: issueId,
          issue_identifier: runningEntry.identifier,
          error: message
        }
      });
      this.recordRuntimeEvent({
        event: CANONICAL_EVENT.budget.hardLimitExceeded,
        severity: 'error',
        issue_identifier: runningEntry.identifier,
        session_id: runningEntry.session_id ?? undefined,
        detail: failureDetail
      });
      this.ports.notifyObservers?.();
    });
  }

  private async enforceBudgetHardLimit(issueId: string, running: RunningEntry, timestampMs: number): Promise<void> {
    const budget = this.config.budget;
    if (!budget) {
      return;
    }

    const stopReasonCode =
      budget.hard_limit_policy === 'terminate_attempt'
        ? REASON_CODES.attemptTerminatedBudgetLimitExceeded
        : REASON_CODES.operatorBudgetLimitExceeded;
    const stopReasonDetail =
      running.budget?.budget_message ??
      `Budget hard limit exceeded: usage ${running.budget?.budget_usage_tokens} tokens, limit ${running.budget?.budget_limit_tokens} tokens.`;

    this.emitPhaseMarker(issueId, {
      phase: budget.hard_limit_policy === 'terminate_attempt' ? 'failed' : 'blocked_input',
      detail: stopReasonDetail,
      attempt: running.retry_attempt,
      thread_id: running.thread_id,
      session_id: running.session_id
    });

    this.addRuntimeSecondsFromEntry(running);
    this.recordBudgetUsageSample(issueId, running.tokens.total_tokens, timestampMs);
    this.state.running.delete(issueId);
    this.state.health.last_error = stopReasonDetail;

    if (budget.hard_limit_policy === 'block_requires_resume') {
      void this.scheduleBlockedInput({
        issue_id: issueId,
        issue_identifier: running.identifier,
        attempt: running.retry_attempt + 1,
        issue_run_id: running.issue_run_id ?? null,
        previous_attempt_id: running.attempt_id ?? null,
        worker_host: running.worker_host ?? null,
        workspace_path: running.workspace_path ?? null,
        provisioner_type: running.provisioner_type ?? null,
        branch_name: running.branch_name ?? null,
        repo_root: running.repo_root ?? null,
        workspace_exists: running.workspace_exists,
        workspace_git_status: running.workspace_git_status,
        workspace_provisioned: running.workspace_provisioned,
        workspace_is_git_worktree: running.workspace_is_git_worktree,
        copy_ignored_applied: running.copy_ignored_applied,
        copy_ignored_status: running.copy_ignored_status,
        copy_ignored_summary: running.copy_ignored_summary,
        stop_reason_code: stopReasonCode,
        stop_reason_detail: stopReasonDetail,
        session_console: running.recent_events,
        previous_thread_id: running.thread_id,
        previous_turn_id: running.turn_id,
        previous_session_id: running.session_id,
        required_actions: ['Increase budget and resume', 'Cancel and return to backlog'],
        budget: running.budget
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.state.health.last_error = `Budget hard limit block scheduling failed: ${message}`;
        this.logger?.log({
          level: 'error',
          event: CANONICAL_EVENT.budget.hardLimitExceeded,
          message: 'budget hard limit block scheduling failed',
          context: {
            issue_id: issueId,
            issue_identifier: running.identifier,
            error: message
          }
        });
      });
    } else {
      this.state.claimed.delete(issueId);
    }

    this.ports.notifyObservers?.();

    let terminationResult: WorkerTerminationResult;
    try {
      terminationResult = await this.ports.terminateWorker({
        issue_id: issueId,
        worker_handle: running.worker_handle,
        cleanup_workspace: false,
        reason: stopReasonCode
      });
    } catch (error) {
      if (budget.hard_limit_policy === 'block_requires_resume') {
        const unknownResult = workerTerminationExceptionResult(error);
        this.updateBudgetBlockedTerminationEvidence(
          issueId,
          workerTerminationResultDetail(stopReasonDetail, unknownResult),
          unknownResult
        );
      }
      throw error;
    }

    const terminalReasonDetail = workerTerminationResultDetail(stopReasonDetail, terminationResult);
    if (budget.hard_limit_policy === 'block_requires_resume') {
      this.updateBudgetBlockedTerminationEvidence(issueId, terminalReasonDetail, terminationResult);
    }
    await this.completeRunRecord(running, 'failed', stopReasonCode, null, terminalReasonDetail);
  }

  private updateBudgetBlockedTerminationEvidence(
    issueId: string,
    stopReasonDetail: string,
    terminationResult: WorkerTerminationResult
  ): void {
    const blockedEntry = this.state.blocked_inputs.get(issueId);
    if (!blockedEntry || blockedEntry.stop_reason_code !== REASON_CODES.operatorBudgetLimitExceeded) {
      return;
    }

    blockedEntry.stop_reason_detail = stopReasonDetail;
    blockedEntry.worker_termination_result = cloneWorkerTerminationResult(terminationResult);
    if (blockedEntry.budget) {
      blockedEntry.budget = {
        ...blockedEntry.budget,
        budget_message: stopReasonDetail
      };
    }
    void this.persistence?.upsertBlockedInput?.(issueId, JSON.stringify(blockedEntry));
    this.ports.notifyObservers?.();
  }

  private recordBudgetUsageSample(issueId: string, totalTokens: number, timestampMs: number): void {
    if (!this.budgetConfigured() || totalTokens <= 0) {
      return;
    }
    const samples = this.pruneBudgetSamples(issueId, timestampMs);
    samples.push({ at_ms: timestampMs, total_tokens: Math.max(0, totalTokens) });
    this.state.budget_usage_samples?.set(issueId, samples);
  }

  private quarantineBlockedWorkerEvent(
    blockedEntry: BlockedEntry,
    workerEvent: WorkerObservabilityEvent,
    reason: 'awaiting_operator_latch' | 'lineage_mismatch'
  ): void {
    const quarantinedEvent = {
      at_ms: workerEvent.timestamp_ms,
      event: workerEvent.event,
      message: workerEvent.detail ?? null,
      codex_app_server_pid: normalizeCodexAppServerPid(workerEvent.codex_app_server_pid),
      session_id: workerEvent.session_id ?? null,
      thread_id: workerEvent.thread_id ?? null,
      turn_id: workerEvent.turn_id ?? null,
      reason
    };
    blockedEntry.quarantined_events = [...(blockedEntry.quarantined_events ?? []), quarantinedEvent].slice(-40);
    blockedEntry.quarantined_event_count = (blockedEntry.quarantined_event_count ?? 0) + 1;
    blockedEntry.last_quarantined_event_at_ms = workerEvent.timestamp_ms;
    void this.persistence
      ?.upsertBlockedInput?.(blockedEntry.issue_id, JSON.stringify(blockedEntry))
      .catch(() => undefined);
    this.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.orchestration.blockedWorkerEventQuarantined,
      message: 'worker event quarantined while awaiting operator action',
      context: {
        issue_id: blockedEntry.issue_id,
        issue_identifier: blockedEntry.issue_identifier,
        stop_reason_code: blockedEntry.stop_reason_code,
        quarantined_event: workerEvent.event,
        reason
      }
    });
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.orchestration.blockedWorkerEventQuarantined,
      severity: 'warn',
      issue_identifier: blockedEntry.issue_identifier,
      session_id: workerEvent.session_id,
      detail: `event=${workerEvent.event} reason=${reason}`
    });
    this.ports.notifyObservers?.();
  }

  private staleWorkerExitReasonForRunningEntry(
    running: RunningEntry,
    details: WorkerExitDetails
  ): 'worker_instance_mismatch' | 'worker_handle_mismatch' | 'worker_pid_mismatch' | 'thread_mismatch' | 'turn_mismatch' | 'session_mismatch' | null {
    const exitWorkerInstanceId = normalizeWorkerInstanceId(details.worker_instance_id);
    if (exitWorkerInstanceId && running.worker_instance_id && exitWorkerInstanceId !== running.worker_instance_id) {
      return 'worker_instance_mismatch';
    }

    if (details.worker_handle !== undefined && details.worker_handle !== running.worker_handle) {
      return 'worker_handle_mismatch';
    }

    const exitPid = normalizeCodexAppServerPid(details.codex_app_server_pid);
    if (exitPid && running.codex_app_server_pid && exitPid !== running.codex_app_server_pid) {
      return 'worker_pid_mismatch';
    }

    if (details.thread_id && running.thread_id && details.thread_id !== running.thread_id) {
      return 'thread_mismatch';
    }

    if (details.turn_id && running.turn_id && details.turn_id !== running.turn_id) {
      return 'turn_mismatch';
    }

    if (details.session_id && running.session_id && details.session_id !== running.session_id) {
      return 'session_mismatch';
    }

    return null;
  }

  private async applyWorkerExitLineage(running: RunningEntry, details: WorkerExitDetails): Promise<void> {
    const sessionId = details.session_id ?? null;
    if (sessionId && !running.session_id) {
      running.session_id = sessionId;
      if (running.run_id) {
        await this.persistence?.recordSession({
          run_id: running.run_id,
          session_id: sessionId
        });
      }
    }
    if (details.thread_id && !running.thread_id) {
      running.thread_id = details.thread_id;
    }
    if (details.turn_id && !running.turn_id) {
      running.turn_id = details.turn_id;
    }
    const codexAppServerPid = normalizeCodexAppServerPid(details.codex_app_server_pid);
    if (codexAppServerPid && !running.codex_app_server_pid) {
      running.codex_app_server_pid = codexAppServerPid;
    }
  }

  private recordTerminationExitObserved(
    issue_id: string,
    running: RunningEntry,
    reason: WorkerExitReason,
    error: string | undefined,
    details: WorkerExitDetails
  ): void {
    const termination = running.termination;
    if (!termination) {
      return;
    }
    const observedAtMs = this.nowMs();
    running.termination = {
      ...termination,
      state: 'exit_observed',
      exit_observed_at_ms: termination.exit_observed_at_ms ?? observedAtMs,
      worker_instance_id:
        normalizeWorkerInstanceId(details.worker_instance_id) ?? termination.worker_instance_id ?? running.worker_instance_id ?? null,
      codex_app_server_pid:
        normalizeCodexAppServerPid(details.codex_app_server_pid) ?? termination.codex_app_server_pid ?? running.codex_app_server_pid ?? null,
      thread_id: details.thread_id ?? termination.thread_id ?? running.thread_id ?? null,
      turn_id: details.turn_id ?? termination.turn_id ?? running.turn_id ?? null,
      session_id: details.session_id ?? termination.session_id ?? running.session_id ?? null
    };
    this.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.orchestration.workerExitHandled,
      message: 'worker exit observed during termination release',
      context: {
        issue_id,
        issue_identifier: running.identifier,
        reason,
        error: error ?? null,
        outcome: 'termination_exit_observed',
        termination_reason: termination.reason,
        termination_state: running.termination.state,
        cleanup_workspace: termination.cleanup_workspace,
        active_run_id: running.run_id ?? null,
        active_issue_run_id: running.issue_run_id ?? null,
        active_attempt_id: running.attempt_id ?? null,
        active_worker_instance_id: running.worker_instance_id ?? null,
        event_worker_instance_id: normalizeWorkerInstanceId(details.worker_instance_id),
        active_codex_app_server_pid: running.codex_app_server_pid ?? null,
        event_codex_app_server_pid: normalizeCodexAppServerPid(details.codex_app_server_pid),
        active_thread_id: running.thread_id ?? null,
        event_thread_id: details.thread_id ?? null,
        active_turn_id: running.turn_id ?? null,
        event_turn_id: details.turn_id ?? null,
        active_session_id: running.session_id ?? null,
        event_session_id: details.session_id ?? null,
        completion_reason: details.completion_reason ?? null,
        refreshed_state: details.refreshed_state ?? null
      }
    });
  }

  async onWorkerExit(
    issue_id: string,
    reason: WorkerExitReason,
    error?: string,
    details: WorkerExitDetails = {}
  ): Promise<void> {
    const running = this.state.running.get(issue_id);
    if (!running) {
      const releasedWorker = this.findReleasedWorkerRecord(issue_id, details);
      if (this.state.completed.has(issue_id) || releasedWorker) {
        this.logger?.log({
          level: 'info',
          event: CANONICAL_EVENT.orchestration.staleWorkerExitIgnored,
          message: 'late worker exit observed after runtime ownership was already released',
          context: {
            issue_id,
            reason,
            error: error ?? null,
            completion_reason: details.completion_reason ?? null,
            refreshed_state: details.refreshed_state ?? null,
            stale_reason: 'ownership_already_released',
            release_reason: releasedWorker?.reason ?? null,
            release_session_id: releasedWorker?.session_id ?? null,
            event_worker_instance_id: normalizeWorkerInstanceId(details.worker_instance_id),
            event_codex_app_server_pid: normalizeCodexAppServerPid(details.codex_app_server_pid),
            event_thread_id: details.thread_id ?? null,
            event_turn_id: details.turn_id ?? null,
            event_session_id: details.session_id ?? null
          }
        });
      }
      return;
    }

    const staleExitReason = this.staleWorkerExitReasonForRunningEntry(running, details);
    if (staleExitReason) {
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.orchestration.staleWorkerExitIgnored,
        message: 'stale worker exit ignored for active run',
        context: {
          issue_id,
          issue_identifier: running.identifier,
          reason,
          error: error ?? null,
          completion_reason: details.completion_reason ?? null,
          refreshed_state: details.refreshed_state ?? null,
          stale_reason: staleExitReason,
          termination_state: running.termination?.state ?? null,
          termination_reason: running.termination?.reason ?? null,
          active_run_id: running.run_id ?? null,
          active_issue_run_id: running.issue_run_id ?? null,
          active_attempt_id: running.attempt_id ?? null,
          active_worker_instance_id: running.worker_instance_id ?? null,
          event_worker_instance_id: normalizeWorkerInstanceId(details.worker_instance_id),
          active_codex_app_server_pid: running.codex_app_server_pid ?? null,
          event_codex_app_server_pid: normalizeCodexAppServerPid(details.codex_app_server_pid),
          active_thread_id: running.thread_id ?? null,
          event_thread_id: details.thread_id ?? null,
          active_turn_id: running.turn_id ?? null,
          event_turn_id: details.turn_id ?? null,
          active_session_id: running.session_id ?? null,
          event_session_id: details.session_id ?? null
        }
      });
      this.ports.notifyObservers?.();
      return;
    }

    await this.applyWorkerExitLineage(running, details);

    if (running.termination) {
      this.recordTerminationExitObserved(issue_id, running, reason, error, details);
      this.ports.notifyObservers?.();
      return;
    }

    this.rememberInactiveWorkerPid(running, details.completion_reason ?? reason);
    this.state.running.delete(issue_id);
    this.addRuntimeSecondsFromEntry(running);
    this.recordBudgetUsageSample(issue_id, running.tokens.total_tokens, this.nowMs());

    if (reason === 'normal') {
      const completionReason = details.completion_reason ?? null;
      if (this.isMissingToolOutputRecoveryInProgress(running)) {
        running.recovery = {
          ...running.recovery,
          last_result: 'succeeded',
          last_result_reason_code: completionReason ?? REASON_CODES.normalCompletion,
          last_result_detail: details.refreshed_state
            ? `recovery turn completed after refreshed issue state: ${details.refreshed_state}`
            : 'recovery turn completed'
        };
        this.recordRuntimeEvent({
          event: CANONICAL_EVENT.orchestration.missingToolOutputRecoveryStarted,
          severity: 'info',
          issue_identifier: running.identifier,
          session_id: running.session_id ?? undefined,
          detail: `result=succeeded completion_reason=${completionReason ?? REASON_CODES.normalCompletion} refreshed_state=${details.refreshed_state ?? 'unknown'}`
        });
      }
      if (completionReason === REASON_CODES.issueStateRefreshFailed) {
        const stopReasonDetail = error ?? 'tracker state refresh failed after completed turn';
        this.emitPhaseMarker(issue_id, {
          phase: 'completed',
          detail: 'worker exited normally; tracker refresh pending',
          attempt: running.retry_attempt,
          thread_id: running.thread_id,
          session_id: running.session_id
        });
        await this.completeRunRecord(running, 'succeeded', REASON_CODES.issueStateRefreshFailed, null, stopReasonDetail);
        await this.persistExecutionGraphStateTransition(
          running,
          'retrying',
          'retrying',
          REASON_CODES.issueStateRefreshFailed,
          stopReasonDetail
        );
        this.state.completed.add(issue_id);
        await this.scheduleRetry({
          issue_id,
          identifier: running.identifier,
          attempt: 1,
          issue_run_id: running.issue_run_id ?? null,
          previous_attempt_id: running.attempt_id ?? null,
          delay_type: 'failure',
          error: 'tracker state refresh pending',
          worker_host: running.worker_host ?? null,
          workspace_path: running.workspace_path ?? null,
          provisioner_type: running.provisioner_type ?? null,
          branch_name: running.branch_name ?? null,
          repo_root: running.repo_root ?? null,
          workspace_exists: running.workspace_exists,
          workspace_git_status: running.workspace_git_status,
          workspace_provisioned: running.workspace_provisioned,
          workspace_is_git_worktree: running.workspace_is_git_worktree,
          copy_ignored_applied: running.copy_ignored_applied,
          copy_ignored_status: running.copy_ignored_status,
          copy_ignored_summary: running.copy_ignored_summary,
          stop_reason_code: REASON_CODES.issueStateRefreshFailed,
          stop_reason_detail: stopReasonDetail,
          previous_thread_id: running.thread_id,
          previous_turn_id: running.turn_id,
          previous_session_id: running.session_id,
          issue_snapshot: running.issue,
          progress_signals: running.progress_signals,
          budget: running.budget,
          recovery: running.recovery ? { ...running.recovery } : null
        });
        this.logger?.log({
          level: 'warn',
          event: CANONICAL_EVENT.orchestration.workerExitHandled,
          message: 'worker exit handled: completed; tracker refresh retry pending',
          context: {
            issue_id,
            issue_identifier: running.identifier,
            session_id: running.session_id,
            reason,
            outcome: 'tracker_refresh_pending',
            retry_attempt: 1,
            stop_reason_code: REASON_CODES.issueStateRefreshFailed,
            error: stopReasonDetail
          }
        });
        this.ports.notifyObservers?.();
        return;
      }
      const normalStop = this.normalStopForWorkerCompletion(completionReason, details.refreshed_state ?? null);
      if (normalStop) {
        this.emitPhaseMarker(issue_id, {
          phase: 'completed',
          detail: normalStop.detail,
          attempt: running.retry_attempt,
          thread_id: running.thread_id,
          session_id: running.session_id
        });
        const terminationResult = normalStop.cleanup_workspace
          ? await this.ports.terminateWorker({
            issue_id,
            worker_handle: running.worker_handle,
            cleanup_workspace: true,
            reason: 'terminal_state_transition'
          })
          : null;
        const terminalReasonDetail = terminationResult
          ? workerTerminationResultDetail(normalStop.detail, terminationResult)
          : normalStop.detail;
        await this.completeRunRecord(running, 'succeeded', normalStop.reason_code, null, terminalReasonDetail);
        await this.persistExecutionGraphStateTransition(
          running,
          'succeeded',
          'succeeded',
          normalStop.reason_code,
          terminalReasonDetail
        );
        this.state.completed.add(issue_id);
        this.state.claimed.delete(issue_id);
        this.logger?.log({
          level: 'info',
          event: CANONICAL_EVENT.orchestration.workerExitHandled,
          message: normalStop.message,
          context: {
            issue_id,
            issue_identifier: running.identifier,
            session_id: running.session_id,
            reason,
            outcome: 'completed',
            completion_reason: completionReason,
            refreshed_state: details.refreshed_state ?? null,
            stop_reason_code: normalStop.reason_code,
            ...workerTerminationResultContext(terminationResult),
            cleanup_workspace: normalStop.cleanup_workspace,
            worker_termination_requested: normalStop.cleanup_workspace,
            worker_process_identity_known: Boolean(running.codex_app_server_pid),
            codex_app_server_pid: running.codex_app_server_pid,
            same_issue_process_cleanup_verified: false
          }
        });
        this.ports.notifyObservers?.();
        return;
      }

      this.emitPhaseMarker(issue_id, {
        phase: 'completed',
        detail: 'worker exited normally',
        attempt: running.retry_attempt,
        thread_id: running.thread_id,
        session_id: running.session_id
      });
      await this.completeRunRecord(running, 'succeeded', null);
      await this.persistExecutionGraphStateTransition(
        running,
        'retrying',
        'retrying',
        REASON_CODES.normalCompletion,
        'normal worker completion, continuing while issue is active'
      );
      this.state.completed.add(issue_id);
      await this.scheduleRetry({
        issue_id,
        identifier: running.identifier,
        attempt: 1,
        issue_run_id: running.issue_run_id ?? null,
        previous_attempt_id: running.attempt_id ?? null,
        delay_type: 'continuation',
        error: null,
        worker_host: running.worker_host ?? null,
        workspace_path: running.workspace_path ?? null,
        provisioner_type: running.provisioner_type ?? null,
        branch_name: running.branch_name ?? null,
        repo_root: running.repo_root ?? null,
        workspace_exists: running.workspace_exists,
        workspace_git_status: running.workspace_git_status,
      workspace_provisioned: running.workspace_provisioned,
      workspace_is_git_worktree: running.workspace_is_git_worktree,
      copy_ignored_applied: running.copy_ignored_applied,
      copy_ignored_status: running.copy_ignored_status,
      copy_ignored_summary: running.copy_ignored_summary,
        stop_reason_code: REASON_CODES.normalCompletion,
        stop_reason_detail: 'normal worker completion, continuing while issue is active',
        previous_thread_id: running.thread_id,
        previous_turn_id: running.turn_id,
        previous_session_id: running.session_id,
        issue_snapshot: running.issue,
        progress_signals: running.progress_signals,
        budget: running.budget,
        recovery: running.recovery ? { ...running.recovery } : null
      });
      this.logger?.log({
        level: 'info',
        event: CANONICAL_EVENT.orchestration.workerExitHandled,
        message: 'worker exit handled: completed; retrying continuation',
        context: {
          issue_id,
          issue_identifier: running.identifier,
          session_id: running.session_id,
          reason,
          outcome: 'completed',
          retry_attempt: 1
        }
      });
    } else {
      const recoveryFailure = this.isMissingToolOutputRecoveryInProgress(running)
        ? {
            ...running.recovery,
            last_result: 'failed' as const,
            last_result_reason_code: REASON_CODES.missingToolOutputRecoveryStartFailed,
            last_result_detail: error ?? `worker exited: ${reason}`
          }
        : null;
      await this.completeRunRecord(running, 'failed', error ?? `worker exited: ${reason}`, recoveryFailure);
      this.state.health.last_error = `worker exited for ${running.identifier}`;
      const stopReasonCode = this.inferStopReasonCode(error, REASON_CODES.workerExitAbnormal);
      if (this.isMissingToolOutputRecoveryInProgress(running)) {
        await this.scheduleRecoveryStartFailedBlock(issue_id, running, error ?? `worker exited: ${reason}`);
        this.ports.notifyObservers?.();
        return;
      }
      if (stopReasonCode === REASON_CODES.turnInputRequired) {
        const inputDetail = this.inferInputRequiredDetail(error, reason);
        const stopReasonDetail = inputDetail.detail;
        this.emitPhaseMarker(issue_id, {
          phase: 'blocked_input',
          detail: stopReasonDetail,
          attempt: running.retry_attempt + 1,
          thread_id: running.thread_id,
          session_id: running.session_id
        });
        await this.scheduleBlockedInput({
          issue_id,
          issue_identifier: running.identifier,
          attempt: running.retry_attempt + 1,
          issue_run_id: running.issue_run_id ?? null,
          previous_attempt_id: running.attempt_id ?? null,
          worker_host: running.worker_host ?? null,
          workspace_path: running.workspace_path ?? null,
          provisioner_type: running.provisioner_type ?? null,
          branch_name: running.branch_name ?? null,
          repo_root: running.repo_root ?? null,
          workspace_exists: running.workspace_exists,
          workspace_git_status: running.workspace_git_status,
          workspace_provisioned: running.workspace_provisioned,
          workspace_is_git_worktree: running.workspace_is_git_worktree,
          copy_ignored_applied: running.copy_ignored_applied,
          copy_ignored_status: running.copy_ignored_status,
          copy_ignored_summary: running.copy_ignored_summary,
          stop_reason_code: REASON_CODES.turnInputRequired,
          stop_reason_detail: stopReasonDetail,
          pending_input: inputDetail,
          session_console: running.recent_events,
          previous_thread_id: running.thread_id,
          previous_turn_id: running.turn_id,
          previous_session_id: running.session_id
        });
        this.logger?.log({
          level: 'warn',
          event: CANONICAL_EVENT.orchestration.workerExitHandled,
          message: 'worker exit handled: blocked on operator input',
          context: {
            issue_id,
            issue_identifier: running.identifier,
            session_id: running.session_id,
            reason,
            outcome: 'blocked',
            stop_reason_code: REASON_CODES.turnInputRequired,
            error: stopReasonDetail
          }
        });
        await this.persistExecutionGraphStateTransition(running, 'blocked', 'blocked', REASON_CODES.turnInputRequired, stopReasonDetail);
        this.ports.notifyObservers?.();
        return;
      }
      if (stopReasonCode === REASON_CODES.operatorWorkspaceConflict) {
        const workspaceConflict = this.inferWorkspaceConflictContext(error, reason);
        this.emitPhaseMarker(issue_id, {
          phase: 'blocked_input',
          detail: workspaceConflict.detail,
          attempt: running.retry_attempt + 1,
          thread_id: running.thread_id,
          session_id: running.session_id
        });
        await this.scheduleBlockedInput({
          issue_id,
          issue_identifier: running.identifier,
          attempt: running.retry_attempt + 1,
          issue_run_id: running.issue_run_id ?? null,
          previous_attempt_id: running.attempt_id ?? null,
          worker_host: running.worker_host ?? null,
          workspace_path: running.workspace_path ?? null,
          provisioner_type: running.provisioner_type ?? null,
          branch_name: running.branch_name ?? null,
          repo_root: running.repo_root ?? null,
          workspace_exists: running.workspace_exists,
          workspace_git_status: running.workspace_git_status,
          workspace_provisioned: running.workspace_provisioned,
          workspace_is_git_worktree: running.workspace_is_git_worktree,
          copy_ignored_applied: running.copy_ignored_applied,
          copy_ignored_status: running.copy_ignored_status,
          copy_ignored_summary: running.copy_ignored_summary,
          stop_reason_code: REASON_CODES.operatorWorkspaceConflict,
          stop_reason_detail: workspaceConflict.detail,
          conflict_files: workspaceConflict.conflict_files,
          classification_summary: workspaceConflict.classification_summary,
          resolution_hints: workspaceConflict.resolution_hints,
          session_console: running.recent_events,
          previous_thread_id: running.thread_id,
          previous_turn_id: running.turn_id,
          previous_session_id: running.session_id
        });
        this.logger?.log({
          level: 'warn',
          event: CANONICAL_EVENT.orchestration.workerExitHandled,
          message: 'worker exit handled: blocked on workspace conflict',
          context: {
            issue_id,
            issue_identifier: running.identifier,
            session_id: running.session_id,
            reason,
            outcome: 'blocked',
            stop_reason_code: REASON_CODES.operatorWorkspaceConflict,
            error: workspaceConflict.detail
          }
        });
        await this.persistExecutionGraphStateTransition(
          running,
          'blocked',
          'blocked',
          REASON_CODES.operatorWorkspaceConflict,
          workspaceConflict.detail
        );
        this.ports.notifyObservers?.();
        return;
      }

      await this.scheduleRetry({
        issue_id,
        identifier: running.identifier,
        attempt: running.retry_attempt + 1,
        issue_run_id: running.issue_run_id ?? null,
        previous_attempt_id: running.attempt_id ?? null,
        delay_type: 'failure',
        error: error ?? `worker exited: ${reason}`,
        worker_host: running.worker_host ?? null,
        workspace_path: running.workspace_path ?? null,
        provisioner_type: running.provisioner_type ?? null,
        branch_name: running.branch_name ?? null,
        repo_root: running.repo_root ?? null,
        workspace_exists: running.workspace_exists,
        workspace_git_status: running.workspace_git_status,
        workspace_provisioned: running.workspace_provisioned,
        workspace_is_git_worktree: running.workspace_is_git_worktree,
        copy_ignored_applied: running.copy_ignored_applied,
        copy_ignored_status: running.copy_ignored_status,
        copy_ignored_summary: running.copy_ignored_summary,
        stop_reason_code: stopReasonCode,
        stop_reason_detail: error ?? `worker exited: ${reason}`,
        previous_thread_id: running.thread_id,
        previous_turn_id: running.turn_id,
        previous_session_id: running.session_id,
        issue_snapshot: running.issue,
        progress_signals: running.progress_signals,
        budget: running.budget,
        recovery: running.recovery ? { ...running.recovery } : null
      });
      this.emitPhaseMarker(issue_id, {
        phase: 'failed',
        detail: error ?? `worker exited: ${reason}`,
        attempt: running.retry_attempt,
        thread_id: running.thread_id,
        session_id: running.session_id
      });
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.orchestration.workerExitHandled,
        message: 'worker exit handled: failed; retrying',
        context: {
          issue_id,
          issue_identifier: running.identifier,
          session_id: running.session_id,
          reason,
          outcome: 'failed',
          retry_attempt: running.retry_attempt + 1,
          error: error ?? null
        }
      });
      await this.persistExecutionGraphStateTransition(
        running,
        'retrying',
        'retrying',
        stopReasonCode,
        error ?? `worker exited: ${reason}`
      );
    }

    this.ports.notifyObservers?.();
  }

  private isMissingToolOutputRecoveryInProgress(running: RunningEntry): running is RunningEntry & {
    recovery: MissingToolOutputRecoveryState;
  } {
    return running.recovery?.reason_code === REASON_CODES.missingToolOutput && running.recovery.last_result === 'started';
  }

  private async scheduleRecoveryStartFailedBlock(issueId: string, running: RunningEntry, error: string): Promise<void> {
    const recovery = running.recovery
      ? {
          ...running.recovery,
          last_result: 'failed' as const,
          last_result_reason_code: REASON_CODES.missingToolOutputRecoveryStartFailed,
          last_result_detail: error
        }
      : null;
    const diagnostic = recovery
      ? {
          tool_name: recovery.last_tool_name,
          call_id: recovery.last_call_id,
          thread_id: recovery.previous_thread_id ?? running.thread_id ?? null,
          turn_id: recovery.previous_turn_id ?? running.turn_id ?? null,
          session_id: recovery.previous_session_id ?? running.session_id ?? null,
          elapsed_wait_ms: recovery.elapsed_wait_ms,
          last_agent_message: recovery.last_agent_message ?? running.last_message ?? null,
          evidence_source: recovery.evidence_source,
          recommended_actions: [
            'Inspect external state for the last tool action',
            'Manually resume the Codex thread with guarded continuation',
            'Cancel or requeue after inspection'
          ]
        }
      : null;
    const detail = [
      'same-thread guarded recovery failed to start or complete',
      `error=${error}`,
      `tool_name=${diagnostic?.tool_name ?? 'unknown'}`,
      `call_id=${diagnostic?.call_id ?? 'unknown'}`,
      `thread_id=${diagnostic?.thread_id ?? 'unknown'}`,
      `turn_id=${diagnostic?.turn_id ?? 'unknown'}`,
      `session_id=${diagnostic?.session_id ?? 'unknown'}`
    ].join(' ');

    await this.scheduleBlockedInput({
      issue_id: issueId,
      issue_identifier: running.identifier,
      attempt: running.retry_attempt + 1,
      issue_run_id: running.issue_run_id ?? null,
      previous_attempt_id: running.attempt_id ?? null,
      worker_host: running.worker_host ?? null,
      workspace_path: running.workspace_path ?? null,
      provisioner_type: running.provisioner_type ?? null,
      branch_name: running.branch_name ?? null,
      repo_root: running.repo_root ?? null,
      workspace_exists: running.workspace_exists,
      workspace_git_status: running.workspace_git_status,
      workspace_provisioned: running.workspace_provisioned,
      workspace_is_git_worktree: running.workspace_is_git_worktree,
      copy_ignored_applied: running.copy_ignored_applied,
      copy_ignored_status: running.copy_ignored_status,
      copy_ignored_summary: running.copy_ignored_summary,
      stop_reason_code: REASON_CODES.missingToolOutputRecoveryStartFailed,
      stop_reason_detail: detail,
      resolution_hints: diagnostic?.recommended_actions ?? [],
      required_actions: diagnostic?.recommended_actions ?? [],
      session_console: running.recent_events,
      previous_thread_id: diagnostic?.thread_id ?? running.thread_id,
      previous_turn_id: diagnostic?.turn_id ?? running.turn_id,
      previous_session_id: diagnostic?.session_id ?? running.session_id,
      last_progress_checkpoint_at: running.last_progress_transition_at_ms ?? running.started_at_ms,
      tool_output_wait: diagnostic,
      recovery
    });
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.orchestration.blockedInputScheduled,
      severity: 'warn',
      issue_identifier: running.identifier,
      session_id: diagnostic?.session_id ?? running.session_id ?? undefined,
      detail
    });
    await this.persistExecutionGraphStateTransition(
      running,
      'blocked',
      'blocked',
      REASON_CODES.missingToolOutputRecoveryStartFailed,
      detail
    );
  }

  async onRetryTimer(issue_id: string): Promise<void> {
    await this.runSerializedOperation(() => this.onRetryTimerOnce(issue_id));
  }

  private recordRetryCleared(
    retryEntry: RetryEntry,
    params: {
      cleanup_reason: 'active_candidate_missing' | 'tracker_state_terminal' | 'tracker_state_non_active';
      observed_tracker_state: string | null;
    }
  ): void {
    const context = {
      issue_id: retryEntry.issue_id,
      issue_identifier: retryEntry.identifier,
      previous_retry_reason: retryEntry.stop_reason_code ?? retryEntry.error,
      retry_attempt: retryEntry.attempt,
      due_at_ms: retryEntry.due_at_ms,
      observed_tracker_state: params.observed_tracker_state,
      cleanup_reason: params.cleanup_reason
    };
    this.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.tracker.retryCleared,
      message: 'retry cleared without redispatch',
      context
    });
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.tracker.retryCleared,
      severity: 'info',
      issue_identifier: retryEntry.identifier,
      detail:
        `cleanup_reason=${params.cleanup_reason} previous_retry_reason=${context.previous_retry_reason ?? 'unknown'} ` +
        `retry_attempt=${retryEntry.attempt} due_at_ms=${retryEntry.due_at_ms} ` +
        `observed_tracker_state=${params.observed_tracker_state ?? 'unknown'}`
    });
  }

  private async onRetryTimerOnce(issue_id: string): Promise<void> {
    if (this.state.blocked_inputs.has(issue_id)) {
      return;
    }

    const retryEntry = this.state.retry_attempts.get(issue_id);
    if (!retryEntry) {
      return;
    }

    this.state.retry_attempts.delete(issue_id);

    if (retryEntry.stop_reason_code === REASON_CODES.issueStateRefreshFailed) {
      await this.onTrackerRefreshRetryTimer(issue_id, retryEntry);
      return;
    }

    let candidates: Issue[];
    try {
      candidates = await this.ports.tracker.fetch_candidate_issues();
    } catch (error) {
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.tracker.retryFetchFailed,
        message: 'failed to fetch candidates for retry dispatch',
        context: {
          issue_id,
          issue_identifier: retryEntry.identifier,
          attempt: retryEntry.attempt,
          error: error instanceof Error ? error.message : 'unknown'
        }
      });
      this.recordRuntimeEvent({
        event: CANONICAL_EVENT.tracker.retryFetchFailed,
        severity: 'warn',
        issue_identifier: retryEntry.identifier,
        detail: error instanceof Error ? error.message : 'unknown'
      });
      await this.scheduleRetry({
        issue_id,
        identifier: retryEntry.identifier,
        attempt: retryEntry.attempt + 1,
        issue_run_id: retryEntry.issue_run_id,
        previous_attempt_id: retryEntry.previous_attempt_id,
        delay_type: 'failure',
        error: 'retry poll failed',
        worker_host: retryEntry.worker_host ?? null,
        workspace_path: retryEntry.workspace_path ?? null,
        provisioner_type: retryEntry.provisioner_type ?? null,
        branch_name: retryEntry.branch_name ?? null,
        repo_root: retryEntry.repo_root ?? null,
        workspace_exists: retryEntry.workspace_exists,
        workspace_git_status: retryEntry.workspace_git_status,
        workspace_provisioned: retryEntry.workspace_provisioned,
        workspace_is_git_worktree: retryEntry.workspace_is_git_worktree,
        copy_ignored_applied: retryEntry.copy_ignored_applied,
        copy_ignored_status: retryEntry.copy_ignored_status,
        copy_ignored_summary: retryEntry.copy_ignored_summary,
        stop_reason_code: REASON_CODES.retryFetchFailed,
        stop_reason_detail: error instanceof Error ? error.message : 'unknown',
        previous_thread_id: retryEntry.previous_thread_id ?? null,
        previous_turn_id: retryEntry.previous_turn_id ?? null,
        previous_session_id: retryEntry.previous_session_id ?? null,
        recover_workspace_attempt_residue: retryEntry.recover_workspace_attempt_residue ?? false,
        issue_snapshot: null
      });
      return;
    }

    const issue = candidates.find((candidate) => candidate.id === issue_id);
    if (!issue) {
      this.recordRetryCleared(retryEntry, {
        cleanup_reason: 'active_candidate_missing',
        observed_tracker_state: null
      });
      this.state.claimed.delete(issue_id);
      return;
    }

    if (!isActiveState(issue.state, this.config)) {
      this.recordRetryCleared(retryEntry, {
        cleanup_reason: isTerminalState(issue.state, this.config) ? 'tracker_state_terminal' : 'tracker_state_non_active',
        observed_tracker_state: issue.state
      });
      this.state.claimed.delete(issue_id);
      return;
    }

    const freshDispatch = this.isFreshDispatchState(issue.state);
    const eligibility = shouldDispatchIssue(issue, this.state, this.config, {
      skipClaimCheckForIssueId: issue_id
    });

    if (!eligibility.eligible) {
      if (eligibility.reason === 'global_slots_exhausted' || eligibility.reason === 'state_slots_exhausted') {
        await this.scheduleRetry({
          issue_id,
          identifier: issue.identifier,
          attempt: retryEntry.attempt + 1,
          issue_run_id: freshDispatch ? null : retryEntry.issue_run_id,
          previous_attempt_id: freshDispatch ? null : retryEntry.previous_attempt_id,
          delay_type: 'failure',
          error: 'no available orchestrator slots',
          worker_host: freshDispatch ? null : retryEntry.worker_host ?? null,
          workspace_path: freshDispatch ? null : retryEntry.workspace_path ?? null,
          provisioner_type: freshDispatch ? null : retryEntry.provisioner_type ?? null,
          branch_name: freshDispatch ? null : retryEntry.branch_name ?? null,
          repo_root: freshDispatch ? null : retryEntry.repo_root ?? null,
          workspace_exists: freshDispatch ? false : retryEntry.workspace_exists,
          workspace_git_status: freshDispatch ? null : retryEntry.workspace_git_status,
          workspace_provisioned: freshDispatch ? false : retryEntry.workspace_provisioned,
          workspace_is_git_worktree: freshDispatch ? false : retryEntry.workspace_is_git_worktree,
          copy_ignored_applied: freshDispatch ? false : retryEntry.copy_ignored_applied,
          copy_ignored_status: freshDispatch ? null : retryEntry.copy_ignored_status,
          copy_ignored_summary: freshDispatch ? null : retryEntry.copy_ignored_summary,
          stop_reason_code: REASON_CODES.slotsExhausted,
          stop_reason_detail: 'no available orchestrator slots',
          previous_thread_id: freshDispatch ? null : retryEntry.previous_thread_id ?? null,
          previous_turn_id: freshDispatch ? null : retryEntry.previous_turn_id ?? null,
          previous_session_id: freshDispatch ? null : retryEntry.previous_session_id ?? null,
          recover_workspace_attempt_residue: freshDispatch ? false : retryEntry.recover_workspace_attempt_residue ?? false,
          issue_snapshot: issue
        });
      } else {
        this.state.claimed.delete(issue_id);
      }

      return;
    }

    const backpressure = this.evaluateDispatchBackpressure();
    if (backpressure.active) {
      await this.delayRetryForBackpressure(issue, retryEntry, backpressure, freshDispatch);
      return;
    }
    this.state.health.dispatch_backpressure = emptyDispatchBackpressureState(this.getBackpressureRetryDelayMs());

    if (freshDispatch) {
      this.state.claimed.delete(issue_id);
      await this.dispatchIssue(issue, null);
      return;
    }

    if (
      retryEntry.stop_reason_code === REASON_CODES.dispatchBackpressureControlPlane ||
      retryEntry.stop_reason_code === REASON_CODES.dispatchBackpressureHostLoad
    ) {
      this.state.claimed.delete(issue_id);
      await this.dispatchIssue(issue, retryEntry.attempt, this.workspaceAttemptResidueResumeContext(retryEntry), {
        issue_run_id: retryEntry.issue_run_id,
        previous_attempt_id: retryEntry.previous_attempt_id,
        recover_workspace_attempt_residue: retryEntry.recover_workspace_attempt_residue ?? false
      });
      return;
    }

    const gateEvaluation = this.evaluateRedispatchGate(issue_id, retryEntry, issue);
    if (!gateEvaluation.allow_redispatch) {
      const stopReasonCode = gateEvaluation.awaiting_human_review_scope_incomplete
        ? REASON_CODES.awaitingHumanReviewScopeIncomplete
        : REASON_CODES.operatorNoProgressRedispatchBlocked;
      const stopReasonDetail = gateEvaluation.awaiting_human_review_scope_incomplete
        ? 'PR is open but scope is incomplete and no progress signal was detected'
        : 'completion gate blocked redispatch because no progress signal was detected';
      let blockedResult: { created: boolean };
      if (gateEvaluation.awaiting_human_review_scope_incomplete) {
        blockedResult = await this.scheduleBlockedInput({
          issue_id,
          issue_identifier: retryEntry.identifier,
          attempt: retryEntry.attempt,
          issue_run_id: retryEntry.issue_run_id,
          previous_attempt_id: retryEntry.previous_attempt_id,
          worker_host: retryEntry.worker_host ?? null,
          workspace_path: retryEntry.workspace_path ?? null,
          provisioner_type: retryEntry.provisioner_type ?? null,
          branch_name: retryEntry.branch_name ?? null,
          repo_root: retryEntry.repo_root ?? null,
          workspace_exists: retryEntry.workspace_exists,
          workspace_git_status: retryEntry.workspace_git_status,
          workspace_provisioned: retryEntry.workspace_provisioned,
          workspace_is_git_worktree: retryEntry.workspace_is_git_worktree,
          copy_ignored_applied: retryEntry.copy_ignored_applied,
          copy_ignored_status: retryEntry.copy_ignored_status,
          copy_ignored_summary: retryEntry.copy_ignored_summary,
          stop_reason_code: stopReasonCode,
          stop_reason_detail: stopReasonDetail,
          previous_thread_id: retryEntry.previous_thread_id ?? null,
          previous_turn_id: retryEntry.previous_turn_id ?? null,
          previous_session_id: retryEntry.previous_session_id ?? null,
          attempt_count_window: gateEvaluation.attempt_count_window,
          window_minutes: gateEvaluation.window_minutes,
          last_known_commit_sha: gateEvaluation.last_known_commit_sha,
          last_progress_checkpoint_at: gateEvaluation.last_progress_checkpoint_at,
          progress_signals: gateEvaluation.progress_signals,
          required_actions:
            retryEntry.stop_reason_code === REASON_CODES.turnWaitingThresholdExceeded
              ? ['Inspect issue diagnostics', 'Resume manually after confirming meaningful progress path', 'Cancel and return to backlog']
              : ['Mark acceptance complete and resume', 'Push additional commit and resume', 'Cancel and return to backlog'],
          apply_circuit_breaker: gateEvaluation.breaker_hit
        });
      } else {
        const existingRetry = this.state.retry_attempts.get(issue_id);
        if (existingRetry) {
          this.ports.cancelRetryTimer(existingRetry.timer_handle);
          this.state.retry_attempts.delete(issue_id);
        }
        this.state.claimed.delete(issue_id);
        await this.upsertCircuitBreaker({
          issue_id,
          issue_identifier: retryEntry.identifier,
          breaker_active: true,
          breaker_hit_count: Math.max(1, gateEvaluation.attempt_count_window),
          breaker_window_minutes: Math.max(1, gateEvaluation.window_minutes),
          breaker_first_hit_at_ms: this.nowMs(),
          breaker_last_hit_at_ms: this.nowMs()
        });
        blockedResult = { created: true };
      }
      await this.persistExecutionGraphRetryTransition(
        retryEntry,
        'blocked',
        'blocked',
        stopReasonCode,
        stopReasonDetail
      );
      const eventName = gateEvaluation.awaiting_human_review_scope_incomplete
        ? CANONICAL_EVENT.orchestration.stateAwaitingHumanReviewScopeIncomplete
        : CANONICAL_EVENT.orchestration.redispatchCompletionGateBlocked;
      if (blockedResult.created) {
        this.recordRuntimeEvent({
          event: eventName,
          severity: 'warn',
          issue_identifier: retryEntry.identifier,
          detail: stopReasonDetail
        });
        this.logger?.log({
          level: 'warn',
          event: eventName,
          message: stopReasonDetail,
          context: {
            issue_id,
            issue_identifier: retryEntry.identifier,
            stop_reason_code: stopReasonCode,
            progress_summary: JSON.stringify({
              attempt_count_window: gateEvaluation.attempt_count_window,
              window_minutes: gateEvaluation.window_minutes,
              last_known_commit_sha: gateEvaluation.last_known_commit_sha,
              signals: gateEvaluation.progress_signals
            }),
            next_operator_action: gateEvaluation.awaiting_human_review_scope_incomplete
              ? 'issue.resume'
              : 'inspect_no_progress_fault',
            next_operator_action_endpoint: gateEvaluation.awaiting_human_review_scope_incomplete
              ? '/api/v1/issues/:issue_identifier/resume'
              : null
          }
        });
      }
      if (gateEvaluation.breaker_hit && blockedResult.created) {
        this.recordRuntimeEvent({
          event: CANONICAL_EVENT.orchestration.redispatchCircuitBreakerOpened,
          severity: 'warn',
          issue_identifier: retryEntry.identifier,
          detail: 'respawn circuit breaker opened'
        });
        this.logger?.log({
          level: 'warn',
          event: CANONICAL_EVENT.orchestration.redispatchCircuitBreakerOpened,
          message: 'respawn circuit breaker opened',
          context: {
            issue_id,
            issue_identifier: retryEntry.identifier,
            stop_reason_code: stopReasonCode,
            progress_summary: JSON.stringify({
              attempt_count_window: gateEvaluation.attempt_count_window,
              window_minutes: gateEvaluation.window_minutes,
              last_known_commit_sha: gateEvaluation.last_known_commit_sha,
              signals: gateEvaluation.progress_signals
            }),
            next_operator_action: gateEvaluation.awaiting_human_review_scope_incomplete
              ? 'issue.resume'
              : 'inspect_no_progress_fault',
            next_operator_action_endpoint: gateEvaluation.awaiting_human_review_scope_incomplete
              ? '/api/v1/issues/:issue_identifier/resume'
              : null
          }
        });
      }
      return;
    }

    if (gateEvaluation.progress_signal_reasons.length > 0) {
      this.recordRuntimeEvent({
        event: CANONICAL_EVENT.orchestration.noProgressBlockSuppressed,
        severity: 'info',
        issue_identifier: retryEntry.identifier,
        detail: `progress_signals=${gateEvaluation.progress_signal_reasons.join(',')}`
      });
      this.logger?.log({
        level: 'info',
        event: CANONICAL_EVENT.orchestration.noProgressBlockSuppressed,
        message: 'no-progress block suppressed by progress classifier',
        context: {
          issue_id,
          issue_identifier: retryEntry.identifier,
          progress_signal_reasons: gateEvaluation.progress_signal_reasons.join(','),
          progress_signals: JSON.stringify(gateEvaluation.progress_signals)
        }
      });
    }

    this.state.claimed.delete(issue_id);
    await this.dispatchIssue(issue, retryEntry.attempt, this.workspaceAttemptResidueResumeContext(retryEntry), {
      issue_run_id: retryEntry.issue_run_id,
      previous_attempt_id: retryEntry.previous_attempt_id,
      recover_workspace_attempt_residue: retryEntry.recover_workspace_attempt_residue ?? false
    });
  }

  private async onTrackerRefreshRetryTimer(issue_id: string, retryEntry: RetryEntry): Promise<void> {
    let refreshedIssues: Issue[];
    try {
      refreshedIssues = await this.ports.tracker.fetch_issue_states_by_ids([issue_id]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown';
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.tracker.stateRefreshFailed,
        message: 'failed to refresh issue state for completed turn retry',
        context: {
          issue_id,
          issue_identifier: retryEntry.identifier,
          attempt: retryEntry.attempt,
          error: detail,
          stop_reason_code: REASON_CODES.issueStateRefreshFailed
        }
      });
      this.recordRuntimeEvent({
        event: CANONICAL_EVENT.tracker.stateRefreshFailed,
        severity: 'warn',
        issue_identifier: retryEntry.identifier,
        detail
      });
      await this.scheduleRetry({
        issue_id,
        identifier: retryEntry.identifier,
        attempt: retryEntry.attempt + 1,
        issue_run_id: retryEntry.issue_run_id,
        previous_attempt_id: retryEntry.previous_attempt_id,
        delay_type: 'failure',
        error: 'tracker state refresh retry failed',
        worker_host: retryEntry.worker_host ?? null,
        workspace_path: retryEntry.workspace_path ?? null,
        provisioner_type: retryEntry.provisioner_type ?? null,
        branch_name: retryEntry.branch_name ?? null,
        repo_root: retryEntry.repo_root ?? null,
        workspace_exists: retryEntry.workspace_exists,
        workspace_git_status: retryEntry.workspace_git_status,
        workspace_provisioned: retryEntry.workspace_provisioned,
        workspace_is_git_worktree: retryEntry.workspace_is_git_worktree,
        copy_ignored_applied: retryEntry.copy_ignored_applied,
        copy_ignored_status: retryEntry.copy_ignored_status,
        copy_ignored_summary: retryEntry.copy_ignored_summary,
        stop_reason_code: REASON_CODES.issueStateRefreshFailed,
        stop_reason_detail: detail,
        previous_thread_id: retryEntry.previous_thread_id ?? null,
        previous_turn_id: retryEntry.previous_turn_id ?? null,
        previous_session_id: retryEntry.previous_session_id ?? null,
        issue_snapshot: null,
        progress_signals: retryEntry.progress_signals,
        budget: retryEntry.budget,
        recovery: retryEntry.recovery ? { ...retryEntry.recovery } : null
      });
      return;
    }

    const issue = refreshedIssues.find((candidate) => candidate.id === issue_id);
    if (!issue) {
      this.recordRetryCleared(retryEntry, {
        cleanup_reason: 'active_candidate_missing',
        observed_tracker_state: null
      });
      this.state.claimed.delete(issue_id);
      return;
    }

    if (!isActiveState(issue.state, this.config)) {
      this.recordRetryCleared(retryEntry, {
        cleanup_reason: isTerminalState(issue.state, this.config) ? 'tracker_state_terminal' : 'tracker_state_non_active',
        observed_tracker_state: issue.state
      });
      this.state.claimed.delete(issue_id);
      return;
    }

    if (this.isFreshDispatchState(issue.state)) {
      this.state.claimed.delete(issue_id);
      await this.dispatchIssue(issue, null);
      return;
    }

    await this.scheduleRetry({
      issue_id,
      identifier: issue.identifier,
      attempt: retryEntry.attempt,
      issue_run_id: retryEntry.issue_run_id,
      previous_attempt_id: retryEntry.previous_attempt_id,
      delay_type: 'continuation',
      error: null,
      worker_host: retryEntry.worker_host ?? null,
      workspace_path: retryEntry.workspace_path ?? null,
      provisioner_type: retryEntry.provisioner_type ?? null,
      branch_name: retryEntry.branch_name ?? null,
      repo_root: retryEntry.repo_root ?? null,
      workspace_exists: retryEntry.workspace_exists,
      workspace_git_status: retryEntry.workspace_git_status,
      workspace_provisioned: retryEntry.workspace_provisioned,
      workspace_is_git_worktree: retryEntry.workspace_is_git_worktree,
      copy_ignored_applied: retryEntry.copy_ignored_applied,
      copy_ignored_status: retryEntry.copy_ignored_status,
      copy_ignored_summary: retryEntry.copy_ignored_summary,
      stop_reason_code: REASON_CODES.normalCompletion,
      stop_reason_detail: 'tracker state refresh succeeded; continuing while issue is active',
      previous_thread_id: retryEntry.previous_thread_id ?? null,
      previous_turn_id: retryEntry.previous_turn_id ?? null,
      previous_session_id: retryEntry.previous_session_id ?? null,
      issue_snapshot: issue,
      progress_signals: retryEntry.progress_signals,
      budget: retryEntry.budget,
      recovery: retryEntry.recovery ? { ...retryEntry.recovery } : null
    });
  }

  private evaluateRedispatchGate(
    issue_id: string,
    retryEntry: RetryEntry,
    issue: Issue
  ): {
    allow_redispatch: boolean;
    awaiting_human_review_scope_incomplete: boolean;
    breaker_hit: boolean;
    attempt_count_window: number;
    window_minutes: number;
    last_known_commit_sha: string | null;
    last_progress_checkpoint_at: number | null;
    progress_signals: ProgressSignals;
    progress_signal_reasons: string[];
  } {
    const windowMinutes = Math.max(1, this.config.respawn_window_minutes ?? 30);
    const windowMs = windowMinutes * 60_000;
    const now = this.nowMs();
    const startedState = retryEntry.progress_signals?.tracker_started_state ?? null;
    const trackerStatusTransition =
      retryEntry.progress_signals?.tracker_status_transition ??
      (retryEntry.progress_signals?.tracker_comment_created &&
      startedState &&
      this.isKnownReviewHandoffTransition(startedState, issue.state)
        ? `${startedState} -> ${issue.state}`
        : null);
    const agentReviewHandoff =
      retryEntry.progress_signals?.agent_review_handoff ??
      (trackerStatusTransition && this.isKnownReviewHandoffTransition(startedState, issue.state) ? issue.state : null);
    const currentSignals = {
      commit_sha: retryEntry.progress_signals?.commit_sha ?? null,
      checklist_checkpoint: retryEntry.progress_signals?.checklist_checkpoint ?? null,
      state_marker: retryEntry.progress_signals?.state_marker ?? null,
      tracker_comment_created: retryEntry.progress_signals?.tracker_comment_created ?? false,
      tracker_status_transition: trackerStatusTransition,
      agent_review_handoff: agentReviewHandoff,
      tracker_started_state: startedState
    };
    const progressMap = this.state.redispatch_progress ?? new Map<string, RedispatchProgressSample[]>();
    this.state.redispatch_progress = progressMap;
    const existing = progressMap.get(issue_id) ?? [];
    const sample = {
      at_ms: now,
      commit_sha: currentSignals.commit_sha,
      checklist_checkpoint: currentSignals.checklist_checkpoint,
      state_marker: currentSignals.state_marker,
      pr_open: this.hasOpenPullRequest(issue),
      tracker_comment_created: currentSignals.tracker_comment_created,
      tracker_status_transition: currentSignals.tracker_status_transition,
      agent_review_handoff: currentSignals.agent_review_handoff
    };
    const kept = existing.filter((entry) => now - entry.at_ms <= windowMs);
    const updated = [...kept, sample];
    progressMap.set(issue_id, updated);
    const first = updated[0] ?? sample;
    const noProgress =
      first.commit_sha === sample.commit_sha &&
      first.checklist_checkpoint === sample.checklist_checkpoint &&
      first.state_marker === sample.state_marker;
    const progressSignalReasons = this.classifyProgressSignals(currentSignals);
    const hasExternalProgress = progressSignalReasons.length > 0;
    const attemptCountWindow = updated.length;
    const breakerHit = noProgress && !hasExternalProgress && attemptCountWindow >= Math.max(1, this.config.respawn_max_attempts_without_progress ?? 3);
    const awaitingHuman = Boolean(sample.pr_open && noProgress && !hasExternalProgress);
    return {
      allow_redispatch: !awaitingHuman && !breakerHit,
      awaiting_human_review_scope_incomplete: awaitingHuman,
      breaker_hit: breakerHit,
      attempt_count_window: attemptCountWindow,
      window_minutes: windowMinutes,
      last_known_commit_sha: sample.commit_sha,
      last_progress_checkpoint_at: noProgress && !hasExternalProgress ? retryEntry.last_progress_checkpoint_at ?? null : sample.at_ms,
      progress_signals: currentSignals,
      progress_signal_reasons: progressSignalReasons
    };
  }

  private classifyProgressSignals(signals: ProgressSignals): string[] {
    const reasons: string[] = [];
    if (signals.tracker_comment_created) {
      reasons.push('tracker_comment_created');
    }
    if (signals.tracker_comment_created && signals.tracker_status_transition) {
      reasons.push('tracker_status_transition');
    }
    if (signals.tracker_comment_created && signals.tracker_status_transition && signals.agent_review_handoff) {
      reasons.push('agent_review_handoff');
    }
    return reasons;
  }

  private isKnownReviewHandoffTransition(startedState: string | null | undefined, currentState: string): boolean {
    if (!startedState || normalizeStateName(startedState) !== normalizeStateName('Agent Review')) {
      return false;
    }
    if (normalizeStateName(currentState) === normalizeStateName(startedState)) {
      return false;
    }
    return (
      normalizeStateName(currentState) === normalizeStateName('In Progress') ||
      normalizeStateName(currentState) === normalizeStateName('Human Review') ||
      normalizeStateName(currentState) === normalizeStateName('Merging') ||
      isActiveState(currentState, this.config) ||
      isTerminalState(currentState, this.config)
    );
  }

  private hasOpenPullRequest(issue: Issue): boolean {
    const links = issue.tracker_meta?.pr_links ?? [];
    return links.some((link) => !link.merged && String(link.state).toLowerCase() === 'open');
  }

  private isFreshDispatchState(issueState: string): boolean {
    const normalizedState = normalizeStateName(issueState);
    return (this.config.fresh_dispatch_states ?? []).some((state) => normalizeStateName(state) === normalizedState);
  }

  private isHandoffFreshDispatchState(issueState: string): boolean {
    const normalizedState = normalizeStateName(issueState);
    const isFreshDispatch = (this.config.fresh_dispatch_states ?? []).some(
      (state) => normalizeStateName(state) === normalizedState
    );
    if (!isFreshDispatch) {
      return false;
    }

    const handoffStates = this.config.handoff_states ?? [];
    if (handoffStates.length === 0) {
      return true;
    }

    return handoffStates.some((state) => normalizeStateName(state) === normalizedState);
  }

  private didRunStartInState(runningEntry: RunningEntry, issueState: string): boolean {
    return normalizeStateName(runningEntry.started_issue_state ?? runningEntry.issue.state) === normalizeStateName(issueState);
  }

  private async upsertCircuitBreaker(entry: CircuitBreakerEntry): Promise<void> {
    this.state.circuit_breakers.set(entry.issue_id, { ...entry });
    await this.persistence?.upsertBreaker?.({
      issue_id: entry.issue_id,
      issue_identifier: entry.issue_identifier,
      breaker_active: entry.breaker_active,
      breaker_hit_count: entry.breaker_hit_count,
      breaker_window_minutes: entry.breaker_window_minutes,
      breaker_first_hit_at: entry.breaker_first_hit_at_ms ? new Date(entry.breaker_first_hit_at_ms).toISOString() : null,
      breaker_last_hit_at: entry.breaker_last_hit_at_ms ? new Date(entry.breaker_last_hit_at_ms).toISOString() : null
    });
  }

  private async clearCircuitBreaker(issueId: string): Promise<void> {
    this.state.circuit_breakers.delete(issueId);
    await this.persistence?.deleteBreaker?.(issueId);
  }

  getCircuitBreakerSnapshot(): CircuitBreakerEntry[] {
    return Array.from(this.state.circuit_breakers.values()).map((entry) => ({ ...entry }));
  }

  getBlockedLatchDiagnostics(): {
    blocked_latch_active_count: number;
    blocked_event_quarantine_total: number;
    blocked_event_allowlist_total: number;
    blocked_event_reject_total: number;
    blocked_latch_violation_total: number;
  } {
    const blocked = Array.from(this.state.blocked_inputs.values());
    const quarantineTotal = blocked.reduce((sum, entry) => sum + (entry.quarantined_event_count ?? 0), 0);
    return {
      blocked_latch_active_count: blocked.filter((entry) => entry.awaiting_operator).length,
      blocked_event_quarantine_total: quarantineTotal,
      blocked_event_allowlist_total: 0,
      blocked_event_reject_total: 0,
      blocked_latch_violation_total: 0
    };
  }

  restoreSuppressionState(params: {
    blocked_entries: BlockedEntry[];
    breaker_entries: CircuitBreakerEntry[];
    operator_actions?: Map<string, OperatorActionRecord[]>;
  }): void {
    for (const entry of params.breaker_entries) {
      this.state.circuit_breakers.set(entry.issue_id, cloneCircuitBreakerEntry(entry));
    }
    for (const entry of params.blocked_entries) {
      this.state.blocked_inputs.set(entry.issue_id, cloneBlockedEntry(entry, { includeTranscriptToolCallDiagnostics: true }));
      this.state.claimed.add(entry.issue_id);
    }
    for (const [issueId, actions] of params.operator_actions ?? new Map<string, OperatorActionRecord[]>()) {
      this.state.operator_actions?.set(issueId, actions.map((action) => cloneOperatorAction(action)).slice(-20));
    }
  }

  async reconcileRunningIssues(): Promise<void> {
    if (this.state.running.size === 0) {
      return;
    }

    const runningIssueIds = Array.from(this.state.running.keys());

    let refreshed: Issue[];
    try {
      refreshed = await this.ports.tracker.fetch_issue_states_by_ids(runningIssueIds);
    } catch (error) {
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.tracker.stateRefreshFailed,
        message: 'failed to refresh tracker states for running issues',
        context: {
          issue_count: runningIssueIds.length,
          error: error instanceof Error ? error.message : 'unknown'
        }
      });
      this.recordRuntimeEvent({
        event: CANONICAL_EVENT.tracker.stateRefreshFailed,
        severity: 'warn',
        detail: error instanceof Error ? error.message : 'unknown'
      });
      await this.reconcileStalledRuns();
      return;
    }

    for (const refreshedIssue of refreshed) {
      const runningEntry = this.state.running.get(refreshedIssue.id);
      if (!runningEntry) {
        continue;
      }

      if (isTerminalState(refreshedIssue.state, this.config)) {
        await this.terminateRunningIssue(refreshedIssue.id, true, 'terminal_state_transition');
        continue;
      }

      if (
        this.isHandoffFreshDispatchState(refreshedIssue.state) &&
        !this.didRunStartInState(runningEntry, refreshedIssue.state)
      ) {
        await this.terminateRunningIssue(refreshedIssue.id, false, REASON_CODES.handoffRelease);
        continue;
      }

      if (
        runningEntry.last_event === CANONICAL_EVENT.codex.turnCompleted &&
        this.isFreshDispatchState(refreshedIssue.state) &&
        !this.didRunStartInState(runningEntry, refreshedIssue.state)
      ) {
        await this.terminateRunningIssue(refreshedIssue.id, false, REASON_CODES.handoffRelease);
        continue;
      }

      if (isActiveState(refreshedIssue.state, this.config)) {
        runningEntry.issue = refreshedIssue;
        runningEntry.identifier = refreshedIssue.identifier;
        continue;
      }

      this.markRunningWaitStallRootCauseIfThresholdExceeded(runningEntry, this.nowMs());
      await this.terminateRunningIssue(refreshedIssue.id, false, 'non_active_state_transition');
    }

    await this.reconcileStalledRuns();
  }

  async reconcileBlockedInputs(): Promise<void> {
    if (this.state.blocked_inputs.size === 0) {
      return;
    }

    const blockedIssueIds = Array.from(this.state.blocked_inputs.keys());
    let refreshed: Issue[];
    try {
      refreshed = await this.ports.tracker.fetch_issue_states_by_ids(blockedIssueIds);
    } catch (error) {
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.tracker.stateRefreshFailed,
        message: 'failed to refresh tracker states for blocked issues',
        context: {
          issue_count: blockedIssueIds.length,
          error: error instanceof Error ? error.message : 'unknown'
        }
      });
      return;
    }

    const refreshedById = new Map(refreshed.map((issue) => [issue.id, issue]));
    for (const issueId of blockedIssueIds) {
      const blocked = this.state.blocked_inputs.get(issueId);
      if (!blocked) {
        continue;
      }

      const issue = refreshedById.get(issueId);
      if (issue && this.shouldClearStaleNoProgressBlockedInput(blocked, issue)) {
        this.clearBlockedInput(issueId, REASON_CODES.staleBlockedInputCleared);
        this.state.redispatch_progress?.delete(issueId);
        void this.clearCircuitBreaker(issueId);
        this.recordRuntimeEvent({
          event: CANONICAL_EVENT.orchestration.staleBlockedInputCleared,
          severity: 'info',
          issue_identifier: blocked.issue_identifier,
          detail: `tracker_state=${issue.state} stop_reason_code=${blocked.stop_reason_code}`
        });
        this.logger?.log({
          level: 'info',
          event: CANONICAL_EVENT.orchestration.staleBlockedInputCleared,
          message: 'stale no-progress blocked input cleared for actionable tracker state',
          context: {
            issue_id: issueId,
            issue_identifier: blocked.issue_identifier,
            tracker_state: issue.state,
            stop_reason_code: blocked.stop_reason_code,
            pending_input: blocked.pending_input ? JSON.stringify(blocked.pending_input) : null
          }
        });
        continue;
      }
      if (issue && this.shouldRecoverWorkspaceAttemptResidue(blocked, issue)) {
        this.clearBlockedInput(issueId, REASON_CODES.workspaceAttemptResidueRecovered);
        await this.scheduleRetry({
          issue_id: issueId,
          identifier: blocked.issue_identifier,
          attempt: blocked.attempt,
          issue_run_id: blocked.issue_run_id,
          previous_attempt_id: blocked.previous_attempt_id,
          delay_type: 'continuation',
          error: 'workspace attempt residue recovered',
          worker_host: blocked.worker_host,
          workspace_path: blocked.workspace_path,
          provisioner_type: blocked.provisioner_type,
          branch_name: blocked.branch_name,
          repo_root: blocked.repo_root,
          workspace_exists: blocked.workspace_exists,
          workspace_git_status: blocked.workspace_git_status,
          workspace_provisioned: blocked.workspace_provisioned,
          workspace_is_git_worktree: blocked.workspace_is_git_worktree,
          copy_ignored_applied: blocked.copy_ignored_applied,
          copy_ignored_status: blocked.copy_ignored_status,
          copy_ignored_summary: blocked.copy_ignored_summary,
          stop_reason_code: REASON_CODES.workspaceAttemptResidueRecovered,
          stop_reason_detail: 'recoverable workspace attempt residue will be continued',
          previous_thread_id: blocked.previous_thread_id,
          previous_turn_id: blocked.previous_turn_id ?? null,
          previous_session_id: blocked.previous_session_id,
          progress_signals: blocked.progress_signals,
          recover_workspace_attempt_residue: true,
          issue_snapshot: issue
        });
        this.recordRuntimeEvent({
          event: CANONICAL_EVENT.orchestration.blockedInputCleared,
          severity: 'info',
          issue_identifier: blocked.issue_identifier,
          detail: `workspace_attempt_residue_recovered conflict_files=${blocked.conflict_files.length}`
        });
        continue;
      }
      if (!issue || isTerminalState(issue.state, this.config) || !isActiveState(issue.state, this.config)) {
        if (
          blocked.stop_reason_code === REASON_CODES.missingToolOutput ||
          blocked.stop_reason_code === REASON_CODES.missingToolOutputRecoveryStartFailed ||
          blocked.stop_reason_code === REASON_CODES.missingToolOutputRecoveryExhausted ||
          blocked.stop_reason_code === REASON_CODES.missingToolOutputRecoveryUnsafe
        ) {
          continue;
        }
        this.clearBlockedInput(issueId, issue ? 'issue_no_longer_active' : 'issue_not_found');
      }
    }
  }

  private shouldClearStaleNoProgressBlockedInput(blocked: BlockedEntry, issue: Issue): boolean {
    if (blocked.pending_input) {
      return false;
    }
    if (!isActiveState(issue.state, this.config)) {
      return false;
    }
    return (
      blocked.stop_reason_code === REASON_CODES.operatorNoProgressRedispatchBlocked ||
      blocked.stop_reason_code === REASON_CODES.awaitingHumanReviewScopeIncomplete
    );
  }

  private shouldRecoverWorkspaceAttemptResidue(blocked: BlockedEntry, issue: Issue): boolean {
    if (blocked.stop_reason_code !== REASON_CODES.operatorWorkspaceConflict) {
      return false;
    }
    if (blocked.pending_input || !isActiveState(issue.state, this.config)) {
      return false;
    }
    if (blocked.attempt <= 0 || !blocked.workspace_path) {
      return false;
    }
    if (!this.isRecoverableWorkspaceResiduePath(blocked)) {
      return false;
    }
    if (blocked.conflict_files.length === 0) {
      return false;
    }
    const summary = blocked.classification_summary;
    if (summary && (summary.tracked_ephemeral > 0 || summary.ephemeral > 0)) {
      return false;
    }
    const persistedClassificationsAreRecoverable = blocked.conflict_files.every((file) => {
      const normalized = file.path.replace(/\\/g, '/');
      const classification = file.classification ?? (summary?.unknown_non_ephemeral === blocked.conflict_files.length ? 'unknown_non_ephemeral' : null);
      return classification === 'unknown_non_ephemeral' && !normalized.startsWith('output/playwright/');
    });
    if (persistedClassificationsAreRecoverable) {
      return true;
    }
    return this.hasRecoverableLiveAttemptResidue(blocked);
  }

  private isRecoverableWorkspaceResiduePath(blocked: BlockedEntry): boolean {
    if (!blocked.workspace_path) {
      return false;
    }
    const workspacePath = blocked.workspace_path;
    try {
      const stat = fs.statSync(workspacePath);
      if (!stat.isDirectory()) {
        return false;
      }
      const gitDir = this.resolveGitDirSync(workspacePath);
      if (!gitDir) {
        return false;
      }
      const activeGitStatePaths = [
        'MERGE_HEAD',
        'REBASE_HEAD',
        'AUTO_MERGE',
        'CHERRY_PICK_HEAD',
        'REVERT_HEAD',
        'BISECT_LOG',
        'sequencer',
        'rebase-merge',
        'rebase-apply'
      ];
      if (activeGitStatePaths.some((entry) => fs.existsSync(path.join(gitDir, entry)))) {
        return false;
      }
      const unmerged = spawnSync('git', ['ls-files', '-u'], { cwd: workspacePath, encoding: 'utf8' });
      if (unmerged.status !== 0 || unmerged.stdout.trim()) {
        return false;
      }
      return !blocked.workspace_provisioned || (blocked.workspace_is_git_worktree && Boolean(blocked.branch_name && blocked.repo_root));
    } catch {
      return false;
    }
  }

  private hasRecoverableLiveAttemptResidue(blocked: BlockedEntry): boolean {
    if (!blocked.workspace_path || blocked.conflict_files.length === 0) {
      return false;
    }
    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: blocked.workspace_path,
      encoding: 'utf8'
    });
    if (status.status !== 0) {
      return false;
    }

    const livePaths = new Set<string>();
    for (const entry of this.parseStatusPorcelain(status.stdout)) {
      const normalized = this.normalizePorcelainPath(entry.path);
      if (!normalized || this.isNonRecoverableResiduePath(normalized)) {
        return false;
      }
      if (entry.staged !== ' ' || entry.unstaged !== ' ') {
        livePaths.add(normalized);
      }
    }
    if (livePaths.size === 0) {
      return false;
    }

    const blockedPaths = new Set<string>();
    for (const file of blocked.conflict_files) {
      const normalized = this.normalizePorcelainPath(file.path);
      if (!normalized || this.isNonRecoverableResiduePath(normalized)) {
        return false;
      }
      blockedPaths.add(normalized);
    }

    return livePaths.size === blockedPaths.size && [...livePaths].every((livePath) => blockedPaths.has(livePath));
  }

  private parseStatusPorcelain(output: string): Array<{ staged: string; unstaged: string; path: string }> {
    return output
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length >= 4)
      .map((line) => ({ staged: line[0] ?? ' ', unstaged: line[1] ?? ' ', path: line.slice(3).trim() }))
      .filter((entry) => entry.path.length > 0);
  }

  private normalizePorcelainPath(rawPath: string): string {
    const normalized = rawPath.replace(/\\/g, '/');
    const renameTarget = normalized.includes(' -> ') ? normalized.slice(normalized.lastIndexOf(' -> ') + 4) : normalized;
    return renameTarget.replace(/^"|"$/g, '');
  }

  private isNonRecoverableResiduePath(normalizedPath: string): boolean {
    return normalizedPath === '.symphony-provision.json' || normalizedPath.startsWith('output/playwright/');
  }

  private resolveGitDirSync(workspacePath: string): string | null {
    const dotGitPath = path.join(workspacePath, '.git');
    try {
      const stat = fs.statSync(dotGitPath);
      if (stat.isDirectory()) {
        return dotGitPath;
      }
      if (!stat.isFile()) {
        return null;
      }
      const content = fs.readFileSync(dotGitPath, 'utf8').trim();
      const match = /^gitdir:\s*(.+)$/i.exec(content);
      if (!match) {
        return null;
      }
      return path.resolve(workspacePath, match[1]);
    } catch {
      return null;
    }
  }

  updateCodexTimestamp(issue_id: string, timestampMs: number): void {
    const runningEntry = this.state.running.get(issue_id);
    if (!runningEntry) {
      return;
    }

    runningEntry.last_codex_timestamp_ms = timestampMs;
  }

  private async reconcileStalledRuns(): Promise<void> {
    const now = this.nowMs();
    const waitThresholdMs = this.config.running_wait_stall_threshold_ms ?? 300_000;

    for (const [issueId, runningEntry] of Array.from(this.state.running.entries())) {
      const elapsedMs = now - (runningEntry.last_codex_timestamp_ms ?? runningEntry.started_at_ms);
      if (waitThresholdMs > 0) {
        this.maybeEmitHeartbeatOnly(issueId, runningEntry, now);
        const handledAsBlocked = await this.maybeClassifyRunningWaitStall(issueId, runningEntry, now);
        if (handledAsBlocked) {
          continue;
        }
      }
      if (runningEntry.last_event && this.shouldResetRunningWaitEpisode(runningEntry.last_event)) {
        runningEntry.running_waiting_started_at_ms = null;
        runningEntry.running_wait_stall_event_emitted = false;
        runningEntry.heartbeat_only_event_emitted = false;
        runningEntry.stalled_waiting_since_ms = null;
        runningEntry.stalled_waiting_reason = null;
      }
      if (this.config.stall_timeout_ms > 0 && elapsedMs > this.config.stall_timeout_ms) {
        const terminationResult = await this.ports.terminateWorker({
          issue_id: issueId,
          worker_handle: runningEntry.worker_handle,
          cleanup_workspace: false,
          reason: 'stall_timeout'
        });

        this.addRuntimeSecondsFromEntry(runningEntry);
        this.state.running.delete(issueId);

        const stalledDetail = workerTerminationResultDetail('worker stalled', terminationResult);
        await this.completeRunRecord(runningEntry, 'stalled', REASON_CODES.workerStalled, null, stalledDetail);

        await this.scheduleRetry({
          issue_id: issueId,
          identifier: runningEntry.identifier,
          attempt: runningEntry.retry_attempt + 1,
          issue_run_id: runningEntry.issue_run_id ?? null,
          previous_attempt_id: runningEntry.attempt_id ?? null,
          delay_type: 'failure',
          error: 'worker stalled',
          worker_host: runningEntry.worker_host ?? null,
          workspace_path: runningEntry.workspace_path ?? null,
          provisioner_type: runningEntry.provisioner_type ?? null,
          branch_name: runningEntry.branch_name ?? null,
          repo_root: runningEntry.repo_root ?? null,
          workspace_exists: runningEntry.workspace_exists,
          workspace_git_status: runningEntry.workspace_git_status,
          workspace_provisioned: runningEntry.workspace_provisioned,
          workspace_is_git_worktree: runningEntry.workspace_is_git_worktree,
          copy_ignored_applied: runningEntry.copy_ignored_applied,
          copy_ignored_status: runningEntry.copy_ignored_status,
          copy_ignored_summary: runningEntry.copy_ignored_summary,
          stop_reason_code: REASON_CODES.workerStalled,
          stop_reason_detail: stalledDetail,
          previous_thread_id: runningEntry.thread_id,
          previous_turn_id: runningEntry.turn_id,
          previous_session_id: runningEntry.session_id,
          last_progress_checkpoint_at: runningEntry.last_progress_transition_at_ms ?? runningEntry.started_at_ms,
          issue_snapshot: runningEntry.issue,
          progress_signals: runningEntry.progress_signals,
          recover_workspace_attempt_residue: true
        });
        this.state.health.last_error = `worker stalled for ${runningEntry.identifier}`;
        this.logger?.log({
          level: 'warn',
          event: CANONICAL_EVENT.orchestration.workerStalled,
          message: 'worker stalled; retrying',
          context: {
            issue_id: issueId,
            issue_identifier: runningEntry.identifier,
            session_id: runningEntry.session_id,
            elapsed_ms: elapsedMs,
            ...workerTerminationResultContext(terminationResult)
          }
        });
        this.recordRuntimeEvent({
          event: CANONICAL_EVENT.orchestration.workerStalled,
          severity: 'warn',
          issue_identifier: runningEntry.identifier,
          session_id: runningEntry.session_id ?? undefined,
          detail: stalledDetail
        });
        continue;
      }

      const handledAsOpaqueTimeout = await this.maybeTerminateOpaqueActivityHardTimeout(issueId, runningEntry, now);
      if (handledAsOpaqueTimeout) {
        continue;
      }
    }
  }

  private async dispatchIssue(
    issue: Issue,
    attempt: number | null,
    resume_context: string | null = null,
    graphContext: DispatchGraphContext = {}
  ): Promise<void> {
    if (this.state.running.has(issue.id) || this.state.claimed.has(issue.id)) {
      this.recordDuplicateDispatchSkipped(issue, attempt ?? 0);
      return;
    }

    this.state.claimed.add(issue.id);
    if (attempt === null || attempt === 0) {
      this.state.completed.delete(issue.id);
      this.state.phase_timeline?.set(issue.id, []);
    }
    this.emitPhaseMarker(issue.id, {
      phase: REASON_CODES.dispatchStarted,
      detail: 'dispatch attempt started',
      attempt: attempt ?? 0
    });
    this.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.orchestration.dispatchAttemptStarted,
      message: 'dispatch attempt started',
      context: {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        retry_attempt: attempt ?? 0
      }
    });
    const workerHost = this.selectWorkerHost();
    if ((this.config.worker_hosts?.length ?? 0) > 0 && !workerHost) {
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.orchestration.workerHostSlotsExhausted,
        message: 'dispatch blocked: no available worker host slots',
        context: {
          issue_id: issue.id,
          issue_identifier: issue.identifier
        }
      });
      this.recordRuntimeEvent({
        event: CANONICAL_EVENT.orchestration.workerHostSlotsExhausted,
        severity: 'warn',
        issue_identifier: issue.identifier,
        detail: 'no available worker host slots'
      });
      const retryGraphContext = await this.persistPreSpawnExecutionGraphAttempt({
        issue,
        attempt,
        graphContext,
        status: 'blocked',
        reasonCode: REASON_CODES.slotsExhausted,
        reasonDetail: 'no available worker host slots'
      });
      await this.scheduleRetry({
        issue_id: issue.id,
        identifier: issue.identifier,
        attempt: nextAttempt(attempt),
        issue_run_id: retryGraphContext.issue_run_id ?? null,
        previous_attempt_id: retryGraphContext.previous_attempt_id ?? null,
        delay_type: 'failure',
        error: 'no available worker host slots',
        worker_host: workerHost,
        workspace_path: null,
        provisioner_type: null,
        branch_name: null,
        repo_root: null,
        workspace_exists: false,
        workspace_git_status: null,
        workspace_provisioned: false,
        workspace_is_git_worktree: false,
        copy_ignored_applied: false,
        copy_ignored_status: null,
        copy_ignored_summary: null,
        stop_reason_code: REASON_CODES.slotsExhausted,
        stop_reason_detail: 'no available worker host slots',
        issue_snapshot: issue
      });
      return;
    }

    const spawned = await this.ports.spawnWorker({
      issue,
      attempt,
      worker_host: workerHost,
      resume_context,
      recover_workspace_attempt_residue: graphContext.recover_workspace_attempt_residue ?? false
    });

    if (!spawned.ok) {
      this.emitPhaseMarker(issue.id, {
        phase: 'failed',
        detail: spawned.error,
        attempt: attempt ?? 0
      });
      this.state.health.last_error = `failed to spawn agent for ${issue.identifier}`;
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.orchestration.dispatchSpawnFailed,
        message: 'dispatch failed; retrying',
        context: {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          retry_attempt: nextAttempt(attempt),
          error: spawned.error
        }
      });
      const retryGraphContext = await this.persistPreSpawnExecutionGraphAttempt({
        issue,
        attempt,
        graphContext,
        status: 'failed',
        reasonCode: REASON_CODES.spawnFailed,
        reasonDetail: spawned.error
      });
      await this.scheduleRetry({
        issue_id: issue.id,
        identifier: issue.identifier,
        attempt: nextAttempt(attempt),
        issue_run_id: retryGraphContext.issue_run_id ?? null,
        previous_attempt_id: retryGraphContext.previous_attempt_id ?? null,
        delay_type: 'failure',
        error: 'failed to spawn agent',
        worker_host: workerHost,
        workspace_path: null,
        provisioner_type: null,
        branch_name: null,
        repo_root: null,
        workspace_exists: false,
        workspace_git_status: null,
        workspace_provisioned: false,
        workspace_is_git_worktree: false,
        copy_ignored_applied: false,
        copy_ignored_status: null,
        copy_ignored_summary: null,
        stop_reason_code: REASON_CODES.spawnFailed,
        stop_reason_detail: spawned.error,
        issue_snapshot: issue
      });
      return;
    }
    this.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.orchestration.dispatchSpawnSucceeded,
      message: 'dispatch spawn succeeded',
      context: {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        worker_host: spawned.worker_host ?? workerHost ?? null
      }
    });

    const startedAtMs = this.nowMs();
    this.state.running.set(issue.id, {
      issue,
      identifier: issue.identifier,
      started_issue_state: issue.state,
      run_id: null,
      issue_run_id: graphContext.issue_run_id ?? null,
      attempt_id: null,
      worker_handle: spawned.worker_handle,
      worker_instance_id: spawned.worker_instance_id ?? this.workerInstanceIdFromHandle(spawned.worker_handle),
      monitor_handle: spawned.monitor_handle,
      retry_attempt: attempt ?? 0,
      workspace_path: spawned.workspace_path ?? null,
      worker_host: spawned.worker_host ?? workerHost ?? null,
      provisioner_type: spawned.provisioner_type ?? null,
      branch_name: spawned.branch_name ?? null,
      repo_root: spawned.repo_root ?? null,
      workspace_exists: spawned.workspace_exists ?? false,
      workspace_git_status: spawned.workspace_git_status ?? null,
      workspace_provisioned: spawned.workspace_provisioned ?? false,
      workspace_is_git_worktree: spawned.workspace_is_git_worktree ?? false,
      copy_ignored_applied: spawned.copy_ignored_applied ?? false,
      copy_ignored_status: spawned.copy_ignored_status ?? null,
      copy_ignored_summary: spawned.copy_ignored_summary ?? null,
      session_id: null,
      thread_id: null,
      turn_id: null,
      persisted_thread_id: null,
      persisted_turn_ids: [],
      codex_app_server_pid: null,
      turn_count: 0,
      last_event: null,
      last_event_summary: null,
      last_message: null,
      awaiting_input_since_ms: null,
      pending_input_preview: null,
      stalled_waiting_since_ms: null,
      stalled_waiting_reason: null,
      running_waiting_started_at_ms: null,
      last_progress_transition_at_ms: startedAtMs,
      last_heartbeat_at_ms: null,
      heartbeat_only_event_emitted: false,
      running_wait_stall_event_emitted: false,
      tokens: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0
      },
      last_reported_tokens: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0
      },
      token_telemetry_status: 'unavailable',
      token_telemetry_last_source: null,
      token_telemetry_last_at_ms: null,
      token_telemetry_turn_started_at_ms: null,
      token_telemetry_warning_emitted: false,
      rate_limits: null,
      protocol_warnings: [],
      model_reroute: null,
      requested_model: null,
      effective_model: null,
      budget_warning_emitted: false,
      budget_hard_limit_enforced: false,
      budget: this.computeBudgetProjection(issue.id, 0, 'unavailable'),
      recent_events: [],
      quarantined_events: [],
      quarantined_event_count: 0,
      last_quarantined_event_at_ms: null,
      ownership_conflict: null,
      started_at_ms: startedAtMs,
      last_codex_timestamp_ms: null,
      codex_thread_activity_at_ms: null,
      codex_thread_activity_source: null,
      codex_thread_activity_status: null,
      current_phase: null,
      current_phase_at_ms: null,
      phase_detail: null,
      tool_call_ledger: {},
      outstanding_tool_calls: {},
      transcript_tool_call_diagnostics: [],
      codex_session_transcript_scan_offsets: {},
      recovery: null,
      termination: null
    });
    this.emitPhaseMarker(issue.id, {
      phase: 'workspace_ready',
      detail: 'workspace ready and worker spawned',
      attempt: attempt ?? 0
    });

    const runningEntry = this.state.running.get(issue.id);
    if (runningEntry && this.persistence) {
      try {
        const startedAt = asIso(runningEntry.started_at_ms);
        if (!graphContext.issue_run_id && this.persistence.recordRunStarted) {
          const started = await this.persistence.recordRunStarted({
            issue_id: issue.id,
            issue_identifier: issue.identifier,
            started_at: startedAt,
            status: 'running',
            reason_code: REASON_CODES.dispatchStarted,
            reason_detail: 'dispatch attempt started',
            attempt_number: runningEntry.retry_attempt
          });
          runningEntry.run_id = started.run_id;
          runningEntry.issue_run_id = started.issue_run_id;
          runningEntry.attempt_id = started.attempt_id;
        } else {
          runningEntry.run_id = await this.persistence.startRun({
            issue_id: issue.id,
            issue_identifier: issue.identifier
          });
          runningEntry.issue_run_id =
            graphContext.issue_run_id ??
            (await this.persistence.appendIssueRun?.({
              issue_id: issue.id,
              issue_identifier: issue.identifier,
              started_at: startedAt,
              status: 'running',
              reason_code: REASON_CODES.dispatchStarted,
              reason_detail: 'dispatch attempt started'
            })) ??
            null;
          if (runningEntry.issue_run_id) {
            runningEntry.attempt_id =
              (await this.persistence.appendAttempt?.({
                issue_run_id: runningEntry.issue_run_id,
                attempt_number: runningEntry.retry_attempt,
                started_at: startedAt,
                status: 'running',
                reason_code: REASON_CODES.attemptStarted,
                reason_detail: 'worker spawned'
              })) ?? null;
            await this.persistence.appendStateTransition?.({
              issue_run_id: runningEntry.issue_run_id,
              attempt_id: runningEntry.attempt_id,
              from_status: null,
              to_status: 'running',
              transitioned_at: startedAt,
              status: 'running',
              reason_code: REASON_CODES.dispatchStarted,
              reason_detail: 'dispatch attempt started'
            });
          }
        }
        await this.persistOperationalFactsForIssue(issue, runningEntry, startedAt);
      } catch (error) {
        await this.recordHistoryWriteFailure('recordRunStarted', REASON_CODES.dispatchStarted, error);
        this.logger?.log({
          level: 'warn',
          event: CANONICAL_EVENT.persistence.startRunFailed,
          message: `failed to start durable run record for ${issue.identifier}`,
          context: {
            issue_id: issue.id,
            issue_identifier: issue.identifier
          }
        });
      }
    }
    const existingRetry = this.state.retry_attempts.get(issue.id);
    if (existingRetry) {
      this.ports.cancelRetryTimer(existingRetry.timer_handle);
      this.state.retry_attempts.delete(issue.id);
    }
  }

  private recordDuplicateDispatchSkipped(issue: Issue, retryAttempt: number): void {
    const runningEntry = this.state.running.get(issue.id);
    if (runningEntry) {
      const waitThresholdMs = this.config.progress_stalled_waiting_ms ?? this.config.running_wait_stall_threshold_ms ?? 300_000;
      const waitingStartedAtMs = runningEntry.running_waiting_started_at_ms ?? null;
      const lastMeaningfulActivityAtMs =
        waitingStartedAtMs !== null &&
        typeof runningEntry.last_progress_transition_at_ms === 'number' &&
        runningEntry.last_progress_transition_at_ms > waitingStartedAtMs
          ? runningEntry.last_progress_transition_at_ms
          : waitingStartedAtMs;
      if (
        runningEntry.stalled_waiting_reason === REASON_CODES.turnWaitingThresholdExceeded ||
        (waitThresholdMs > 0 &&
          lastMeaningfulActivityAtMs !== null &&
          this.nowMs() >= lastMeaningfulActivityAtMs + waitThresholdMs)
      ) {
        void this.maybeClassifyRunningWaitStall(issue.id, runningEntry, this.nowMs());
        return;
      }
    }
    const retryEntry = this.state.retry_attempts.get(issue.id);
    if (retryEntry?.stop_reason_code === REASON_CODES.turnWaitingThresholdExceeded) {
      return;
    }

    this.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.orchestration.dispatchDuplicateSkipped,
      message: 'dispatch skipped: issue already has active runtime ownership',
      context: {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        retry_attempt: retryAttempt,
        runtime_state: JSON.stringify(this.describeIssueRuntimeState(issue.id))
      }
    });
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.orchestration.dispatchDuplicateSkipped,
      severity: 'warn',
      issue_identifier: issue.identifier,
      detail: 'issue already has active runtime ownership'
    });
  }

  private async terminateRunningIssue(issue_id: string, cleanup_workspace: boolean, reason: string): Promise<void> {
    const runningEntry = this.state.running.get(issue_id);
    if (!runningEntry) {
      return;
    }

    const requestedAtMs = this.nowMs();
    runningEntry.termination = {
      state: 'requested',
      reason,
      cleanup_workspace,
      requested_at_ms: requestedAtMs,
      worker_handle: runningEntry.worker_handle,
      worker_instance_id: runningEntry.worker_instance_id ?? null,
      codex_app_server_pid: runningEntry.codex_app_server_pid ?? null,
      thread_id: runningEntry.thread_id ?? null,
      turn_id: runningEntry.turn_id ?? null,
      session_id: runningEntry.session_id ?? null
    };

    this.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.orchestration.workerTerminated,
      message: `worker termination requested: ${reason}`,
      context: {
        issue_id,
        issue_identifier: runningEntry.identifier,
        session_id: runningEntry.session_id,
        cleanup_workspace,
        reason,
        termination_state: 'requested',
        worker_instance_id: runningEntry.worker_instance_id ?? null,
        worker_process_identity_known: Boolean(runningEntry.codex_app_server_pid),
        codex_app_server_pid: runningEntry.codex_app_server_pid,
        thread_id: runningEntry.thread_id,
        turn_id: runningEntry.turn_id
      }
    });

    let terminationResult: WorkerTerminationResult | null = null;
    try {
      terminationResult = await this.ports.terminateWorker({
        issue_id,
        worker_handle: runningEntry.worker_handle,
        cleanup_workspace,
        reason
      });
    } catch (error) {
      const failureDetail = error instanceof Error ? error.message : String(error);
      if (this.state.running.get(issue_id) === runningEntry) {
        runningEntry.termination = {
          ...runningEntry.termination,
          state: 'failed',
          failure_at_ms: this.nowMs(),
          failure_detail: failureDetail
        };
        this.state.health.last_error = `worker termination failed for ${runningEntry.identifier}: ${failureDetail}`;
      }
      this.logger?.log({
        level: 'error',
        event: CANONICAL_EVENT.orchestration.workerTerminated,
        message: `worker termination failed: ${reason}`,
        context: {
          issue_id,
          issue_identifier: runningEntry.identifier,
          session_id: runningEntry.session_id,
          cleanup_workspace,
          reason,
          termination_state: 'failed',
          error: failureDetail,
          worker_instance_id: runningEntry.worker_instance_id ?? null,
          worker_process_identity_known: Boolean(runningEntry.codex_app_server_pid),
          codex_app_server_pid: runningEntry.codex_app_server_pid,
          thread_id: runningEntry.thread_id,
          turn_id: runningEntry.turn_id
        }
      });
      this.ports.notifyObservers?.();
      return;
    }

    if (this.state.running.get(issue_id) !== runningEntry) {
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.orchestration.workerTerminated,
        message: 'worker termination finalization skipped for superseded ownership',
        context: {
          issue_id,
          issue_identifier: runningEntry.identifier,
          session_id: runningEntry.session_id,
          cleanup_workspace,
          reason,
          termination_state: runningEntry.termination?.state ?? null,
          active_worker_instance_id: this.state.running.get(issue_id)?.worker_instance_id ?? null,
          released_worker_instance_id: runningEntry.worker_instance_id ?? null
        }
      });
      return;
    }

    runningEntry.termination = {
      ...runningEntry.termination,
      state: 'finalizing'
    };

    const finalizationDetail = workerTerminationResultDetail(`worker termination finalized: ${reason}`, terminationResult);
    this.addRuntimeSecondsFromEntry(runningEntry);
    await this.completeRunRecord(runningEntry, 'cancelled', reason, null, finalizationDetail);
    await this.persistExecutionGraphStateTransition(runningEntry, 'cancelled', 'cancelled', reason, finalizationDetail);
    this.rememberInactiveWorkerPid(runningEntry, reason);
    this.rememberReleasedWorker(runningEntry, reason, cleanup_workspace);
    this.state.running.delete(issue_id);
    this.state.claimed.delete(issue_id);
    this.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.orchestration.workerTerminated,
      message: `worker termination finalized: ${reason}`,
      context: {
        issue_id,
        issue_identifier: runningEntry.identifier,
        session_id: runningEntry.session_id,
        cleanup_workspace,
        reason,
        termination_state: 'finalized',
        termination_exit_observed: Boolean(runningEntry.termination.exit_observed_at_ms),
        ...workerTerminationResultContext(terminationResult),
        worker_termination_requested: true,
        worker_process_identity_known: Boolean(runningEntry.codex_app_server_pid),
        codex_app_server_pid: runningEntry.codex_app_server_pid,
        same_issue_process_cleanup_verified: false
      }
    });

    const retry = this.state.retry_attempts.get(issue_id);
    if (retry) {
      this.ports.cancelRetryTimer(retry.timer_handle);
      this.state.retry_attempts.delete(issue_id);
    }
  }

  private async scheduleRetry(params: ScheduleRetryParams): Promise<void> {
    if (this.state.blocked_inputs.has(params.issue_id)) {
      this.state.blocked_inputs.delete(params.issue_id);
    }

    const existing = this.state.retry_attempts.get(params.issue_id);
    if (existing) {
      this.ports.cancelRetryTimer(existing.timer_handle);
      this.state.retry_attempts.delete(params.issue_id);
    }

    const delayMs =
      params.delay_ms ??
      (params.delay_type === 'continuation'
        ? 1000
        : params.delay_type === 'backpressure'
          ? this.getBackpressureRetryDelayMs()
          : computeFailureBackoffMs(params.attempt, this.config.max_retry_backoff_ms));

    const dueAtMs = this.nowMs() + delayMs;

    const timerHandle = this.ports.scheduleRetryTimer({
      issue_id: params.issue_id,
      due_at_ms: dueAtMs,
      callback: async () => {
        await this.onRetryTimer(params.issue_id);
      }
    });

    const resolvedProgressSignals = await this.captureProgressSignals({
      issue: params.issue_snapshot ?? null,
      issue_id: params.issue_id,
      branch_name: params.branch_name ?? null,
      repo_root: params.repo_root ?? null,
      previous_progress_signals: params.progress_signals ?? null
    });
    this.state.retry_attempts.set(params.issue_id, {
      issue_id: params.issue_id,
      identifier: params.identifier,
      attempt: params.attempt,
      issue_run_id: params.issue_run_id ?? null,
      previous_attempt_id: params.previous_attempt_id ?? null,
      due_at_ms: dueAtMs,
      error: params.error ?? null,
      worker_host: params.worker_host ?? null,
      workspace_path: params.workspace_path ?? null,
      provisioner_type: params.provisioner_type ?? null,
      branch_name: params.branch_name ?? null,
      repo_root: params.repo_root ?? null,
      workspace_exists: params.workspace_exists ?? false,
      workspace_git_status: params.workspace_git_status ?? null,
      workspace_provisioned: params.workspace_provisioned ?? false,
      workspace_is_git_worktree: params.workspace_is_git_worktree ?? false,
      copy_ignored_applied: params.copy_ignored_applied ?? false,
      copy_ignored_status: params.copy_ignored_status ?? null,
      copy_ignored_summary: params.copy_ignored_summary ?? null,
      stop_reason_code: params.stop_reason_code ?? null,
      stop_reason_detail: params.stop_reason_detail ?? null,
      previous_thread_id: params.previous_thread_id ?? null,
      previous_turn_id: params.previous_turn_id ?? null,
      previous_session_id: params.previous_session_id ?? null,
      last_progress_checkpoint_at: params.last_progress_checkpoint_at ?? null,
      last_phase: this.getLastPhaseMarker(params.issue_id)?.phase ?? null,
      last_phase_at_ms: this.getLastPhaseMarker(params.issue_id)?.at_ms ?? null,
      last_phase_detail: this.getLastPhaseMarker(params.issue_id)?.detail ?? null,
      progress_signals: resolvedProgressSignals,
      recover_workspace_attempt_residue: params.recover_workspace_attempt_residue ?? false,
      budget: params.budget ? { ...params.budget } : undefined,
      recovery: params.recovery ? { ...params.recovery } : null,
      timer_handle: timerHandle
    });

    this.state.claimed.add(params.issue_id);
    this.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.orchestration.retryScheduled,
      message: `retry scheduled (${params.delay_type})`,
      context: {
        issue_id: params.issue_id,
        issue_identifier: params.identifier,
        attempt: params.attempt,
        delay_type: params.delay_type,
        due_at_ms: dueAtMs,
        error: params.error ?? null,
        stop_reason_code: params.stop_reason_code ?? null
      }
    });
  }

  private workspaceAttemptResidueResumeContext(retryEntry: RetryEntry): string | null {
    if (!retryEntry.recover_workspace_attempt_residue) {
      return null;
    }
    return [
      'Workspace attempt residue recovery:',
      '- The previous attempt left dirty files in this managed issue workspace.',
      '- Continue from the current workspace state instead of restarting.',
      '- First inspect `git status --short` and `git diff` / untracked files.',
      '- Run the ticket-required validation before committing.',
      '- Commit/push only if the dirty workspace matches the ticket scope; otherwise report the blocker.'
    ].join('\n');
  }

  private async scheduleBlockedInput(params: {
    issue_id: string;
    issue_identifier: string;
    attempt: number;
    issue_run_id?: string | null;
    previous_attempt_id?: string | null;
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
    conflict_files?: Array<{
      path: string;
      status: 'staged' | 'unstaged' | 'unknown';
      classification?: 'ephemeral' | 'tracked_ephemeral' | 'unknown_non_ephemeral';
    }>;
    classification_summary?: {
      ephemeral: number;
      tracked_ephemeral: number;
      unknown_non_ephemeral: number;
    };
    resolution_hints?: string[];
    pending_input?: {
      detail: string;
      request_id: string | null;
      request_method: string | null;
      prompt_text: string | null;
      questions: Array<{ id: string; prompt?: string; options?: Array<{ label: string; value?: string }> }>;
    } | null;
    tool_output_wait?: BlockedEntry['tool_output_wait'];
    transcript_tool_call_diagnostics?: BlockedEntry['transcript_tool_call_diagnostics'];
    recovery?: BlockedEntry['recovery'];
    session_console?: Array<{ at_ms: number; event: string; message: string | null }>;
    previous_thread_id: string | null;
    previous_turn_id?: string | null;
    previous_session_id: string | null;
    attempt_count_window?: number;
    window_minutes?: number;
    last_known_commit_sha?: string | null;
    last_progress_checkpoint_at?: number | null;
    progress_signals?: ProgressSignals;
    required_actions?: string[];
    apply_circuit_breaker?: boolean;
    budget?: BudgetRuntimeProjection;
  }): Promise<{ created: boolean }> {
    const existingRetry = this.state.retry_attempts.get(params.issue_id);
    if (existingRetry) {
      this.ports.cancelRetryTimer(existingRetry.timer_handle);
      this.state.retry_attempts.delete(params.issue_id);
    }

    const existingBlocked = this.state.blocked_inputs.get(params.issue_id);
    if (existingBlocked && existingBlocked.stop_reason_code === params.stop_reason_code && existingBlocked.requires_manual_resume) {
      return { created: false };
    }

    const blockedEntry: BlockedEntry = {
      issue_id: params.issue_id,
      issue_identifier: params.issue_identifier,
      attempt: params.attempt,
      issue_run_id: params.issue_run_id ?? null,
      previous_attempt_id: params.previous_attempt_id ?? null,
      worker_host: params.worker_host,
      workspace_path: params.workspace_path,
      provisioner_type: params.provisioner_type,
      branch_name: params.branch_name,
      repo_root: params.repo_root,
      workspace_exists: params.workspace_exists,
      workspace_git_status: params.workspace_git_status,
      workspace_provisioned: params.workspace_provisioned,
      workspace_is_git_worktree: params.workspace_is_git_worktree,
      copy_ignored_applied: params.copy_ignored_applied ?? false,
      copy_ignored_status: params.copy_ignored_status ?? null,
      copy_ignored_summary: params.copy_ignored_summary ?? null,
      stop_reason_code: params.stop_reason_code,
      stop_reason_detail: params.stop_reason_detail,
      conflict_files: (params.conflict_files ?? []).map((file) => ({ ...file })),
      classification_summary: params.classification_summary ? { ...params.classification_summary } : undefined,
      resolution_hints: [...(params.resolution_hints ?? [])],
      previous_thread_id: params.previous_thread_id,
      previous_turn_id: params.previous_turn_id ?? null,
      previous_session_id: params.previous_session_id,
      last_phase: this.getLastPhaseMarker(params.issue_id)?.phase ?? null,
      last_phase_at_ms: this.getLastPhaseMarker(params.issue_id)?.at_ms ?? null,
      last_phase_detail: this.getLastPhaseMarker(params.issue_id)?.detail ?? null,
      blocked_at_ms: this.nowMs(),
      requires_manual_resume: true,
      awaiting_operator: true,
      awaiting_operator_reason_code: params.stop_reason_code,
      awaiting_operator_since_ms: this.nowMs(),
      awaiting_operator_resume_nonce: (existingBlocked?.awaiting_operator_resume_nonce ?? 0) + 1,
      attempt_count_window: params.attempt_count_window,
      window_minutes: params.window_minutes,
      last_known_commit_sha: params.last_known_commit_sha ?? null,
      last_progress_checkpoint_at: params.last_progress_checkpoint_at ?? null,
      progress_signals: params.progress_signals
        ? {
            commit_sha: params.progress_signals.commit_sha ?? null,
            checklist_checkpoint: params.progress_signals.checklist_checkpoint ?? null,
            state_marker: params.progress_signals.state_marker ?? null,
            tracker_comment_created: params.progress_signals.tracker_comment_created ?? false,
            tracker_status_transition: params.progress_signals.tracker_status_transition ?? null,
            agent_review_handoff: params.progress_signals.agent_review_handoff ?? null,
            tracker_started_state: params.progress_signals.tracker_started_state ?? null
          }
        : undefined,
      required_actions: [...(params.required_actions ?? [])],
      resume_override_reason: null,
      budget: params.budget ? { ...params.budget } : undefined,
      pending_input: params.pending_input
        ? {
            request_id: params.pending_input.request_id,
            request_method: params.pending_input.request_method,
            prompt_text: params.pending_input.prompt_text,
            questions: params.pending_input.questions,
            input_schema_type: this.inferInputSchemaType(params.pending_input.questions),
            input_required_at_ms: this.nowMs()
          }
        : null,
      last_input_submit: null,
      resume_history: [],
      tool_output_wait: params.tool_output_wait
        ? {
            ...params.tool_output_wait,
            recommended_actions: [...params.tool_output_wait.recommended_actions]
          }
        : null,
      transcript_tool_call_diagnostics: (params.transcript_tool_call_diagnostics ?? []).map((diagnostic) => ({ ...diagnostic })),
      recovery: params.recovery ? { ...params.recovery } : null,
      session_console: (params.session_console ?? []).slice(-40),
      quarantined_events: [],
      quarantined_event_count: 0,
      last_quarantined_event_at_ms: null
    };
    this.state.blocked_inputs.set(params.issue_id, blockedEntry);
    this.state.claimed.add(params.issue_id);

    if (params.apply_circuit_breaker) {
      await this.upsertCircuitBreaker({
        issue_id: params.issue_id,
        issue_identifier: params.issue_identifier,
        breaker_active: true,
        breaker_hit_count: Math.max(1, params.attempt_count_window ?? 1),
        breaker_window_minutes: Math.max(1, params.window_minutes ?? this.config.respawn_window_minutes ?? 30),
        breaker_first_hit_at_ms: blockedEntry.blocked_at_ms,
        breaker_last_hit_at_ms: blockedEntry.blocked_at_ms
      });
    }

    void this.persistence?.upsertBlockedInput?.(params.issue_id, JSON.stringify(blockedEntry));
    void this.persistTicketBlocker(blockedEntry);
    void this.persistBlockedInputEvent(blockedEntry);

    this.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.orchestration.blockedInputScheduled,
      message: 'issue blocked: operator input required',
      context: {
        issue_id: params.issue_id,
        issue_identifier: params.issue_identifier,
        stop_reason_code: params.stop_reason_code,
        request_id: params.pending_input?.request_id ?? null,
        previous_thread_id: params.previous_thread_id,
        previous_session_id: params.previous_session_id
      }
    });
    return { created: true };
  }

  private clearBlockedInput(issue_id: string, reason: string): void {
    const blocked = this.state.blocked_inputs.get(issue_id);
    if (!blocked) {
      return;
    }

    this.state.blocked_inputs.delete(issue_id);
    this.state.claimed.delete(issue_id);
    void this.persistence?.deleteBlockedInput?.(issue_id);
    this.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.orchestration.blockedInputCleared,
      message: 'blocked issue cleared',
      context: {
        issue_id,
        issue_identifier: blocked.issue_identifier,
        reason
      }
    });
  }

  private async persistTicketBlocker(blockedEntry: BlockedEntry): Promise<void> {
    if (!this.persistence?.appendTicketBlocker || !blockedEntry.issue_run_id) {
      return;
    }

    try {
      await this.persistence.appendTicketBlocker({
        issue_run_id: blockedEntry.issue_run_id,
        attempt_id: blockedEntry.previous_attempt_id ?? null,
        thread_id: blockedEntry.previous_thread_id ?? null,
        turn_id: blockedEntry.previous_turn_id ?? null,
        blocker_type: this.ticketBlockerTypeForBlockedEntry(blockedEntry),
        status: 'active',
        reason_code: blockedEntry.stop_reason_code,
        reason_detail: blockedEntry.stop_reason_detail,
        blocked_at: asIso(blockedEntry.blocked_at_ms)
      });
    } catch (error) {
      await this.recordHistoryWriteFailure('appendTicketBlocker', blockedEntry.stop_reason_code, error);
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.persistence.recordEventFailed,
        message: `failed to persist ticket blocker for ${blockedEntry.issue_identifier}`,
        context: {
          issue_id: blockedEntry.issue_id,
          issue_identifier: blockedEntry.issue_identifier,
          issue_run_id: blockedEntry.issue_run_id,
          previous_attempt_id: blockedEntry.previous_attempt_id ?? null,
          reason_code: blockedEntry.stop_reason_code,
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  private async persistBlockedInputEvent(blockedEntry: BlockedEntry): Promise<void> {
    if (!this.persistence?.appendBlockedInputEvent || !blockedEntry.issue_run_id) {
      return;
    }

    try {
      await this.persistence.appendBlockedInputEvent({
        issue_run_id: blockedEntry.issue_run_id,
        attempt_id: blockedEntry.previous_attempt_id ?? null,
        thread_id: blockedEntry.previous_thread_id ?? null,
        turn_id: blockedEntry.previous_turn_id ?? null,
        issue_id: blockedEntry.issue_id,
        issue_identifier: blockedEntry.issue_identifier,
        phase: blockedEntry.last_phase,
        runtime_state: 'blocked',
        reason_code: blockedEntry.stop_reason_code,
        reason_detail: blockedEntry.stop_reason_detail,
        request_id: blockedEntry.pending_input?.request_id ?? null,
        request_method: blockedEntry.pending_input?.request_method ?? null,
        input_schema_type: blockedEntry.pending_input?.input_schema_type ?? null,
        prompt_text: blockedEntry.pending_input?.prompt_text ?? null,
        pending_input: blockedEntry.pending_input
          ? {
              request_id: blockedEntry.pending_input.request_id,
              request_method: blockedEntry.pending_input.request_method,
              prompt_text: blockedEntry.pending_input.prompt_text,
              input_schema_type: blockedEntry.pending_input.input_schema_type,
              questions: blockedEntry.pending_input.questions
            }
          : null,
        state_context: {
          previous_session_id: blockedEntry.previous_session_id,
          previous_turn_id: blockedEntry.previous_turn_id ?? null,
          worker_host: blockedEntry.worker_host,
          workspace_path: blockedEntry.workspace_path,
          branch_name: blockedEntry.branch_name,
          last_phase_at_ms: blockedEntry.last_phase_at_ms,
          last_phase_detail: blockedEntry.last_phase_detail,
          tool_output_wait: blockedEntry.tool_output_wait,
          conflict_files: blockedEntry.conflict_files,
          budget: blockedEntry.budget ?? null,
          recovery: blockedEntry.recovery,
          required_actions: blockedEntry.required_actions,
          progress_signals: blockedEntry.progress_signals ?? null
        },
        blocked_at: asIso(blockedEntry.blocked_at_ms)
      });
    } catch (error) {
      await this.recordHistoryWriteFailure('appendBlockedInputEvent', blockedEntry.stop_reason_code, error);
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.persistence.recordEventFailed,
        message: `failed to persist blocked input event for ${blockedEntry.issue_identifier}`,
        context: {
          issue_id: blockedEntry.issue_id,
          issue_identifier: blockedEntry.issue_identifier,
          issue_run_id: blockedEntry.issue_run_id,
          previous_attempt_id: blockedEntry.previous_attempt_id ?? null,
          reason_code: blockedEntry.stop_reason_code,
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  private ticketBlockerTypeForBlockedEntry(blockedEntry: BlockedEntry): string {
    if (blockedEntry.pending_input) {
      return 'operator_input';
    }
    if (blockedEntry.tool_output_wait) {
      return REASON_CODES.missingToolOutput;
    }
    if (blockedEntry.conflict_files.length > 0) {
      return 'workspace_conflict';
    }
    if (blockedEntry.budget?.budget_status === 'hard_limited') {
      return 'budget_limit';
    }
    return 'orchestration_blocker';
  }

  private resolveBacklogStateName(): string {
    const candidates = this.config.active_states ?? [];
    const backlog = candidates.find((entry) => entry.trim().toLowerCase() === 'backlog');
    if (backlog) {
      return backlog;
    }
    const todo = candidates.find((entry) => entry.trim().toLowerCase() === 'todo');
    if (todo) {
      return todo;
    }
    return 'Todo';
  }

  private async captureProgressSignals(params: {
    issue: Issue | null;
    issue_id: string;
    branch_name: string | null;
    repo_root: string | null;
    previous_progress_signals?: ProgressSignals | null;
  }): Promise<ProgressSignals> {
    const fallbackStateMarker = this.getLastPhaseMarker(params.issue_id)?.phase ?? null;
    if (!this.ports.resolveProgressSignals) {
      return {
        commit_sha: params.previous_progress_signals?.commit_sha ?? null,
        checklist_checkpoint: params.previous_progress_signals?.checklist_checkpoint ?? null,
        state_marker: params.previous_progress_signals?.state_marker ?? fallbackStateMarker,
        tracker_comment_created: params.previous_progress_signals?.tracker_comment_created ?? false,
        tracker_status_transition: params.previous_progress_signals?.tracker_status_transition ?? null,
        agent_review_handoff: params.previous_progress_signals?.agent_review_handoff ?? null,
        tracker_started_state: params.previous_progress_signals?.tracker_started_state ?? null
      };
    }

    try {
      const resolved = await this.ports.resolveProgressSignals({
        issue: params.issue,
        issue_id: params.issue_id,
        branch_name: params.branch_name,
        repo_root: params.repo_root,
        fallback_state_marker: fallbackStateMarker,
        previous_progress_signals: params.previous_progress_signals ?? null
      });
      return {
        commit_sha: resolved.commit_sha ?? params.previous_progress_signals?.commit_sha ?? null,
        checklist_checkpoint: resolved.checklist_checkpoint ?? params.previous_progress_signals?.checklist_checkpoint ?? null,
        state_marker: resolved.state_marker ?? params.previous_progress_signals?.state_marker ?? fallbackStateMarker,
        tracker_comment_created:
          resolved.tracker_comment_created ?? params.previous_progress_signals?.tracker_comment_created ?? false,
        tracker_status_transition:
          resolved.tracker_status_transition ?? params.previous_progress_signals?.tracker_status_transition ?? null,
        agent_review_handoff: resolved.agent_review_handoff ?? params.previous_progress_signals?.agent_review_handoff ?? null,
        tracker_started_state: resolved.tracker_started_state ?? params.previous_progress_signals?.tracker_started_state ?? null
      };
    } catch {
      return {
        commit_sha: params.previous_progress_signals?.commit_sha ?? null,
        checklist_checkpoint: params.previous_progress_signals?.checklist_checkpoint ?? null,
        state_marker: params.previous_progress_signals?.state_marker ?? fallbackStateMarker,
        tracker_comment_created: params.previous_progress_signals?.tracker_comment_created ?? false,
        tracker_status_transition: params.previous_progress_signals?.tracker_status_transition ?? null,
        agent_review_handoff: params.previous_progress_signals?.agent_review_handoff ?? null,
        tracker_started_state: params.previous_progress_signals?.tracker_started_state ?? null
      };
    }
  }

  async cancelCurrentTurn(
    issue_identifier: string,
    params: { actor?: string | null; reason_note?: string | null; confirmed?: boolean | null } = {}
  ): Promise<{ ok: true; issue_id: string } | { ok: false; code: string; message: string }> {
    const reasonNote = normalizeOperatorReasonNote(params.reason_note);
    if (!reasonNote) {
      return reasonNoteRequiredFailure();
    }
    const running = Array.from(this.state.running.values()).find((entry) => entry.identifier === issue_identifier);
    if (!running) {
      return { ok: false, code: 'unsupported_transition', message: `Issue ${issue_identifier} has no running turn to cancel` };
    }
    const preState = this.describeIssueRuntimeState(running.issue.id);
    if (params.confirmed !== true) {
      this.recordOperatorAction(running.issue.id, {
        action: 'cancel',
        requested_at_ms: this.nowMs(),
        result: 'rejected',
        result_code: 'confirmation_required',
        message: 'Cancel current turn requires explicit confirmation',
        actor: params.actor ?? null,
        reason_note: reasonNote,
        pre_state: preState,
        post_state: this.describeIssueRuntimeState(running.issue.id)
      });
      return { ok: false, code: 'confirmation_required', message: 'Cancel current turn requires explicit confirmation' };
    }

    await this.terminateRunningIssue(running.issue.id, false, reasonNote);
    this.recordOperatorAction(running.issue.id, {
      action: 'cancel',
      requested_at_ms: this.nowMs(),
      result: 'accepted',
      result_code: 'current_turn_cancelled',
      message: 'current turn cancelled',
      actor: params.actor ?? null,
      reason_note: reasonNote,
      pre_state: preState,
      post_state: this.describeIssueRuntimeState(running.issue.id)
    });
    this.ports.notifyObservers?.();
    return { ok: true, issue_id: running.issue.id };
  }

  async requeueIssue(
    issue_identifier: string,
    params: { actor?: string | null; reason_note?: string | null; confirmed?: boolean | null } = {}
  ): Promise<{ ok: true; issue_id: string; retry_attempt: number } | { ok: false; code: string; message: string }> {
    const reasonNote = normalizeOperatorReasonNote(params.reason_note);
    if (!reasonNote) {
      return reasonNoteRequiredFailure();
    }
    const running = Array.from(this.state.running.values()).find((entry) => entry.identifier === issue_identifier);
    if (running) {
      const preState = this.describeIssueRuntimeState(running.issue.id);
      if (params.confirmed !== true) {
        this.recordOperatorAction(running.issue.id, {
          action: 'requeue',
          requested_at_ms: this.nowMs(),
          result: 'rejected',
          result_code: 'confirmation_required',
          message: 'Requeue from a running turn requires explicit confirmation',
          actor: params.actor ?? null,
          reason_note: reasonNote,
          pre_state: preState,
          post_state: this.describeIssueRuntimeState(running.issue.id)
        });
        return { ok: false, code: 'confirmation_required', message: 'Requeue from a running turn requires explicit confirmation' };
      }
      await this.terminateRunningIssue(running.issue.id, false, reasonNote);
      const retryAttempt = running.retry_attempt + 1;
      await this.scheduleRetry({
        issue_id: running.issue.id,
        identifier: running.identifier,
        attempt: retryAttempt,
        issue_run_id: running.issue_run_id ?? null,
        previous_attempt_id: running.attempt_id ?? null,
        delay_type: 'continuation',
        error: 'operator requeue requested',
        worker_host: running.worker_host ?? null,
        workspace_path: running.workspace_path,
        provisioner_type: running.provisioner_type,
        branch_name: running.branch_name,
        repo_root: running.repo_root,
        workspace_exists: running.workspace_exists,
        workspace_git_status: running.workspace_git_status,
        workspace_provisioned: running.workspace_provisioned,
        workspace_is_git_worktree: running.workspace_is_git_worktree,
        copy_ignored_applied: running.copy_ignored_applied,
        copy_ignored_status: running.copy_ignored_status,
        copy_ignored_summary: running.copy_ignored_summary,
        stop_reason_code: REASON_CODES.operatorRequeueRequested,
        stop_reason_detail: reasonNote,
        previous_thread_id: running.thread_id,
        previous_turn_id: running.turn_id,
        previous_session_id: running.session_id,
        issue_snapshot: running.issue,
        progress_signals: running.progress_signals
      });
      this.recordOperatorAction(running.issue.id, {
        action: 'requeue',
        requested_at_ms: this.nowMs(),
        result: 'accepted',
        result_code: 'requeue_scheduled',
        message: 'issue requeued',
        actor: params.actor ?? null,
        reason_note: reasonNote,
        pre_state: preState,
        post_state: this.describeIssueRuntimeState(running.issue.id)
      });
      this.ports.notifyObservers?.();
      return { ok: true, issue_id: running.issue.id, retry_attempt: retryAttempt };
    }

    const blocked = Array.from(this.state.blocked_inputs.values()).find((entry) => entry.issue_identifier === issue_identifier);
    if (blocked) {
      const preState = this.describeIssueRuntimeState(blocked.issue_id);
      const retryAttempt = blocked.attempt;
      await this.scheduleRetry({
        issue_id: blocked.issue_id,
        identifier: blocked.issue_identifier,
        attempt: retryAttempt,
        issue_run_id: blocked.issue_run_id,
        previous_attempt_id: blocked.previous_attempt_id,
        delay_type: 'continuation',
        error: 'operator requeue requested',
        worker_host: blocked.worker_host,
        workspace_path: blocked.workspace_path,
        provisioner_type: blocked.provisioner_type,
        branch_name: blocked.branch_name,
        repo_root: blocked.repo_root,
        workspace_exists: blocked.workspace_exists,
        workspace_git_status: blocked.workspace_git_status,
        workspace_provisioned: blocked.workspace_provisioned,
        workspace_is_git_worktree: blocked.workspace_is_git_worktree,
        copy_ignored_applied: blocked.copy_ignored_applied,
        copy_ignored_status: blocked.copy_ignored_status,
        copy_ignored_summary: blocked.copy_ignored_summary,
        stop_reason_code: REASON_CODES.operatorRequeueRequested,
        stop_reason_detail: reasonNote,
        previous_thread_id: blocked.previous_thread_id,
        previous_turn_id: blocked.previous_turn_id ?? null,
        previous_session_id: blocked.previous_session_id,
        issue_snapshot: null
      });
      await this.persistence?.deleteBlockedInput?.(blocked.issue_id);
      this.recordOperatorAction(blocked.issue_id, {
        action: 'requeue',
        requested_at_ms: this.nowMs(),
        result: 'accepted',
        result_code: 'requeue_scheduled',
        message: 'issue requeued',
        actor: params.actor ?? null,
        reason_note: reasonNote,
        pre_state: preState,
        post_state: this.describeIssueRuntimeState(blocked.issue_id)
      });
      this.ports.notifyObservers?.();
      return { ok: true, issue_id: blocked.issue_id, retry_attempt: retryAttempt };
    }

    const retry = Array.from(this.state.retry_attempts.values()).find((entry) => entry.identifier === issue_identifier);
    if (retry) {
      const preState = this.describeIssueRuntimeState(retry.issue_id);
      await this.scheduleRetry({
        issue_id: retry.issue_id,
        identifier: retry.identifier,
        attempt: retry.attempt,
        issue_run_id: retry.issue_run_id,
        previous_attempt_id: retry.previous_attempt_id,
        delay_type: 'continuation',
        error: 'operator requeue requested',
        worker_host: retry.worker_host,
        workspace_path: retry.workspace_path,
        provisioner_type: retry.provisioner_type,
        branch_name: retry.branch_name,
        repo_root: retry.repo_root,
        workspace_exists: retry.workspace_exists,
        workspace_git_status: retry.workspace_git_status,
        workspace_provisioned: retry.workspace_provisioned,
        workspace_is_git_worktree: retry.workspace_is_git_worktree,
        copy_ignored_applied: retry.copy_ignored_applied,
        copy_ignored_status: retry.copy_ignored_status,
        copy_ignored_summary: retry.copy_ignored_summary,
        stop_reason_code: REASON_CODES.operatorRequeueRequested,
        stop_reason_detail: reasonNote,
        previous_thread_id: retry.previous_thread_id,
        previous_turn_id: retry.previous_turn_id ?? null,
        previous_session_id: retry.previous_session_id,
        issue_snapshot: null
      });
      this.recordOperatorAction(retry.issue_id, {
        action: 'requeue',
        requested_at_ms: this.nowMs(),
        result: 'accepted',
        result_code: 'requeue_scheduled',
        message: 'issue requeued',
        actor: params.actor ?? null,
        reason_note: reasonNote,
        pre_state: preState,
        post_state: this.describeIssueRuntimeState(retry.issue_id)
      });
      this.ports.notifyObservers?.();
      return { ok: true, issue_id: retry.issue_id, retry_attempt: retry.attempt };
    }

    return { ok: false, code: 'unsupported_transition', message: `Issue ${issue_identifier} is not running, blocked, or retrying` };
  }

  async retryLastFailedStep(
    issue_identifier: string,
    params: { actor?: string | null; reason_note?: string | null } = {}
  ): Promise<{ ok: true; issue_id: string; retry_attempt: number } | { ok: false; code: string; message: string }> {
    const reasonNote = normalizeOperatorReasonNote(params.reason_note);
    if (!reasonNote) {
      return reasonNoteRequiredFailure();
    }
    const retry = Array.from(this.state.retry_attempts.values()).find((entry) => entry.identifier === issue_identifier);
    if (!retry) {
      return {
        ok: false,
        code: 'unsupported_transition',
        message: `Issue ${issue_identifier} has no failed or stalled retry step`
      };
    }
    const preState = this.describeIssueRuntimeState(retry.issue_id);
    await this.scheduleRetry({
      issue_id: retry.issue_id,
      identifier: retry.identifier,
      attempt: retry.attempt,
      issue_run_id: retry.issue_run_id,
      previous_attempt_id: retry.previous_attempt_id,
      delay_type: 'continuation',
      error: 'operator retry-step requested',
      worker_host: retry.worker_host,
      workspace_path: retry.workspace_path,
      provisioner_type: retry.provisioner_type,
      branch_name: retry.branch_name,
      repo_root: retry.repo_root,
      workspace_exists: retry.workspace_exists,
      workspace_git_status: retry.workspace_git_status,
      workspace_provisioned: retry.workspace_provisioned,
      workspace_is_git_worktree: retry.workspace_is_git_worktree,
      copy_ignored_applied: retry.copy_ignored_applied,
      copy_ignored_status: retry.copy_ignored_status,
      copy_ignored_summary: retry.copy_ignored_summary,
      stop_reason_code: REASON_CODES.operatorRetryStepRequested,
      stop_reason_detail: reasonNote,
      previous_thread_id: retry.previous_thread_id,
      previous_turn_id: retry.previous_turn_id ?? null,
      previous_session_id: retry.previous_session_id,
      issue_snapshot: null
    });
    this.recordOperatorAction(retry.issue_id, {
      action: 'retry_step',
      requested_at_ms: this.nowMs(),
      result: 'accepted',
      result_code: 'retry_step_scheduled',
      message: 'last failed or stalled step retry scheduled',
      actor: params.actor ?? null,
      reason_note: reasonNote,
      pre_state: preState,
      post_state: this.describeIssueRuntimeState(retry.issue_id)
    });
    this.ports.notifyObservers?.();
    return { ok: true, issue_id: retry.issue_id, retry_attempt: retry.attempt };
  }

  async resumeBlockedIssue(
    issue_identifier: string,
    resume_context: string | null = null,
    resume_override_reason: string | null = null,
    operator_context: { actor?: string | null; reason_note?: string | null } | null = null,
    resume_metadata?: {
      request_id: string;
      resume_mode: 'native' | 'fallback';
      resume_reason_code: string;
    }
  ): Promise<{ ok: true; issue_id: string } | { ok: false; code: string; message: string }> {
    const reasonNote = normalizeOperatorReasonNote(operator_context?.reason_note);
    if (!reasonNote) {
      return reasonNoteRequiredFailure();
    }
    const blocked = Array.from(this.state.blocked_inputs.values()).find((entry) => entry.issue_identifier === issue_identifier);
    if (!blocked) {
      return {
        ok: false,
        code: 'issue_not_blocked',
        message: `Issue ${issue_identifier} is not blocked`
      };
    }
    const preState = this.describeIssueRuntimeState(blocked.issue_id);

    let refreshedIssues: Issue[];
    try {
      refreshedIssues = await this.ports.tracker.fetch_issue_states_by_ids([blocked.issue_id]);
    } catch (error) {
      this.recordOperatorAction(blocked.issue_id, {
        action: 'resume',
        requested_at_ms: this.nowMs(),
        result: 'failed',
        result_code: 'resume_failed',
        message: error instanceof Error ? error.message : 'failed to refresh issue state',
        actor: operator_context?.actor ?? null,
        reason_note: reasonNote,
        pre_state: preState,
        post_state: this.describeIssueRuntimeState(blocked.issue_id)
      });
      return {
        ok: false,
        code: 'resume_failed',
        message: error instanceof Error ? error.message : 'failed to refresh issue state'
      };
    }

    const issue = refreshedIssues.find((entry) => entry.id === blocked.issue_id);
    if (!issue) {
      this.recordOperatorAction(blocked.issue_id, {
        action: 'resume',
        requested_at_ms: this.nowMs(),
        result: 'rejected',
        result_code: 'issue_not_found',
        message: `Issue ${issue_identifier} no longer exists in tracker`,
        actor: operator_context?.actor ?? null,
        reason_note: reasonNote,
        pre_state: preState
      });
      this.clearBlockedInput(blocked.issue_id, 'issue_not_found');
      return {
        ok: false,
        code: 'issue_not_found',
        message: `Issue ${issue_identifier} no longer exists in tracker`
      };
    }

    if (!isActiveState(issue.state, this.config)) {
      this.recordOperatorAction(blocked.issue_id, {
        action: 'resume',
        requested_at_ms: this.nowMs(),
        result: 'rejected',
        result_code: 'issue_not_active',
        message: `Issue ${issue_identifier} is no longer in an active state`,
        actor: operator_context?.actor ?? null,
        reason_note: reasonNote,
        pre_state: preState
      });
      this.clearBlockedInput(blocked.issue_id, 'issue_not_active');
      return {
        ok: false,
        code: 'issue_not_active',
        message: `Issue ${issue_identifier} is no longer in an active state`
      };
    }

    const currentSignals = await this.captureProgressSignals({
      issue,
      issue_id: blocked.issue_id,
      branch_name: blocked.branch_name,
      repo_root: blocked.repo_root
    });
    const hasProgressSignal =
      currentSignals.commit_sha !== (blocked.progress_signals?.commit_sha ?? null) ||
      currentSignals.checklist_checkpoint !== (blocked.progress_signals?.checklist_checkpoint ?? null) ||
      currentSignals.state_marker !== (blocked.progress_signals?.state_marker ?? null);
    const requiresProgressResume =
      blocked.stop_reason_code === REASON_CODES.operatorNoProgressRedispatchBlocked ||
      blocked.stop_reason_code === REASON_CODES.awaitingHumanReviewScopeIncomplete;
    if (requiresProgressResume && !hasProgressSignal && (!resume_override_reason || resume_override_reason.trim().length === 0)) {
      this.recordOperatorAction(blocked.issue_id, {
        action: 'resume',
        requested_at_ms: this.nowMs(),
        result: 'rejected',
        result_code: 'resume_failed',
        message: `Issue ${issue_identifier} requires progress or an explicit resume override reason`,
        actor: operator_context?.actor ?? null,
        reason_note: reasonNote,
        pre_state: preState,
        post_state: this.describeIssueRuntimeState(blocked.issue_id)
      });
      return {
        ok: false,
        code: 'resume_failed',
        message: `Issue ${issue_identifier} requires progress or an explicit resume override reason`
      };
    }
    blocked.resume_override_reason = resume_override_reason?.trim() || null;

    this.state.blocked_inputs.delete(blocked.issue_id);
    this.state.claimed.delete(blocked.issue_id);
    this.state.redispatch_progress?.delete(blocked.issue_id);
    await this.clearCircuitBreaker(blocked.issue_id);
    await this.persistence?.deleteBlockedInput?.(blocked.issue_id);

    const eligibility = shouldDispatchIssue(issue, this.state, this.config);
    if (eligibility.eligible) {
      await this.dispatchIssue(issue, blocked.attempt, resume_context, {
        issue_run_id: blocked.issue_run_id,
        previous_attempt_id: blocked.previous_attempt_id
      });
    } else if (eligibility.reason === 'global_slots_exhausted' || eligibility.reason === 'state_slots_exhausted') {
      await this.scheduleRetry({
        issue_id: blocked.issue_id,
        identifier: blocked.issue_identifier,
        attempt: blocked.attempt,
        issue_run_id: blocked.issue_run_id,
        previous_attempt_id: blocked.previous_attempt_id,
        delay_type: 'failure',
        error: 'no available orchestrator slots',
        worker_host: blocked.worker_host,
        workspace_path: blocked.workspace_path,
        provisioner_type: blocked.provisioner_type,
        branch_name: blocked.branch_name,
        repo_root: blocked.repo_root,
        workspace_exists: blocked.workspace_exists,
        workspace_git_status: blocked.workspace_git_status,
        workspace_provisioned: blocked.workspace_provisioned,
        workspace_is_git_worktree: blocked.workspace_is_git_worktree,
        copy_ignored_applied: blocked.copy_ignored_applied,
        copy_ignored_status: blocked.copy_ignored_status,
        copy_ignored_summary: blocked.copy_ignored_summary,
        stop_reason_code: REASON_CODES.slotsExhausted,
        stop_reason_detail: 'resume blocked by no available orchestrator slots',
        previous_thread_id: blocked.previous_thread_id,
        previous_turn_id: blocked.previous_turn_id ?? null,
        previous_session_id: blocked.previous_session_id,
        issue_snapshot: issue
      });
    } else {
      await this.scheduleRetry({
        issue_id: blocked.issue_id,
        identifier: blocked.issue_identifier,
        attempt: blocked.attempt,
        issue_run_id: blocked.issue_run_id,
        previous_attempt_id: blocked.previous_attempt_id,
        delay_type: 'continuation',
        error: null,
        worker_host: blocked.worker_host,
        workspace_path: blocked.workspace_path,
        provisioner_type: blocked.provisioner_type,
        branch_name: blocked.branch_name,
        repo_root: blocked.repo_root,
        workspace_exists: blocked.workspace_exists,
        workspace_git_status: blocked.workspace_git_status,
        workspace_provisioned: blocked.workspace_provisioned,
        workspace_is_git_worktree: blocked.workspace_is_git_worktree,
        copy_ignored_applied: blocked.copy_ignored_applied,
        copy_ignored_status: blocked.copy_ignored_status,
        copy_ignored_summary: blocked.copy_ignored_summary,
        stop_reason_code: REASON_CODES.manualResume,
        stop_reason_detail: 'manual resume requested',
        previous_thread_id: blocked.previous_thread_id,
        previous_turn_id: blocked.previous_turn_id ?? null,
        previous_session_id: blocked.previous_session_id,
        issue_snapshot: issue
      });
    }

    if (resume_metadata) {
      const submittedAtMs = this.nowMs();
      const record = {
        submitted_at_ms: submittedAtMs,
        request_id: resume_metadata.request_id,
        resume_mode: resume_metadata.resume_mode,
        resume_reason_code: resume_metadata.resume_reason_code,
        previous_thread_id: blocked.previous_thread_id ?? null,
        previous_session_id: blocked.previous_session_id ?? null
      };
      blocked.last_input_submit = {
        submitted_at_ms: submittedAtMs,
        request_id: resume_metadata.request_id,
        resume_mode: resume_metadata.resume_mode,
        resume_reason_code: resume_metadata.resume_reason_code
      };
      blocked.resume_history = [...(blocked.resume_history ?? []), record].slice(-20);
    }

    this.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.orchestration.blockedInputResumed,
      message: 'blocked issue resumed',
      context: {
        issue_id: blocked.issue_id,
        issue_identifier: blocked.issue_identifier,
        request_id: resume_metadata?.request_id ?? blocked.pending_input?.request_id ?? null,
        resume_mode: resume_metadata?.resume_mode ?? null,
        resume_reason_code: resume_metadata?.resume_reason_code ?? null,
        previous_thread_id: blocked.previous_thread_id,
        previous_session_id: blocked.previous_session_id
      }
    });

    this.recordOperatorAction(blocked.issue_id, {
      action: resume_metadata ? 'submit_input' : 'resume',
      requested_at_ms: this.nowMs(),
      result: 'accepted',
      result_code: resume_metadata?.resume_reason_code ?? 'resume_accepted',
      message: 'blocked issue resumed',
      actor: operator_context?.actor ?? null,
      reason_note: reasonNote,
      pre_state: preState,
      post_state: this.describeIssueRuntimeState(blocked.issue_id)
    });
    this.ports.notifyObservers?.();
    return {
      ok: true,
      issue_id: blocked.issue_id
    };
  }

  async cancelBlockedIssue(
    issue_identifier: string,
    cancel_reason: string | null = null,
    operator_context: { actor?: string | null; reason_note?: string | null; confirmed?: boolean | null } | null = null
  ): Promise<{ ok: true; issue_id: string; moved_to_state: string } | { ok: false; code: string; message: string }> {
    const reasonNote = normalizeOperatorReasonNote(operator_context?.reason_note ?? cancel_reason);
    if (!reasonNote) {
      return reasonNoteRequiredFailure();
    }
    const blocked = Array.from(this.state.blocked_inputs.values()).find((entry) => entry.issue_identifier === issue_identifier);
    if (!blocked) {
      return {
        ok: false,
        code: 'issue_not_blocked',
        message: `Issue ${issue_identifier} is not blocked`
      };
    }
    const preState = this.describeIssueRuntimeState(blocked.issue_id);
    if (operator_context?.confirmed !== true) {
      this.recordOperatorAction(blocked.issue_id, {
        action: 'cancel',
        requested_at_ms: this.nowMs(),
        result: 'rejected',
        result_code: 'confirmation_required',
        message: 'Cancel requires explicit confirmation',
        actor: operator_context?.actor ?? null,
        reason_note: reasonNote,
        pre_state: preState,
        post_state: this.describeIssueRuntimeState(blocked.issue_id)
      });
      return { ok: false, code: 'confirmation_required', message: 'Cancel requires explicit confirmation' };
    }

    const targetState = this.resolveBacklogStateName();
    try {
      await this.ports.tracker.update_issue_state(blocked.issue_id, targetState);
    } catch (error) {
      this.recordOperatorAction(blocked.issue_id, {
        action: 'cancel',
        requested_at_ms: this.nowMs(),
        result: 'failed',
        result_code: 'cancel_failed',
        message: error instanceof Error ? error.message : 'failed to move issue to backlog state',
        actor: operator_context?.actor ?? null,
        reason_note: reasonNote,
        pre_state: preState,
        post_state: this.describeIssueRuntimeState(blocked.issue_id)
      });
      return {
        ok: false,
        code: 'cancel_failed',
        message: error instanceof Error ? error.message : 'failed to move issue to backlog state'
      };
    }

    this.clearBlockedInput(blocked.issue_id, 'operator_cancelled_to_backlog');
    this.state.redispatch_progress?.delete(blocked.issue_id);
    await this.clearCircuitBreaker(blocked.issue_id);
    this.recordOperatorAction(blocked.issue_id, {
      action: 'cancel',
      requested_at_ms: this.nowMs(),
      result: 'accepted',
      result_code: targetState,
      message: `cancelled to backlog: ${reasonNote}`,
      actor: operator_context?.actor ?? null,
      reason_note: reasonNote,
      target_identifiers: this.targetIdentifiersFromRuntimeState(blocked.issue_id, preState),
      pre_state: preState,
      post_state: this.describeIssueRuntimeState(blocked.issue_id)
    });
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.orchestration.cancelToBacklogExecuted,
      severity: 'info',
      issue_identifier,
      detail: cancel_reason?.trim() ? `cancelled to backlog: ${cancel_reason.trim()}` : 'cancelled to backlog'
    });
    this.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.orchestration.cancelToBacklogExecuted,
      message: cancel_reason?.trim() ? `cancelled to backlog: ${cancel_reason.trim()}` : 'cancelled to backlog',
      context: {
        issue_id: blocked.issue_id,
        issue_identifier,
        stop_reason_code: blocked.stop_reason_code,
        classification_summary: JSON.stringify(
          blocked.classification_summary ?? {
            ephemeral: 0,
            tracked_ephemeral: 0,
            unknown_non_ephemeral: 0
          }
        ),
        next_operator_action: 'issue.state.todo',
        next_operator_action_endpoint: '/api/v1/issues/:issue_identifier/cancel'
      }
    });
    this.ports.notifyObservers?.();
    return { ok: true, issue_id: blocked.issue_id, moved_to_state: targetState };
  }

  async submitBlockedIssueInput(params: {
    issue_identifier: string;
    request_id: string;
    actor?: string | null;
    reason_note?: string | null;
    answer: { question_id?: string; option_label?: string; text?: string };
  }): Promise<
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
  > {
    const reasonNote = normalizeOperatorReasonNote(params.reason_note);
    if (!reasonNote) {
      return reasonNoteRequiredFailure();
    }
    const blocked = Array.from(this.state.blocked_inputs.values()).find((entry) => entry.issue_identifier === params.issue_identifier);
    if (!blocked) {
      return { ok: false, code: 'issue_not_blocked', message: `Issue ${params.issue_identifier} is not blocked` };
    }
    const preState = this.describeIssueRuntimeState(blocked.issue_id);
    const operatorContext = { actor: params.actor ?? null, reason_note: reasonNote };
    if (!blocked.pending_input) {
      this.recordOperatorAction(blocked.issue_id, {
        action: 'submit_input',
        requested_at_ms: this.nowMs(),
        result: 'rejected',
        result_code: 'input_submission_not_answerable',
        message: 'Blocked issue has no pending input request payload',
        actor: operatorContext.actor,
        reason_note: operatorContext.reason_note,
        pre_state: preState,
        post_state: this.describeIssueRuntimeState(blocked.issue_id)
      });
      return { ok: false, code: 'input_submission_not_answerable', message: 'Blocked issue has no pending input request payload' };
    }
    if (!blocked.pending_input.request_id || blocked.pending_input.request_id !== params.request_id) {
      this.recordOperatorAction(blocked.issue_id, {
        action: 'submit_input',
        requested_at_ms: this.nowMs(),
        result: 'rejected',
        result_code: 'input_submission_expired',
        message: 'Input request_id does not match current blocked request',
        actor: operatorContext.actor,
        reason_note: operatorContext.reason_note,
        pre_state: preState,
        post_state: this.describeIssueRuntimeState(blocked.issue_id)
      });
      return { ok: false, code: 'input_submission_expired', message: 'Input request_id does not match current blocked request' };
    }

    if (blocked.pending_input.input_schema_type === 'options') {
      const q = blocked.pending_input.questions.find((question) => question.id === params.answer.question_id) ?? blocked.pending_input.questions[0];
      const options = q?.options ?? [];
      if (!params.answer.option_label || !options.some((option) => option.label === params.answer.option_label)) {
      this.recordOperatorAction(blocked.issue_id, {
        action: 'submit_input',
        requested_at_ms: this.nowMs(),
        result: 'rejected',
        result_code: 'input_submission_invalid',
        message: 'Answer must select a valid option label for the pending question',
        actor: operatorContext.actor,
        reason_note: operatorContext.reason_note,
        pre_state: preState,
        post_state: this.describeIssueRuntimeState(blocked.issue_id)
      });
      return { ok: false, code: 'input_submission_invalid', message: 'Answer must select a valid option label for the pending question' };
      }
    } else if (blocked.pending_input.input_schema_type === 'text') {
      if (!params.answer.text || !params.answer.text.trim()) {
        this.recordOperatorAction(blocked.issue_id, {
          action: 'submit_input',
          requested_at_ms: this.nowMs(),
          result: 'rejected',
          result_code: 'input_submission_invalid',
          message: 'Answer text is required for this input request',
          actor: operatorContext.actor,
          reason_note: operatorContext.reason_note,
          pre_state: preState,
          post_state: this.describeIssueRuntimeState(blocked.issue_id)
        });
        return { ok: false, code: 'input_submission_invalid', message: 'Answer text is required for this input request' };
      }
    }

    const nativeAttempt = await this.submitBlockedIssueInputNative(blocked, params);
    if (nativeAttempt.applied) {
      this.logger?.log({
        level: 'info',
        event: CANONICAL_EVENT.orchestration.blockedInputSubmitNativeApplied,
        message: 'native blocked input submission applied',
        context: {
          issue_id: blocked.issue_id,
          issue_identifier: blocked.issue_identifier,
          request_id: params.request_id
        }
      });
      const resumed = await this.resumeBlockedIssue(params.issue_identifier, nativeAttempt.resume_context ?? null, null, operatorContext, {
        request_id: params.request_id,
        resume_mode: 'native',
        resume_reason_code: 'native_applied'
      });
      if (!resumed.ok) {
        return resumed;
      }
      return {
        ok: true,
        issue_id: resumed.issue_id,
        request_id: params.request_id,
        resume_mode: 'native',
        resume_reason_code: 'native_applied',
        requested_at: new Date().toISOString(),
        request_lineage: {
          previous_thread_id: blocked.previous_thread_id ?? null,
          previous_session_id: blocked.previous_session_id ?? null
        }
      };
    }

    this.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.orchestration.blockedInputSubmitNativeFailed,
      message: 'native blocked input submission unavailable',
      context: {
        issue_id: blocked.issue_id,
        issue_identifier: blocked.issue_identifier,
        request_id: params.request_id,
        resume_reason_code: nativeAttempt.code
      }
    });

    const mappedCode =
      nativeAttempt.code === 'session_expired' || nativeAttempt.code === 'request_not_found'
        ? 'input_submission_expired'
        : nativeAttempt.code === 'transport_unsupported'
          ? 'input_submission_transport_unavailable'
          : 'input_submission_not_answerable';
    this.recordOperatorAction(blocked.issue_id, {
      action: 'submit_input',
      requested_at_ms: this.nowMs(),
      result: mappedCode === 'input_submission_transport_unavailable' ? 'failed' : 'rejected',
      result_code: mappedCode,
      message: nativeAttempt.message ?? 'Input submission unavailable for this request',
      actor: operatorContext.actor,
      reason_note: operatorContext.reason_note,
      pre_state: preState,
      post_state: this.describeIssueRuntimeState(blocked.issue_id)
    });
    return { ok: false, code: mappedCode, message: nativeAttempt.message ?? 'Input submission unavailable for this request' };
  }

  private async submitBlockedIssueInputNative(
    blocked: BlockedEntry,
    params: { issue_identifier: string; request_id: string; answer: { question_id?: string; option_label?: string; text?: string } }
  ): Promise<{
    applied: boolean;
    code: 'native_applied' | 'session_expired' | 'request_not_found' | 'transport_unsupported' | 'native_submit_failed';
    message?: string;
    resume_context?: string;
  }> {
    if (!this.ports.submitBlockedIssueInputNative) {
      return { applied: false, code: 'transport_unsupported' };
    }
    return this.ports.submitBlockedIssueInputNative({
      issue_id: blocked.issue_id,
      issue_identifier: params.issue_identifier,
      request_id: params.request_id,
      request_method: blocked.pending_input?.request_method ?? null,
      previous_thread_id: blocked.previous_thread_id ?? null,
      previous_session_id: blocked.previous_session_id ?? null,
      answer: params.answer
    });
  }

  private buildOperatorInputResumeContext(
    blocked: BlockedEntry,
    answer: { question_id?: string; option_label?: string; text?: string }
  ): string {
    const question =
      blocked.pending_input?.questions.find((entry) => entry.id === answer.question_id) ?? blocked.pending_input?.questions[0] ?? null;
    const promptText = question?.prompt ?? blocked.pending_input?.prompt_text ?? 'Operator input requested';
    const normalizedAnswer = answer.option_label ?? answer.text?.trim() ?? '';
    const requestId = blocked.pending_input?.request_id ?? 'unknown';
    return [
      'Operator provided input for a previously blocked request. Apply this answer and continue execution.',
      `Request ID: ${requestId}`,
      `Question: ${promptText}`,
      `Answer: ${normalizedAnswer}`
    ].join('\n');
  }

  getPhaseMarkerSettings(): PhaseMarkerSettings {
    return { ...this.phaseSettings };
  }

  private getLastPhaseMarker(issue_id: string): PhaseMarker | null {
    const timeline = this.state.phase_timeline?.get(issue_id);
    return timeline && timeline.length > 0 ? timeline[timeline.length - 1] ?? null : null;
  }

  private emitExplicitPhaseMarker(issue_id: string, workerEvent: WorkerObservabilityEvent): boolean {
    const running = this.state.running.get(issue_id);
    const markerBase = {
      detail: workerEvent.detail ?? null,
      attempt: running?.retry_attempt ?? 0,
      thread_id: workerEvent.thread_id ?? running?.thread_id ?? null,
      session_id: workerEvent.session_id ?? running?.session_id ?? null
    };

    switch (workerEvent.event) {
      case CANONICAL_EVENT.codex.promptSent:
        this.emitPhaseMarker(issue_id, { ...markerBase, phase: 'prompt_sent' });
        return true;
      case CANONICAL_EVENT.codex.phasePlanning:
        this.emitPhaseMarker(issue_id, { ...markerBase, phase: 'planning' });
        return true;
      case CANONICAL_EVENT.codex.phaseImplementation:
        this.emitPhaseMarker(issue_id, { ...markerBase, phase: 'implementation' });
        return true;
      case CANONICAL_EVENT.codex.phaseValidation:
        this.emitPhaseMarker(issue_id, { ...markerBase, phase: 'validation' });
        return true;
      default:
        return false;
    }
  }

  private emitMappedPhaseMarker(issue_id: string, workerEvent: WorkerObservabilityEvent): void {
    const mapped = this.mapPhaseForWorkerEvent(workerEvent.event);
    if (!mapped) {
      return;
    }
    const running = this.state.running.get(issue_id);
    this.emitPhaseMarker(issue_id, {
      phase: mapped,
      detail: workerEvent.detail ?? null,
      attempt: running?.retry_attempt ?? 0,
      thread_id: workerEvent.thread_id ?? running?.thread_id ?? null,
      session_id: workerEvent.session_id ?? running?.session_id ?? null
    });
  }

  private mapPhaseForWorkerEvent(eventName: string): PhaseMarkerName | null {
    switch (eventName) {
      case CANONICAL_EVENT.codex.sessionStarted:
        return REASON_CODES.codexSessionStarted;
      case CANONICAL_EVENT.codex.turnStarted:
        return 'codex_turn_started';
      case CANONICAL_EVENT.codex.turnWaiting:
        return 'planning';
      case CANONICAL_EVENT.codex.toolCallCompleted:
        return 'implementation';
      case CANONICAL_EVENT.codex.turnCompleted:
        return 'validation';
      case CANONICAL_EVENT.codex.turnFailed:
        return 'failed';
      case CANONICAL_EVENT.codex.turnInputRequired:
        return 'blocked_input';
      default:
        return null;
    }
  }

  private emitPhaseMarker(
    issue_id: string,
    marker: {
      phase: PhaseMarkerName | string;
      detail: string | null;
      attempt: number;
      thread_id?: string | null;
      session_id?: string | null;
    }
  ): void {
    if (!this.phaseSettings.enabled) {
      return;
    }
    if (!isKnownPhaseMarker(marker.phase)) {
      this.phaseSettings.last_emit_error_code = 'unknown_phase';
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.orchestration.phaseMarkerIgnored,
        message: 'phase marker ignored: unknown phase',
        context: { issue_id, phase: marker.phase, attempt: marker.attempt }
      });
      return;
    }
    const timeline = this.state.phase_timeline?.get(issue_id) ?? [];
    const lastForAttempt = this.getLastPhaseMarkerForAttempt(timeline, marker.attempt);
    if (
      lastForAttempt &&
      (isTerminalPhaseMarker(lastForAttempt.phase) || phaseMarkerOrder(marker.phase) <= phaseMarkerOrder(lastForAttempt.phase))
    ) {
      this.logger?.log({
        level: 'info',
        event: CANONICAL_EVENT.orchestration.phaseMarkerIgnored,
        message: 'phase marker ignored: non-monotonic or terminal',
        context: { issue_id, phase: marker.phase, previous_phase: lastForAttempt.phase, attempt: marker.attempt }
      });
      return;
    }
    const next: PhaseMarker = {
      at_ms: this.nowMs(),
      phase: marker.phase,
      detail: marker.detail,
      attempt: marker.attempt,
      thread_id: marker.thread_id ?? null,
      session_id: marker.session_id ?? null
    };
    timeline.push(next);
    if (timeline.length > this.phaseSettings.timeline_limit) {
      timeline.splice(0, timeline.length - this.phaseSettings.timeline_limit);
    }
    this.state.phase_timeline?.set(issue_id, timeline);
    const running = this.state.running.get(issue_id);
    if (running) {
      running.current_phase = next.phase;
      running.current_phase_at_ms = next.at_ms;
      running.phase_detail = next.detail;
    }
    this.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.orchestration.phaseMarkerEmitted,
      message: 'phase marker emitted',
      context: {
        issue_id,
        phase: next.phase,
        attempt: next.attempt,
        thread_id: next.thread_id,
        session_id: next.session_id
      }
    });
  }

  private getLastPhaseMarkerForAttempt(timeline: PhaseMarker[], attempt: number): PhaseMarker | null {
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const marker = timeline[index];
      if (marker?.attempt === attempt) {
        return marker;
      }
    }
    return null;
  }

  private inferStopReasonCode(error: string | undefined, fallback: string): string {
    if (!error) {
      return fallback;
    }

    const workspaceConflictPayload = this.parseWorkspaceConflictPayload(error);
    if (workspaceConflictPayload?.code === REASON_CODES.operatorWorkspaceConflict) {
      return REASON_CODES.operatorWorkspaceConflict;
    }

    const normalized = error.toLowerCase();
    if (normalized.includes(REASON_CODES.turnInputRequired)) {
      return REASON_CODES.turnInputRequired;
    }
    if (normalized.includes(REASON_CODES.issueStateRefreshFailed)) {
      return REASON_CODES.issueStateRefreshFailed;
    }
    if (normalized.includes(REASON_CODES.unsafeWorkspaceRoot)) {
      return REASON_CODES.unsafeWorkspaceRoot;
    }
    if (normalized.includes(REASON_CODES.workspaceEmpty)) {
      return REASON_CODES.workspaceEmpty;
    }
    if (
      normalized.includes('workspace_unprovisioned_conflict') ||
      normalized.includes('worktree_branch_conflict')
    ) {
      return REASON_CODES.operatorWorkspaceConflict;
    }

    return fallback;
  }

  private inferWorkspaceConflictContext(error: string | undefined, fallbackReason: string): WorkspaceConflictContext {
    const defaultDetail = error ?? `worker exited: ${fallbackReason}`;
    const defaultHints = [
      'Resolve workspace git conflicts in the issue worktree.',
      'Ensure the workspace branch/worktree mapping matches repository state.',
      'Resume the blocked issue explicitly after conflicts are resolved.'
    ];
    if (!error) {
      return { detail: defaultDetail, conflict_files: [], resolution_hints: defaultHints };
    }

    const payload = this.parseWorkspaceConflictPayload(error);
    if (payload) {
      return {
        detail: payload.detail ?? defaultDetail,
        conflict_files: payload.conflict_files,
        classification_summary: payload.classification_summary,
        resolution_hints: payload.resolution_hints.length > 0 ? payload.resolution_hints : defaultHints
      };
    }

    const inferredConflictFiles = this.inferWorkspaceConflictFiles(defaultDetail);
    return { detail: defaultDetail, conflict_files: inferredConflictFiles, resolution_hints: defaultHints };
  }

  private inferWorkspaceConflictFiles(detail: string): Array<{ path: string; status: 'staged' | 'unstaged' | 'unknown' }> {
    const normalized = detail.toLowerCase();
    if (normalized.includes('worktree_branch_conflict')) {
      return [{ path: '.git/HEAD', status: 'unknown' }];
    }
    if (normalized.includes('workspace path is not a managed git worktree')) {
      return [{ path: '.git', status: 'unknown' }];
    }
    if (normalized.includes('workspace path exists but branch cannot be inspected')) {
      return [{ path: '.git/HEAD', status: 'unknown' }];
    }
    if (normalized.includes('workspace path exists but is not a managed git worktree')) {
      return [{ path: '.git', status: 'unknown' }];
    }

    return [];
  }

  private parseWorkspaceConflictPayload(error: string): {
    code: string | null;
    detail: string | null;
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
  } | null {
    const prefix = 'workspace_conflict:';
    if (!error.toLowerCase().startsWith(prefix)) {
      return null;
    }
    const rawDetail = error.slice(prefix.length).trim();
    try {
      const payload = JSON.parse(rawDetail) as {
        code?: string;
        detail?: string;
        conflict_files?: Array<{ path?: string; status?: string; classification?: string }>;
        classification_summary?: { ephemeral?: number; tracked_ephemeral?: number; unknown_non_ephemeral?: number };
        resolution_hints?: string[];
      };
      return {
        code: typeof payload.code === 'string' ? payload.code : null,
        detail: typeof payload.detail === 'string' ? payload.detail : null,
        conflict_files: (payload.conflict_files ?? [])
          .filter((file) => typeof file?.path === 'string' && file.path.trim().length > 0)
          .map((file) => ({
            path: String(file.path),
            status: file?.status === 'staged' || file?.status === 'unstaged' ? file.status : 'unknown',
            classification:
              file.classification === 'ephemeral' ||
              file.classification === 'tracked_ephemeral' ||
              file.classification === 'unknown_non_ephemeral'
                ? file.classification
                : undefined
          })),
        classification_summary: payload.classification_summary
          ? {
              ephemeral: Number(payload.classification_summary.ephemeral ?? 0),
              tracked_ephemeral: Number(payload.classification_summary.tracked_ephemeral ?? 0),
              unknown_non_ephemeral: Number(payload.classification_summary.unknown_non_ephemeral ?? 0)
            }
          : undefined,
        resolution_hints: (payload.resolution_hints ?? []).filter(
          (hint): hint is string => typeof hint === 'string' && hint.trim().length > 0
        )
      };
    } catch {
      return null;
    }
  }

  private inferInputRequiredDetail(
    error: string | undefined,
    fallbackReason: string
  ): {
    detail: string;
    request_id: string | null;
    request_method: string | null;
    prompt_text: string | null;
    questions: Array<{ id: string; prompt?: string; options?: Array<{ label: string; value?: string }> }>;
  } {
    if (!error) {
      return {
        detail: `worker exited: ${fallbackReason}`,
        request_id: null,
        request_method: null,
        prompt_text: null,
        questions: []
      };
    }
    const prefix = `${REASON_CODES.turnInputRequired}:`;
    if (error.toLowerCase().startsWith(prefix)) {
      const rawDetail = error.slice(prefix.length).trim() || 'input_required_unanswerable';
      try {
        const payload = JSON.parse(rawDetail) as {
          detail?: string;
          request_id?: string;
          request_method?: string;
          prompt_text?: string | null;
          questions?: Array<{ id?: string; prompt?: string; options?: Array<{ label?: string; value?: string }> }>;
        };
        return {
          detail: payload.detail ?? 'input_required_unanswerable',
          request_id: payload.request_id ?? null,
          request_method: payload.request_method ?? null,
          prompt_text: payload.prompt_text ?? null,
          questions: Array.isArray(payload.questions)
            ? payload.questions
                .filter((question) => Boolean(question?.id))
                .map((question) => ({
                  id: String(question.id),
                  ...(question?.prompt ? { prompt: String(question.prompt) } : {}),
                  ...(Array.isArray(question?.options)
                    ? {
                        options: question.options
                          .filter((option) => Boolean(option?.label))
                          .map((option) => ({
                            label: String(option.label),
                            ...(option?.value ? { value: String(option.value) } : {})
                          }))
                      }
                    : {})
                }))
            : []
        };
      } catch {
        return {
          detail: rawDetail,
          request_id: null,
          request_method: null,
          prompt_text: null,
          questions: []
        };
      }
    }
    return {
      detail: error,
      request_id: null,
      request_method: null,
      prompt_text: null,
      questions: []
    };
  }

  private inferInputSchemaType(
    questions: Array<{ id: string; prompt?: string; options?: Array<{ label: string; value?: string }> }>
  ): 'options' | 'text' | 'unknown' {
    if (questions.some((question) => Array.isArray(question.options) && question.options.length > 0)) {
      return 'options';
    }
    if (questions.length > 0) {
      return 'text';
    }
    return 'unknown';
  }

  private addRuntimeSecondsFromEntry(runningEntry: RunningEntry): void {
    this.state.codex_totals.seconds_running += Math.max(0, Math.floor((this.nowMs() - runningEntry.started_at_ms) / 1000));
  }

  private describeIssueRuntimeState(issueId: string): Record<string, unknown> {
    const running = this.state.running.get(issueId);
    if (running) {
      return {
        runtime_state: 'running',
        issue_id: issueId,
        issue_identifier: running.identifier,
        issue_run_id: running.issue_run_id ?? null,
        run_id: running.run_id ?? null,
        attempt_id: running.attempt_id ?? null,
        retry_attempt: running.retry_attempt,
        thread_id: running.thread_id,
        turn_id: running.turn_id,
        session_id: running.session_id
      };
    }
    const blocked = this.state.blocked_inputs.get(issueId);
    if (blocked) {
      return {
        runtime_state: 'blocked',
        issue_id: issueId,
        issue_identifier: blocked.issue_identifier,
        issue_run_id: blocked.issue_run_id ?? null,
        run_id: null,
        attempt_id: blocked.previous_attempt_id ?? null,
        retry_attempt: blocked.attempt,
        thread_id: blocked.previous_thread_id,
        session_id: blocked.previous_session_id,
        reason_code: blocked.stop_reason_code
      };
    }
    const retry = this.state.retry_attempts.get(issueId);
    if (retry) {
      return {
        runtime_state: 'retrying',
        issue_id: issueId,
        issue_identifier: retry.identifier,
        issue_run_id: retry.issue_run_id ?? null,
        run_id: null,
        attempt_id: retry.previous_attempt_id ?? null,
        retry_attempt: retry.attempt,
        thread_id: retry.previous_thread_id,
        session_id: retry.previous_session_id,
        due_at_ms: retry.due_at_ms,
        reason_code: retry.stop_reason_code
      };
    }
    return {
      runtime_state: this.state.completed.has(issueId) ? 'completed' : 'untracked',
      issue_id: issueId
    };
  }

  private recordOperatorAction(issueId: string, action: OperatorActionRecord): void {
    const operatorActions = this.state.operator_actions ?? new Map<string, OperatorActionRecord[]>();
    this.state.operator_actions = operatorActions;
    const currentState = this.describeIssueRuntimeState(issueId);
    const normalized: OperatorActionRecord = {
      ...action,
      actor: action.actor ?? 'operator',
      reason_note: action.reason_note ?? null,
      target_identifiers: action.target_identifiers ?? this.targetIdentifiersFromRuntimeState(issueId, action.pre_state ?? currentState),
      pre_state: action.pre_state ?? currentState,
      post_state: action.post_state ?? currentState
    };
    const existing = operatorActions.get(issueId) ?? [];
    const updated = [...existing, normalized].slice(-20);
    operatorActions.set(issueId, updated);
    void this.persistence?.upsertOperatorActions?.(issueId, JSON.stringify(updated));
    void this.persistence?.appendOperatorActionHistory?.({
      issue_run_id: this.stringOrNull(normalized.target_identifiers?.issue_run_id) ?? this.stringOrNull((normalized.pre_state ?? {}).issue_run_id),
      attempt_id: this.stringOrNull(normalized.target_identifiers?.attempt_id),
      thread_id: this.stringOrNull(normalized.target_identifiers?.thread_id),
      turn_id: this.stringOrNull(normalized.target_identifiers?.turn_id),
      action: normalized.action,
      actor: normalized.actor ?? 'operator',
      result: normalized.result,
      result_code: normalized.result_code,
      message: normalized.message,
      reason_note: normalized.reason_note,
      phase: this.stringOrNull((normalized.pre_state ?? {}).current_phase) ?? this.stringOrNull((normalized.pre_state ?? {}).last_phase),
      state_context: {
        issue_id: issueId,
        target_identifiers: normalized.target_identifiers ?? null,
        pre_state: normalized.pre_state ?? null,
        post_state: normalized.post_state ?? null
      },
      requested_at: asIso(normalized.requested_at_ms),
      observed_at: asIso(this.nowMs())
    })?.catch((error: unknown) => {
      void this.recordHistoryWriteFailure('appendOperatorActionHistory', normalized.result_code ?? normalized.action, error);
    });
  }

  private stringOrNull(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null;
  }

  private firstNonEmpty(...values: Array<string | null | undefined>): string | null {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return null;
  }

  private targetIdentifiersFromRuntimeState(
    issueId: string,
    runtimeState: Record<string, unknown>
  ): NonNullable<OperatorActionRecord['target_identifiers']> {
    return {
      issue_id: issueId,
      issue_identifier: typeof runtimeState.issue_identifier === 'string' ? runtimeState.issue_identifier : null,
      issue_run_id: typeof runtimeState.issue_run_id === 'string' ? runtimeState.issue_run_id : null,
      run_id: typeof runtimeState.run_id === 'string' ? runtimeState.run_id : null,
      attempt_id: typeof runtimeState.attempt_id === 'string' ? runtimeState.attempt_id : null,
      thread_id: typeof runtimeState.thread_id === 'string' ? runtimeState.thread_id : null,
      turn_id: typeof runtimeState.turn_id === 'string' ? runtimeState.turn_id : null,
      session_id: typeof runtimeState.session_id === 'string' ? runtimeState.session_id : null
    };
  }

  private maybeEmitTokenTelemetryWarning(runningEntry: RunningEntry, eventAtMs: number): void {
    if (runningEntry.token_telemetry_status === 'available' || runningEntry.token_telemetry_warning_emitted) {
      return;
    }

    const turnStartedAtMs = runningEntry.token_telemetry_turn_started_at_ms;
    if (turnStartedAtMs === null) {
      return;
    }

    const thresholdMs = this.config.no_telemetry_warning_threshold_ms ?? 120_000;
    if (thresholdMs <= 0 || eventAtMs - turnStartedAtMs < thresholdMs) {
      return;
    }

    runningEntry.token_telemetry_warning_emitted = true;
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.codex.tokenTelemetryMissingThresholdExceeded,
      severity: 'warn',
      issue_identifier: runningEntry.identifier,
      session_id: runningEntry.session_id ?? undefined,
      detail: `token_telemetry_status=${runningEntry.token_telemetry_status} elapsed_ms=${eventAtMs - turnStartedAtMs}`
    });
  }

  private isTerminalTurnEvent(event: string): boolean {
    return (
      event === CANONICAL_EVENT.codex.turnCompleted ||
      event === CANONICAL_EVENT.codex.turnFailed ||
      event === CANONICAL_EVENT.codex.turnCancelled
    );
  }

  private shouldResetRunningWaitEpisode(event: string): boolean {
    return (
      this.isTerminalTurnEvent(event) ||
      event === CANONICAL_EVENT.codex.turnStarted ||
      event === CANONICAL_EVENT.codex.promptSent ||
      event === CANONICAL_EVENT.codex.turnInputRequired ||
      event === CANONICAL_EVENT.codex.startupFailed ||
      event === CANONICAL_EVENT.codex.phaseImplementation ||
      event === CANONICAL_EVENT.codex.phaseValidation ||
      event === CANONICAL_EVENT.codex.toolCallStarted ||
      event === CANONICAL_EVENT.codex.toolCallCompleted ||
      event === CANONICAL_EVENT.codex.toolCallFailed
    );
  }

  private resetRunningWaitEpisode(runningEntry: RunningEntry, progressAtMs: number): void {
    runningEntry.running_waiting_started_at_ms = null;
    runningEntry.running_wait_stall_event_emitted = false;
    runningEntry.heartbeat_only_event_emitted = false;
    runningEntry.stalled_waiting_since_ms = null;
    runningEntry.stalled_waiting_reason = null;
    runningEntry.last_progress_transition_at_ms = progressAtMs;
  }

  private classifyWorkerActivity(runningEntry: RunningEntry, observedAtMs: number): WorkerActivityClassification {
    const latestMeaningfulProgressAtMs = Math.max(
      0,
      runningEntry.last_progress_transition_at_ms ?? runningEntry.started_at_ms,
      ...Object.values(runningEntry.tool_call_ledger ?? {}).map((entry) => entry.last_seen_at_ms),
      ...Object.values(runningEntry.outstanding_tool_calls ?? {}).map((entry) => entry.last_waiting_at_ms ?? entry.started_at_ms)
    );
    const latestThreadActivityAtMs = runningEntry.codex_thread_activity_at_ms ?? null;
    const latestLivenessAtMs = Math.max(
      0,
      runningEntry.last_codex_timestamp_ms ?? runningEntry.started_at_ms,
      runningEntry.last_heartbeat_at_ms ?? 0,
      latestThreadActivityAtMs ?? 0
    );
    const normalizedMeaningful = latestMeaningfulProgressAtMs > 0 ? latestMeaningfulProgressAtMs : null;
    const normalizedLiveness = latestLivenessAtMs > 0 ? latestLivenessAtMs : null;
    const waitThresholdMs = this.config.progress_stalled_waiting_ms ?? this.config.running_wait_stall_threshold_ms ?? 300_000;
    const meaningfulAgeMs = normalizedMeaningful === null ? Number.POSITIVE_INFINITY : observedAtMs - normalizedMeaningful;
    const livenessAgeMs = normalizedLiveness === null ? Number.POSITIVE_INFINITY : observedAtMs - normalizedLiveness;
    const hasFreshLiveness = waitThresholdMs <= 0 || livenessAgeMs <= waitThresholdMs;
    const hasFreshThreadActivity =
      latestThreadActivityAtMs !== null && (waitThresholdMs <= 0 || observedAtMs - latestThreadActivityAtMs <= waitThresholdMs);
    const waitingLike = runningEntry.last_event === CANONICAL_EVENT.codex.turnWaiting || runningEntry.running_waiting_started_at_ms != null;
    const activityState: WorkerActivityState =
      meaningfulAgeMs <= waitThresholdMs
        ? 'advancing'
        : hasFreshThreadActivity
          ? 'active_but_opaque'
          : hasFreshLiveness || waitingLike
            ? 'heartbeat_only'
            : 'stale';

    return {
      latest_meaningful_progress_at_ms: normalizedMeaningful,
      latest_liveness_at_ms: normalizedLiveness,
      latest_thread_activity_at_ms: latestThreadActivityAtMs,
      activity_state: activityState
    };
  }

  private isMeaningfulWorkerProgressEvent(workerEvent: WorkerObservabilityEvent): boolean {
    return (
      workerEvent.event === CANONICAL_EVENT.codex.dynamicToolCapabilityMismatch ||
      workerEvent.event === CANONICAL_EVENT.codex.approvalAutoApproved ||
      workerEvent.event === CANONICAL_EVENT.codex.toolInputAutoAnswered ||
      workerEvent.event === CANONICAL_EVENT.codex.sideOutput
    );
  }

  private updateOutstandingToolCalls(runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent): void {
    if (workerEvent.event === CANONICAL_EVENT.codex.toolCallStarted) {
      const callId = this.resolveToolCallId(workerEvent);
      if (!callId) {
        return;
      }
      this.applyToolCallLedgerObservation(runningEntry, {
        kind: 'function_call',
        call_id: callId,
        tool_name: this.resolveToolName(workerEvent),
        thread_id: workerEvent.thread_id ?? runningEntry.thread_id ?? null,
        turn_id: workerEvent.turn_id ?? runningEntry.turn_id ?? null,
        session_id: workerEvent.session_id ?? runningEntry.session_id ?? null,
        observed_at_ms: workerEvent.timestamp_ms,
        last_agent_message: runningEntry.last_message ?? null,
        evidence_source: workerEvent.tool_call_evidence_source ?? 'worker_event'
      });
      return;
    }

    if (
      workerEvent.event === CANONICAL_EVENT.codex.toolCallCompleted ||
      workerEvent.event === CANONICAL_EVENT.codex.toolCallFailed ||
      workerEvent.event === CANONICAL_EVENT.codex.dynamicToolCapabilityMismatch ||
      workerEvent.event === CANONICAL_EVENT.codex.unsupportedToolCall
    ) {
      const callId = this.resolveToolCallId(workerEvent);
      if (!callId) {
        return;
      }
      this.applyToolCallLedgerObservation(runningEntry, {
        kind: 'function_call_output',
        call_id: callId,
        tool_name: workerEvent.tool_name ?? null,
        thread_id: workerEvent.thread_id ?? runningEntry.thread_id ?? null,
        turn_id: workerEvent.turn_id ?? runningEntry.turn_id ?? null,
        session_id: workerEvent.session_id ?? runningEntry.session_id ?? null,
        observed_at_ms: workerEvent.timestamp_ms,
        evidence_source: workerEvent.tool_call_evidence_source ?? 'worker_event'
      });
      return;
    }

    if (workerEvent.event === CANONICAL_EVENT.codex.turnWaiting && runningEntry.outstanding_tool_calls) {
      for (const call of Object.values(runningEntry.outstanding_tool_calls)) {
        call.last_waiting_at_ms = workerEvent.timestamp_ms;
        call.last_agent_message = workerEvent.detail ?? runningEntry.last_message ?? call.last_agent_message;
      }
    }
  }

  private applyToolCallLedgerObservation(runningEntry: RunningEntry, observation: ToolCallLedgerObservation): void {
    const callId = observation.call_id.trim();
    if (!callId) {
      return;
    }

    const ledgerEntry = this.upsertToolCallLedgerEntry(runningEntry, observation, callId);
    if (observation.kind === 'function_call_output') {
      if (runningEntry.outstanding_tool_calls) {
        delete runningEntry.outstanding_tool_calls[callId];
      }
      return;
    }

    const calls = runningEntry.outstanding_tool_calls ?? {};
    const existing = calls[callId];
    if (!existing && ledgerEntry.completion_status === 'completed') {
      return;
    }
    calls[callId] = {
      call_id: callId,
      tool_name: ledgerEntry.tool_name,
      thread_id: ledgerEntry.thread_id,
      turn_id: ledgerEntry.turn_id,
      session_id: ledgerEntry.session_id,
      started_at_ms: existing?.started_at_ms ?? ledgerEntry.first_seen_at_ms,
      last_waiting_at_ms: existing?.last_waiting_at_ms ?? null,
      last_agent_message: observation.last_agent_message ?? runningEntry.last_message ?? existing?.last_agent_message ?? null,
      evidence_source: existing?.evidence_source ?? ledgerEntry.start_evidence_source ?? observation.evidence_source
    };
    runningEntry.outstanding_tool_calls = calls;
  }

  private upsertToolCallLedgerEntry(
    runningEntry: RunningEntry,
    observation: ToolCallLedgerObservation,
    callId: string
  ): ToolCallLedgerEntry {
    const ledger = (runningEntry.tool_call_ledger ??= {});
    const existing = ledger[callId];
    const toolName =
      observation.tool_name?.trim() ||
      existing?.tool_name ||
      runningEntry.outstanding_tool_calls?.[callId]?.tool_name ||
      'unknown_tool';
    const evidenceSources = existing?.evidence_sources ? [...existing.evidence_sources] : [];
    if (!evidenceSources.includes(observation.evidence_source)) {
      evidenceSources.push(observation.evidence_source);
    }

    const firstSeenAtMs = existing ? Math.min(existing.first_seen_at_ms, observation.observed_at_ms) : observation.observed_at_ms;
    const lastSeenAtMs = existing ? Math.max(existing.last_seen_at_ms, observation.observed_at_ms) : observation.observed_at_ms;
    const completionStatus =
      observation.kind === 'function_call_output' || existing?.completion_status === 'completed' ? 'completed' : 'pending';
    const completedAtMs =
      observation.kind === 'function_call_output'
        ? existing?.completed_at_ms
          ? Math.min(existing.completed_at_ms, observation.observed_at_ms)
          : observation.observed_at_ms
        : existing?.completed_at_ms ?? null;

    const entry: ToolCallLedgerEntry = {
      call_id: callId,
      tool_name: toolName,
      thread_id: existing?.thread_id ?? observation.thread_id ?? runningEntry.thread_id ?? null,
      turn_id: existing?.turn_id ?? observation.turn_id ?? runningEntry.turn_id ?? null,
      session_id: existing?.session_id ?? observation.session_id ?? runningEntry.session_id ?? null,
      issue_id: runningEntry.issue.id,
      issue_identifier: runningEntry.identifier,
      run_id: runningEntry.run_id ?? null,
      issue_run_id: runningEntry.issue_run_id ?? null,
      attempt_id: runningEntry.attempt_id ?? null,
      first_seen_at_ms: firstSeenAtMs,
      last_seen_at_ms: lastSeenAtMs,
      completed_at_ms: completedAtMs,
      completion_status: completionStatus,
      evidence_sources: evidenceSources,
      start_evidence_source:
        existing?.start_evidence_source ?? (observation.kind === 'function_call' ? observation.evidence_source : null),
      completion_evidence_source:
        observation.kind === 'function_call_output'
          ? observation.evidence_source
          : existing?.completion_evidence_source ?? null,
      last_agent_message:
        observation.last_agent_message ?? runningEntry.last_message ?? existing?.last_agent_message ?? null
    };
    ledger[callId] = entry;
    return entry;
  }

  private resolveToolCallId(workerEvent: WorkerObservabilityEvent): string | null {
    const explicit = workerEvent.tool_call_id?.trim();
    if (explicit) {
      return explicit;
    }

    const detail = workerEvent.detail?.trim();
    if (!detail) {
      return null;
    }
    const mismatch = parseDynamicToolCapabilityMismatchDetail(detail);
    if (mismatch?.call_id) {
      return mismatch.call_id;
    }
    const match = detail.match(/\b(?:call_id|callId|id)=([^\s,]+)/);
    return match?.[1] ?? null;
  }

  private resolveToolName(workerEvent: WorkerObservabilityEvent): string {
    const explicit = workerEvent.tool_name?.trim();
    if (explicit) {
      return explicit;
    }
    const detail = workerEvent.detail?.trim();
    return detail && detail.length > 0 ? detail : 'unknown_tool';
  }

  private maybeEmitHeartbeatOnly(issueId: string, runningEntry: RunningEntry, observedAtMs: number): void {
    const thresholdMs = this.config.progress_heartbeat_only_warn_ms ?? 120_000;
    if (thresholdMs <= 0 || (runningEntry.last_event !== CANONICAL_EVENT.codex.turnWaiting && runningEntry.running_waiting_started_at_ms == null)) {
      return;
    }
    const waitingStartedAtMs =
      runningEntry.running_waiting_started_at_ms ?? runningEntry.last_codex_timestamp_ms ?? runningEntry.started_at_ms;
    runningEntry.running_waiting_started_at_ms = waitingStartedAtMs;
    if (observedAtMs - waitingStartedAtMs < thresholdMs || runningEntry.heartbeat_only_event_emitted) {
      return;
    }
    runningEntry.heartbeat_only_event_emitted = true;
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.progress.heartbeatOnlyDetected,
      severity: 'warn',
      issue_identifier: runningEntry.identifier,
      session_id: runningEntry.session_id ?? undefined,
      detail: `issue_id=${issueId} thread_id=${runningEntry.thread_id ?? 'unknown'} session_id=${runningEntry.session_id ?? 'unknown'} elapsed_ms=${Math.max(0, observedAtMs - waitingStartedAtMs)}`
    });
  }

  private async maybeClassifyRunningWaitStall(
    issueId: string,
    runningEntry: RunningEntry,
    observedAtMs: number
  ): Promise<boolean> {
    const waitThresholdMs = this.config.progress_stalled_waiting_ms ?? this.config.running_wait_stall_threshold_ms ?? 300_000;
    if (waitThresholdMs <= 0) {
      return false;
    }

    this.scanCodexSessionTranscriptForToolCalls(runningEntry, observedAtMs);

    const missingToolOutput = this.findMissingToolOutputCandidate(runningEntry, observedAtMs, waitThresholdMs);
    if (missingToolOutput) {
      runningEntry.stalled_waiting_reason = REASON_CODES.turnWaitingThresholdExceeded;
      await this.recoverOrBlockMissingToolOutput(issueId, runningEntry, missingToolOutput, observedAtMs);
      return true;
    }

    if (runningEntry.awaiting_input_since_ms !== null) {
      return false;
    }

    if (runningEntry.last_event !== CANONICAL_EVENT.codex.turnWaiting && runningEntry.running_waiting_started_at_ms == null) {
      return false;
    }

    const waitingStartedAtMs =
      runningEntry.running_waiting_started_at_ms ?? runningEntry.last_codex_timestamp_ms ?? runningEntry.started_at_ms;
    runningEntry.running_waiting_started_at_ms = waitingStartedAtMs;
    const activity = this.classifyWorkerActivity(runningEntry, observedAtMs);
    const lastMeaningfulActivityAtMs =
      typeof activity.latest_meaningful_progress_at_ms === 'number' && activity.latest_meaningful_progress_at_ms > waitingStartedAtMs
        ? activity.latest_meaningful_progress_at_ms
        : waitingStartedAtMs;
    const thresholdCrossedAtMs = lastMeaningfulActivityAtMs + waitThresholdMs;
    runningEntry.stalled_waiting_since_ms = thresholdCrossedAtMs;

    if (observedAtMs < thresholdCrossedAtMs) {
      runningEntry.stalled_waiting_reason = null;
      return false;
    }

    const elapsedMs = Math.max(0, observedAtMs - waitingStartedAtMs);
    if (!runningEntry.running_wait_stall_event_emitted) {
      runningEntry.running_wait_stall_event_emitted = true;
      const progressEvent =
        activity.activity_state === 'active_but_opaque'
          ? CANONICAL_EVENT.progress.activeButOpaqueDetected
          : CANONICAL_EVENT.progress.stalledWaitingDetected;
      this.recordRuntimeEvent({
        event: progressEvent,
        severity: 'warn',
        issue_identifier: runningEntry.identifier,
        session_id: runningEntry.session_id ?? undefined,
        detail: [
          `issue_id=${issueId}`,
          `thread_id=${runningEntry.thread_id ?? 'unknown'}`,
          `session_id=${runningEntry.session_id ?? 'unknown'}`,
          `activity_state=${activity.activity_state}`,
          `elapsed_ms=${elapsedMs}`,
          `latest_liveness_at_ms=${activity.latest_liveness_at_ms ?? 'unknown'}`,
          `latest_thread_activity_at_ms=${activity.latest_thread_activity_at_ms ?? 'unknown'}`
        ].join(' ')
      });
      this.recordRuntimeEvent({
        event: CANONICAL_EVENT.orchestration.runningWaitStallThresholdExceeded,
        severity: 'warn',
        issue_identifier: runningEntry.identifier,
        session_id: runningEntry.session_id ?? undefined,
        detail: `issue_id=${issueId} thread_id=${runningEntry.thread_id ?? 'unknown'} session_id=${runningEntry.session_id ?? 'unknown'} elapsed_ms=${elapsedMs}`
      });
    }
    runningEntry.stalled_waiting_reason = null;
    return false;
  }

  private async recoverRunningWaitStall(
    issueId: string,
    runningEntry: RunningEntry,
    observedAtMs: number,
    elapsedMs: number
  ): Promise<void> {
    if (this.state.running.get(issueId) !== runningEntry) {
      return;
    }

    const handoffProgress = await this.classifyTrackerHandoffProgress(issueId, runningEntry);
    if (handoffProgress?.kind === 'unknown') {
      await this.completeStalledTrackerRefreshUncertain(issueId, runningEntry, handoffProgress.error_detail, observedAtMs, elapsedMs);
      return;
    }
    if (handoffProgress?.kind === 'progress') {
      await this.completeStalledReviewHandoff(issueId, runningEntry, handoffProgress, observedAtMs, elapsedMs);
      return;
    }

    const detail = [
      'no meaningful progress while waiting for Codex turn completion',
      `reason_code=${REASON_CODES.turnWaitingThresholdExceeded}`,
      `thread_id=${runningEntry.thread_id ?? 'unknown'}`,
      `turn_id=${runningEntry.turn_id ?? 'unknown'}`,
      `session_id=${runningEntry.session_id ?? 'unknown'}`,
      `elapsed_wait_ms=${elapsedMs}`,
      `observed_at_ms=${observedAtMs}`
    ].join(' ');
    const terminationResult = await this.ports.terminateWorker({
      issue_id: issueId,
      worker_handle: runningEntry.worker_handle,
      cleanup_workspace: false,
      reason: REASON_CODES.turnWaitingThresholdExceeded
    });
    const stalledDetail = workerTerminationResultDetail(detail, terminationResult);

    this.rememberInactiveWorkerPid(runningEntry, REASON_CODES.turnWaitingThresholdExceeded);
    this.addRuntimeSecondsFromEntry(runningEntry);
    await this.completeRunRecord(runningEntry, 'stalled', REASON_CODES.turnWaitingThresholdExceeded, null, stalledDetail);
    await this.persistExecutionGraphStateTransition(
      runningEntry,
      'failed',
      'failed',
      REASON_CODES.turnWaitingThresholdExceeded,
      stalledDetail
    );
    this.state.running.delete(issueId);

    await this.scheduleRetry({
      issue_id: issueId,
      identifier: runningEntry.identifier,
      attempt: runningEntry.retry_attempt + 1,
      issue_run_id: runningEntry.issue_run_id ?? null,
      previous_attempt_id: runningEntry.attempt_id ?? null,
      delay_type: 'failure',
      error: 'turn waiting threshold exceeded',
      worker_host: runningEntry.worker_host ?? null,
      workspace_path: runningEntry.workspace_path ?? null,
      provisioner_type: runningEntry.provisioner_type ?? null,
      branch_name: runningEntry.branch_name ?? null,
      repo_root: runningEntry.repo_root ?? null,
      workspace_exists: runningEntry.workspace_exists,
      workspace_git_status: runningEntry.workspace_git_status,
      workspace_provisioned: runningEntry.workspace_provisioned,
      workspace_is_git_worktree: runningEntry.workspace_is_git_worktree,
      copy_ignored_applied: runningEntry.copy_ignored_applied,
      copy_ignored_status: runningEntry.copy_ignored_status,
      copy_ignored_summary: runningEntry.copy_ignored_summary,
      stop_reason_code: REASON_CODES.turnWaitingThresholdExceeded,
      stop_reason_detail: stalledDetail,
      previous_thread_id: runningEntry.thread_id,
      previous_turn_id: runningEntry.turn_id,
      previous_session_id: runningEntry.session_id,
      last_progress_checkpoint_at: runningEntry.last_progress_transition_at_ms ?? runningEntry.started_at_ms,
      issue_snapshot: runningEntry.issue,
      progress_signals: runningEntry.progress_signals
    });
    this.state.health.last_error = `turn waiting threshold exceeded for ${runningEntry.identifier}`;
    this.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.orchestration.workerStalled,
      message: 'turn waiting threshold exceeded; retrying',
      context: {
        issue_id: issueId,
        issue_identifier: runningEntry.identifier,
        session_id: runningEntry.session_id,
        elapsed_ms: elapsedMs,
        stop_reason_code: REASON_CODES.turnWaitingThresholdExceeded,
        ...workerTerminationResultContext(terminationResult)
      }
    });
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.orchestration.workerStalled,
      severity: 'warn',
      issue_identifier: runningEntry.identifier,
      session_id: runningEntry.session_id ?? undefined,
      detail: stalledDetail
    });
  }

  private async maybeTerminateOpaqueActivityHardTimeout(
    issueId: string,
    runningEntry: RunningEntry,
    observedAtMs: number
  ): Promise<boolean> {
    if (this.state.running.get(issueId) !== runningEntry || runningEntry.awaiting_input_since_ms !== null) {
      return false;
    }

    const hardTimeoutMs = this.config.worker_opaque_activity_hard_timeout_ms ?? 1_800_000;
    if (hardTimeoutMs <= 0) {
      return false;
    }

    this.scanCodexSessionTranscriptForToolCalls(runningEntry, observedAtMs);
    if (this.findMissingToolOutputCandidate(runningEntry, observedAtMs, this.config.progress_stalled_waiting_ms ?? 300_000)) {
      return false;
    }

    const activity = this.classifyWorkerActivity(runningEntry, observedAtMs);
    if (activity.activity_state !== 'active_but_opaque' && activity.activity_state !== 'heartbeat_only') {
      return false;
    }
    const lastMeaningfulProgressAtMs = activity.latest_meaningful_progress_at_ms ?? runningEntry.started_at_ms;
    const opaqueElapsedMs = Math.max(0, observedAtMs - lastMeaningfulProgressAtMs);
    if (opaqueElapsedMs <= hardTimeoutMs) {
      return false;
    }

    const handoffProgress = await this.classifyTrackerHandoffProgress(issueId, runningEntry);
    if (handoffProgress?.kind === 'unknown') {
      await this.completeStalledTrackerRefreshUncertain(issueId, runningEntry, handoffProgress.error_detail, observedAtMs, opaqueElapsedMs);
      return true;
    }
    if (handoffProgress?.kind === 'progress') {
      await this.completeStalledReviewHandoff(issueId, runningEntry, handoffProgress, observedAtMs, opaqueElapsedMs);
      return true;
    }

    const detail = [
      'active but opaque hard timeout',
      `reason_code=${REASON_CODES.workerOpaqueActivityHardTimeout}`,
      `activity_state=${activity.activity_state}`,
      `thread_id=${runningEntry.thread_id ?? 'unknown'}`,
      `turn_id=${runningEntry.turn_id ?? 'unknown'}`,
      `session_id=${runningEntry.session_id ?? 'unknown'}`,
      `latest_meaningful_progress_at_ms=${activity.latest_meaningful_progress_at_ms ?? 'unknown'}`,
      `latest_liveness_at_ms=${activity.latest_liveness_at_ms ?? 'unknown'}`,
      `latest_thread_activity_at_ms=${activity.latest_thread_activity_at_ms ?? 'unknown'}`,
      `opaque_elapsed_ms=${opaqueElapsedMs}`,
      `observed_at_ms=${observedAtMs}`
    ].join(' ');
    const terminationResult = await this.ports.terminateWorker({
      issue_id: issueId,
      worker_handle: runningEntry.worker_handle,
      cleanup_workspace: false,
      reason: REASON_CODES.workerOpaqueActivityHardTimeout
    });
    const stalledDetail = workerTerminationResultDetail(detail, terminationResult);

    this.rememberInactiveWorkerPid(runningEntry, REASON_CODES.workerOpaqueActivityHardTimeout);
    this.addRuntimeSecondsFromEntry(runningEntry);
    await this.completeRunRecord(runningEntry, 'stalled', REASON_CODES.workerOpaqueActivityHardTimeout, null, stalledDetail);
    await this.persistExecutionGraphStateTransition(
      runningEntry,
      'failed',
      'failed',
      REASON_CODES.workerOpaqueActivityHardTimeout,
      stalledDetail
    );
    this.state.running.delete(issueId);

    await this.scheduleRetry({
      issue_id: issueId,
      identifier: runningEntry.identifier,
      attempt: runningEntry.retry_attempt + 1,
      issue_run_id: runningEntry.issue_run_id ?? null,
      previous_attempt_id: runningEntry.attempt_id ?? null,
      delay_type: 'failure',
      error: 'active but opaque hard timeout',
      worker_host: runningEntry.worker_host ?? null,
      workspace_path: runningEntry.workspace_path ?? null,
      provisioner_type: runningEntry.provisioner_type ?? null,
      branch_name: runningEntry.branch_name ?? null,
      repo_root: runningEntry.repo_root ?? null,
      workspace_exists: runningEntry.workspace_exists,
      workspace_git_status: runningEntry.workspace_git_status,
      workspace_provisioned: runningEntry.workspace_provisioned,
      workspace_is_git_worktree: runningEntry.workspace_is_git_worktree,
      copy_ignored_applied: runningEntry.copy_ignored_applied,
      copy_ignored_status: runningEntry.copy_ignored_status,
      copy_ignored_summary: runningEntry.copy_ignored_summary,
      stop_reason_code: REASON_CODES.workerOpaqueActivityHardTimeout,
      stop_reason_detail: stalledDetail,
      previous_thread_id: runningEntry.thread_id,
      previous_turn_id: runningEntry.turn_id,
      previous_session_id: runningEntry.session_id,
      last_progress_checkpoint_at: activity.latest_meaningful_progress_at_ms ?? runningEntry.started_at_ms,
      issue_snapshot: runningEntry.issue,
      progress_signals: runningEntry.progress_signals,
      recover_workspace_attempt_residue: true
    });
    this.state.health.last_error = `active but opaque hard timeout for ${runningEntry.identifier}`;
    this.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.orchestration.workerStalled,
      message: 'active but opaque hard timeout; retrying',
      context: {
        issue_id: issueId,
        issue_identifier: runningEntry.identifier,
        session_id: runningEntry.session_id,
        elapsed_ms: opaqueElapsedMs,
        stop_reason_code: REASON_CODES.workerOpaqueActivityHardTimeout,
        ...workerTerminationResultContext(terminationResult)
      }
    });
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.orchestration.workerStalled,
      severity: 'warn',
      issue_identifier: runningEntry.identifier,
      session_id: runningEntry.session_id ?? undefined,
      detail: stalledDetail
    });
    return true;
  }

  private async completeStalledTrackerRefreshUncertain(
    issueId: string,
    runningEntry: RunningEntry,
    errorDetail: string,
    observedAtMs: number,
    elapsedMs: number
  ): Promise<void> {
    const detail = [
      'tracker state refresh failed during stalled-wait recovery',
      `reason_code=${REASON_CODES.issueStateRefreshFailed}`,
      `refresh_error=${errorDetail}`,
      `thread_id=${runningEntry.thread_id ?? 'unknown'}`,
      `turn_id=${runningEntry.turn_id ?? 'unknown'}`,
      `session_id=${runningEntry.session_id ?? 'unknown'}`,
      `elapsed_wait_ms=${elapsedMs}`,
      `observed_at_ms=${observedAtMs}`
    ].join(' ');
    const terminationResult = await this.ports.terminateWorker({
      issue_id: issueId,
      worker_handle: runningEntry.worker_handle,
      cleanup_workspace: false,
      reason: REASON_CODES.turnWaitingThresholdExceeded
    });
    const stalledDetail = workerTerminationResultDetail(detail, terminationResult);

    this.rememberInactiveWorkerPid(runningEntry, REASON_CODES.issueStateRefreshFailed);
    this.addRuntimeSecondsFromEntry(runningEntry);
    await this.completeRunRecord(runningEntry, 'stalled', REASON_CODES.issueStateRefreshFailed, null, stalledDetail);
    await this.persistExecutionGraphStateTransition(
      runningEntry,
      'failed',
      'failed',
      REASON_CODES.issueStateRefreshFailed,
      stalledDetail
    );
    this.state.running.delete(issueId);

    await this.scheduleRetry({
      issue_id: issueId,
      identifier: runningEntry.identifier,
      attempt: runningEntry.retry_attempt + 1,
      issue_run_id: runningEntry.issue_run_id ?? null,
      previous_attempt_id: runningEntry.attempt_id ?? null,
      delay_type: 'failure',
      error: 'tracker state refresh failed during stalled-wait recovery',
      worker_host: runningEntry.worker_host ?? null,
      workspace_path: runningEntry.workspace_path ?? null,
      provisioner_type: runningEntry.provisioner_type ?? null,
      branch_name: runningEntry.branch_name ?? null,
      repo_root: runningEntry.repo_root ?? null,
      workspace_exists: runningEntry.workspace_exists,
      workspace_git_status: runningEntry.workspace_git_status,
      workspace_provisioned: runningEntry.workspace_provisioned,
      workspace_is_git_worktree: runningEntry.workspace_is_git_worktree,
      copy_ignored_applied: runningEntry.copy_ignored_applied,
      copy_ignored_status: runningEntry.copy_ignored_status,
      copy_ignored_summary: runningEntry.copy_ignored_summary,
      stop_reason_code: REASON_CODES.issueStateRefreshFailed,
      stop_reason_detail: stalledDetail,
      previous_thread_id: runningEntry.thread_id,
      previous_turn_id: runningEntry.turn_id,
      previous_session_id: runningEntry.session_id,
      issue_snapshot: runningEntry.issue,
      progress_signals: runningEntry.progress_signals
    });
    this.state.health.last_error = `tracker state refresh failed during stalled-wait recovery for ${runningEntry.identifier}`;
    this.logger?.log({
      level: 'warn',
      event: CANONICAL_EVENT.tracker.stateRefreshFailed,
      message: 'tracker refresh uncertainty scheduled bounded retry',
      context: {
        issue_id: issueId,
        issue_identifier: runningEntry.identifier,
        session_id: runningEntry.session_id,
        elapsed_ms: elapsedMs,
        stop_reason_code: REASON_CODES.issueStateRefreshFailed,
        error: errorDetail,
        ...workerTerminationResultContext(terminationResult)
      }
    });
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.tracker.stateRefreshFailed,
      severity: 'warn',
      issue_identifier: runningEntry.identifier,
      session_id: runningEntry.session_id ?? undefined,
      detail: stalledDetail
    });
  }

  private async classifyTrackerHandoffProgress(
    issueId: string,
    runningEntry: RunningEntry
  ): Promise<
    | { kind: 'progress'; issue: Issue; signals: ProgressSignals; reasons: string[] }
    | { kind: 'unknown'; error_detail: string }
    | null
  > {
    let refreshed: Issue[];
    try {
      refreshed = await this.ports.tracker.fetch_issue_states_by_ids([issueId]);
    } catch (error) {
      const errorDetail = error instanceof Error ? error.message : String(error);
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.tracker.stateRefreshFailed,
        message: 'failed to refresh tracker state before stalled-wait recovery',
        context: {
          issue_id: issueId,
          issue_identifier: runningEntry.identifier,
          error: errorDetail
        }
      });
      return { kind: 'unknown', error_detail: errorDetail };
    }

    const issue = refreshed.find((candidate) => candidate.id === issueId);
    if (!issue) {
      return null;
    }

    const startedState = runningEntry.started_issue_state ?? runningEntry.issue.state;
    if (normalizeStateName(startedState) !== normalizeStateName('Agent Review')) {
      return null;
    }
    if (normalizeStateName(issue.state) === normalizeStateName(startedState)) {
      return null;
    }

    if (!this.isKnownReviewHandoffTransition(startedState, issue.state)) {
      return null;
    }

    const signals: ProgressSignals = {
      commit_sha: null,
      checklist_checkpoint: null,
      state_marker: this.getLastPhaseMarker(issueId)?.phase ?? null,
      tracker_comment_created: this.hasWorkerTrackerCommentSignal(runningEntry),
      tracker_status_transition: `${startedState} -> ${issue.state}`,
      agent_review_handoff: issue.state,
      tracker_started_state: startedState
    };
    const reasons = this.classifyProgressSignals(signals);
    if (!reasons.includes('agent_review_handoff')) {
      return null;
    }
    return { kind: 'progress', issue, signals, reasons };
  }

  private hasWorkerTrackerCommentSignal(runningEntry: RunningEntry): boolean {
    if (runningEntry.progress_signals?.tracker_comment_created) {
      return true;
    }
    return runningEntry.recent_events.some((event) => {
      return this.workerEventLooksLikeTrackerComment(event);
    });
  }

  private captureWorkerProgressSignal(runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent): void {
    if (!this.workerEventLooksLikeTrackerComment(workerEvent)) {
      return;
    }

    runningEntry.progress_signals = {
      commit_sha: runningEntry.progress_signals?.commit_sha ?? null,
      checklist_checkpoint: runningEntry.progress_signals?.checklist_checkpoint ?? null,
      state_marker: runningEntry.progress_signals?.state_marker ?? this.getLastPhaseMarker(runningEntry.issue.id)?.phase ?? null,
      tracker_comment_created: true,
      tracker_status_transition: runningEntry.progress_signals?.tracker_status_transition ?? null,
      agent_review_handoff: runningEntry.progress_signals?.agent_review_handoff ?? null,
      tracker_started_state:
        runningEntry.progress_signals?.tracker_started_state ?? runningEntry.started_issue_state ?? runningEntry.issue.state
    };
  }

  private workerEventLooksLikeTrackerComment(
    workerEvent: Pick<WorkerObservabilityEvent, 'event' | 'tool_name' | 'request_method' | 'request_category'>
  ): boolean {
    const event = workerEvent.event?.toLowerCase() ?? '';
    const toolName = workerEvent.tool_name?.toLowerCase() ?? '';
    const requestMethod = workerEvent.request_method?.toLowerCase() ?? '';
    const requestCategory = workerEvent.request_category?.toLowerCase() ?? '';

    if (event === 'linear.comment.created' || event === 'linear.comment.updated') {
      return true;
    }

    const looksLikeLinearRequest = requestCategory === 'linear' || event.startsWith('linear.');
    return (
      looksLikeLinearRequest &&
      (toolName === 'save_comment' ||
        toolName === 'create_comment' ||
        requestMethod === 'save_comment' ||
        requestMethod === 'create_comment')
    );
  }

  private async completeStalledReviewHandoff(
    issueId: string,
    runningEntry: RunningEntry,
    handoffProgress: { issue: Issue; signals: ProgressSignals; reasons: string[] },
    observedAtMs: number,
    elapsedMs: number
  ): Promise<void> {
    const detail = [
      'Agent Review handoff progress observed before stalled-wait cleanup',
      `reason_code=${REASON_CODES.agentReviewHandoffProgressObserved}`,
      `tracker_status_transition=${handoffProgress.signals.tracker_status_transition ?? 'unknown'}`,
      `thread_id=${runningEntry.thread_id ?? 'unknown'}`,
      `turn_id=${runningEntry.turn_id ?? 'unknown'}`,
      `session_id=${runningEntry.session_id ?? 'unknown'}`,
      `elapsed_wait_ms=${elapsedMs}`,
      `observed_at_ms=${observedAtMs}`
    ].join(' ');
    const terminationResult = await this.ports.terminateWorker({
      issue_id: issueId,
      worker_handle: runningEntry.worker_handle,
      cleanup_workspace: false,
      reason: REASON_CODES.turnWaitingThresholdExceeded
    });
    const terminalDetail = workerTerminationResultDetail(detail, terminationResult);

    this.rememberInactiveWorkerPid(runningEntry, REASON_CODES.turnWaitingThresholdExceeded);
    this.addRuntimeSecondsFromEntry(runningEntry);
    await this.completeRunRecord(
      runningEntry,
      'succeeded',
      REASON_CODES.agentReviewHandoffProgressObserved,
      null,
      terminalDetail
    );
    await this.persistExecutionGraphStateTransition(
      runningEntry,
      'succeeded',
      'succeeded',
      REASON_CODES.agentReviewHandoffProgressObserved,
      terminalDetail
    );
    this.rememberReleasedWorker(runningEntry, REASON_CODES.agentReviewHandoffProgressObserved, false);
    this.state.running.delete(issueId);
    this.state.retry_attempts.delete(issueId);
    this.state.blocked_inputs.delete(issueId);
    this.state.claimed.delete(issueId);
    this.state.redispatch_progress?.delete(issueId);
    await this.clearCircuitBreaker(issueId);

    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.orchestration.agentReviewHandoffProgressObserved,
      severity: 'info',
      issue_identifier: runningEntry.identifier,
      session_id: runningEntry.session_id ?? undefined,
      detail
    });
    this.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.orchestration.agentReviewHandoffProgressObserved,
      message: 'Agent Review handoff progress observed during stalled-wait recovery',
      context: {
        issue_id: issueId,
        issue_identifier: runningEntry.identifier,
        session_id: runningEntry.session_id,
        progress_signal_reasons: handoffProgress.reasons.join(','),
        progress_signals: JSON.stringify(handoffProgress.signals),
        ...workerTerminationResultContext(terminationResult)
      }
    });

    if (isActiveState(handoffProgress.issue.state, this.config) && this.isFreshDispatchState(handoffProgress.issue.state)) {
      this.recordRuntimeEvent({
        event: CANONICAL_EVENT.orchestration.freshDispatchAfterReviewHandoff,
        severity: 'info',
        issue_identifier: runningEntry.identifier,
        detail: `tracker_state=${handoffProgress.issue.state}`
      });
      this.logger?.log({
        level: 'info',
        event: CANONICAL_EVENT.orchestration.freshDispatchAfterReviewHandoff,
        message: 'fresh dispatch after Agent Review handoff',
        context: {
          issue_id: issueId,
          issue_identifier: runningEntry.identifier,
          tracker_state: handoffProgress.issue.state
        }
      });
      await this.dispatchIssue(handoffProgress.issue, null);
    } else {
      this.state.completed.add(issueId);
    }
  }

  private markRunningWaitStallRootCauseIfThresholdExceeded(runningEntry: RunningEntry, observedAtMs: number): void {
    const waitThresholdMs = this.config.progress_stalled_waiting_ms ?? this.config.running_wait_stall_threshold_ms ?? 300_000;
    if (waitThresholdMs <= 0 || runningEntry.awaiting_input_since_ms !== null) {
      return;
    }
    if (runningEntry.last_event !== CANONICAL_EVENT.codex.turnWaiting && runningEntry.running_waiting_started_at_ms == null) {
      return;
    }

    const waitingStartedAtMs =
      runningEntry.running_waiting_started_at_ms ?? runningEntry.last_codex_timestamp_ms ?? runningEntry.started_at_ms;
    const lastMeaningfulActivityAtMs =
      typeof runningEntry.last_progress_transition_at_ms === 'number' &&
      runningEntry.last_progress_transition_at_ms > waitingStartedAtMs
        ? runningEntry.last_progress_transition_at_ms
        : waitingStartedAtMs;
    const thresholdCrossedAtMs = lastMeaningfulActivityAtMs + waitThresholdMs;
    runningEntry.stalled_waiting_since_ms = thresholdCrossedAtMs;
    if (observedAtMs >= thresholdCrossedAtMs) {
      runningEntry.stalled_waiting_reason = REASON_CODES.turnWaitingThresholdExceeded;
    }
  }

  private hasOutstandingToolCallEvidence(runningEntry: RunningEntry): boolean {
    return Object.keys(runningEntry.outstanding_tool_calls ?? {}).length > 0;
  }

  private findMissingToolOutputCandidate(
    runningEntry: RunningEntry,
    observedAtMs: number,
    waitThresholdMs: number
  ): OutstandingToolCall | null {
    const calls = Object.values(runningEntry.outstanding_tool_calls ?? {});
    if (calls.length === 0) {
      return null;
    }
    const eligible = calls
      .filter((call) => observedAtMs - call.started_at_ms >= waitThresholdMs)
      .sort((left, right) => left.started_at_ms - right.started_at_ms);
    return eligible[0] ?? null;
  }

  private scanCodexSessionTranscriptForToolCalls(runningEntry: RunningEntry, observedAtMs: number): void {
    if (!runningEntry.session_id && !runningEntry.thread_id && !runningEntry.turn_id) {
      return;
    }

    const transcriptPaths = this.findCodexSessionTranscriptPaths(runningEntry, observedAtMs);
    if (transcriptPaths.length === 0) {
      return;
    }

    const offsets = (runningEntry.codex_session_transcript_scan_offsets ??= {});
    const reasons = new Set(runningEntry.codex_session_transcript_scan_budget?.reason_codes ?? []);
    let remainingBytes = CODEX_SESSION_TRANSCRIPT_MAX_SCAN_BYTES;
    let bytesRead = 0;
    let filesParsed = 0;
    for (const transcriptPath of transcriptPaths) {
      if (remainingBytes <= 0) {
        reasons.add('transcript_scan_byte_budget_exhausted');
        break;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(transcriptPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }

      const previousOffset = Math.min(offsets[transcriptPath] ?? 0, stat.size);
      let completeContent = '';
      let consumedBytes = 0;
      try {
        const fd = fs.openSync(transcriptPath, 'r');
        try {
          const unreadBytes = Math.max(0, stat.size - previousOffset);
          const bytesToRead = Math.min(unreadBytes, remainingBytes);
          if (bytesToRead < unreadBytes) {
            reasons.add('transcript_scan_byte_budget_exhausted');
          }
          const buffer = Buffer.alloc(bytesToRead);
          fs.readSync(fd, buffer, 0, buffer.length, previousOffset);
          const lastCompleteLineIndex = buffer.lastIndexOf(0x0a);
          if (lastCompleteLineIndex >= 0) {
            consumedBytes = lastCompleteLineIndex + 1;
            completeContent = buffer.subarray(0, consumedBytes).toString('utf8');
          } else if (bytesToRead > 0 && bytesToRead >= remainingBytes) {
            reasons.add('transcript_scan_byte_budget_exhausted');
          }
          remainingBytes -= bytesToRead;
          bytesRead += bytesToRead;
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        continue;
      }

      offsets[transcriptPath] = previousOffset + consumedBytes;
      filesParsed += 1;
      for (const line of completeContent.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const observation = this.readToolCallObservationFromTranscriptRecord(parsed, runningEntry, observedAtMs);
        if (observation) {
          this.applyToolCallLedgerObservation(runningEntry, observation);
        }
      }
    }
    this.updateTranscriptScanBudget(runningEntry, observedAtMs, {
      candidate_count: transcriptPaths.length,
      files_considered: runningEntry.codex_session_transcript_scan_budget?.files_considered ?? transcriptPaths.length,
      files_parsed: filesParsed,
      bytes_read: bytesRead,
      exhausted: reasons.size > 0,
      reason_codes: [...reasons].sort()
    });
  }

  private findCodexSessionTranscriptPaths(runningEntry: RunningEntry, observedAtMs: number): string[] {
    const codexHome = (process.env.SYMPHONY_CODEX_HOME || path.join(process.env.HOME || '', '.codex')).trim();
    if (!codexHome) {
      return [];
    }
    const identityKey = this.transcriptCandidateIdentityKey(runningEntry);
    const cached = runningEntry.codex_session_transcript_candidate_cache;
    if (
      cached &&
      cached.identity_key === identityKey &&
      observedAtMs - cached.refreshed_at_ms < CODEX_SESSION_TRANSCRIPT_CANDIDATE_CACHE_TTL_MS
    ) {
      runningEntry.codex_session_transcript_scan_budget = {
        ...cached,
        observed_at_ms: observedAtMs,
        reason_codes: [...cached.reason_codes],
        limits: { ...cached.limits }
      };
      return [...cached.paths];
    }

    const sessionsRoot = path.join(codexHome, 'sessions');
    let stat: fs.Stats;
    try {
      stat = fs.statSync(sessionsRoot);
    } catch {
      return [];
    }
    if (!stat.isDirectory()) {
      return [];
    }

    const candidates: string[] = [];
    const deadlineAtMs = Date.now() + CODEX_SESSION_TRANSCRIPT_MAX_WALL_CLOCK_MS;
    const reasonCodes = new Set<string>();
    let filesConsidered = 0;
    let filesParsed = 0;
    let remainingProbeBytes = CODEX_SESSION_TRANSCRIPT_MAX_PROBE_BYTES;
    const stack: Array<{ directory: string; depth: number }> = [{ directory: sessionsRoot, depth: 0 }];
    while (
      stack.length > 0 &&
      candidates.length < CODEX_SESSION_TRANSCRIPT_MAX_CANDIDATE_FILES &&
      filesConsidered < CODEX_SESSION_TRANSCRIPT_MAX_DISCOVERY_FILES
    ) {
      if (Date.now() > deadlineAtMs) {
        reasonCodes.add('transcript_discovery_wall_clock_budget_exhausted');
        break;
      }
      const current = stack.pop();
      if (!current) {
        continue;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current.directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (Date.now() > deadlineAtMs) {
          reasonCodes.add('transcript_discovery_wall_clock_budget_exhausted');
          break;
        }
        const entryPath = path.join(current.directory, entry.name);
        if (entry.isDirectory()) {
          if (current.depth < CODEX_SESSION_TRANSCRIPT_MAX_DEPTH) {
            stack.push({ directory: entryPath, depth: current.depth + 1 });
          }
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
          continue;
        }
        if (filesConsidered >= CODEX_SESSION_TRANSCRIPT_MAX_DISCOVERY_FILES) {
          reasonCodes.add('transcript_discovery_file_count_budget_exhausted');
          break;
        }
        filesConsidered += 1;
        if (this.transcriptPathMayMatch(entryPath, runningEntry)) {
          candidates.push(entryPath);
          if (candidates.length >= CODEX_SESSION_TRANSCRIPT_MAX_CANDIDATE_FILES) {
            reasonCodes.add('transcript_candidate_file_budget_exhausted');
            break;
          }
          continue;
        }
        let fileStat: fs.Stats;
        try {
          fileStat = fs.statSync(entryPath);
        } catch {
          continue;
        }
        if (observedAtMs - fileStat.mtimeMs > CODEX_SESSION_TRANSCRIPT_MAX_FILE_AGE_MS) {
          reasonCodes.add('transcript_discovery_age_budget_skipped');
          continue;
        }
        if (!runningEntry.workspace_path && !runningEntry.repo_root) {
          continue;
        }
        if (remainingProbeBytes <= 0) {
          reasonCodes.add('transcript_probe_byte_budget_exhausted');
          continue;
        }
        const probe = this.transcriptContentMayMatch(entryPath, runningEntry, {
          remainingBytes: remainingProbeBytes,
          deadlineAtMs
        });
        remainingProbeBytes = probe.remainingBytes;
        if (probe.bytesRead > 0) {
          filesParsed += 1;
        }
        for (const reason of probe.reasonCodes) {
          reasonCodes.add(reason);
        }
        if (probe.matched) {
          candidates.push(entryPath);
          if (candidates.length >= CODEX_SESSION_TRANSCRIPT_MAX_CANDIDATE_FILES) {
            reasonCodes.add('transcript_candidate_file_budget_exhausted');
            break;
          }
        }
      }
    }
    if (candidates.length >= CODEX_SESSION_TRANSCRIPT_MAX_CANDIDATE_FILES) {
      reasonCodes.add('transcript_candidate_file_budget_exhausted');
    }
    if (filesConsidered >= CODEX_SESSION_TRANSCRIPT_MAX_DISCOVERY_FILES && stack.length > 0) {
      reasonCodes.add('transcript_discovery_file_count_budget_exhausted');
    }
    this.updateTranscriptScanBudget(runningEntry, observedAtMs, {
      candidate_count: candidates.length,
      files_considered: filesConsidered,
      files_parsed: filesParsed,
      bytes_read: CODEX_SESSION_TRANSCRIPT_MAX_PROBE_BYTES - remainingProbeBytes,
      exhausted: reasonCodes.size > 0,
      reason_codes: [...reasonCodes].sort()
    });
    const scanBudget = runningEntry.codex_session_transcript_scan_budget;
    if (!scanBudget) {
      return candidates;
    }
    runningEntry.codex_session_transcript_candidate_cache = {
      ...scanBudget,
      identity_key: identityKey,
      paths: [...candidates],
      refreshed_at_ms: observedAtMs
    };
    return candidates;
  }

  private transcriptPathMayMatch(transcriptPath: string, runningEntry: RunningEntry): boolean {
    const normalized = transcriptPath.toLowerCase();
    return [runningEntry.session_id, runningEntry.thread_id, runningEntry.turn_id].some((identifier) =>
      Boolean(identifier && normalized.includes(identifier.toLowerCase()))
    );
  }

  private transcriptContentMayMatch(
    transcriptPath: string,
    runningEntry: RunningEntry,
    budget: { remainingBytes: number; deadlineAtMs: number }
  ): { matched: boolean; bytesRead: number; remainingBytes: number; reasonCodes: string[] } {
    const reasonCodes: string[] = [];
    if (budget.remainingBytes <= 0) {
      return { matched: false, bytesRead: 0, remainingBytes: 0, reasonCodes: ['transcript_probe_byte_budget_exhausted'] };
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(transcriptPath);
    } catch {
      return { matched: false, bytesRead: 0, remainingBytes: budget.remainingBytes, reasonCodes };
    }
    const bytesToRead = Math.min(stat.size, budget.remainingBytes);
    let content = '';
    try {
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const buffer = Buffer.alloc(bytesToRead);
        fs.readSync(fd, buffer, 0, buffer.length, 0);
        content = buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return { matched: false, bytesRead: 0, remainingBytes: budget.remainingBytes, reasonCodes };
    }
    if (bytesToRead < stat.size) {
      reasonCodes.push('transcript_probe_file_byte_budget_exhausted');
    }
    for (const line of content.split(/\r?\n/)) {
      if (Date.now() > budget.deadlineAtMs) {
        reasonCodes.push('transcript_discovery_wall_clock_budget_exhausted');
        return { matched: false, bytesRead: bytesToRead, remainingBytes: budget.remainingBytes - bytesToRead, reasonCodes };
      }
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const record = asRecord(parsed);
      if (record && this.transcriptRecordMayMatchRunningEntry(record, runningEntry)) {
        return { matched: true, bytesRead: bytesToRead, remainingBytes: budget.remainingBytes - bytesToRead, reasonCodes };
      }
    }
    return { matched: false, bytesRead: bytesToRead, remainingBytes: budget.remainingBytes - bytesToRead, reasonCodes };
  }

  private transcriptCandidateIdentityKey(runningEntry: RunningEntry): string {
    return [
      runningEntry.session_id ?? '',
      runningEntry.thread_id ?? '',
      runningEntry.turn_id ?? '',
      runningEntry.workspace_path ?? '',
      runningEntry.repo_root ?? ''
    ].join('|');
  }

  private updateTranscriptScanBudget(
    runningEntry: RunningEntry,
    observedAtMs: number,
    stats: {
      candidate_count: number;
      files_considered: number;
      files_parsed: number;
      bytes_read: number;
      exhausted: boolean;
      reason_codes: string[];
    }
  ): void {
    runningEntry.codex_session_transcript_scan_budget = {
      observed_at_ms: observedAtMs,
      candidate_count: stats.candidate_count,
      files_considered: stats.files_considered,
      files_parsed: stats.files_parsed,
      bytes_read: stats.bytes_read,
      exhausted: stats.exhausted,
      reason_codes: [...new Set(stats.reason_codes)].sort(),
      limits: {
        max_candidate_files: CODEX_SESSION_TRANSCRIPT_MAX_CANDIDATE_FILES,
        max_discovery_files: CODEX_SESSION_TRANSCRIPT_MAX_DISCOVERY_FILES,
        max_probe_bytes: CODEX_SESSION_TRANSCRIPT_MAX_PROBE_BYTES,
        max_scan_bytes: CODEX_SESSION_TRANSCRIPT_MAX_SCAN_BYTES,
        max_file_age_ms: CODEX_SESSION_TRANSCRIPT_MAX_FILE_AGE_MS,
        max_wall_clock_ms: CODEX_SESSION_TRANSCRIPT_MAX_WALL_CLOCK_MS
      }
    };
  }

  private transcriptRecordMayMatchRunningEntry(record: Record<string, unknown>, runningEntry: RunningEntry): boolean {
    const payload = asRecord(record.payload);
    const item = this.readTranscriptResponseItem(record);
    const threadId = this.readTranscriptString(['thread_id', 'threadId'], record, payload, item);
    const turnId = this.readTranscriptString(['turn_id', 'turnId'], record, payload, item);
    const sessionId = this.readTranscriptString(['session_id', 'sessionId'], record, payload, item);
    if (
      (runningEntry.thread_id && threadId === runningEntry.thread_id) ||
      (runningEntry.turn_id && turnId === runningEntry.turn_id) ||
      (runningEntry.session_id && sessionId === runningEntry.session_id)
    ) {
      return true;
    }

    const activePaths = [runningEntry.workspace_path, runningEntry.repo_root]
      .map((candidate) => candidate?.trim())
      .filter((candidate): candidate is string => Boolean(candidate));
    if (activePaths.length === 0) {
      return false;
    }
    const transcriptPaths = [
      this.readTranscriptString(['cwd', 'workspace_path', 'workspacePath', 'repo_root', 'repoRoot'], record),
      this.readTranscriptString(['cwd', 'workspace_path', 'workspacePath', 'repo_root', 'repoRoot'], payload),
      this.readTranscriptString(['cwd', 'workspace_path', 'workspacePath', 'repo_root', 'repoRoot'], item)
    ]
      .map((candidate) => candidate?.trim())
      .filter((candidate): candidate is string => Boolean(candidate));
    return transcriptPaths.some((candidate) => activePaths.includes(candidate));
  }

  private readTranscriptResponseItem(record: Record<string, unknown>): Record<string, unknown> {
    const payload = asRecord(record.payload);
    const item =
      asRecord(record.response_item) ??
      asRecord(record.responseItem) ??
      asRecord(record.rawResponseItem) ??
      asRecord(record.raw_response_item) ??
      asRecord(record.item);
    if (item) {
      return item;
    }
    const recordType = readString(record.type);
    if (payload && (recordType === 'response_item' || recordType === 'rawResponseItem' || recordType === 'raw_response_item')) {
      return payload;
    }
    return record;
  }

  private readTranscriptString(keys: string[], ...records: Array<Record<string, unknown> | null | undefined>): string | undefined {
    for (const record of records) {
      if (!record) {
        continue;
      }
      for (const key of keys) {
        const value = readString(record[key]);
        if (value) {
          return value;
        }
      }
    }
    return undefined;
  }

  private readToolCallObservationFromTranscriptRecord(
    value: unknown,
    runningEntry: RunningEntry,
    observedAtMs: number
  ): ToolCallLedgerObservation | null {
    const record = asRecord(value);
    if (!record) {
      return null;
    }
    const item = this.readTranscriptResponseItem(record);
    const type = readString(item.type);
    if (type !== 'function_call' && type !== 'function_call_output') {
      return null;
    }
    const callId = readString(item.call_id) ?? readString(item.callId) ?? readString(item.id);
    if (!callId) {
      return null;
    }
    const payload = asRecord(record.payload);
    const threadId = this.readTranscriptString(['thread_id', 'threadId'], record, payload, item);
    const turnId = this.readTranscriptString(['turn_id', 'turnId'], record, payload, item);
    const sessionId = this.readTranscriptString(['session_id', 'sessionId'], record, payload, item);
    const explicitObservedAtMs = readTimestampMs(record) ?? readTimestampMs(item);
    const observedAt = explicitObservedAtMs ?? observedAtMs;
    const classification = this.classifyTranscriptToolCallRecord(
      {
        issue_id: this.readTranscriptString(['issue_id', 'issueId'], record, payload, item),
        issue_identifier: this.readTranscriptString(['issue_identifier', 'issueIdentifier', 'identifier'], record, payload, item),
        run_id: this.readTranscriptString(['run_id', 'runId'], record, payload, item),
        issue_run_id: this.readTranscriptString(['issue_run_id', 'issueRunId'], record, payload, item),
        attempt_id: this.readTranscriptString(['attempt_id', 'attemptId'], record, payload, item),
        codex_app_server_pid: this.readTranscriptPid(record, payload, item),
        thread_id: threadId,
        turn_id: turnId,
        session_id: sessionId,
        observed_at_ms: observedAt
      },
      runningEntry
    );

    this.recordTranscriptToolCallDiagnostic(runningEntry, {
      kind: type,
      call_id: callId,
      tool_name: readString(item.name) ?? readString(item.tool_name) ?? readString(item.toolName) ?? null,
      thread_id: threadId ?? null,
      turn_id: turnId ?? null,
      session_id: sessionId ?? null,
      issue_id: classification.record.issue_id,
      issue_identifier: classification.record.issue_identifier,
      run_id: classification.record.run_id,
      issue_run_id: classification.record.issue_run_id,
      attempt_id: classification.record.attempt_id,
      codex_app_server_pid: classification.record.codex_app_server_pid,
      observed_at_ms: observedAt,
      lineage: classification.lineage,
      reason: classification.reason,
      active_issue_id: runningEntry.issue.id,
      active_issue_identifier: runningEntry.identifier,
      active_run_id: runningEntry.run_id ?? null,
      active_issue_run_id: runningEntry.issue_run_id ?? null,
      active_attempt_id: runningEntry.attempt_id ?? null,
      active_codex_app_server_pid: runningEntry.codex_app_server_pid ?? null,
      active_thread_id: runningEntry.thread_id ?? null,
      active_turn_id: runningEntry.turn_id ?? null,
      active_session_id: runningEntry.session_id ?? null
    });

    if (classification.lineage !== 'active_owned') {
      return null;
    }

    return {
      kind: type,
      call_id: callId,
      tool_name: readString(item.name) ?? readString(item.tool_name) ?? readString(item.toolName) ?? null,
      thread_id: threadId ?? runningEntry.thread_id ?? null,
      turn_id: turnId ?? runningEntry.turn_id ?? null,
      session_id: sessionId ?? runningEntry.session_id ?? null,
      observed_at_ms: explicitObservedAtMs ?? observedAtMs,
      last_agent_message: type === 'function_call' ? runningEntry.last_message ?? null : null,
      evidence_source: 'session_transcript'
    };
  }

  private readTranscriptPid(...records: Array<Record<string, unknown> | null | undefined>): string | null {
    for (const record of records) {
      if (!record) {
        continue;
      }
      for (const key of ['codex_app_server_pid', 'codexAppServerPid', 'app_server_pid', 'appServerPid', 'pid']) {
        const value = record[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
          return String(value);
        }
        const text = readString(value)?.trim();
        if (text) {
          return text;
        }
      }
    }
    return null;
  }

  private classifyTranscriptToolCallRecord(
    record: {
      issue_id?: string | null;
      issue_identifier?: string | null;
      run_id?: string | null;
      issue_run_id?: string | null;
      attempt_id?: string | null;
      codex_app_server_pid?: string | null;
      thread_id?: string | null;
      turn_id?: string | null;
      session_id?: string | null;
      observed_at_ms: number;
    },
    runningEntry: RunningEntry
  ): {
    lineage: TranscriptToolCallLineage;
    reason: string;
    record: {
      issue_id: string | null;
      issue_identifier: string | null;
      run_id: string | null;
      issue_run_id: string | null;
      attempt_id: string | null;
      codex_app_server_pid: string | null;
    };
  } {
    const normalized = {
      issue_id: record.issue_id?.trim() || null,
      issue_identifier: record.issue_identifier?.trim() || null,
      run_id: record.run_id?.trim() || null,
      issue_run_id: record.issue_run_id?.trim() || null,
      attempt_id: record.attempt_id?.trim() || null,
      codex_app_server_pid: record.codex_app_server_pid?.trim() || null,
      thread_id: record.thread_id?.trim() || null,
      turn_id: record.turn_id?.trim() || null,
      session_id: record.session_id?.trim() || null
    };
    const active = {
      issue_id: runningEntry.issue.id,
      issue_identifier: runningEntry.identifier,
      run_id: runningEntry.run_id ?? null,
      issue_run_id: runningEntry.issue_run_id ?? null,
      attempt_id: runningEntry.attempt_id ?? null,
      codex_app_server_pid: runningEntry.codex_app_server_pid ?? null,
      thread_id: runningEntry.thread_id ?? null,
      turn_id: runningEntry.turn_id ?? null,
      session_id: runningEntry.session_id ?? null
    };
    const identifiers: Array<keyof typeof normalized> = [
      'issue_id',
      'issue_identifier',
      'run_id',
      'issue_run_id',
      'attempt_id',
      'codex_app_server_pid',
      'thread_id',
      'turn_id',
      'session_id'
    ];
    const mismatches = identifiers.filter((key) => Boolean(normalized[key] && active[key] && normalized[key] !== active[key]));
    const matches = identifiers.filter((key) => Boolean(normalized[key] && active[key] && normalized[key] === active[key]));
    const hasPidMatch = matches.includes('codex_app_server_pid');
    const hasThreadMatch = matches.includes('thread_id');
    const hasTurnMatch = matches.includes('turn_id');
    const hasSessionMatch = matches.includes('session_id');
    const hasRunMatch = matches.includes('run_id') || matches.includes('issue_run_id') || matches.includes('attempt_id');
    const isPrior = record.observed_at_ms < runningEntry.started_at_ms;
    const lineageRecord = {
      issue_id: normalized.issue_id,
      issue_identifier: normalized.issue_identifier,
      run_id: normalized.run_id,
      issue_run_id: normalized.issue_run_id,
      attempt_id: normalized.attempt_id,
      codex_app_server_pid: normalized.codex_app_server_pid
    };

    if (mismatches.length > 0) {
      return {
        lineage: isPrior ? 'prior_stale' : 'external_manual',
        reason: `mismatched active lineage: ${mismatches.join(',')}`,
        record: lineageRecord
      };
    }

    const ownsKnownTurn = hasThreadMatch && hasTurnMatch;
    const ownsThreadBeforeTurnKnown = hasThreadMatch && !active.turn_id;
    const ownsSessionBeforeThreadKnown = hasSessionMatch && !active.thread_id && !active.turn_id;
    const ownsRunLineage = hasRunMatch && (hasThreadMatch || hasTurnMatch || hasSessionMatch || hasPidMatch);
    if (hasPidMatch || ownsKnownTurn || ownsThreadBeforeTurnKnown || ownsSessionBeforeThreadKnown || ownsRunLineage) {
      return { lineage: 'active_owned', reason: 'matches active runtime lineage', record: lineageRecord };
    }

    if (isPrior) {
      return { lineage: 'prior_stale', reason: 'transcript record predates active run start', record: lineageRecord };
    }
    if (matches.length > 0) {
      return {
        lineage: 'external_manual',
        reason: `partial active lineage is insufficient for ownership: ${matches.join(',')}`,
        record: lineageRecord
      };
    }
    return { lineage: 'unattributed', reason: 'no active runtime lineage identifiers matched', record: lineageRecord };
  }

  private recordTranscriptToolCallDiagnostic(runningEntry: RunningEntry, diagnostic: TranscriptToolCallDiagnostic): void {
    const diagnostics = (runningEntry.transcript_tool_call_diagnostics ??= []);
    diagnostics.push(diagnostic);
    if (diagnostics.length > 200) {
      diagnostics.splice(0, diagnostics.length - 200);
    }
  }

  private async recoverOrBlockMissingToolOutput(
    issueId: string,
    runningEntry: RunningEntry,
    missingToolOutput: OutstandingToolCall,
    observedAtMs: number
  ): Promise<void> {
    const previousThreadId = missingToolOutput.thread_id ?? runningEntry.thread_id ?? null;
    const previousTurnId = missingToolOutput.turn_id ?? runningEntry.turn_id ?? null;
    const previousSessionId = missingToolOutput.session_id ?? runningEntry.session_id ?? null;
    const elapsedWaitMs = Math.max(0, observedAtMs - missingToolOutput.started_at_ms);
    const recoveryPrompt = this.buildMissingToolOutputRecoveryPrompt(runningEntry, missingToolOutput, {
      previousThreadId,
      previousTurnId,
      previousSessionId,
      elapsedWaitMs
    });
    const attemptCount = (runningEntry.recovery?.attempt_count ?? 0) + 1;
    const recovery = this.buildMissingToolOutputRecoveryState(runningEntry, missingToolOutput, {
      observedAtMs,
      previousThreadId,
      previousTurnId,
      previousSessionId,
      elapsedWaitMs,
      attemptCount,
      recoveryPrompt
    });
    const maxRecoveries = Math.max(0, this.config.missing_tool_output_max_recoveries_per_run ?? 1);

    if (attemptCount > maxRecoveries) {
      await this.blockMissingToolOutput(
        issueId,
        runningEntry,
        missingToolOutput,
        observedAtMs,
        REASON_CODES.missingToolOutputRecoveryExhausted,
        'automatic missing-tool-output recovery attempt limit exceeded',
        { ...recovery, last_result: 'blocked', last_result_reason_code: REASON_CODES.missingToolOutputRecoveryExhausted }
      );
      return;
    }

    if (!previousThreadId || !previousTurnId) {
      await this.blockMissingToolOutput(
        issueId,
        runningEntry,
        missingToolOutput,
        observedAtMs,
        REASON_CODES.missingToolOutputRecoveryStartFailed,
        'missing previous thread or turn id for same-thread guarded recovery',
        { ...recovery, last_result: 'failed', last_result_reason_code: REASON_CODES.missingToolOutputRecoveryStartFailed }
      );
      return;
    }

    if (!this.ports.recoverMissingToolOutput) {
      await this.blockMissingToolOutput(issueId, runningEntry, missingToolOutput, observedAtMs);
      return;
    }

    const terminationResult = await this.ports.terminateWorker({
      issue_id: issueId,
      worker_handle: runningEntry.worker_handle,
      cleanup_workspace: false,
      reason: REASON_CODES.missingToolOutputRecoveryInterrupted
    });
    const interruptedRecovery: MissingToolOutputRecoveryState = {
      ...recovery,
      interrupt_cancel_result: {
        status: this.workerTerminationInterruptStatus(terminationResult),
        reason_code: terminationResult.reason_code,
        detail: terminationResult.detail,
        termination_result: terminationResult
      }
    };
    if (!this.workerTerminationAllowsRecovery(terminationResult)) {
      await this.blockMissingToolOutput(
        issueId,
        runningEntry,
        missingToolOutput,
        observedAtMs,
        REASON_CODES.missingToolOutputRecoveryStartFailed,
        `worker interruption not safely confirmed result=${terminationResult.result} reason_code=${terminationResult.reason_code} detail=${terminationResult.detail ?? 'none'}`,
        { ...interruptedRecovery, last_result: 'failed', last_result_reason_code: terminationResult.reason_code, last_result_detail: terminationResult.detail },
        { terminate_worker: false }
      );
      return;
    }
    this.rememberInactiveWorkerPid(runningEntry, REASON_CODES.missingToolOutputRecoveryInterrupted);
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.orchestration.missingToolOutputRecoveryInterruptCompleted,
      severity: 'warn',
      issue_identifier: runningEntry.identifier,
      session_id: previousSessionId ?? undefined,
      detail: `thread_id=${previousThreadId} turn_id=${previousTurnId} tool_name=${missingToolOutput.tool_name} call_id=${missingToolOutput.call_id} termination_result=${terminationResult.result} termination_reason_code=${terminationResult.reason_code}`
    });
    interruptedRecovery.interrupt_cancel_result = {
      status: 'succeeded',
      reason_code: terminationResult.reason_code,
      detail: terminationResult.detail ?? `interrupted previous turn ${previousTurnId ?? 'unknown'} on thread ${previousThreadId ?? 'unknown'}`,
      termination_result: terminationResult
    };

    const recovered = await this.ports.recoverMissingToolOutput({
      issue: runningEntry.issue,
      attempt: runningEntry.retry_attempt,
      worker_host: runningEntry.worker_host ?? null,
      previous_thread_id: previousThreadId,
      previous_turn_id: previousTurnId,
      previous_session_id: previousSessionId,
      recovery_prompt: recoveryPrompt
    }).catch((error) => ({
      ok: false as const,
      error: error instanceof Error ? error.message : 'same-thread guarded recovery threw'
    }));

    if (!recovered.ok) {
      await this.blockMissingToolOutput(
        issueId,
        runningEntry,
        missingToolOutput,
        observedAtMs,
        REASON_CODES.missingToolOutputRecoveryStartFailed,
        recovered.error,
        { ...interruptedRecovery, last_result: 'failed', last_result_reason_code: REASON_CODES.missingToolOutputRecoveryStartFailed }
      );
      return;
    }

    this.addRuntimeSecondsFromEntry(runningEntry);
    await this.completeRunRecord(
      runningEntry,
      'cancelled',
      REASON_CODES.missingToolOutputRecoveryInterrupted,
      { ...interruptedRecovery, last_result: 'started' }
    );
    await this.persistExecutionGraphStateTransition(
      runningEntry,
      'cancelled',
      'cancelled',
      REASON_CODES.missingToolOutputRecoveryInterrupted,
      'stalled turn interrupted for same-thread guarded recovery'
    );

    const recoveryStartedAtMs = this.nowMs();
    this.state.running.set(issueId, {
      ...runningEntry,
      worker_handle: recovered.worker_handle,
      worker_instance_id: recovered.worker_instance_id ?? this.workerInstanceIdFromHandle(recovered.worker_handle),
      monitor_handle: recovered.monitor_handle,
      worker_host: recovered.worker_host ?? runningEntry.worker_host ?? null,
      workspace_path: recovered.workspace_path ?? runningEntry.workspace_path ?? null,
      provisioner_type: recovered.provisioner_type ?? runningEntry.provisioner_type ?? null,
      branch_name: recovered.branch_name ?? runningEntry.branch_name ?? null,
      repo_root: recovered.repo_root ?? runningEntry.repo_root ?? null,
      workspace_exists: recovered.workspace_exists ?? runningEntry.workspace_exists,
      workspace_git_status: recovered.workspace_git_status ?? runningEntry.workspace_git_status,
      workspace_provisioned: recovered.workspace_provisioned ?? runningEntry.workspace_provisioned,
      workspace_is_git_worktree: recovered.workspace_is_git_worktree ?? runningEntry.workspace_is_git_worktree,
      copy_ignored_applied: recovered.copy_ignored_applied ?? runningEntry.copy_ignored_applied,
      copy_ignored_status: recovered.copy_ignored_status ?? runningEntry.copy_ignored_status,
      copy_ignored_summary: recovered.copy_ignored_summary ?? runningEntry.copy_ignored_summary,
      run_id: runningEntry.run_id,
      attempt_id: runningEntry.attempt_id ?? null,
      codex_app_server_pid: null,
      thread_id: previousThreadId,
      turn_id: previousTurnId,
      session_id: previousSessionId,
      last_event: CANONICAL_EVENT.orchestration.missingToolOutputRecoveryStarted,
      last_event_summary: 'missing tool output recovery started',
      last_message: recovery.prompt_summary,
      recent_events: [
        ...runningEntry.recent_events,
        {
          at_ms: recoveryStartedAtMs,
          event: CANONICAL_EVENT.orchestration.missingToolOutputRecoveryStarted,
          message: recovery.prompt_summary
        }
      ].slice(-20),
      started_at_ms: recoveryStartedAtMs,
      last_codex_timestamp_ms: recoveryStartedAtMs,
      last_progress_transition_at_ms: recoveryStartedAtMs,
      running_waiting_started_at_ms: null,
      stalled_waiting_since_ms: null,
      stalled_waiting_reason: null,
      heartbeat_only_event_emitted: false,
      running_wait_stall_event_emitted: false,
      outstanding_tool_calls: {},
      codex_session_transcript_scan_offsets: {},
      ownership_conflict: null,
      recovery: { ...interruptedRecovery, last_result: 'started' }
    });

    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.orchestration.missingToolOutputRecoveryStarted,
      severity: 'warn',
      issue_identifier: runningEntry.identifier,
      session_id: previousSessionId ?? undefined,
      detail: `mode=same_thread_guarded_continuation thread_id=${previousThreadId} previous_turn_id=${previousTurnId} tool_name=${missingToolOutput.tool_name} call_id=${missingToolOutput.call_id} attempt_count=${attemptCount}`
    });
    this.ports.notifyObservers?.();
  }

  private buildMissingToolOutputRecoveryState(
    runningEntry: RunningEntry,
    missingToolOutput: OutstandingToolCall,
    params: {
      observedAtMs: number;
      previousThreadId: string | null;
      previousTurnId: string | null;
      previousSessionId: string | null;
      elapsedWaitMs: number;
      attemptCount: number;
      recoveryPrompt: string;
    }
  ): MissingToolOutputRecoveryState {
    return {
      attempt_count: params.attemptCount,
      started_at_ms: params.observedAtMs,
      reason_code: REASON_CODES.missingToolOutput,
      mode: 'same_thread_guarded_continuation',
      previous_thread_id: params.previousThreadId,
      previous_turn_id: params.previousTurnId,
      previous_session_id: params.previousSessionId,
      previous_worker_handle_known: Boolean(runningEntry.worker_handle),
      previous_codex_app_server_pid: runningEntry.codex_app_server_pid ?? null,
      last_tool_name: missingToolOutput.tool_name,
      last_call_id: missingToolOutput.call_id,
      evidence_source: missingToolOutput.evidence_source,
      elapsed_wait_ms: params.elapsedWaitMs,
      last_agent_message: missingToolOutput.last_agent_message ?? runningEntry.last_message ?? null,
      last_observed_phase: runningEntry.current_phase ?? null,
      last_observed_phase_detail: runningEntry.phase_detail ?? null,
      recent_event_count: runningEntry.recent_events.length,
      quarantined_event_count: runningEntry.quarantined_event_count ?? 0,
      prompt_hash: createHash('sha256').update(params.recoveryPrompt).digest('hex').slice(0, 16),
      prompt_summary: 'guarded recovery prompt: inspect state before retrying indeterminate tool action',
      interrupt_cancel_result: {
        status: 'not_started',
        reason_code: null,
        detail: null
      },
      last_result: 'started'
    };
  }

  private workerTerminationAllowsRecovery(result: WorkerTerminationResult): boolean {
    return (
      result.result === 'succeeded' &&
      result.cancellation_supported &&
      result.cancellation_requested &&
      result.worker_settled === true &&
      (result.forced_kill_requested ? result.forced_kill_settled === true : true)
    );
  }

  private workerTerminationInterruptStatus(
    result: WorkerTerminationResult
  ): NonNullable<MissingToolOutputRecoveryState['interrupt_cancel_result']>['status'] {
    if (this.workerTerminationAllowsRecovery(result)) {
      return 'succeeded';
    }
    if (result.result === 'unknown') {
      return 'unknown';
    }
    return 'failed';
  }

  private buildMissingToolOutputRecoveryPrompt(
    runningEntry: RunningEntry,
    missingToolOutput: OutstandingToolCall,
    params: {
      previousThreadId: string | null;
      previousTurnId: string | null;
      previousSessionId: string | null;
      elapsedWaitMs: number;
    }
  ): string {
    const lastObserved = runningEntry.current_phase
      ? `${runningEntry.current_phase}${runningEntry.phase_detail ? `: ${runningEntry.phase_detail}` : ''}`
      : (runningEntry.last_event_summary ?? runningEntry.last_event ?? 'unknown');
    return [
      'Recover from an interrupted/stalled turn.',
      '',
      'The previous turn stalled while waiting for a tool result. Treat the last tool action outcome as indeterminate unless you can prove otherwise.',
      '',
      'Before retrying anything, inspect current local and external state relevant to the last attempted action.',
      '',
      'If the action already took effect, do not repeat it; continue from the next required workflow step.',
      'If the action did not take effect, retry it once using the normal workflow path.',
      'If the action partially took effect, cannot be verified safely, or retrying could duplicate an external side effect, stop and report the ambiguity with the exact state you found and the required operator action.',
      '',
      'Recovery context:',
      `- issue: ${runningEntry.identifier}/${runningEntry.issue.id}`,
      `- issue state: ${runningEntry.issue.state}`,
      `- run id: ${runningEntry.run_id ?? 'unknown'}`,
      `- attempt id: ${runningEntry.attempt_id ?? 'unknown'}`,
      `- previous thread: ${params.previousThreadId ?? 'unknown'}`,
      `- previous turn: ${params.previousTurnId ?? 'unknown'}`,
      `- previous session: ${params.previousSessionId ?? 'unknown'}`,
      `- worker host: ${runningEntry.worker_host ?? 'unknown'}`,
      `- Codex app-server PID: ${runningEntry.codex_app_server_pid ?? 'unknown'}`,
      `- last tool: ${missingToolOutput.tool_name}`,
      `- last call id: ${missingToolOutput.call_id}`,
      `- evidence source: ${missingToolOutput.evidence_source}`,
      `- elapsed wait: ${Math.round(params.elapsedWaitMs / 1000)}s`,
      `- last observed phase/event: ${lastObserved}`,
      `- last agent message: ${missingToolOutput.last_agent_message ?? runningEntry.last_message ?? 'unknown'}`,
      `- recent event count: ${runningEntry.recent_events.length}`,
      `- quarantined event count: ${runningEntry.quarantined_event_count ?? 0}`
    ].join('\n');
  }

  private async blockMissingToolOutput(
    issueId: string,
    runningEntry: RunningEntry,
    missingToolOutput: OutstandingToolCall,
    observedAtMs: number,
    stopReasonCode: string = REASON_CODES.missingToolOutput,
    stopReasonDetailPrefix: string | null = null,
    recovery: MissingToolOutputRecoveryState | null = null,
    options: { terminate_worker?: boolean } = {}
  ): Promise<void> {
    if (!this.state.running.has(issueId) || this.state.blocked_inputs.has(issueId)) {
      return;
    }

    const elapsedWaitMs = Math.max(0, observedAtMs - missingToolOutput.started_at_ms);
    const recommendedActions =
      stopReasonCode === REASON_CODES.missingToolOutput
        ? ['Inspect the Codex thread', 'Resume the blocked run', 'Cancel the blocked run']
        : [
            'Inspect external state for the last tool action',
            'Manually resume the Codex thread with guarded continuation',
            'Cancel or requeue after inspection'
          ];
    const diagnostic = {
      tool_name: missingToolOutput.tool_name,
      call_id: missingToolOutput.call_id,
      thread_id: missingToolOutput.thread_id ?? runningEntry.thread_id ?? null,
      turn_id: missingToolOutput.turn_id ?? runningEntry.turn_id ?? null,
      session_id: missingToolOutput.session_id ?? runningEntry.session_id ?? null,
      elapsed_wait_ms: elapsedWaitMs,
      last_agent_message: missingToolOutput.last_agent_message ?? runningEntry.last_message ?? null,
      evidence_source: missingToolOutput.evidence_source,
      recommended_actions: recommendedActions
    };
    const detail = [
      ...(stopReasonDetailPrefix ? [stopReasonDetailPrefix] : []),
      `tool_name=${diagnostic.tool_name}`,
      `call_id=${diagnostic.call_id}`,
      `thread_id=${diagnostic.thread_id ?? 'unknown'}`,
      `turn_id=${diagnostic.turn_id ?? 'unknown'}`,
      `session_id=${diagnostic.session_id ?? 'unknown'}`,
      `evidence_source=${diagnostic.evidence_source}`,
      `elapsed_wait_ms=${diagnostic.elapsed_wait_ms}`
    ].join(' ');

    let terminationResult: WorkerTerminationResult | null = null;
    if (options.terminate_worker ?? true) {
      terminationResult = await this.ports.terminateWorker({
        issue_id: issueId,
        worker_handle: runningEntry.worker_handle,
        cleanup_workspace: false,
        reason: stopReasonCode
      });
    }
    const blockDetail = terminationResult ? workerTerminationResultDetail(detail, terminationResult) : detail;

    this.rememberInactiveWorkerPid(runningEntry, stopReasonCode);
    this.addRuntimeSecondsFromEntry(runningEntry);
    await this.completeRunRecord(runningEntry, 'cancelled', stopReasonCode, recovery, blockDetail);
    this.state.running.delete(issueId);

    await this.scheduleBlockedInput({
      issue_id: issueId,
      issue_identifier: runningEntry.identifier,
      attempt: runningEntry.retry_attempt + 1,
      issue_run_id: runningEntry.issue_run_id ?? null,
      previous_attempt_id: runningEntry.attempt_id ?? null,
      worker_host: runningEntry.worker_host ?? null,
      workspace_path: runningEntry.workspace_path ?? null,
      provisioner_type: runningEntry.provisioner_type ?? null,
      branch_name: runningEntry.branch_name ?? null,
      repo_root: runningEntry.repo_root ?? null,
      workspace_exists: runningEntry.workspace_exists,
      workspace_git_status: runningEntry.workspace_git_status,
      workspace_provisioned: runningEntry.workspace_provisioned,
      workspace_is_git_worktree: runningEntry.workspace_is_git_worktree,
      copy_ignored_applied: runningEntry.copy_ignored_applied,
      copy_ignored_status: runningEntry.copy_ignored_status,
      copy_ignored_summary: runningEntry.copy_ignored_summary,
      stop_reason_code: stopReasonCode,
      stop_reason_detail: blockDetail,
      resolution_hints: recommendedActions,
      required_actions: recommendedActions,
      session_console: runningEntry.recent_events,
      previous_thread_id: diagnostic.thread_id,
      previous_turn_id: diagnostic.turn_id,
      previous_session_id: diagnostic.session_id,
      last_progress_checkpoint_at: runningEntry.last_progress_transition_at_ms ?? runningEntry.started_at_ms,
      tool_output_wait: diagnostic,
      transcript_tool_call_diagnostics: runningEntry.transcript_tool_call_diagnostics,
      recovery
    });

    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.orchestration.blockedInputScheduled,
      severity: 'warn',
      issue_identifier: runningEntry.identifier,
      session_id: diagnostic.session_id ?? undefined,
      detail: blockDetail
    });
    await this.persistExecutionGraphStateTransition(
      runningEntry,
      'blocked',
      'blocked',
      stopReasonCode,
      blockDetail
    );
    this.ports.notifyObservers?.();
  }

  private async completeRunRecord(
    runningEntry: RunningEntry,
    terminal_status: 'succeeded' | 'failed' | 'timed_out' | 'stalled' | 'cancelled',
    error_code: string | null,
    recoveryOverride: MissingToolOutputRecoveryState | null = null,
    terminalReasonDetail: string | null = null
  ): Promise<void> {
    if (!runningEntry.run_id || !this.persistence) {
      return;
    }

    const rootCause = this.extractRootCauseDiagnostic(runningEntry, error_code);
    try {
      await this.persistence.completeRun({
        run_id: runningEntry.run_id,
        issue_run_id: runningEntry.issue_run_id,
        attempt_id: runningEntry.attempt_id,
        terminal_status,
        error_code,
        terminal_reason_code: error_code,
        terminal_reason_detail: terminalReasonDetail,
        root_cause_status: rootCause.status,
        root_cause_reason_code: rootCause.reason_code,
        root_cause_reason_detail: rootCause.reason_detail,
        root_cause_at: rootCause.at,
        session_id: rootCause.session_id ?? runningEntry.session_id,
        thread_id: rootCause.thread_id ?? runningEntry.thread_id ?? runningEntry.persisted_thread_id ?? null,
        turn_id: rootCause.turn_id ?? runningEntry.turn_id ?? null,
        missing_tool_output_recovery: this.buildDurableMissingToolOutputRecoveryContext(runningEntry, recoveryOverride)
      });
    } catch (error) {
      await this.recordHistoryWriteFailure('completeRun', error_code ?? REASON_CODES.normalCompletion, error);
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.persistence.completeRunFailed,
        message: `failed to complete durable run record for ${runningEntry.identifier}`,
        context: {
          issue_id: runningEntry.issue.id,
          issue_identifier: runningEntry.identifier,
          session_id: runningEntry.session_id
        }
      });
    }

    await this.persistTicketTerminalOutcome(runningEntry, terminal_status, error_code, terminalReasonDetail, rootCause);
  }

  private async persistTicketTerminalOutcome(
    runningEntry: RunningEntry,
    terminalStatus: 'succeeded' | 'failed' | 'timed_out' | 'stalled' | 'cancelled',
    reasonCode: string | null,
    reasonDetail: string | null,
    rootCause: {
      at: string | null;
      thread_id: string | null;
      turn_id: string | null;
    }
  ): Promise<void> {
    if (!this.persistence?.appendTicketTerminalOutcome || !runningEntry.issue_run_id) {
      return;
    }

    try {
      await this.persistence.appendTicketTerminalOutcome({
        issue_run_id: runningEntry.issue_run_id,
        attempt_id: runningEntry.attempt_id ?? null,
        thread_id: rootCause.thread_id ?? runningEntry.thread_id ?? runningEntry.persisted_thread_id ?? null,
        turn_id: rootCause.turn_id ?? runningEntry.turn_id ?? null,
        outcome: terminalStatus,
        reason_code: reasonCode,
        reason_detail: reasonDetail,
        recorded_at: rootCause.at ?? asIso(this.nowMs())
      });
    } catch (error) {
      await this.recordHistoryWriteFailure('appendTicketTerminalOutcome', reasonCode ?? REASON_CODES.normalCompletion, error);
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.persistence.recordEventFailed,
        message: `failed to persist ticket terminal outcome for ${runningEntry.identifier}`,
        context: {
          issue_id: runningEntry.issue.id,
          issue_identifier: runningEntry.identifier,
          issue_run_id: runningEntry.issue_run_id,
          attempt_id: runningEntry.attempt_id ?? null,
          reason_code: reasonCode,
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  private buildDurableMissingToolOutputRecoveryContext(
    runningEntry: RunningEntry,
    recoveryOverride: MissingToolOutputRecoveryState | null
  ): Record<string, unknown> | null {
    const recovery = recoveryOverride ?? runningEntry.recovery ?? null;
    if (!recovery) {
      return null;
    }
    const replacementThreadId = recovery.replacement_thread_id ?? runningEntry.thread_id ?? recovery.previous_thread_id ?? null;
    const replacementTurnId =
      recovery.replacement_turn_id ??
      (runningEntry.turn_id && runningEntry.turn_id !== recovery.previous_turn_id ? runningEntry.turn_id : null);
    const replacementSessionId =
      recovery.replacement_session_id ??
      (runningEntry.session_id && runningEntry.session_id !== recovery.previous_session_id ? runningEntry.session_id : null);
    return {
      status:
        recovery.last_result === 'started'
          ? 'in_progress'
          : recovery.last_result === 'succeeded'
            ? 'succeeded'
            : recovery.last_result === 'blocked' || recovery.last_result_reason_code === REASON_CODES.missingToolOutputRecoveryUnsafe
              ? 'manual_action_required'
              : 'failed',
      original_tool_name: recovery.last_tool_name,
      original_call_id: recovery.last_call_id,
      evidence_source: recovery.evidence_source,
      elapsed_wait_ms: recovery.elapsed_wait_ms,
      active_ownership: {
        issue_id: runningEntry.issue.id,
        issue_identifier: runningEntry.identifier,
        run_id: runningEntry.run_id ?? null,
        issue_run_id: runningEntry.issue_run_id ?? null,
        attempt_id: runningEntry.attempt_id ?? null,
        thread_id: runningEntry.thread_id ?? null,
        turn_id: runningEntry.turn_id ?? null,
        session_id: runningEntry.session_id ?? null,
        codex_app_server_pid: runningEntry.codex_app_server_pid ?? null,
        app_server_owned: Boolean(runningEntry.codex_app_server_pid || runningEntry.run_id || runningEntry.issue_run_id)
      },
      interrupt_cancel_result: {
        status: recovery.interrupt_cancel_result?.status ?? 'not_started',
        reason_code: recovery.interrupt_cancel_result?.reason_code ?? null,
        detail: recovery.interrupt_cancel_result?.detail ?? null,
        termination_result: recovery.interrupt_cancel_result?.termination_result ?? null
      },
      replacement_turn: {
        thread_id: replacementThreadId,
        turn_id: replacementTurnId,
        session_id: replacementSessionId
      },
      guarded_prompt_dispatch: {
        status:
          recovery.last_result === 'failed' && recovery.last_result_reason_code === REASON_CODES.missingToolOutputRecoveryStartFailed
            ? recovery.interrupt_cancel_result?.status === 'succeeded'
              ? 'failed'
              : 'not_started'
            : recovery.last_result === 'blocked'
              ? 'not_started'
            : 'sent',
        prompt_hash: recovery.prompt_hash,
        prompt_summary: recovery.prompt_summary
      },
      final_outcome: {
        result: recovery.last_result,
        reason_code: recovery.last_result_reason_code ?? null,
        detail: recovery.last_result_detail ?? null
      }
    };
  }

  private extractRootCauseDiagnostic(
    runningEntry: RunningEntry,
    terminalReasonCode: string | null
  ): {
    status: 'blocked' | 'running' | null;
    reason_code: string | null;
    reason_detail: string | null;
    at: string | null;
    session_id: string | null;
    thread_id: string | null;
    turn_id: string | null;
  } {
    if (runningEntry.stalled_waiting_reason) {
      return {
        status: 'blocked',
        reason_code: runningEntry.stalled_waiting_reason,
        reason_detail: runningEntry.last_event_summary ?? runningEntry.last_message ?? null,
        at:
          typeof runningEntry.stalled_waiting_since_ms === 'number'
            ? new Date(runningEntry.stalled_waiting_since_ms).toISOString()
            : null,
        session_id: runningEntry.session_id,
        thread_id: runningEntry.thread_id ?? runningEntry.persisted_thread_id ?? null,
        turn_id: runningEntry.turn_id
      };
    }

    const outstandingToolCall = Object.values(runningEntry.outstanding_tool_calls ?? {}).sort(
      (left, right) => left.started_at_ms - right.started_at_ms
    )[0];
    if (outstandingToolCall && terminalReasonCode !== REASON_CODES.missingToolOutput) {
      return {
        status: 'blocked',
        reason_code: REASON_CODES.missingToolOutput,
        reason_detail: [
          `tool_name=${outstandingToolCall.tool_name}`,
          `call_id=${outstandingToolCall.call_id}`,
          `thread_id=${outstandingToolCall.thread_id ?? runningEntry.thread_id ?? 'unknown'}`,
          `turn_id=${outstandingToolCall.turn_id ?? runningEntry.turn_id ?? 'unknown'}`,
          `session_id=${outstandingToolCall.session_id ?? runningEntry.session_id ?? 'unknown'}`
        ].join(' '),
        at: new Date(outstandingToolCall.started_at_ms).toISOString(),
        session_id: outstandingToolCall.session_id ?? runningEntry.session_id,
        thread_id: outstandingToolCall.thread_id ?? runningEntry.thread_id ?? runningEntry.persisted_thread_id ?? null,
        turn_id: outstandingToolCall.turn_id ?? runningEntry.turn_id
      };
    }

    return {
      status: null,
      reason_code: null,
      reason_detail: null,
      at: null,
      session_id: null,
      thread_id: null,
      turn_id: null
    };
  }


  private recordRuntimeEvent(params: {
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
    protocol_warning?: import('../codex').CodexProtocolWarningEvidence;
    model_reroute?: import('../codex').CodexModelRerouteEvidence | null;
    requested_model?: string | null;
    effective_model?: string | null;
  }): void {
    this.state.recent_runtime_events.push({
      at_ms: this.nowMs(),
      event: params.event,
      severity: params.severity,
      issue_identifier: params.issue_identifier,
      session_id: params.session_id,
      detail: params.detail,
      ...(params.reason_code !== undefined ? { reason_code: params.reason_code } : {}),
      ...(params.request_method !== undefined ? { request_method: params.request_method } : {}),
      ...(params.request_category !== undefined ? { request_category: params.request_category } : {}),
      ...(params.tool_call_id !== undefined ? { tool_call_id: params.tool_call_id } : {}),
      ...(params.tool_name !== undefined ? { tool_name: params.tool_name } : {}),
      ...(params.protocol_warning !== undefined ? { protocol_warning: { ...params.protocol_warning } } : {}),
      ...(params.model_reroute !== undefined
        ? { model_reroute: params.model_reroute ? { ...params.model_reroute } : null }
        : {}),
      ...(params.requested_model !== undefined ? { requested_model: params.requested_model } : {}),
      ...(params.effective_model !== undefined ? { effective_model: params.effective_model } : {})
    });
    if (this.state.recent_runtime_events.length > 50) {
      this.state.recent_runtime_events.splice(0, this.state.recent_runtime_events.length - 50);
    }
  }

  private selectWorkerHost(): string | null {
    const configuredHosts = this.config.worker_hosts ?? [];
    if (!configuredHosts.length) {
      return null;
    }

    if (!this.config.max_concurrent_agents_per_host || this.config.max_concurrent_agents_per_host <= 0) {
      const host = configuredHosts[this.hostRoundRobinIndex % configuredHosts.length] ?? configuredHosts[0];
      this.hostRoundRobinIndex = (this.hostRoundRobinIndex + 1) % configuredHosts.length;
      return host ?? null;
    }

    const hostLimit = this.config.max_concurrent_agents_per_host;
    const currentByHost = new Map<string, number>();
    for (const entry of this.state.running.values()) {
      if (!entry.worker_host) {
        continue;
      }
      currentByHost.set(entry.worker_host, (currentByHost.get(entry.worker_host) ?? 0) + 1);
    }

    for (let offset = 0; offset < configuredHosts.length; offset += 1) {
      const idx = (this.hostRoundRobinIndex + offset) % configuredHosts.length;
      const candidate = configuredHosts[idx];
      if ((currentByHost.get(candidate) ?? 0) < hostLimit) {
        this.hostRoundRobinIndex = (idx + 1) % configuredHosts.length;
        return candidate;
      }
    }

    return null;
  }
}
