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
      total_tokens: entry.tokens.total_tokens
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
      error: entry.error
    }));

    const activeSeconds = Array.from(state.running.values()).reduce((total, entry) => {
      const seconds = Math.max(0, Math.floor((nowMs - entry.started_at_ms) / 1000));
      return total + seconds;
    }, 0);

    return redactUnknown({
      generated_at: asIsoDate(nowMs),
      counts: {
        running: running.length,
        retrying: retrying.length
      },
      running,
      retrying,
      codex_totals: {
        input_tokens: state.codex_totals.input_tokens,
        output_tokens: state.codex_totals.output_tokens,
        total_tokens: state.codex_totals.total_tokens,
        seconds_running: state.codex_totals.seconds_running + activeSeconds
      },
      rate_limits: state.codex_rate_limits,
      health: {
        dispatch_validation: state.health.dispatch_validation,
        last_error: state.health.last_error
      }
    }) as ApiStateResponse;
  }

  projectIssue(state: OrchestratorState, issueIdentifier: string): ApiIssueResponse {
    const runningEntry = Array.from(state.running.entries()).find(([, entry]) => entry.identifier === issueIdentifier);
    const retryEntry = Array.from(state.retry_attempts.values()).find((entry) => entry.identifier === issueIdentifier);

    if (!runningEntry && !retryEntry) {
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
            total_tokens: entry.tokens.total_tokens
          }
        },
        retry: retryEntry
          ? {
              attempt: retryEntry.attempt,
              due_at: asIsoDate(retryEntry.due_at_ms),
              error: retryEntry.error
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

    const retryOnlyEntry = retryEntry;
    if (!retryOnlyEntry) {
      throw new LocalApiError(
        'issue_not_found',
        `Issue ${issueIdentifier} is not in runtime state`,
        404
      );
    }

    const issueId = retryOnlyEntry.issue_id;
    return redactUnknown({
      issue_identifier: issueIdentifier,
      issue_id: issueId,
      status: 'retrying',
      workspace: {
        path: null,
        host: null
      },
      attempts: {
        restart_count: 0,
        current_retry_attempt: retryOnlyEntry.attempt
      },
      running: null,
      retry: {
        attempt: retryOnlyEntry.attempt,
        due_at: asIsoDate(retryOnlyEntry.due_at_ms),
        error: retryOnlyEntry.error
      },
      recent_events: [],
      last_error: retryOnlyEntry.error,
      logs: {
        codex_session_logs: []
      },
      tracked: {}
    }) as ApiIssueResponse;
  }
}
