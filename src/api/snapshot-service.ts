import type { OrchestratorState, RunningEntry } from '../orchestrator';
import { redactUnknown } from '../security/redaction';
import { LocalApiError } from './errors';
import type { ApiIssueResponse, ApiStateResponse } from './types';

function asIsoDate(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function toStateRunningRow(issueId: string, entry: RunningEntry): ApiStateResponse['running'][number] {
  return {
    issue_id: issueId,
    issue_identifier: entry.identifier,
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
    thread_id: entry.thread_id,
    turn_id: entry.turn_id,
    codex_app_server_pid: entry.codex_app_server_pid,
    turn_count: entry.turn_count,
    last_event: entry.last_event,
    last_event_summary: entry.last_event_summary,
    last_message: entry.last_message,
    started_at: asIsoDate(entry.started_at_ms),
    last_event_at: entry.last_codex_timestamp_ms !== null ? asIsoDate(entry.last_codex_timestamp_ms) : null,
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
    const running = Array.from(state.running.entries()).map(([issueId, entry]) => toStateRunningRow(issueId, entry));
    const retrying = Array.from(state.retry_attempts.values()).map((entry) => ({
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
      stop_reason_code: entry.stop_reason_code ?? null,
      stop_reason_detail: entry.stop_reason_detail ?? null,
      previous_thread_id: entry.previous_thread_id ?? null,
      previous_session_id: entry.previous_session_id ?? null
    }));
    const blocked = Array.from(state.blocked_inputs.values()).map((entry) => ({
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
      stop_reason_code: entry.stop_reason_code,
      stop_reason_detail: entry.stop_reason_detail ?? null,
      previous_thread_id: entry.previous_thread_id ?? null,
      previous_session_id: entry.previous_session_id ?? null,
      requires_manual_resume: true as const
    }));

    const activeSeconds = Array.from(state.running.values()).reduce((total, entry) => {
      const seconds = Math.max(0, Math.floor((nowMs - entry.started_at_ms) / 1000));
      return total + seconds;
    }, 0);

    return redactUnknown({
      generated_at: asIsoDate(nowMs),
      counts: {
        running: running.length,
        retrying: retrying.length,
        blocked: blocked.length
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
    const runningEntry = Array.from(state.running.entries()).find(([, entry]) => entry.identifier === issueIdentifier);
    const retryEntry = Array.from(state.retry_attempts.values()).find((entry) => entry.identifier === issueIdentifier);
    const blockedEntry = Array.from(state.blocked_inputs.values()).find((entry) => entry.issue_identifier === issueIdentifier);

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
      return redactUnknown({
        issue_identifier: issueIdentifier,
        issue_id: issueId,
        status: 'running',
        workspace: {
          path: entry.workspace_path,
          host: entry.worker_host ?? null
        },
        attempts: {
          restart_count: entry.retry_attempt,
          current_retry_attempt: currentRetryAttempt
        },
        running: {
          session_id: entry.session_id,
          worker_host: entry.worker_host ?? null,
          workspace_path: entry.workspace_path ?? null,
          provisioner_type: entry.provisioner_type ?? null,
          branch_name: entry.branch_name ?? null,
          repo_root: entry.repo_root ?? null,
          workspace_exists: entry.workspace_exists,
          workspace_git_status: entry.workspace_git_status ?? null,
          thread_id: entry.thread_id,
          turn_id: entry.turn_id,
          codex_app_server_pid: entry.codex_app_server_pid,
          turn_count: entry.turn_count,
          state: entry.issue.state,
          started_at: asIsoDate(entry.started_at_ms),
          last_event: entry.last_event,
          last_event_summary: entry.last_event_summary,
          last_message: entry.last_message,
          last_event_at: entry.last_codex_timestamp_ms !== null ? asIsoDate(entry.last_codex_timestamp_ms) : null,
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
              stop_reason_code: retryEntry.stop_reason_code ?? null,
              stop_reason_detail: retryEntry.stop_reason_detail ?? null,
              previous_thread_id: retryEntry.previous_thread_id ?? null,
              previous_session_id: retryEntry.previous_session_id ?? null
            }
          : null,
        blocked: blockedEntry
          ? {
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
              stop_reason_code: blockedEntry.stop_reason_code,
              stop_reason_detail: blockedEntry.stop_reason_detail ?? null,
              previous_thread_id: blockedEntry.previous_thread_id ?? null,
              previous_session_id: blockedEntry.previous_session_id ?? null,
              requires_manual_resume: true as const
            }
          : null,
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
      return redactUnknown({
        issue_identifier: issueIdentifier,
        issue_id: issueId,
        status: 'retrying',
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
          stop_reason_code: retryOnlyEntry.stop_reason_code ?? null,
          stop_reason_detail: retryOnlyEntry.stop_reason_detail ?? null,
          previous_thread_id: retryOnlyEntry.previous_thread_id ?? null,
          previous_session_id: retryOnlyEntry.previous_session_id ?? null
        },
        blocked: blockedEntry
          ? {
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
              stop_reason_code: blockedEntry.stop_reason_code,
              stop_reason_detail: blockedEntry.stop_reason_detail ?? null,
              previous_thread_id: blockedEntry.previous_thread_id ?? null,
              previous_session_id: blockedEntry.previous_session_id ?? null,
              requires_manual_resume: true as const
            }
          : null,
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
    return redactUnknown({
      issue_identifier: issueIdentifier,
      issue_id: issueId,
      status: 'blocked',
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
        stop_reason_code: blockedEntry.stop_reason_code,
        stop_reason_detail: blockedEntry.stop_reason_detail ?? null,
        previous_thread_id: blockedEntry.previous_thread_id ?? null,
        previous_session_id: blockedEntry.previous_session_id ?? null,
        requires_manual_resume: true as const
      },
      recent_events: [],
      last_error: blockedEntry.stop_reason_detail ?? blockedEntry.stop_reason_code,
      logs: {
        codex_session_logs: []
      },
      tracked: {}
    }) as ApiIssueResponse;
  }
}
