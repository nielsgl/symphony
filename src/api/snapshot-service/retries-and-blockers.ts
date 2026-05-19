import type { CircuitBreakerEntry, OrchestratorState } from '../../orchestrator';
import { explainOperatorRuntimeState, getReasonCodeDefinition, REASON_CODES, toOperatorExplainerHint } from '../../observability';
import type { ApiBlockedRootCauseProjection, ApiCurrentOperatorBlockProjection, ApiStateResponse } from '../types';
import { defaultBudgetProjection } from './budget';
import { projectOperatorActions } from './operator-actions';
import { projectTranscriptToolCallDiagnosticSummary } from './transcript-diagnostics';
import { asIsoDate } from './time';

export function normalizeReasonDetail(detail: string): string {
  return detail.trim().replace(/\s+/g, ' ');
}

export function resolveFailedPhaseReasonCode(detail: string): string {
  const normalized = normalizeReasonDetail(detail);
  if (normalized.includes('worktree_dirty_repo')) {
    return 'worktree_dirty_repo';
  }
  const match = normalized.match(/(?:^|[:\s])([a-z][a-z0-9_]+)(?:[:\s]|$)/);
  return match?.[1] ?? 'failed_phase';
}

export function summarizeRootCause(reasonCode: string, detail: string): Pick<ApiBlockedRootCauseProjection, 'summary' | 'remediation_hint'> {
  if (reasonCode === 'worktree_dirty_repo') {
    return {
      summary: 'Workspace provisioning failed: repo root has uncommitted or untracked files.',
      remediation_hint: 'Clean, commit, or ignore the dirty repo files, then requeue or resume.'
    };
  }
  return {
    summary: `Original failure: ${normalizeReasonDetail(detail)}`,
    remediation_hint: null
  };
}

export function projectCurrentOperatorBlock(entry: { stop_reason_code: string; stop_reason_detail?: string | null }): ApiCurrentOperatorBlockProjection {
  return {
    reason_code: entry.stop_reason_code,
    detail: entry.stop_reason_detail ?? null
  };
}

export function projectCircuitBreakerMetadata(entry: CircuitBreakerEntry) {
  return {
    breaker_active: entry.breaker_active,
    breaker_hit_count: entry.breaker_hit_count,
    breaker_window_minutes: entry.breaker_window_minutes,
    breaker_first_hit_at: entry.breaker_first_hit_at_ms ? asIsoDate(entry.breaker_first_hit_at_ms) : null,
    breaker_last_hit_at: entry.breaker_last_hit_at_ms ? asIsoDate(entry.breaker_last_hit_at_ms) : null
  };
}

export function projectNoProgressCircuitBreakerFault(
  entry: CircuitBreakerEntry,
  state: OrchestratorState,
  nowMs: number
): ApiStateResponse['blocked'][number] {
  const definition = getReasonCodeDefinition(REASON_CODES.operatorNoProgressRedispatchBlocked);
  const detail =
    definition?.detail ??
    'Completion gate stopped redispatch because no progress signal was detected; no answerable input payload is pending.';
  const observedAtMs = entry.breaker_last_hit_at_ms ?? entry.breaker_first_hit_at_ms ?? nowMs;
  return {
    ...defaultBudgetProjection(),
    ...projectCircuitBreakerMetadata(entry),
    issue_id: entry.issue_id,
    issue_identifier: entry.issue_identifier,
    attempt: 0,
    blocked_at: asIsoDate(observedAtMs),
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
    stop_reason_code: REASON_CODES.operatorNoProgressRedispatchBlocked,
    stop_reason_detail: detail,
    worker_termination_result: null,
    conflict_files: [],
    resolution_hints: [...(definition?.recommended_actions ?? [])],
    previous_thread_id: null,
    previous_session_id: null,
    last_phase: null,
    last_phase_at: null,
    last_phase_detail: null,
    root_cause: null,
    current_operator_block: {
      reason_code: REASON_CODES.operatorNoProgressRedispatchBlocked,
      detail
    },
    requires_manual_resume: false,
    awaiting_operator: false,
    awaiting_operator_reason_code: REASON_CODES.operatorNoProgressRedispatchBlocked,
    awaiting_operator_since: asIsoDate(observedAtMs),
    awaiting_operator_resume_nonce: 0,
    quarantined_event_count: 0,
    last_quarantined_event_at: null,
    pending_input: null,
    tool_output_wait: null,
    transcript_tool_call_diagnostic_summary: projectTranscriptToolCallDiagnosticSummary({
      issue_identifier: entry.issue_identifier
    }),
    last_input_submit: null,
    resume_history: [],
    session_console: [],
    turn_control_state: 'automation_fault',
    turn_control_reason_code: REASON_CODES.operatorNoProgressRedispatchBlocked,
    turn_control_since_ms: observedAtMs,
    progress_signal_state: 'stalled_waiting',
    last_progress_transition_at_ms: null,
    last_heartbeat_at_ms: observedAtMs,
    ownership_conflict: null,
    operator_actions: projectOperatorActions(state, entry.issue_id),
    recovery: null,
    missing_tool_output_recovery: null,
    operator_explainer_hint: toOperatorExplainerHint(
      explainOperatorRuntimeState({
        state_class: 'blocked',
        reason_code: REASON_CODES.operatorNoProgressRedispatchBlocked,
        reason_detail: detail
      })
    )
  };
}

