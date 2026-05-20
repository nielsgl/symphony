import type { Issue } from '../../tracker';
import type { StructuredLogger } from '../../observability';
import { CANONICAL_EVENT } from '../../observability/events';
import { REASON_CODES } from '../../observability/reason-codes';
import { isActiveState, isTerminalState, shouldDispatchIssue } from '../decisions';
import {
  type OrchestratorOptions,
  type OrchestratorState,
  type RetryDelayType,
  type RetryEntry,
  type ProgressSignals,
  type BudgetRuntimeProjection,
  type MissingToolOutputRecoveryState,
  type CircuitBreakerEntry,
  type DispatchBackpressureState,
  type RedispatchProgressSample
} from '../types';
import {
  buildRetryClearedContext,
  buildRetryClearedDetail,
  emptyDispatchBackpressureState,
  evaluateDispatchBackpressure,
  evaluateRedispatchGate,
  getBackpressureRetryDelayMs,
  isFreshDispatchState
} from './retry-backpressure';
import { cloneDispatchBackpressureState } from './snapshot-cloning';
import type { DispatchGraphContext } from './execution-graph-persistence';

export interface RetryTimerScheduleRetryParams {
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

export interface RetryTimerBlockedInputParams {
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
}

export interface RetryTimerCoordinatorHooks {
  scheduleRetry: (params: RetryTimerScheduleRetryParams) => Promise<void>;
  scheduleBlockedInput: (params: RetryTimerBlockedInputParams) => Promise<{ created: boolean }>;
  dispatchIssue: (
    issue: Issue,
    attempt: number | null,
    resumeContext?: string | null,
    graphContext?: DispatchGraphContext
  ) => Promise<void>;
  workspaceAttemptResidueResumeContext: (retryEntry: RetryEntry) => string | null;
  upsertCircuitBreaker: (entry: CircuitBreakerEntry) => Promise<void>;
  persistExecutionGraphRetryTransition: (
    retryEntry: RetryEntry,
    toStatus: string,
    status: 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'retrying',
    reasonCode: string,
    reasonDetail: string | null
  ) => Promise<void>;
  recordRuntimeEvent: (params: {
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
  }) => void;
}

export interface RetryTimerCoordinatorContext {
  readonly state: OrchestratorState;
  readonly config: OrchestratorOptions['config'];
  readonly tracker: Pick<OrchestratorOptions['ports']['tracker'], 'fetch_candidate_issues' | 'fetch_issue_states_by_ids'>;
  readonly cancelRetryTimer: OrchestratorOptions['ports']['cancelRetryTimer'];
  readonly getControlPlaneHealth?: OrchestratorOptions['ports']['getControlPlaneHealth'];
  readonly getHostLoad?: OrchestratorOptions['ports']['getHostLoad'];
  readonly logger: StructuredLogger | undefined;
  readonly nowMs: () => number;
  readonly hooks: RetryTimerCoordinatorHooks;
}

export async function coordinateRetryTimer(context: RetryTimerCoordinatorContext, issue_id: string): Promise<void> {
  const { state } = context;
  if (state.blocked_inputs.has(issue_id)) {
    return;
  }

  const retryEntry = state.retry_attempts.get(issue_id);
  if (!retryEntry) {
    return;
  }

  state.retry_attempts.delete(issue_id);

  if (retryEntry.stop_reason_code === REASON_CODES.issueStateRefreshFailed) {
    await coordinateTrackerRefreshRetryTimer(context, issue_id, retryEntry);
    return;
  }

  let candidates: Issue[];
  try {
    candidates = await context.tracker.fetch_candidate_issues();
  } catch (error) {
    context.logger?.log({
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
    context.hooks.recordRuntimeEvent({
      event: CANONICAL_EVENT.tracker.retryFetchFailed,
      severity: 'warn',
      issue_identifier: retryEntry.identifier,
      detail: error instanceof Error ? error.message : 'unknown'
    });
    await context.hooks.scheduleRetry({
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
    recordRetryCleared(context, retryEntry, {
      cleanup_reason: 'active_candidate_missing',
      observed_tracker_state: null
    });
    state.claimed.delete(issue_id);
    return;
  }

  if (!isActiveState(issue.state, context.config)) {
    recordRetryCleared(context, retryEntry, {
      cleanup_reason: isTerminalState(issue.state, context.config) ? 'tracker_state_terminal' : 'tracker_state_non_active',
      observed_tracker_state: issue.state
    });
    state.claimed.delete(issue_id);
    return;
  }

  const freshDispatch = isFreshDispatchState(issue.state, context.config);
  const eligibility = shouldDispatchIssue(issue, state, context.config, {
    skipClaimCheckForIssueId: issue_id
  });

  if (!eligibility.eligible) {
    if (eligibility.reason === 'global_slots_exhausted' || eligibility.reason === 'state_slots_exhausted') {
      await context.hooks.scheduleRetry({
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
      state.claimed.delete(issue_id);
    }

    return;
  }

  const backpressure = evaluateDispatchBackpressure({
    config: context.config,
    runningCount: state.running.size,
    getControlPlaneHealth: () => context.getControlPlaneHealth?.(),
    getHostLoad: () => context.getHostLoad?.(),
    nowMs: context.nowMs
  });
  if (backpressure.active) {
    await delayRetryForBackpressure(context, issue, retryEntry, backpressure, freshDispatch);
    return;
  }
  state.health.dispatch_backpressure = emptyDispatchBackpressureState(getBackpressureRetryDelayMs(context.config));

  if (freshDispatch) {
    state.claimed.delete(issue_id);
    await context.hooks.dispatchIssue(issue, null);
    return;
  }

  if (
    retryEntry.stop_reason_code === REASON_CODES.dispatchBackpressureControlPlane ||
    retryEntry.stop_reason_code === REASON_CODES.dispatchBackpressureHostLoad
  ) {
    state.claimed.delete(issue_id);
    await context.hooks.dispatchIssue(issue, retryEntry.attempt, context.hooks.workspaceAttemptResidueResumeContext(retryEntry), {
      issue_run_id: retryEntry.issue_run_id,
      previous_attempt_id: retryEntry.previous_attempt_id,
      recover_workspace_attempt_residue: retryEntry.recover_workspace_attempt_residue ?? false
    });
    return;
  }

  const progressMap = state.redispatch_progress ?? new Map<string, RedispatchProgressSample[]>();
  state.redispatch_progress = progressMap;
  const gateEvaluation = evaluateRedispatchGate({
    issue_id,
    retryEntry,
    issue,
    config: context.config,
    progressMap,
    nowMs: context.nowMs()
  });
  if (!gateEvaluation.allow_redispatch) {
    const stopReasonCode = gateEvaluation.awaiting_human_review_scope_incomplete
      ? REASON_CODES.awaitingHumanReviewScopeIncomplete
      : REASON_CODES.operatorNoProgressRedispatchBlocked;
    const stopReasonDetail = gateEvaluation.awaiting_human_review_scope_incomplete
      ? 'PR is open but scope is incomplete and no progress signal was detected'
      : 'completion gate blocked redispatch because no progress signal was detected';
    let blockedResult: { created: boolean };
    if (gateEvaluation.awaiting_human_review_scope_incomplete) {
      blockedResult = await context.hooks.scheduleBlockedInput({
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
      const existingRetry = state.retry_attempts.get(issue_id);
      if (existingRetry) {
        context.cancelRetryTimer(existingRetry.timer_handle);
        state.retry_attempts.delete(issue_id);
      }
      state.claimed.delete(issue_id);
      await context.hooks.upsertCircuitBreaker({
        issue_id,
        issue_identifier: retryEntry.identifier,
        breaker_active: true,
        breaker_hit_count: Math.max(1, gateEvaluation.attempt_count_window),
        breaker_window_minutes: Math.max(1, gateEvaluation.window_minutes),
        breaker_first_hit_at_ms: context.nowMs(),
        breaker_last_hit_at_ms: context.nowMs()
      });
      blockedResult = { created: true };
    }
    await context.hooks.persistExecutionGraphRetryTransition(
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
      context.hooks.recordRuntimeEvent({
        event: eventName,
        severity: 'warn',
        issue_identifier: retryEntry.identifier,
        detail: stopReasonDetail
      });
      context.logger?.log({
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
      context.hooks.recordRuntimeEvent({
        event: CANONICAL_EVENT.orchestration.redispatchCircuitBreakerOpened,
        severity: 'warn',
        issue_identifier: retryEntry.identifier,
        detail: 'respawn circuit breaker opened'
      });
      context.logger?.log({
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
    context.hooks.recordRuntimeEvent({
      event: CANONICAL_EVENT.orchestration.noProgressBlockSuppressed,
      severity: 'info',
      issue_identifier: retryEntry.identifier,
      detail: `progress_signals=${gateEvaluation.progress_signal_reasons.join(',')}`
    });
    context.logger?.log({
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

  state.claimed.delete(issue_id);
  await context.hooks.dispatchIssue(issue, retryEntry.attempt, context.hooks.workspaceAttemptResidueResumeContext(retryEntry), {
    issue_run_id: retryEntry.issue_run_id,
    previous_attempt_id: retryEntry.previous_attempt_id,
    recover_workspace_attempt_residue: retryEntry.recover_workspace_attempt_residue ?? false
  });
}

async function coordinateTrackerRefreshRetryTimer(
  context: RetryTimerCoordinatorContext,
  issue_id: string,
  retryEntry: RetryEntry
): Promise<void> {
  let refreshedIssues: Issue[];
  try {
    refreshedIssues = await context.tracker.fetch_issue_states_by_ids([issue_id]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown';
    context.logger?.log({
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
    context.hooks.recordRuntimeEvent({
      event: CANONICAL_EVENT.tracker.stateRefreshFailed,
      severity: 'warn',
      issue_identifier: retryEntry.identifier,
      detail
    });
    await context.hooks.scheduleRetry({
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
    recordRetryCleared(context, retryEntry, {
      cleanup_reason: 'active_candidate_missing',
      observed_tracker_state: null
    });
    context.state.claimed.delete(issue_id);
    return;
  }

  if (!isActiveState(issue.state, context.config)) {
    recordRetryCleared(context, retryEntry, {
      cleanup_reason: isTerminalState(issue.state, context.config) ? 'tracker_state_terminal' : 'tracker_state_non_active',
      observed_tracker_state: issue.state
    });
    context.state.claimed.delete(issue_id);
    return;
  }

  if (isFreshDispatchState(issue.state, context.config)) {
    context.state.claimed.delete(issue_id);
    await context.hooks.dispatchIssue(issue, null);
    return;
  }

  await context.hooks.scheduleRetry({
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

function recordRetryCleared(
  context: RetryTimerCoordinatorContext,
  retryEntry: RetryEntry,
  params: {
    cleanup_reason: 'active_candidate_missing' | 'tracker_state_terminal' | 'tracker_state_non_active';
    observed_tracker_state: string | null;
  }
): void {
  const retryContext = buildRetryClearedContext(retryEntry, params);
  context.logger?.log({
    level: 'info',
    event: CANONICAL_EVENT.tracker.retryCleared,
    message: 'retry cleared without redispatch',
    context: retryContext
  });
  context.hooks.recordRuntimeEvent({
    event: CANONICAL_EVENT.tracker.retryCleared,
    severity: 'info',
    issue_identifier: retryEntry.identifier,
    detail: buildRetryClearedDetail(retryEntry, retryContext)
  });
}

async function delayRetryForBackpressure(
  context: RetryTimerCoordinatorContext,
  issue: Issue,
  retryEntry: RetryEntry,
  backpressure: DispatchBackpressureState,
  freshDispatch: boolean
): Promise<void> {
  recordDispatchBackpressure(context, issue, backpressure, retryEntry.attempt);
  await context.hooks.scheduleRetry({
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

function recordDispatchBackpressure(
  context: RetryTimerCoordinatorContext,
  issue: Issue,
  backpressure: DispatchBackpressureState,
  attempt: number | null
): void {
  context.state.health.dispatch_backpressure = cloneDispatchBackpressureState(backpressure);
  context.state.health.last_error = `dispatch backpressure active for ${issue.identifier}: ${backpressure.reason_code}`;
  context.logger?.log({
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
  context.hooks.recordRuntimeEvent({
    event: CANONICAL_EVENT.orchestration.dispatchBackpressureActive,
    severity: 'warn',
    issue_identifier: issue.identifier,
    detail: `${backpressure.reason_code}: ${backpressure.reason_detail ?? 'dispatch delayed'}`
  });
}
