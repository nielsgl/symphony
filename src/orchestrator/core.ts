import type { Issue } from '../tracker';
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
  TickReason,
  WorkerExitReason
} from './types';

interface ScheduleRetryParams {
  issue_id: string;
  identifier: string;
  attempt: number;
  delay_type: RetryDelayType;
  error?: string | null;
}

function cloneRetryEntry(entry: RetryEntry): RetryEntry {
  return {
    issue_id: entry.issue_id,
    identifier: entry.identifier,
    attempt: entry.attempt,
    due_at_ms: entry.due_at_ms,
    error: entry.error,
    timer_handle: entry.timer_handle
  };
}

export class OrchestratorCore {
  private readonly config: OrchestratorOptions['config'];
  private readonly ports: OrchestratorOptions['ports'];
  private readonly nowMs: () => number;

  private readonly state: OrchestratorState;

  constructor(options: OrchestratorOptions) {
    this.config = options.config;
    this.ports = options.ports;
    this.nowMs = options.nowMs ?? (() => Date.now());

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
      codex_rate_limits: null
    };
  }

  getStateSnapshot(): OrchestratorState {
    return {
      ...this.state,
      running: new Map(this.state.running.entries()),
      claimed: new Set(this.state.claimed.values()),
      retry_attempts: new Map(
        Array.from(this.state.retry_attempts.entries()).map(([issueId, entry]) => [issueId, cloneRetryEntry(entry)])
      ),
      completed: new Set(this.state.completed.values()),
      codex_totals: { ...this.state.codex_totals },
      codex_rate_limits: this.state.codex_rate_limits ? { ...this.state.codex_rate_limits } : null
    };
  }

  async tick(_reason: TickReason): Promise<void> {
    await this.reconcileRunningIssues();

    const preflight = this.ports.dispatchPreflight();
    if (!preflight.dispatch_allowed) {
      this.ports.notifyObservers?.();
      return;
    }

    let candidates: Issue[];
    try {
      candidates = await this.ports.tracker.fetch_candidate_issues();
    } catch {
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

  async onWorkerExit(issue_id: string, reason: WorkerExitReason): Promise<void> {
    const running = this.state.running.get(issue_id);
    if (!running) {
      return;
    }

    this.state.running.delete(issue_id);
    this.state.codex_totals.seconds_running += Math.max(0, Math.floor((this.nowMs() - running.started_at_ms) / 1000));

    if (reason === 'normal') {
      this.state.completed.add(issue_id);
      await this.scheduleRetry({
        issue_id,
        identifier: running.identifier,
        attempt: 1,
        delay_type: 'continuation',
        error: null
      });
    } else {
      await this.scheduleRetry({
        issue_id,
        identifier: running.identifier,
        attempt: running.retry_attempt + 1,
        delay_type: 'failure',
        error: `worker exited: ${reason}`
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
    } catch {
      await this.scheduleRetry({
        issue_id,
        identifier: retryEntry.identifier,
        attempt: retryEntry.attempt + 1,
        delay_type: 'failure',
        error: 'retry poll failed'
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
          error: 'no available orchestrator slots'
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
    } catch {
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

      this.state.running.delete(issueId);

      await this.scheduleRetry({
        issue_id: issueId,
        identifier: runningEntry.identifier,
        attempt: runningEntry.retry_attempt + 1,
        delay_type: 'failure',
        error: 'worker stalled'
      });
    }
  }

  private async dispatchIssue(issue: Issue, attempt: number | null): Promise<void> {
    const spawned = await this.ports.spawnWorker({ issue, attempt });

    if (!spawned.ok) {
      await this.scheduleRetry({
        issue_id: issue.id,
        identifier: issue.identifier,
        attempt: nextAttempt(attempt),
        delay_type: 'failure',
        error: 'failed to spawn agent'
      });
      return;
    }

    this.state.running.set(issue.id, {
      issue,
      identifier: issue.identifier,
      worker_handle: spawned.worker_handle,
      monitor_handle: spawned.monitor_handle,
      retry_attempt: attempt ?? 0,
      started_at_ms: this.nowMs(),
      last_codex_timestamp_ms: null
    });

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

    this.state.running.delete(issue_id);
    this.state.claimed.delete(issue_id);

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
      timer_handle: timerHandle
    });

    this.state.claimed.add(params.issue_id);
  }
}