export function projectRetryTiming(dueAtMs: number, nowMs: number) {
  const overdueMs = Math.max(0, nowMs - dueAtMs);
  const retryWaitMs = Math.max(0, dueAtMs - nowMs);
  return {
    due_at_ms: dueAtMs,
    due_state: overdueMs > 0 ? ('overdue' as const) : ('pending' as const),
    overdue_ms: overdueMs > 0 ? overdueMs : null,
    retry_wait_ms: retryWaitMs > 0 ? retryWaitMs : null
  };
}

export function projectRetryExplainer(
  entry: {
    due_at_ms: number;
    stop_reason_code?: string | null;
    stop_reason_detail?: string | null;
    error?: string | null;
  },
  nowMs: number
) {
  const timing = projectRetryTiming(entry.due_at_ms, nowMs);
  return explainOperatorRuntimeState({
    state_class: 'retrying',
    reason_code: entry.stop_reason_code,
    reason_detail: entry.stop_reason_detail ?? entry.error,
    expected_transition_detail:
      timing.due_state === 'overdue'
        ? `Retry due time passed ${timing.overdue_ms}ms ago; dispatch may be stuck`
        : `Automatic retry at ${asIsoDate(entry.due_at_ms)}`
  });
}

export function projectRetryCause(
  entry: {
    due_at_ms: number;
    stop_reason_code?: string | null;
    stop_reason_detail?: string | null;
    error?: string | null;
    last_phase?: import('../../observability').PhaseMarkerName | null;
  },
  nowMs: number
) {
  const timing = projectRetryTiming(entry.due_at_ms, nowMs);
  const explainer = projectRetryExplainer(entry, nowMs);
  const definition = getReasonCodeDefinition(entry.stop_reason_code);
  return {
    reason_code: entry.stop_reason_code ?? null,
    detail: entry.stop_reason_detail ?? entry.error ?? null,
    operator_detail: definition?.detail ?? explainer.detail,
    headline: explainer.headline,
    expected_transition: explainer.expected_transition,
    last_phase: entry.last_phase ?? null,
    ...timing
  };
}

export function projectBlockedRootCause(entry: {
  last_phase?: import('../../observability').PhaseMarkerName | null;
  last_phase_detail?: string | null;
  stop_reason_code: string;
  stop_reason_detail?: string | null;
}): ApiBlockedRootCauseProjection | null {
  if (entry.last_phase !== 'failed' || !entry.last_phase_detail?.trim()) {
    return null;
  }
  const detail = normalizeReasonDetail(entry.last_phase_detail);
  const reasonCode = resolveFailedPhaseReasonCode(detail);
  const summary = summarizeRootCause(reasonCode, detail);
  return {
    phase: entry.last_phase,
    reason_code: reasonCode,
    detail,
    ...summary,
    differs_from_current_operator_block:
      reasonCode !== entry.stop_reason_code && detail !== normalizeReasonDetail(entry.stop_reason_detail ?? '')
  };
}
