import type { OrchestratorState, RunningEntry } from '../orchestrator';
import { explainOperatorRuntimeState, REASON_CODES, toOperatorExplainerHint } from '../observability';
import { redactUnknown } from '../security/redaction';
import { LocalApiError } from './errors';
import {
  createApiDegradedDiagnostics,
  resolveBlockedProgressSignal,
  resolveBlockedTurnControl,
  resolveNotBlockedExplainer,
  resolveProgressSignal,
  resolveRunningTurnControl,
  resolveSnapshotFreshness,
  resolveTokenTelemetryQuality
} from './runtime-visibility';
import type { ApiBudgetProjection, ApiIssueResponse, ApiStateResponse } from './types';

function asIsoDate(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function redactPromptPreview(input: string | null | undefined): string | null {
  if (!input) {
    return null;
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  const redacted = trimmed
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '***REDACTED***')
    .replace(/\b(?:bearer\s+)?(?:sk|api|token|key)[_-]?[a-z0-9]*[:=]\s*[^\s,;]+/gi, '***REDACTED***')
    .replace(/\b(?:password|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=***REDACTED***');
  const truncated = Array.from(redacted).slice(0, 160).join('').trim();
  return truncated && truncated !== '***REDACTED***' ? truncated : null;
}

function projectOperatorActions(state: OrchestratorState, issueId: string) {
  return (state.operator_actions?.get(issueId) ?? []).map((action) => ({ ...action }));
}

function resolveStateFreshness(state: OrchestratorState, nowMs: number) {
  return resolveSnapshotFreshness(state.snapshot_generated_at_ms ?? nowMs, nowMs);
}

function defaultBudgetProjection(windowMinutes = 1440): ApiBudgetProjection {
  return {
    budget_usage_tokens: null,
    budget_limit_tokens: null,
    budget_window_minutes: windowMinutes,
    budget_status: 'ok' as const,
    budget_policy: null,
    budget_message: null
  };
}

function projectBudget(entry: { budget?: ApiBudgetProjection | null }): ApiBudgetProjection {
  return entry.budget ? { ...entry.budget } : defaultBudgetProjection();
}

function explainRunningEntry(entry: RunningEntry) {
  return explainOperatorRuntimeState({
    state_class: 'running',
    awaiting_input: Boolean(entry.awaiting_input_since_ms),
    stalled_waiting: Boolean(entry.stalled_waiting_since_ms && entry.stalled_waiting_reason),
    stalled_waiting_reason: entry.stalled_waiting_reason ?? null,
    reason_code:
      entry.stalled_waiting_since_ms && entry.stalled_waiting_reason
        ? entry.stalled_waiting_reason
        : entry.awaiting_input_since_ms
          ? REASON_CODES.turnInputRequired
          : null,
    reason_detail:
      entry.stalled_waiting_since_ms && entry.stalled_waiting_reason
        ? 'codex.turn.waiting heartbeat loop exceeded threshold'
        : entry.awaiting_input_since_ms
          ? entry.pending_input_preview?.type ?? null
          : entry.last_event_summary ?? entry.last_message
  });
}

function toStateRunningRow(
  issueId: string,
  entry: RunningEntry,
  nowMs: number,
  operatorActions: OrchestratorState['operator_actions']
): ApiStateResponse['running'][number] {
  const awaitingInput = Boolean(entry.awaiting_input_since_ms);
  const stalledWaiting = Boolean(entry.stalled_waiting_since_ms && entry.stalled_waiting_reason);
  const progressSignal = resolveProgressSignal(entry);
  const turnControl = resolveRunningTurnControl(entry);
  const notBlockedExplainer = resolveNotBlockedExplainer({
    blocked: false,
    progress_signal_state: progressSignal.progress_signal_state,
    awaiting_input: awaitingInput,
    waiting_started_at_ms: entry.running_waiting_started_at_ms ?? null,
    now_ms: nowMs,
    stalled_waiting_ms: 300_000
  });
  const operatorExplainer = explainRunningEntry(entry);
  return {
    issue_id: issueId,
    issue_identifier: entry.identifier,
    ...projectBudget(entry),
    state: entry.issue.state,
    session_id: entry.session_id,
    worker_host: entry.worker_host ?? null,
    workspace_path: entry.workspace_path ?? null,
    provisioner_type: entry.provisioner_type ?? null,
    branch_name: entry.branch_name ?? null,
    repo_root: entry.repo_root ?? null,
    workspace_exists: entry.workspace_exists,
    workspace_git_status: entry.workspace_git_status ?? null,
    workspace_provisioned: entry.workspace_provisioned,
    workspace_is_git_worktree: entry.workspace_is_git_worktree,
    copy_ignored_applied: entry.copy_ignored_applied ?? false,
    copy_ignored_status: entry.copy_ignored_status ?? null,
    copy_ignored_summary: entry.copy_ignored_summary ?? null,
    thread_id: entry.thread_id,
    turn_id: entry.turn_id,
    codex_app_server_pid: entry.codex_app_server_pid,
    turn_count: entry.turn_count,
    last_event: entry.last_event,
    last_event_summary: entry.last_event_summary,
    last_message: entry.last_message,
    awaiting_input: awaitingInput,
    awaiting_input_since_ms: entry.awaiting_input_since_ms ?? null,
    pending_input_preview: entry.pending_input_preview
      ? {
          type: entry.pending_input_preview.type,
          prompt_preview: redactPromptPreview(entry.pending_input_preview.prompt_preview),
          option_count: typeof entry.pending_input_preview.option_count === 'number' ? entry.pending_input_preview.option_count : null
        }
      : null,
    stalled_waiting: stalledWaiting,
    stalled_waiting_since_ms: stalledWaiting ? entry.stalled_waiting_since_ms ?? null : null,
    stalled_waiting_reason: stalledWaiting ? REASON_CODES.turnWaitingThresholdExceeded : null,
    current_phase: entry.current_phase ?? null,
    current_phase_at: entry.current_phase_at_ms ? asIsoDate(entry.current_phase_at_ms) : null,
    phase_elapsed_ms: entry.current_phase_at_ms ? Math.max(0, nowMs - entry.current_phase_at_ms) : null,
    phase_detail: entry.phase_detail ?? null,
    started_at: asIsoDate(entry.started_at_ms),
    last_event_at: entry.last_codex_timestamp_ms !== null ? asIsoDate(entry.last_codex_timestamp_ms) : null,
    token_telemetry_status: entry.token_telemetry_status,
    token_telemetry_last_source: entry.token_telemetry_last_source,
    token_telemetry_last_at_ms: entry.token_telemetry_last_at_ms,
    ...turnControl,
    ...progressSignal,
    ...resolveTokenTelemetryQuality(entry),
    ...notBlockedExplainer,
    operator_actions: (operatorActions?.get(issueId) ?? []).map((action) => ({ ...action })),
    tokens: {
      input_tokens: entry.tokens.input_tokens,
      output_tokens: entry.tokens.output_tokens,
      total_tokens: entry.tokens.total_tokens,
      ...(typeof entry.tokens.cached_input_tokens === 'number'
        ? { cached_input_tokens: entry.tokens.cached_input_tokens }
        : {}),
      ...(typeof entry.tokens.reasoning_output_tokens === 'number'
        ? { reasoning_output_tokens: entry.tokens.reasoning_output_tokens }
        : {}),
      ...(typeof entry.tokens.model_context_window === 'number'
        ? { model_context_window: entry.tokens.model_context_window }
        : {})
    },
    operator_explainer_hint: toOperatorExplainerHint(operatorExplainer)
  };
}

export interface SnapshotServiceOptions {
  nowMs?: () => number;
}

export class SnapshotService {
  private readonly nowMs: () => number;

  constructor(options: SnapshotServiceOptions = {}) {
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  projectState(state: OrchestratorState): ApiStateResponse {
    const nowMs = this.nowMs();
    const freshness = resolveStateFreshness(state, nowMs);
    const running = Array.from(state.running.entries()).map(([issueId, entry]) =>
      toStateRunningRow(issueId, entry, nowMs, state.operator_actions)
    );
    const retrying = Array.from(state.retry_attempts.values()).map((entry) => ({
      ...projectBudget(entry),
      issue_id: entry.issue_id,
      issue_identifier: entry.identifier,
      attempt: entry.attempt,
      due_at: asIsoDate(entry.due_at_ms),
      error: entry.error,
      worker_host: entry.worker_host ?? null,
      workspace_path: entry.workspace_path ?? null,
      provisioner_type: entry.provisioner_type ?? null,
      branch_name: entry.branch_name ?? null,
      repo_root: entry.repo_root ?? null,
      workspace_exists: entry.workspace_exists,
      workspace_git_status: entry.workspace_git_status ?? null,
      workspace_provisioned: entry.workspace_provisioned,
      workspace_is_git_worktree: entry.workspace_is_git_worktree,
      copy_ignored_applied: entry.copy_ignored_applied ?? false,
      copy_ignored_status: entry.copy_ignored_status ?? null,
      copy_ignored_summary: entry.copy_ignored_summary ?? null,
      stop_reason_code: entry.stop_reason_code ?? null,
      stop_reason_detail: entry.stop_reason_detail ?? null,
      previous_thread_id: entry.previous_thread_id ?? null,
      previous_session_id: entry.previous_session_id ?? null,
      last_phase: entry.last_phase ?? null,
      last_phase_at: entry.last_phase_at_ms ? asIsoDate(entry.last_phase_at_ms) : null,
      last_phase_detail: entry.last_phase_detail ?? null,
      operator_explainer_hint: toOperatorExplainerHint(
        explainOperatorRuntimeState({
          state_class: 'retrying',
          reason_code: entry.stop_reason_code,
          reason_detail: entry.stop_reason_detail ?? entry.error,
          expected_transition_detail: `Automatic retry at ${asIsoDate(entry.due_at_ms)}`
        })
      )
    }));
    const blocked = Array.from(state.blocked_inputs.values()).map((entry) => {
      const progressSignal = resolveBlockedProgressSignal(entry);
      return {
        ...projectBudget(entry),
        ...(state.circuit_breakers.get(entry.issue_id)
          ? {
              breaker_active: state.circuit_breakers.get(entry.issue_id)?.breaker_active ?? false,
              breaker_hit_count: state.circuit_breakers.get(entry.issue_id)?.breaker_hit_count ?? 0,
              breaker_window_minutes: state.circuit_breakers.get(entry.issue_id)?.breaker_window_minutes ?? 0,
              breaker_first_hit_at: state.circuit_breakers.get(entry.issue_id)?.breaker_first_hit_at_ms
                ? asIsoDate(state.circuit_breakers.get(entry.issue_id)!.breaker_first_hit_at_ms!)
                : null,
              breaker_last_hit_at: state.circuit_breakers.get(entry.issue_id)?.breaker_last_hit_at_ms
                ? asIsoDate(state.circuit_breakers.get(entry.issue_id)!.breaker_last_hit_at_ms!)
                : null
            }
          : {
              breaker_active: false,
              breaker_hit_count: 0,
              breaker_window_minutes: 0,
              breaker_first_hit_at: null,
              breaker_last_hit_at: null
            }),
        issue_id: entry.issue_id,
        issue_identifier: entry.issue_identifier,
        attempt: entry.attempt,
        blocked_at: asIsoDate(entry.blocked_at_ms),
        worker_host: entry.worker_host ?? null,
        workspace_path: entry.workspace_path ?? null,
        provisioner_type: entry.provisioner_type ?? null,
        branch_name: entry.branch_name ?? null,
        repo_root: entry.repo_root ?? null,
        workspace_exists: entry.workspace_exists,
        workspace_git_status: entry.workspace_git_status ?? null,
        workspace_provisioned: entry.workspace_provisioned,
        workspace_is_git_worktree: entry.workspace_is_git_worktree,
        copy_ignored_applied: entry.copy_ignored_applied ?? false,
        copy_ignored_status: entry.copy_ignored_status ?? null,
        copy_ignored_summary: entry.copy_ignored_summary ?? null,
        stop_reason_code: entry.stop_reason_code,
        stop_reason_detail: entry.stop_reason_detail ?? null,
        conflict_files: entry.conflict_files.map((file) => ({ ...file })),
        classification_summary: entry.classification_summary ? { ...entry.classification_summary } : undefined,
        resolution_hints: [...entry.resolution_hints],
        previous_thread_id: entry.previous_thread_id ?? null,
        previous_session_id: entry.previous_session_id ?? null,
        last_phase: entry.last_phase ?? null,
        last_phase_at: entry.last_phase_at_ms ? asIsoDate(entry.last_phase_at_ms) : null,
        last_phase_detail: entry.last_phase_detail ?? null,
        requires_manual_resume: true as const,
        awaiting_operator: true as const,
        awaiting_operator_reason_code: entry.awaiting_operator_reason_code ?? entry.stop_reason_code,
        awaiting_operator_since: asIsoDate(entry.awaiting_operator_since_ms ?? entry.blocked_at_ms),
        awaiting_operator_resume_nonce: entry.awaiting_operator_resume_nonce ?? 0,
        quarantined_event_count: entry.quarantined_event_count ?? 0,
        last_quarantined_event_at: entry.last_quarantined_event_at_ms ? asIsoDate(entry.last_quarantined_event_at_ms) : null,
        attempt_count_window: entry.attempt_count_window,
        window_minutes: entry.window_minutes,
        last_known_commit_sha: entry.last_known_commit_sha ?? null,
        last_progress_checkpoint_at: entry.last_progress_checkpoint_at ? asIsoDate(entry.last_progress_checkpoint_at) : null,
        progress_signals: entry.progress_signals ? { ...entry.progress_signals } : undefined,
        required_actions: [...(entry.required_actions ?? [])],
        resume_override_reason: entry.resume_override_reason ?? null,
        ...resolveBlockedTurnControl(entry),
        ...progressSignal,
        operator_actions: projectOperatorActions(state, entry.issue_id),
        operator_explainer_hint: toOperatorExplainerHint(
          explainOperatorRuntimeState({
            state_class: 'blocked',
            reason_code: entry.stop_reason_code,
            reason_detail: entry.stop_reason_detail
          })
        ),
        pending_input: entry.pending_input
          ? {
              ...entry.pending_input,
              input_required_at: asIsoDate(entry.pending_input.input_required_at_ms)
            }
          : null,
        last_input_submit: entry.last_input_submit
          ? {
              submitted_at: asIsoDate(entry.last_input_submit.submitted_at_ms),
              request_id: entry.last_input_submit.request_id,
              resume_mode: entry.last_input_submit.resume_mode,
              resume_reason_code: entry.last_input_submit.resume_reason_code
            }
          : null,
        resume_history: (entry.resume_history ?? []).map((history) => ({
          submitted_at: asIsoDate(history.submitted_at_ms),
          request_id: history.request_id,
          resume_mode: history.resume_mode,
          resume_reason_code: history.resume_reason_code,
          previous_thread_id: history.previous_thread_id ?? null,
          previous_session_id: history.previous_session_id ?? null
        })),
        session_console: (entry.session_console ?? []).map((event) => ({
          at: asIsoDate(event.at_ms),
          event: event.event,
          message: event.message
        }))
      };
    });

    const activeSeconds = Array.from(state.running.values()).reduce((total, entry) => {
      const seconds = Math.max(0, Math.floor((nowMs - entry.started_at_ms) / 1000));
      return total + seconds;
    }, 0);

    return redactUnknown({
      generated_at: asIsoDate(nowMs),
      ...freshness,
      ...createApiDegradedDiagnostics(null, []),
      counts: {
        running: running.length,
        retrying: retrying.length,
        blocked: blocked.length,
        running_stalled_waiting_count: running.filter((entry) => entry.operator_explainer_hint?.classification === 'stalled_waiting')
          .length,
        running_awaiting_input_count: running.filter((entry) => entry.operator_explainer_hint?.classification === 'awaiting_input')
          .length
      },
      running,
      retrying,
      blocked,
      codex_totals: {
        input_tokens: state.codex_totals.input_tokens,
        output_tokens: state.codex_totals.output_tokens,
        total_tokens: state.codex_totals.total_tokens,
        ...(typeof state.codex_totals.cached_input_tokens === 'number'
          ? { cached_input_tokens: state.codex_totals.cached_input_tokens }
          : {}),
        ...(typeof state.codex_totals.reasoning_output_tokens === 'number'
          ? { reasoning_output_tokens: state.codex_totals.reasoning_output_tokens }
          : {}),
        ...(typeof state.codex_totals.model_context_window === 'number'
          ? { model_context_window: state.codex_totals.model_context_window }
          : {}),
        seconds_running: state.codex_totals.seconds_running + activeSeconds
      },
      rate_limits: state.codex_rate_limits,
      health: {
        dispatch_validation: state.health.dispatch_validation,
        last_error: state.health.last_error
      },
      throughput: {
        current_tps: state.throughput.current_tps,
        avg_tps_60s: state.throughput.avg_tps_60s,
        window_seconds: state.throughput.window_seconds,
        sparkline_10m: [...state.throughput.sparkline_10m],
        sample_count: state.throughput.sample_count
      },
      recent_runtime_events: state.recent_runtime_events.map((event) => ({
        at: asIsoDate(event.at_ms),
        event: event.event,
        severity: event.severity,
        issue_identifier: event.issue_identifier,
        session_id: event.session_id,
        detail: event.detail
      }))
    }) as ApiStateResponse;
  }

  projectIssue(state: OrchestratorState, issueIdentifier: string): ApiIssueResponse {
    const nowMs = this.nowMs();
    const freshness = resolveStateFreshness(state, nowMs);
    const runningEntry = Array.from(state.running.entries()).find(([, entry]) => entry.identifier === issueIdentifier);
    const retryEntry = Array.from(state.retry_attempts.values()).find((entry) => entry.identifier === issueIdentifier);
    const blockedEntry = Array.from(state.blocked_inputs.values()).find((entry) => entry.issue_identifier === issueIdentifier);
    const breakerEntry = blockedEntry ? state.circuit_breakers.get(blockedEntry.issue_id) : undefined;

    if (!runningEntry && !retryEntry && !blockedEntry) {
      throw new LocalApiError(
        'issue_not_found',
        `Issue ${issueIdentifier} is not in runtime state`,
        404
      );
    }

    if (runningEntry) {
      const [issueId, entry] = runningEntry;
      const currentRetryAttempt = retryEntry?.attempt ?? 0;
      const progressSignal = resolveProgressSignal(entry);
      const turnControl = resolveRunningTurnControl(entry);
      const blockedProgressSignal = blockedEntry ? resolveBlockedProgressSignal(blockedEntry) : null;
      const operatorExplainer = explainRunningEntry(entry);
      return redactUnknown({
        issue_identifier: issueIdentifier,
        issue_id: issueId,
        status: 'running',
        ...freshness,
        ...createApiDegradedDiagnostics(null, []),
        operator_actions: projectOperatorActions(state, issueId),
        operator_explainer: operatorExplainer,
        workspace: {
          path: entry.workspace_path,
          host: entry.worker_host ?? null
        },
        attempts: {
          restart_count: entry.retry_attempt,
          current_retry_attempt: currentRetryAttempt
        },
        running: {
          ...projectBudget(entry),
          session_id: entry.session_id,
          worker_host: entry.worker_host ?? null,
          workspace_path: entry.workspace_path ?? null,
          provisioner_type: entry.provisioner_type ?? null,
          branch_name: entry.branch_name ?? null,
          repo_root: entry.repo_root ?? null,
          workspace_exists: entry.workspace_exists,
          workspace_git_status: entry.workspace_git_status ?? null,
          workspace_provisioned: entry.workspace_provisioned,
          workspace_is_git_worktree: entry.workspace_is_git_worktree,
          copy_ignored_applied: entry.copy_ignored_applied ?? false,
          copy_ignored_status: entry.copy_ignored_status ?? null,
          copy_ignored_summary: entry.copy_ignored_summary ?? null,
          thread_id: entry.thread_id,
          turn_id: entry.turn_id,
          codex_app_server_pid: entry.codex_app_server_pid,
          turn_count: entry.turn_count,
          state: entry.issue.state,
          started_at: asIsoDate(entry.started_at_ms),
          last_event: entry.last_event,
          last_event_summary: entry.last_event_summary,
          last_message: entry.last_message,
          awaiting_input: Boolean(entry.awaiting_input_since_ms),
          awaiting_input_since_ms: entry.awaiting_input_since_ms ?? null,
          pending_input_preview: entry.pending_input_preview
            ? {
                type: entry.pending_input_preview.type,
                prompt_preview: redactPromptPreview(entry.pending_input_preview.prompt_preview),
                option_count: typeof entry.pending_input_preview.option_count === 'number' ? entry.pending_input_preview.option_count : null
              }
            : null,
          stalled_waiting: Boolean(entry.stalled_waiting_since_ms && entry.stalled_waiting_reason),
          stalled_waiting_since_ms:
            entry.stalled_waiting_since_ms && entry.stalled_waiting_reason ? entry.stalled_waiting_since_ms : null,
          stalled_waiting_reason:
            entry.stalled_waiting_since_ms && entry.stalled_waiting_reason ? REASON_CODES.turnWaitingThresholdExceeded : null,
          current_phase: entry.current_phase ?? null,
          current_phase_at: entry.current_phase_at_ms ? asIsoDate(entry.current_phase_at_ms) : null,
          phase_elapsed_ms: entry.current_phase_at_ms ? Math.max(0, this.nowMs() - entry.current_phase_at_ms) : null,
          phase_detail: entry.phase_detail ?? null,
          last_event_at: entry.last_codex_timestamp_ms !== null ? asIsoDate(entry.last_codex_timestamp_ms) : null,
          token_telemetry_status: entry.token_telemetry_status,
          token_telemetry_last_source: entry.token_telemetry_last_source,
          token_telemetry_last_at_ms: entry.token_telemetry_last_at_ms,
          ...turnControl,
          ...progressSignal,
          ...resolveTokenTelemetryQuality(entry),
          ...resolveNotBlockedExplainer({
            blocked: false,
            progress_signal_state: progressSignal.progress_signal_state,
            awaiting_input: Boolean(entry.awaiting_input_since_ms),
            waiting_started_at_ms: entry.running_waiting_started_at_ms ?? null,
            now_ms: nowMs,
            stalled_waiting_ms: 300_000
          }),
          operator_actions: projectOperatorActions(state, issueId),
          tokens: {
            input_tokens: entry.tokens.input_tokens,
            output_tokens: entry.tokens.output_tokens,
            total_tokens: entry.tokens.total_tokens,
            ...(typeof entry.tokens.cached_input_tokens === 'number'
              ? { cached_input_tokens: entry.tokens.cached_input_tokens }
              : {}),
            ...(typeof entry.tokens.reasoning_output_tokens === 'number'
              ? { reasoning_output_tokens: entry.tokens.reasoning_output_tokens }
              : {}),
            ...(typeof entry.tokens.model_context_window === 'number'
              ? { model_context_window: entry.tokens.model_context_window }
              : {})
          }
        },
        retry: retryEntry
          ? {
              ...projectBudget(retryEntry),
              attempt: retryEntry.attempt,
              due_at: asIsoDate(retryEntry.due_at_ms),
              error: retryEntry.error,
              worker_host: retryEntry.worker_host ?? null,
              workspace_path: retryEntry.workspace_path ?? null,
              provisioner_type: retryEntry.provisioner_type ?? null,
              branch_name: retryEntry.branch_name ?? null,
              repo_root: retryEntry.repo_root ?? null,
              workspace_exists: retryEntry.workspace_exists,
              workspace_git_status: retryEntry.workspace_git_status ?? null,
              workspace_provisioned: retryEntry.workspace_provisioned,
              workspace_is_git_worktree: retryEntry.workspace_is_git_worktree,
              copy_ignored_applied: retryEntry.copy_ignored_applied ?? false,
              copy_ignored_status: retryEntry.copy_ignored_status ?? null,
              copy_ignored_summary: retryEntry.copy_ignored_summary ?? null,
              stop_reason_code: retryEntry.stop_reason_code ?? null,
              stop_reason_detail: retryEntry.stop_reason_detail ?? null,
              previous_thread_id: retryEntry.previous_thread_id ?? null,
              previous_session_id: retryEntry.previous_session_id ?? null,
              last_phase: retryEntry.last_phase ?? null,
              last_phase_at: retryEntry.last_phase_at_ms ? asIsoDate(retryEntry.last_phase_at_ms) : null,
              last_phase_detail: retryEntry.last_phase_detail ?? null
            }
          : null,
        blocked: blockedEntry
          ? {
              ...projectBudget(blockedEntry),
              attempt: blockedEntry.attempt,
              blocked_at: asIsoDate(blockedEntry.blocked_at_ms),
              worker_host: blockedEntry.worker_host ?? null,
              workspace_path: blockedEntry.workspace_path ?? null,
              provisioner_type: blockedEntry.provisioner_type ?? null,
              branch_name: blockedEntry.branch_name ?? null,
              repo_root: blockedEntry.repo_root ?? null,
              workspace_exists: blockedEntry.workspace_exists,
              workspace_git_status: blockedEntry.workspace_git_status ?? null,
              workspace_provisioned: blockedEntry.workspace_provisioned,
              workspace_is_git_worktree: blockedEntry.workspace_is_git_worktree,
              copy_ignored_applied: blockedEntry.copy_ignored_applied ?? false,
              copy_ignored_status: blockedEntry.copy_ignored_status ?? null,
              copy_ignored_summary: blockedEntry.copy_ignored_summary ?? null,
              stop_reason_code: blockedEntry.stop_reason_code,
              stop_reason_detail: blockedEntry.stop_reason_detail ?? null,
          conflict_files: blockedEntry.conflict_files.map((file) => ({ ...file })),
          classification_summary: blockedEntry.classification_summary ? { ...blockedEntry.classification_summary } : undefined,
              resolution_hints: [...blockedEntry.resolution_hints],
              previous_thread_id: blockedEntry.previous_thread_id ?? null,
              previous_session_id: blockedEntry.previous_session_id ?? null,
              last_phase: blockedEntry.last_phase ?? null,
              last_phase_at: blockedEntry.last_phase_at_ms ? asIsoDate(blockedEntry.last_phase_at_ms) : null,
              last_phase_detail: blockedEntry.last_phase_detail ?? null,
          requires_manual_resume: true as const,
      awaiting_operator: true as const,
      awaiting_operator_reason_code: blockedEntry.awaiting_operator_reason_code ?? blockedEntry.stop_reason_code,
      awaiting_operator_since: asIsoDate(blockedEntry.awaiting_operator_since_ms ?? blockedEntry.blocked_at_ms),
      awaiting_operator_resume_nonce: blockedEntry.awaiting_operator_resume_nonce ?? 0,
      quarantined_event_count: blockedEntry.quarantined_event_count ?? 0,
      last_quarantined_event_at: blockedEntry.last_quarantined_event_at_ms ? asIsoDate(blockedEntry.last_quarantined_event_at_ms) : null,
          ...resolveBlockedTurnControl(blockedEntry),
          ...(blockedProgressSignal ?? resolveBlockedProgressSignal(blockedEntry)),
          operator_actions: projectOperatorActions(state, blockedEntry.issue_id),
          breaker_active: breakerEntry?.breaker_active ?? false,
          breaker_hit_count: breakerEntry?.breaker_hit_count ?? 0,
          breaker_window_minutes: breakerEntry?.breaker_window_minutes ?? 0,
          breaker_first_hit_at: breakerEntry?.breaker_first_hit_at_ms ? asIsoDate(breakerEntry.breaker_first_hit_at_ms) : null,
          breaker_last_hit_at: breakerEntry?.breaker_last_hit_at_ms ? asIsoDate(breakerEntry.breaker_last_hit_at_ms) : null,
      attempt_count_window: blockedEntry.attempt_count_window,
      window_minutes: blockedEntry.window_minutes,
      last_known_commit_sha: blockedEntry.last_known_commit_sha ?? null,
      last_progress_checkpoint_at: blockedEntry.last_progress_checkpoint_at ? asIsoDate(blockedEntry.last_progress_checkpoint_at) : null,
      progress_signals: blockedEntry.progress_signals ? { ...blockedEntry.progress_signals } : undefined,
      required_actions: [...(blockedEntry.required_actions ?? [])],
      resume_override_reason: blockedEntry.resume_override_reason ?? null,
              pending_input: blockedEntry.pending_input
                ? {
                    ...blockedEntry.pending_input,
                    input_required_at: asIsoDate(blockedEntry.pending_input.input_required_at_ms)
                  }
                : null,
              last_input_submit: blockedEntry.last_input_submit
                ? {
                    submitted_at: asIsoDate(blockedEntry.last_input_submit.submitted_at_ms),
                    request_id: blockedEntry.last_input_submit.request_id,
                    resume_mode: blockedEntry.last_input_submit.resume_mode,
                    resume_reason_code: blockedEntry.last_input_submit.resume_reason_code
                  }
                : null,
              resume_history: (blockedEntry.resume_history ?? []).map((history) => ({
                submitted_at: asIsoDate(history.submitted_at_ms),
                request_id: history.request_id,
                resume_mode: history.resume_mode,
                resume_reason_code: history.resume_reason_code,
                previous_thread_id: history.previous_thread_id ?? null,
                previous_session_id: history.previous_session_id ?? null
              })),
              session_console: (blockedEntry.session_console ?? []).map((event) => ({
                at: asIsoDate(event.at_ms),
                event: event.event,
                message: event.message
              }))
            }
          : null,
        phase_timeline: (state.phase_timeline?.get(issueId) ?? []).map((event) => ({
          at: asIsoDate(event.at_ms),
          phase: event.phase,
          detail: event.detail,
          attempt: event.attempt,
          thread_id: event.thread_id ?? null,
          session_id: event.session_id ?? null
        })),
        recent_events: entry.recent_events.map((event) => ({
          at: asIsoDate(event.at_ms),
          event: event.event,
          message: event.message
        })),
        last_error: retryEntry?.error ?? state.health.last_error,
        logs: {
          codex_session_logs: []
        },
        tracked: {}
      }) as ApiIssueResponse;
    }

    if (retryEntry) {
      const retryOnlyEntry = retryEntry;
      const issueId = retryOnlyEntry.issue_id;
      const blockedProgressSignal = blockedEntry ? resolveBlockedProgressSignal(blockedEntry) : null;
      const operatorExplainer = explainOperatorRuntimeState({
        state_class: 'retrying',
        reason_code: retryOnlyEntry.stop_reason_code,
        reason_detail: retryOnlyEntry.stop_reason_detail ?? retryOnlyEntry.error,
        expected_transition_detail: `Automatic retry at ${asIsoDate(retryOnlyEntry.due_at_ms)}`
      });
      return redactUnknown({
        issue_identifier: issueIdentifier,
        issue_id: issueId,
        status: 'retrying',
        ...freshness,
        ...createApiDegradedDiagnostics(null, []),
        operator_actions: projectOperatorActions(state, issueId),
        operator_explainer: operatorExplainer,
        workspace: {
          path: retryOnlyEntry.workspace_path ?? null,
          host: retryOnlyEntry.worker_host ?? null
        },
        attempts: {
          restart_count: 0,
          current_retry_attempt: retryOnlyEntry.attempt
        },
        running: null,
        retry: {
          ...projectBudget(retryOnlyEntry),
          attempt: retryOnlyEntry.attempt,
          due_at: asIsoDate(retryOnlyEntry.due_at_ms),
          error: retryOnlyEntry.error,
          worker_host: retryOnlyEntry.worker_host ?? null,
          workspace_path: retryOnlyEntry.workspace_path ?? null,
          provisioner_type: retryOnlyEntry.provisioner_type ?? null,
          branch_name: retryOnlyEntry.branch_name ?? null,
          repo_root: retryOnlyEntry.repo_root ?? null,
          workspace_exists: retryOnlyEntry.workspace_exists,
          workspace_git_status: retryOnlyEntry.workspace_git_status ?? null,
          workspace_provisioned: retryOnlyEntry.workspace_provisioned,
          workspace_is_git_worktree: retryOnlyEntry.workspace_is_git_worktree,
          copy_ignored_applied: retryOnlyEntry.copy_ignored_applied ?? false,
          copy_ignored_status: retryOnlyEntry.copy_ignored_status ?? null,
          copy_ignored_summary: retryOnlyEntry.copy_ignored_summary ?? null,
          stop_reason_code: retryOnlyEntry.stop_reason_code ?? null,
          stop_reason_detail: retryOnlyEntry.stop_reason_detail ?? null,
          previous_thread_id: retryOnlyEntry.previous_thread_id ?? null,
          previous_session_id: retryOnlyEntry.previous_session_id ?? null,
          last_phase: retryOnlyEntry.last_phase ?? null,
          last_phase_at: retryOnlyEntry.last_phase_at_ms ? asIsoDate(retryOnlyEntry.last_phase_at_ms) : null,
          last_phase_detail: retryOnlyEntry.last_phase_detail ?? null
        },
        blocked: blockedEntry
          ? {
              ...projectBudget(blockedEntry),
              attempt: blockedEntry.attempt,
              blocked_at: asIsoDate(blockedEntry.blocked_at_ms),
              worker_host: blockedEntry.worker_host ?? null,
              workspace_path: blockedEntry.workspace_path ?? null,
              provisioner_type: blockedEntry.provisioner_type ?? null,
              branch_name: blockedEntry.branch_name ?? null,
              repo_root: blockedEntry.repo_root ?? null,
              workspace_exists: blockedEntry.workspace_exists,
              workspace_git_status: blockedEntry.workspace_git_status ?? null,
              workspace_provisioned: blockedEntry.workspace_provisioned,
              workspace_is_git_worktree: blockedEntry.workspace_is_git_worktree,
              copy_ignored_applied: blockedEntry.copy_ignored_applied ?? false,
              copy_ignored_status: blockedEntry.copy_ignored_status ?? null,
              copy_ignored_summary: blockedEntry.copy_ignored_summary ?? null,
              stop_reason_code: blockedEntry.stop_reason_code,
              stop_reason_detail: blockedEntry.stop_reason_detail ?? null,
              conflict_files: blockedEntry.conflict_files.map((file) => ({ ...file })),
              resolution_hints: [...blockedEntry.resolution_hints],
              previous_thread_id: blockedEntry.previous_thread_id ?? null,
              previous_session_id: blockedEntry.previous_session_id ?? null,
              last_phase: blockedEntry.last_phase ?? null,
              last_phase_at: blockedEntry.last_phase_at_ms ? asIsoDate(blockedEntry.last_phase_at_ms) : null,
              last_phase_detail: blockedEntry.last_phase_detail ?? null,
              requires_manual_resume: true as const,
              awaiting_operator: true as const,
              awaiting_operator_reason_code: blockedEntry.awaiting_operator_reason_code ?? blockedEntry.stop_reason_code,
              awaiting_operator_since: asIsoDate(blockedEntry.awaiting_operator_since_ms ?? blockedEntry.blocked_at_ms),
              awaiting_operator_resume_nonce: blockedEntry.awaiting_operator_resume_nonce ?? 0,
              quarantined_event_count: blockedEntry.quarantined_event_count ?? 0,
              last_quarantined_event_at: blockedEntry.last_quarantined_event_at_ms
                ? asIsoDate(blockedEntry.last_quarantined_event_at_ms)
                : null,
              attempt_count_window: blockedEntry.attempt_count_window,
              window_minutes: blockedEntry.window_minutes,
              last_known_commit_sha: blockedEntry.last_known_commit_sha ?? null,
              last_progress_checkpoint_at: blockedEntry.last_progress_checkpoint_at
                ? asIsoDate(blockedEntry.last_progress_checkpoint_at)
                : null,
              progress_signals: blockedEntry.progress_signals ? { ...blockedEntry.progress_signals } : undefined,
              required_actions: [...(blockedEntry.required_actions ?? [])],
              resume_override_reason: blockedEntry.resume_override_reason ?? null,
              ...resolveBlockedTurnControl(blockedEntry),
              ...(blockedProgressSignal ?? resolveBlockedProgressSignal(blockedEntry)),
              operator_actions: projectOperatorActions(state, blockedEntry.issue_id),
              pending_input: blockedEntry.pending_input
                ? {
                    ...blockedEntry.pending_input,
                    input_required_at: asIsoDate(blockedEntry.pending_input.input_required_at_ms)
                  }
                : null,
              last_input_submit: blockedEntry.last_input_submit
                ? {
                    submitted_at: asIsoDate(blockedEntry.last_input_submit.submitted_at_ms),
                    request_id: blockedEntry.last_input_submit.request_id,
                    resume_mode: blockedEntry.last_input_submit.resume_mode,
                    resume_reason_code: blockedEntry.last_input_submit.resume_reason_code
                  }
                : null,
              resume_history: (blockedEntry.resume_history ?? []).map((history) => ({
                submitted_at: asIsoDate(history.submitted_at_ms),
                request_id: history.request_id,
                resume_mode: history.resume_mode,
                resume_reason_code: history.resume_reason_code,
                previous_thread_id: history.previous_thread_id ?? null,
                previous_session_id: history.previous_session_id ?? null
              })),
              session_console: (blockedEntry.session_console ?? []).map((event) => ({
                at: asIsoDate(event.at_ms),
                event: event.event,
                message: event.message
              }))
            }
          : null,
        phase_timeline: (state.phase_timeline?.get(issueId) ?? []).map((event) => ({
          at: asIsoDate(event.at_ms),
          phase: event.phase,
          detail: event.detail,
          attempt: event.attempt,
          thread_id: event.thread_id ?? null,
          session_id: event.session_id ?? null
        })),
        recent_events: [],
        last_error: retryOnlyEntry.error,
        logs: {
          codex_session_logs: []
        },
        tracked: {}
      }) as ApiIssueResponse;
    }

    if (!blockedEntry) {
      throw new LocalApiError(
        'issue_not_found',
        `Issue ${issueIdentifier} is not in runtime state`,
        404
      );
    }

    const issueId = blockedEntry.issue_id;
    const operatorExplainer = explainOperatorRuntimeState({
      state_class: 'blocked',
      reason_code: blockedEntry.stop_reason_code,
      reason_detail: blockedEntry.stop_reason_detail
    });
    return redactUnknown({
      issue_identifier: issueIdentifier,
      issue_id: issueId,
      status: 'blocked',
      ...freshness,
      ...createApiDegradedDiagnostics(null, []),
      operator_actions: projectOperatorActions(state, issueId),
      operator_explainer: operatorExplainer,
      workspace: {
        path: blockedEntry.workspace_path ?? null,
        host: blockedEntry.worker_host ?? null
      },
      attempts: {
        restart_count: 0,
        current_retry_attempt: blockedEntry.attempt
      },
      running: null,
      retry: null,
      blocked: {
        ...projectBudget(blockedEntry),
        attempt: blockedEntry.attempt,
        blocked_at: asIsoDate(blockedEntry.blocked_at_ms),
        worker_host: blockedEntry.worker_host ?? null,
        workspace_path: blockedEntry.workspace_path ?? null,
        provisioner_type: blockedEntry.provisioner_type ?? null,
        branch_name: blockedEntry.branch_name ?? null,
        repo_root: blockedEntry.repo_root ?? null,
        workspace_exists: blockedEntry.workspace_exists,
        workspace_git_status: blockedEntry.workspace_git_status ?? null,
        workspace_provisioned: blockedEntry.workspace_provisioned,
        workspace_is_git_worktree: blockedEntry.workspace_is_git_worktree,
        copy_ignored_applied: blockedEntry.copy_ignored_applied ?? false,
        copy_ignored_status: blockedEntry.copy_ignored_status ?? null,
        copy_ignored_summary: blockedEntry.copy_ignored_summary ?? null,
        stop_reason_code: blockedEntry.stop_reason_code,
        stop_reason_detail: blockedEntry.stop_reason_detail ?? null,
        conflict_files: blockedEntry.conflict_files.map((file) => ({ ...file })),
        resolution_hints: [...blockedEntry.resolution_hints],
        previous_thread_id: blockedEntry.previous_thread_id ?? null,
        previous_session_id: blockedEntry.previous_session_id ?? null,
        last_phase: blockedEntry.last_phase ?? null,
        last_phase_at: blockedEntry.last_phase_at_ms ? asIsoDate(blockedEntry.last_phase_at_ms) : null,
        last_phase_detail: blockedEntry.last_phase_detail ?? null,
        requires_manual_resume: true as const,
        awaiting_operator: true as const,
        awaiting_operator_reason_code: blockedEntry.awaiting_operator_reason_code ?? blockedEntry.stop_reason_code,
        awaiting_operator_since: asIsoDate(blockedEntry.awaiting_operator_since_ms ?? blockedEntry.blocked_at_ms),
        awaiting_operator_resume_nonce: blockedEntry.awaiting_operator_resume_nonce ?? 0,
        quarantined_event_count: blockedEntry.quarantined_event_count ?? 0,
        last_quarantined_event_at: blockedEntry.last_quarantined_event_at_ms
          ? asIsoDate(blockedEntry.last_quarantined_event_at_ms)
          : null,
        attempt_count_window: blockedEntry.attempt_count_window,
        window_minutes: blockedEntry.window_minutes,
        last_known_commit_sha: blockedEntry.last_known_commit_sha ?? null,
        last_progress_checkpoint_at: blockedEntry.last_progress_checkpoint_at
          ? asIsoDate(blockedEntry.last_progress_checkpoint_at)
          : null,
        progress_signals: blockedEntry.progress_signals ? { ...blockedEntry.progress_signals } : undefined,
        required_actions: [...(blockedEntry.required_actions ?? [])],
        resume_override_reason: blockedEntry.resume_override_reason ?? null,
        ...resolveBlockedTurnControl(blockedEntry),
        ...resolveBlockedProgressSignal(blockedEntry),
        operator_actions: projectOperatorActions(state, blockedEntry.issue_id),
        pending_input: blockedEntry.pending_input
          ? {
              ...blockedEntry.pending_input,
              input_required_at: asIsoDate(blockedEntry.pending_input.input_required_at_ms)
            }
          : null,
        last_input_submit: blockedEntry.last_input_submit
          ? {
              submitted_at: asIsoDate(blockedEntry.last_input_submit.submitted_at_ms),
              request_id: blockedEntry.last_input_submit.request_id,
              resume_mode: blockedEntry.last_input_submit.resume_mode,
              resume_reason_code: blockedEntry.last_input_submit.resume_reason_code
            }
          : null,
        resume_history: (blockedEntry.resume_history ?? []).map((history) => ({
          submitted_at: asIsoDate(history.submitted_at_ms),
          request_id: history.request_id,
          resume_mode: history.resume_mode,
          resume_reason_code: history.resume_reason_code,
          previous_thread_id: history.previous_thread_id ?? null,
          previous_session_id: history.previous_session_id ?? null
        })),
        session_console: (blockedEntry.session_console ?? []).map((event) => ({
          at: asIsoDate(event.at_ms),
          event: event.event,
          message: event.message
        }))
      },
      phase_timeline: (state.phase_timeline?.get(issueId) ?? []).map((event) => ({
        at: asIsoDate(event.at_ms),
        phase: event.phase,
        detail: event.detail,
        attempt: event.attempt,
        thread_id: event.thread_id ?? null,
        session_id: event.session_id ?? null
      })),
      recent_events: (blockedEntry.session_console ?? []).map((event) => ({
        at: asIsoDate(event.at_ms),
        event: event.event,
        message: event.message
      })),
      last_error: blockedEntry.stop_reason_detail ?? blockedEntry.stop_reason_code,
      logs: {
        codex_session_logs: []
      },
      tracked: {}
    }) as ApiIssueResponse;
  }
}
