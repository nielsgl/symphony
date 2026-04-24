import type { Issue } from '../tracker';
import type { StructuredLogger } from '../observability';
import { CANONICAL_EVENT } from '../observability/events';
import { ThroughputTracker } from '../observability/throughput';
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
  OrchestratorOptions,
  OrchestratorState,
  RetryDelayType,
  RetryEntry,
  RunningEntry,
  TickReason,
  WorkerObservabilityEvent,
  WorkerExitReason
} from './types';

interface ScheduleRetryParams {
  issue_id: string;
  identifier: string;
  attempt: number;
  delay_type: RetryDelayType;
  error?: string | null;
  worker_host?: string | null;
  workspace_path?: string | null;
  stop_reason_code?: string | null;
  stop_reason_detail?: string | null;
  previous_thread_id?: string | null;
  previous_session_id?: string | null;
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

function cloneRunningEntry(entry: RunningEntry): RunningEntry {
  return {
    ...entry,
    issue: cloneIssue(entry.issue),
    tokens: { ...entry.tokens },
    last_reported_tokens: { ...entry.last_reported_tokens },
    recent_events: entry.recent_events.map((event) => ({ ...event }))
  };
}

function cloneRetryEntry(entry: RetryEntry): RetryEntry {
  return {
    issue_id: entry.issue_id,
    identifier: entry.identifier,
    attempt: entry.attempt,
    due_at_ms: entry.due_at_ms,
    error: entry.error,
    worker_host: entry.worker_host,
    workspace_path: entry.workspace_path,
    stop_reason_code: entry.stop_reason_code,
    stop_reason_detail: entry.stop_reason_detail,
    previous_thread_id: entry.previous_thread_id,
    previous_session_id: entry.previous_session_id,
    timer_handle: entry.timer_handle
  };
}

function humanizeWorkerEvent(event: WorkerObservabilityEvent): string {
  const base = event.event.replace(/[._/]+/g, ' ').trim();
  if (event.detail && event.detail.trim().length > 0) {
    return `${base}: ${event.detail.trim()}`;
  }

  return base;
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

export class OrchestratorCore {
  private readonly config: OrchestratorOptions['config'];
  private readonly ports: OrchestratorOptions['ports'];
  private readonly nowMs: () => number;
  private readonly logger?: StructuredLogger;
  private readonly persistence?: OrchestratorOptions['persistence'];
  private readonly throughputTracker: ThroughputTracker;

  private readonly state: OrchestratorState;
  private hostRoundRobinIndex: number;

  constructor(options: OrchestratorOptions) {
    this.config = options.config;
    this.ports = options.ports;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.logger = options.logger;
    this.persistence = options.persistence;

    this.state = {
      poll_interval_ms: this.config.poll_interval_ms,
      max_concurrent_agents: this.config.max_concurrent_agents,
      running: new Map(),
      claimed: new Set(),
      retry_attempts: new Map(),
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
        last_error: null
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
  }

  getStateSnapshot(): OrchestratorState {
    return {
      ...this.state,
      running: new Map(
        Array.from(this.state.running.entries()).map(([issueId, entry]) => [issueId, cloneRunningEntry(entry)])
      ),
      claimed: new Set(this.state.claimed.values()),
      retry_attempts: new Map(
        Array.from(this.state.retry_attempts.entries()).map(([issueId, entry]) => [issueId, cloneRetryEntry(entry)])
      ),
      completed: new Set(this.state.completed.values()),
      codex_totals: { ...this.state.codex_totals },
      codex_rate_limits: this.state.codex_rate_limits ? { ...this.state.codex_rate_limits } : null,
      health: { ...this.state.health },
      throughput: this.throughputTracker.snapshot(this.nowMs()),
      recent_runtime_events: this.state.recent_runtime_events.map((event) => ({ ...event }))
    };
  }

  applyRuntimeConfig(config: {
    poll_interval_ms: number;
    max_concurrent_agents: number;
    max_concurrent_agents_by_state: Record<string, number>;
    max_retry_backoff_ms: number;
    active_states: string[];
    terminal_states: string[];
    stall_timeout_ms: number;
    worker_hosts?: string[];
    max_concurrent_agents_per_host?: number | null;
  }): void {
    this.config.poll_interval_ms = config.poll_interval_ms;
    this.config.max_concurrent_agents = config.max_concurrent_agents;
    this.config.max_concurrent_agents_by_state = { ...config.max_concurrent_agents_by_state };
    this.config.max_retry_backoff_ms = config.max_retry_backoff_ms;
    this.config.active_states = [...config.active_states];
    this.config.terminal_states = [...config.terminal_states];
    this.config.stall_timeout_ms = config.stall_timeout_ms;
    this.config.worker_hosts = config.worker_hosts ? [...config.worker_hosts] : [];
    this.config.max_concurrent_agents_per_host = config.max_concurrent_agents_per_host ?? null;

    this.state.poll_interval_ms = config.poll_interval_ms;
    this.state.max_concurrent_agents = config.max_concurrent_agents;
  }

  async tick(reason: TickReason): Promise<void> {
    await this.reconcileRunningIssues();

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

    for (const issue of sortedCandidates) {
      if (availableGlobalSlots(this.state) <= 0) {
        break;
      }

      const eligibility = shouldDispatchIssue(issue, this.state, this.config);
      if (!eligibility.eligible) {
        continue;
      }

      await this.dispatchIssue(issue, null);
    }

    this.ports.notifyObservers?.();
  }

  onWorkerEvent(issue_id: string, workerEvent: WorkerObservabilityEvent): void {
    const runningEntry = this.state.running.get(issue_id);
    if (!runningEntry) {
      return;
    }

    runningEntry.last_codex_timestamp_ms = workerEvent.timestamp_ms;
    runningEntry.last_event = workerEvent.event;
    runningEntry.last_event_summary = humanizeWorkerEvent(workerEvent);
    runningEntry.last_message = workerEvent.detail ?? null;

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

    if (workerEvent.event === CANONICAL_EVENT.codex.turnStarted) {
      runningEntry.turn_count += 1;
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
      if (totalDelta > 0) {
        this.throughputTracker.observe({
          at_ms: workerEvent.timestamp_ms,
          tokens: totalDelta
        });
      }
    }

    if (workerEvent.rate_limits) {
      this.state.codex_rate_limits = { ...workerEvent.rate_limits };
    }

    runningEntry.recent_events.push({
      at_ms: workerEvent.timestamp_ms,
      event: workerEvent.event,
      message: workerEvent.detail ?? null
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
          message: workerEvent.detail ?? null
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
        event_summary: runningEntry.last_event_summary
      }
    });
    this.recordRuntimeEvent({
      event: workerEvent.event,
      severity: severityForRuntimeEvent(workerEvent.event),
      issue_identifier: runningEntry.identifier,
      session_id: runningEntry.session_id ?? undefined,
      detail: workerEvent.detail
    });
  }

  async onWorkerExit(issue_id: string, reason: WorkerExitReason, error?: string): Promise<void> {
    const running = this.state.running.get(issue_id);
    if (!running) {
      return;
    }

    this.state.running.delete(issue_id);
    this.addRuntimeSecondsFromEntry(running);

    if (reason === 'normal') {
      await this.completeRunRecord(running, 'succeeded', null);
      this.state.completed.add(issue_id);
      await this.scheduleRetry({
        issue_id,
        identifier: running.identifier,
        attempt: 1,
        delay_type: 'continuation',
        error: null,
        worker_host: running.worker_host ?? null,
        workspace_path: running.workspace_path ?? null,
        stop_reason_code: 'normal_completion',
        stop_reason_detail: 'normal worker completion, continuing while issue is active',
        previous_thread_id: running.thread_id,
        previous_session_id: running.session_id
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
      await this.completeRunRecord(running, 'failed', error ?? `worker exited: ${reason}`);
      this.state.health.last_error = `worker exited for ${running.identifier}`;
      await this.scheduleRetry({
        issue_id,
        identifier: running.identifier,
        attempt: running.retry_attempt + 1,
        delay_type: 'failure',
        error: error ?? `worker exited: ${reason}`,
        worker_host: running.worker_host ?? null,
        workspace_path: running.workspace_path ?? null,
        stop_reason_code: this.inferStopReasonCode(error, 'worker_exit_abnormal'),
        stop_reason_detail: error ?? `worker exited: ${reason}`,
        previous_thread_id: running.thread_id,
        previous_session_id: running.session_id
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
    }

    this.ports.notifyObservers?.();
  }

  async onRetryTimer(issue_id: string): Promise<void> {
    const retryEntry = this.state.retry_attempts.get(issue_id);
    if (!retryEntry) {
      return;
    }

    this.state.retry_attempts.delete(issue_id);

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
        delay_type: 'failure',
        error: 'retry poll failed',
        worker_host: retryEntry.worker_host ?? null,
        workspace_path: retryEntry.workspace_path ?? null,
        stop_reason_code: 'retry_fetch_failed',
        stop_reason_detail: error instanceof Error ? error.message : 'unknown',
        previous_thread_id: retryEntry.previous_thread_id ?? null,
        previous_session_id: retryEntry.previous_session_id ?? null
      });
      return;
    }

    const issue = candidates.find((candidate) => candidate.id === issue_id);
    if (!issue) {
      this.state.claimed.delete(issue_id);
      return;
    }

    if (!isActiveState(issue.state, this.config)) {
      this.state.claimed.delete(issue_id);
      return;
    }

    const eligibility = shouldDispatchIssue(issue, this.state, this.config, {
      skipClaimCheckForIssueId: issue_id
    });

    if (!eligibility.eligible) {
      if (eligibility.reason === 'global_slots_exhausted' || eligibility.reason === 'state_slots_exhausted') {
        await this.scheduleRetry({
          issue_id,
          identifier: issue.identifier,
          attempt: retryEntry.attempt + 1,
          delay_type: 'failure',
          error: 'no available orchestrator slots',
          worker_host: retryEntry.worker_host ?? null,
          workspace_path: retryEntry.workspace_path ?? null,
          stop_reason_code: 'slots_exhausted',
          stop_reason_detail: 'no available orchestrator slots',
          previous_thread_id: retryEntry.previous_thread_id ?? null,
          previous_session_id: retryEntry.previous_session_id ?? null
        });
      } else {
        this.state.claimed.delete(issue_id);
      }

      return;
    }

    await this.dispatchIssue(issue, retryEntry.attempt);
  }

  async reconcileRunningIssues(): Promise<void> {
    await this.reconcileStalledRuns();

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

      if (isActiveState(refreshedIssue.state, this.config)) {
        runningEntry.issue = refreshedIssue;
        runningEntry.identifier = refreshedIssue.identifier;
        continue;
      }

      await this.terminateRunningIssue(refreshedIssue.id, false, 'non_active_state_transition');
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
    if (this.config.stall_timeout_ms <= 0) {
      return;
    }

    const now = this.nowMs();

    for (const [issueId, runningEntry] of Array.from(this.state.running.entries())) {
      const elapsedMs = now - (runningEntry.last_codex_timestamp_ms ?? runningEntry.started_at_ms);
      if (elapsedMs <= this.config.stall_timeout_ms) {
        continue;
      }

      await this.ports.terminateWorker({
        issue_id: issueId,
        worker_handle: runningEntry.worker_handle,
        cleanup_workspace: false,
        reason: 'stall_timeout'
      });

      this.addRuntimeSecondsFromEntry(runningEntry);
      this.state.running.delete(issueId);

      await this.completeRunRecord(runningEntry, 'stalled', 'worker stalled');

      await this.scheduleRetry({
        issue_id: issueId,
        identifier: runningEntry.identifier,
        attempt: runningEntry.retry_attempt + 1,
        delay_type: 'failure',
        error: 'worker stalled',
        worker_host: runningEntry.worker_host ?? null,
        workspace_path: runningEntry.workspace_path ?? null,
        stop_reason_code: 'worker_stalled',
        stop_reason_detail: 'worker stalled',
        previous_thread_id: runningEntry.thread_id,
        previous_session_id: runningEntry.session_id
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
          elapsed_ms: elapsedMs
        }
      });
      this.recordRuntimeEvent({
        event: CANONICAL_EVENT.orchestration.workerStalled,
        severity: 'warn',
        issue_identifier: runningEntry.identifier,
        session_id: runningEntry.session_id ?? undefined,
        detail: 'worker stalled'
      });
    }
  }

  private async dispatchIssue(issue: Issue, attempt: number | null): Promise<void> {
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
      await this.scheduleRetry({
        issue_id: issue.id,
        identifier: issue.identifier,
        attempt: nextAttempt(attempt),
        delay_type: 'failure',
        error: 'no available worker host slots',
        worker_host: workerHost,
        workspace_path: null,
        stop_reason_code: 'slots_exhausted',
        stop_reason_detail: 'no available worker host slots'
      });
      return;
    }

    const spawned = await this.ports.spawnWorker({ issue, attempt, worker_host: workerHost });

    if (!spawned.ok) {
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
      await this.scheduleRetry({
        issue_id: issue.id,
        identifier: issue.identifier,
        attempt: nextAttempt(attempt),
        delay_type: 'failure',
        error: 'failed to spawn agent',
        worker_host: workerHost,
        workspace_path: null,
        stop_reason_code: 'spawn_failed',
        stop_reason_detail: spawned.error
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

    this.state.running.set(issue.id, {
      issue,
      identifier: issue.identifier,
      run_id: null,
      worker_handle: spawned.worker_handle,
      monitor_handle: spawned.monitor_handle,
      retry_attempt: attempt ?? 0,
      workspace_path: spawned.workspace_path ?? null,
      worker_host: spawned.worker_host ?? workerHost ?? null,
      session_id: null,
      thread_id: null,
      turn_id: null,
      codex_app_server_pid: null,
      turn_count: 0,
      last_event: null,
      last_event_summary: null,
      last_message: null,
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
      recent_events: [],
      started_at_ms: this.nowMs(),
      last_codex_timestamp_ms: null
    });

    const runningEntry = this.state.running.get(issue.id);
    if (runningEntry && this.persistence) {
      try {
        runningEntry.run_id = await this.persistence.startRun({
          issue_id: issue.id,
          issue_identifier: issue.identifier
        });
      } catch {
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

    this.state.claimed.add(issue.id);

    const existingRetry = this.state.retry_attempts.get(issue.id);
    if (existingRetry) {
      this.ports.cancelRetryTimer(existingRetry.timer_handle);
      this.state.retry_attempts.delete(issue.id);
    }
  }

  private async terminateRunningIssue(issue_id: string, cleanup_workspace: boolean, reason: string): Promise<void> {
    const runningEntry = this.state.running.get(issue_id);
    if (!runningEntry) {
      return;
    }

    await this.ports.terminateWorker({
      issue_id,
      worker_handle: runningEntry.worker_handle,
      cleanup_workspace,
      reason
    });

    this.addRuntimeSecondsFromEntry(runningEntry);
    await this.completeRunRecord(runningEntry, 'cancelled', reason);
    this.state.running.delete(issue_id);
    this.state.claimed.delete(issue_id);
    this.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.orchestration.workerTerminated,
      message: `worker terminated: ${reason}`,
      context: {
        issue_id,
        issue_identifier: runningEntry.identifier,
        session_id: runningEntry.session_id,
        cleanup_workspace,
        reason
      }
    });

    const retry = this.state.retry_attempts.get(issue_id);
    if (retry) {
      this.ports.cancelRetryTimer(retry.timer_handle);
      this.state.retry_attempts.delete(issue_id);
    }
  }

  private async scheduleRetry(params: ScheduleRetryParams): Promise<void> {
    const existing = this.state.retry_attempts.get(params.issue_id);
    if (existing) {
      this.ports.cancelRetryTimer(existing.timer_handle);
      this.state.retry_attempts.delete(params.issue_id);
    }

    const delayMs =
      params.delay_type === 'continuation'
        ? 1000
        : computeFailureBackoffMs(params.attempt, this.config.max_retry_backoff_ms);

    const dueAtMs = this.nowMs() + delayMs;

    const timerHandle = this.ports.scheduleRetryTimer({
      issue_id: params.issue_id,
      due_at_ms: dueAtMs,
      callback: async () => {
        await this.onRetryTimer(params.issue_id);
      }
    });

    this.state.retry_attempts.set(params.issue_id, {
      issue_id: params.issue_id,
      identifier: params.identifier,
      attempt: params.attempt,
      due_at_ms: dueAtMs,
      error: params.error ?? null,
      worker_host: params.worker_host ?? null,
      workspace_path: params.workspace_path ?? null,
      stop_reason_code: params.stop_reason_code ?? null,
      stop_reason_detail: params.stop_reason_detail ?? null,
      previous_thread_id: params.previous_thread_id ?? null,
      previous_session_id: params.previous_session_id ?? null,
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

  private inferStopReasonCode(error: string | undefined, fallback: string): string {
    if (!error) {
      return fallback;
    }

    const normalized = error.toLowerCase();
    if (normalized.includes('turn_input_required')) {
      return 'turn_input_required';
    }
    if (normalized.includes('issue_state_refresh_failed')) {
      return 'issue_state_refresh_failed';
    }
    if (normalized.includes('unsafe_workspace_root')) {
      return 'unsafe_workspace_root';
    }
    if (normalized.includes('workspace_empty')) {
      return 'workspace_empty';
    }

    return fallback;
  }

  private addRuntimeSecondsFromEntry(runningEntry: RunningEntry): void {
    this.state.codex_totals.seconds_running += Math.max(0, Math.floor((this.nowMs() - runningEntry.started_at_ms) / 1000));
  }

  private async completeRunRecord(
    runningEntry: RunningEntry,
    terminal_status: 'succeeded' | 'failed' | 'timed_out' | 'stalled' | 'cancelled',
    error_code: string | null
  ): Promise<void> {
    if (!runningEntry.run_id || !this.persistence) {
      return;
    }

    try {
      await this.persistence.completeRun({
        run_id: runningEntry.run_id,
        terminal_status,
        error_code
      });
    } catch {
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
  }


  private recordRuntimeEvent(params: {
    event: string;
    severity: 'info' | 'warn' | 'error';
    issue_identifier?: string;
    session_id?: string;
    detail?: string;
  }): void {
    this.state.recent_runtime_events.push({
      at_ms: this.nowMs(),
      event: params.event,
      severity: params.severity,
      issue_identifier: params.issue_identifier,
      session_id: params.session_id,
      detail: params.detail
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
