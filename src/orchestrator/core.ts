import type { Issue } from '../tracker';
import type { StructuredLogger } from '../observability';
import { CANONICAL_EVENT } from '../observability/events';
import { isKnownPhaseMarker, isTerminalPhaseMarker, phaseMarkerOrder, type PhaseMarker, type PhaseMarkerName } from '../observability';
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
  BlockedEntry,
  OrchestratorOptions,
  OrchestratorState,
  PhaseMarkerSettings,
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
  previous_session_id?: string | null;
  issue_snapshot?: Issue | null;
  progress_signals?: {
    commit_sha: string | null;
    checklist_checkpoint: string | null;
    state_marker: string | null;
  };
}

interface WorkspaceConflictContext {
  detail: string;
  conflict_files: Array<{
    path: string;
    status: 'staged' | 'unstaged' | 'unknown';
  }>;
  resolution_hints: string[];
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
    recent_events: entry.recent_events.map((event) => ({ ...event })),
    copy_ignored_summary: entry.copy_ignored_summary ? { ...entry.copy_ignored_summary } : null,
    current_phase: entry.current_phase,
    current_phase_at_ms: entry.current_phase_at_ms,
    phase_detail: entry.phase_detail
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
    previous_session_id: entry.previous_session_id,
    last_phase: entry.last_phase,
    last_phase_at_ms: entry.last_phase_at_ms,
    last_phase_detail: entry.last_phase_detail,
    timer_handle: entry.timer_handle,
    progress_signals: entry.progress_signals ? { ...entry.progress_signals } : undefined
  };
}

function cloneBlockedEntry(entry: BlockedEntry): BlockedEntry {
  return {
    issue_id: entry.issue_id,
    issue_identifier: entry.issue_identifier,
    attempt: entry.attempt,
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
    resolution_hints: [...(entry.resolution_hints ?? [])],
    previous_thread_id: entry.previous_thread_id,
    previous_session_id: entry.previous_session_id,
    last_phase: entry.last_phase,
    last_phase_at_ms: entry.last_phase_at_ms,
    last_phase_detail: entry.last_phase_detail,
    blocked_at_ms: entry.blocked_at_ms,
    requires_manual_resume: true,
    attempt_count_window: entry.attempt_count_window,
    window_minutes: entry.window_minutes,
    last_known_commit_sha: entry.last_known_commit_sha ?? null,
    last_progress_checkpoint_at: entry.last_progress_checkpoint_at ?? null,
    progress_signals: entry.progress_signals ? { ...entry.progress_signals } : undefined,
    required_actions: [...(entry.required_actions ?? [])],
    resume_override_reason: entry.resume_override_reason ?? null,
    pending_input: entry.pending_input
      ? {
          ...entry.pending_input,
          questions: entry.pending_input.questions.map((question) => ({
            ...question,
            options: question.options ? question.options.map((option) => ({ ...option })) : undefined
          }))
        }
      : null,
    session_console: (entry.session_console ?? []).map((event) => ({ ...event }))
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
  private readonly phaseSettings: PhaseMarkerSettings;
  private readonly throughputTracker: ThroughputTracker;

  private readonly state: OrchestratorState;
  private hostRoundRobinIndex: number;

  constructor(options: OrchestratorOptions) {
    this.config = options.config;
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
      redispatch_progress: new Map(),
      phase_timeline: new Map(),
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
      blocked_inputs: new Map(
        Array.from(this.state.blocked_inputs.entries()).map(([issueId, entry]) => [issueId, cloneBlockedEntry(entry)])
      ),
      redispatch_progress: new Map(
        Array.from((this.state.redispatch_progress ?? new Map<string, Array<{ at_ms: number; commit_sha: string | null; checklist_checkpoint: string | null; state_marker: string | null; pr_open: boolean }>>()).entries()).map(([issueId, entries]) => [
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
    respawn_window_minutes: number;
    respawn_max_attempts_without_progress: number;
    active_states: string[];
    terminal_states: string[];
    github_linking_mode?: 'off' | 'warn' | 'required' | string;
    stall_timeout_ms: number;
    worker_hosts?: string[];
    max_concurrent_agents_per_host?: number | null;
    phase_markers_enabled?: boolean;
    phase_timeline_limit?: number;
  }): void {
    this.config.poll_interval_ms = config.poll_interval_ms;
    this.config.max_concurrent_agents = config.max_concurrent_agents;
    this.config.max_concurrent_agents_by_state = { ...config.max_concurrent_agents_by_state };
    this.config.max_retry_backoff_ms = config.max_retry_backoff_ms;
    this.config.respawn_window_minutes = config.respawn_window_minutes;
    this.config.respawn_max_attempts_without_progress = config.respawn_max_attempts_without_progress;
    this.config.active_states = [...config.active_states];
    this.config.terminal_states = [...config.terminal_states];
    this.config.github_linking_mode = config.github_linking_mode ?? 'off';
    this.config.stall_timeout_ms = config.stall_timeout_ms;
    this.config.worker_hosts = config.worker_hosts ? [...config.worker_hosts] : [];
    this.config.max_concurrent_agents_per_host = config.max_concurrent_agents_per_host ?? null;
    this.config.phase_markers_enabled = config.phase_markers_enabled ?? true;
    this.config.phase_timeline_limit = config.phase_timeline_limit ?? 30;
    this.phaseSettings.enabled = this.config.phase_markers_enabled !== false;
    this.phaseSettings.timeline_limit = Math.max(1, this.config.phase_timeline_limit ?? 30);

    this.state.poll_interval_ms = config.poll_interval_ms;
    this.state.max_concurrent_agents = config.max_concurrent_agents;
  }

  async tick(reason: TickReason): Promise<void> {
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

      const eligibility = shouldDispatchIssue(issue, this.state, this.config);
      if (!eligibility.eligible) {
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

      await this.dispatchIssue(issue, null);
    }

    if (githubLinkingMode === 'required' && missingGithubLinkCount > 0) {
      this.state.health.last_error = `${missingGithubLinkCount} candidate issue(s) missing linked GitHub issue`;
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
    if (!this.emitExplicitPhaseMarker(issue_id, workerEvent)) {
      this.emitMappedPhaseMarker(issue_id, workerEvent);
    }
  }

  async onWorkerExit(issue_id: string, reason: WorkerExitReason, error?: string): Promise<void> {
    const running = this.state.running.get(issue_id);
    if (!running) {
      return;
    }

    this.state.running.delete(issue_id);
    this.addRuntimeSecondsFromEntry(running);

    if (reason === 'normal') {
      this.emitPhaseMarker(issue_id, {
        phase: 'completed',
        detail: 'worker exited normally',
        attempt: running.retry_attempt,
        thread_id: running.thread_id,
        session_id: running.session_id
      });
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
        stop_reason_code: 'normal_completion',
        stop_reason_detail: 'normal worker completion, continuing while issue is active',
        previous_thread_id: running.thread_id,
        previous_session_id: running.session_id,
        issue_snapshot: running.issue
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
      const stopReasonCode = this.inferStopReasonCode(error, 'worker_exit_abnormal');
      if (stopReasonCode === 'turn_input_required') {
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
          stop_reason_code: 'turn_input_required',
          stop_reason_detail: stopReasonDetail,
          pending_input: inputDetail,
          session_console: running.recent_events,
          previous_thread_id: running.thread_id,
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
            stop_reason_code: 'turn_input_required',
            error: stopReasonDetail
          }
        });
        this.ports.notifyObservers?.();
        return;
      }
      if (stopReasonCode === 'operator_action_required_workspace_conflict') {
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
          stop_reason_code: 'operator_action_required_workspace_conflict',
          stop_reason_detail: workspaceConflict.detail,
          conflict_files: workspaceConflict.conflict_files,
          resolution_hints: workspaceConflict.resolution_hints,
          session_console: running.recent_events,
          previous_thread_id: running.thread_id,
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
            stop_reason_code: 'operator_action_required_workspace_conflict',
            error: workspaceConflict.detail
          }
        });
        this.ports.notifyObservers?.();
        return;
      }

      await this.scheduleRetry({
        issue_id,
        identifier: running.identifier,
        attempt: running.retry_attempt + 1,
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
        previous_session_id: running.session_id,
        issue_snapshot: running.issue
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
    }

    this.ports.notifyObservers?.();
  }

  async onRetryTimer(issue_id: string): Promise<void> {
    if (this.state.blocked_inputs.has(issue_id)) {
      return;
    }

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
        stop_reason_code: 'retry_fetch_failed',
        stop_reason_detail: error instanceof Error ? error.message : 'unknown',
        previous_thread_id: retryEntry.previous_thread_id ?? null,
        previous_session_id: retryEntry.previous_session_id ?? null,
        issue_snapshot: null
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
          stop_reason_code: 'slots_exhausted',
          stop_reason_detail: 'no available orchestrator slots',
          previous_thread_id: retryEntry.previous_thread_id ?? null,
          previous_session_id: retryEntry.previous_session_id ?? null,
          issue_snapshot: issue
        });
      } else {
        this.state.claimed.delete(issue_id);
      }

      return;
    }

    const gateEvaluation = this.evaluateRedispatchGate(issue_id, retryEntry, issue);
    if (!gateEvaluation.allow_redispatch) {
      const stopReasonCode = gateEvaluation.awaiting_human_review_scope_incomplete
        ? 'awaiting_human_review_scope_incomplete'
        : 'operator_action_required_no_progress_redispatch_blocked';
      const stopReasonDetail = gateEvaluation.awaiting_human_review_scope_incomplete
        ? 'PR is open but scope is incomplete and no progress signal was detected'
        : 'completion gate blocked redispatch because no progress signal was detected';
      await this.scheduleBlockedInput({
        issue_id,
        issue_identifier: retryEntry.identifier,
        attempt: retryEntry.attempt,
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
        previous_session_id: retryEntry.previous_session_id ?? null,
        attempt_count_window: gateEvaluation.attempt_count_window,
        window_minutes: gateEvaluation.window_minutes,
        last_known_commit_sha: gateEvaluation.last_known_commit_sha,
        last_progress_checkpoint_at: gateEvaluation.last_progress_checkpoint_at,
        progress_signals: gateEvaluation.progress_signals,
        required_actions: [
          'Mark acceptance complete and resume',
          'Push additional commit and resume',
          'Cancel and return to backlog'
        ]
      });
      const eventName = gateEvaluation.awaiting_human_review_scope_incomplete
        ? CANONICAL_EVENT.orchestration.stateAwaitingHumanReviewScopeIncomplete
        : CANONICAL_EVENT.orchestration.redispatchCompletionGateBlocked;
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
          attempt_count_window: gateEvaluation.attempt_count_window,
          window_minutes: gateEvaluation.window_minutes
        }
      });
      if (gateEvaluation.attempt_count_window >= (this.config.respawn_max_attempts_without_progress ?? 3)) {
        this.recordRuntimeEvent({
          event: CANONICAL_EVENT.orchestration.redispatchCircuitBreakerOpened,
          severity: 'warn',
          issue_identifier: retryEntry.identifier,
          detail: 'respawn circuit breaker opened'
        });
      }
      return;
    }

    await this.dispatchIssue(issue, retryEntry.attempt);
  }

  private evaluateRedispatchGate(
    issue_id: string,
    retryEntry: RetryEntry,
    issue: Issue
  ): {
    allow_redispatch: boolean;
    awaiting_human_review_scope_incomplete: boolean;
    attempt_count_window: number;
    window_minutes: number;
    last_known_commit_sha: string | null;
    last_progress_checkpoint_at: number | null;
    progress_signals: { commit_sha: string | null; checklist_checkpoint: string | null; state_marker: string | null };
  } {
    const windowMinutes = Math.max(1, this.config.respawn_window_minutes ?? 30);
    const windowMs = windowMinutes * 60_000;
    const now = this.nowMs();
    const currentSignals = {
      commit_sha: retryEntry.progress_signals?.commit_sha ?? null,
      checklist_checkpoint: retryEntry.progress_signals?.checklist_checkpoint ?? null,
      state_marker: retryEntry.progress_signals?.state_marker ?? null
    };
    const progressMap = this.state.redispatch_progress ?? new Map<string, Array<{ at_ms: number; commit_sha: string | null; checklist_checkpoint: string | null; state_marker: string | null; pr_open: boolean }>>();
    this.state.redispatch_progress = progressMap;
    const existing = progressMap.get(issue_id) ?? [];
    const sample = {
      at_ms: now,
      commit_sha: currentSignals.commit_sha,
      checklist_checkpoint: currentSignals.checklist_checkpoint,
      state_marker: currentSignals.state_marker,
      pr_open: this.hasOpenPullRequest(issue)
    };
    const kept = existing.filter((entry) => now - entry.at_ms <= windowMs);
    const updated = [...kept, sample];
    progressMap.set(issue_id, updated);
    const first = updated[0] ?? sample;
    const noProgress =
      first.commit_sha === sample.commit_sha &&
      first.checklist_checkpoint === sample.checklist_checkpoint &&
      first.state_marker === sample.state_marker;
    const attemptCountWindow = updated.length;
    const breakerHit = noProgress && attemptCountWindow >= Math.max(1, this.config.respawn_max_attempts_without_progress ?? 3);
    const awaitingHuman = Boolean(sample.pr_open && noProgress && breakerHit);
    return {
      allow_redispatch: !breakerHit,
      awaiting_human_review_scope_incomplete: awaitingHuman,
      attempt_count_window: attemptCountWindow,
      window_minutes: windowMinutes,
      last_known_commit_sha: sample.commit_sha,
      last_progress_checkpoint_at: noProgress ? null : sample.at_ms,
      progress_signals: currentSignals
    };
  }

  private hasOpenPullRequest(issue: Issue): boolean {
    const links = issue.tracker_meta?.pr_links ?? [];
    return links.some((link) => !link.merged && String(link.state).toLowerCase() === 'open');
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
      if (!issue || isTerminalState(issue.state, this.config) || !isActiveState(issue.state, this.config)) {
        this.clearBlockedInput(issueId, issue ? 'issue_no_longer_active' : 'issue_not_found');
      }
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
        stop_reason_code: 'worker_stalled',
        stop_reason_detail: 'worker stalled',
        previous_thread_id: runningEntry.thread_id,
        previous_session_id: runningEntry.session_id,
        issue_snapshot: runningEntry.issue
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

  private async dispatchIssue(issue: Issue, attempt: number | null, resume_context: string | null = null): Promise<void> {
    this.emitPhaseMarker(issue.id, {
      phase: 'dispatch_started',
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
      await this.scheduleRetry({
        issue_id: issue.id,
        identifier: issue.identifier,
        attempt: nextAttempt(attempt),
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
        stop_reason_code: 'slots_exhausted',
        stop_reason_detail: 'no available worker host slots',
        issue_snapshot: issue
      });
      return;
    }

    const spawned = await this.ports.spawnWorker({ issue, attempt, worker_host: workerHost, resume_context });

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
      await this.scheduleRetry({
        issue_id: issue.id,
        identifier: issue.identifier,
        attempt: nextAttempt(attempt),
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
        stop_reason_code: 'spawn_failed',
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

    this.state.running.set(issue.id, {
      issue,
      identifier: issue.identifier,
      run_id: null,
      worker_handle: spawned.worker_handle,
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
      last_codex_timestamp_ms: null,
      current_phase: null,
      current_phase_at_ms: null,
      phase_detail: null
    });
    this.emitPhaseMarker(issue.id, {
      phase: 'workspace_ready',
      detail: 'workspace ready and worker spawned',
      attempt: attempt ?? 0
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
    if (this.state.blocked_inputs.has(params.issue_id)) {
      this.state.blocked_inputs.delete(params.issue_id);
    }

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

    const resolvedProgressSignals =
      params.progress_signals ??
      (await this.captureProgressSignals({
        issue: params.issue_snapshot ?? null,
        issue_id: params.issue_id,
        branch_name: params.branch_name ?? null,
        repo_root: params.repo_root ?? null
      }));
    this.state.retry_attempts.set(params.issue_id, {
      issue_id: params.issue_id,
      identifier: params.identifier,
      attempt: params.attempt,
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
      previous_session_id: params.previous_session_id ?? null,
      last_phase: this.getLastPhaseMarker(params.issue_id)?.phase ?? null,
      last_phase_at_ms: this.getLastPhaseMarker(params.issue_id)?.at_ms ?? null,
      last_phase_detail: this.getLastPhaseMarker(params.issue_id)?.detail ?? null,
      progress_signals: resolvedProgressSignals,
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

  private async scheduleBlockedInput(params: {
    issue_id: string;
    issue_identifier: string;
    attempt: number;
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
    }>;
    resolution_hints?: string[];
    pending_input?: {
      detail: string;
      request_id: string | null;
      request_method: string | null;
      prompt_text: string | null;
      questions: Array<{ id: string; prompt?: string; options?: Array<{ label: string; value?: string }> }>;
    } | null;
    session_console?: Array<{ at_ms: number; event: string; message: string | null }>;
    previous_thread_id: string | null;
    previous_session_id: string | null;
    attempt_count_window?: number;
    window_minutes?: number;
    last_known_commit_sha?: string | null;
    last_progress_checkpoint_at?: number | null;
    progress_signals?: {
      commit_sha: string | null;
      checklist_checkpoint: string | null;
      state_marker: string | null;
    };
    required_actions?: string[];
  }): Promise<void> {
    const existingRetry = this.state.retry_attempts.get(params.issue_id);
    if (existingRetry) {
      this.ports.cancelRetryTimer(existingRetry.timer_handle);
      this.state.retry_attempts.delete(params.issue_id);
    }

    this.state.blocked_inputs.set(params.issue_id, {
      issue_id: params.issue_id,
      issue_identifier: params.issue_identifier,
      attempt: params.attempt,
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
      resolution_hints: [...(params.resolution_hints ?? [])],
      previous_thread_id: params.previous_thread_id,
      previous_session_id: params.previous_session_id,
      last_phase: this.getLastPhaseMarker(params.issue_id)?.phase ?? null,
      last_phase_at_ms: this.getLastPhaseMarker(params.issue_id)?.at_ms ?? null,
      last_phase_detail: this.getLastPhaseMarker(params.issue_id)?.detail ?? null,
      blocked_at_ms: this.nowMs(),
      requires_manual_resume: true,
      attempt_count_window: params.attempt_count_window,
      window_minutes: params.window_minutes,
      last_known_commit_sha: params.last_known_commit_sha ?? null,
      last_progress_checkpoint_at: params.last_progress_checkpoint_at ?? null,
      progress_signals: params.progress_signals
        ? {
            commit_sha: params.progress_signals.commit_sha ?? null,
            checklist_checkpoint: params.progress_signals.checklist_checkpoint ?? null,
            state_marker: params.progress_signals.state_marker ?? null
          }
        : undefined,
      required_actions: [...(params.required_actions ?? [])],
      resume_override_reason: null,
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
      session_console: (params.session_console ?? []).slice(-40)
    });
    this.state.claimed.add(params.issue_id);

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
  }

  private clearBlockedInput(issue_id: string, reason: string): void {
    const blocked = this.state.blocked_inputs.get(issue_id);
    if (!blocked) {
      return;
    }

    this.state.blocked_inputs.delete(issue_id);
    this.state.claimed.delete(issue_id);
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
  }): Promise<{
    commit_sha: string | null;
    checklist_checkpoint: string | null;
    state_marker: string | null;
  }> {
    const fallbackStateMarker = this.getLastPhaseMarker(params.issue_id)?.phase ?? null;
    if (!this.ports.resolveProgressSignals) {
      return {
        commit_sha: null,
        checklist_checkpoint: null,
        state_marker: fallbackStateMarker
      };
    }

    try {
      return await this.ports.resolveProgressSignals({
        issue: params.issue,
        issue_id: params.issue_id,
        branch_name: params.branch_name,
        repo_root: params.repo_root,
        fallback_state_marker: fallbackStateMarker
      });
    } catch {
      return {
        commit_sha: null,
        checklist_checkpoint: null,
        state_marker: fallbackStateMarker
      };
    }
  }

  async resumeBlockedIssue(
    issue_identifier: string,
    resume_context: string | null = null,
    resume_override_reason: string | null = null,
    resume_metadata?: {
      request_id: string;
      resume_mode: 'native' | 'fallback';
      resume_reason_code: string;
    }
  ): Promise<{ ok: true; issue_id: string } | { ok: false; code: string; message: string }> {
    const blocked = Array.from(this.state.blocked_inputs.values()).find((entry) => entry.issue_identifier === issue_identifier);
    if (!blocked) {
      return {
        ok: false,
        code: 'issue_not_blocked',
        message: `Issue ${issue_identifier} is not blocked`
      };
    }

    let refreshedIssues: Issue[];
    try {
      refreshedIssues = await this.ports.tracker.fetch_issue_states_by_ids([blocked.issue_id]);
    } catch (error) {
      return {
        ok: false,
        code: 'resume_failed',
        message: error instanceof Error ? error.message : 'failed to refresh issue state'
      };
    }

    const issue = refreshedIssues.find((entry) => entry.id === blocked.issue_id);
    if (!issue) {
      this.clearBlockedInput(blocked.issue_id, 'issue_not_found');
      return {
        ok: false,
        code: 'issue_not_found',
        message: `Issue ${issue_identifier} no longer exists in tracker`
      };
    }

    if (!isActiveState(issue.state, this.config)) {
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
      blocked.stop_reason_code === 'operator_action_required_no_progress_redispatch_blocked' ||
      blocked.stop_reason_code === 'awaiting_human_review_scope_incomplete';
    if (requiresProgressResume && !hasProgressSignal && (!resume_override_reason || resume_override_reason.trim().length === 0)) {
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

    const eligibility = shouldDispatchIssue(issue, this.state, this.config);
    if (eligibility.eligible) {
      await this.dispatchIssue(issue, blocked.attempt, resume_context);
    } else if (eligibility.reason === 'global_slots_exhausted' || eligibility.reason === 'state_slots_exhausted') {
      await this.scheduleRetry({
        issue_id: blocked.issue_id,
        identifier: blocked.issue_identifier,
        attempt: blocked.attempt,
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
        stop_reason_code: 'slots_exhausted',
        stop_reason_detail: 'resume blocked by no available orchestrator slots',
        previous_thread_id: blocked.previous_thread_id,
        previous_session_id: blocked.previous_session_id,
        issue_snapshot: issue
      });
    } else {
      await this.scheduleRetry({
        issue_id: blocked.issue_id,
        identifier: blocked.issue_identifier,
        attempt: blocked.attempt,
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
        stop_reason_code: 'manual_resume',
        stop_reason_detail: 'manual resume requested',
        previous_thread_id: blocked.previous_thread_id,
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

    this.ports.notifyObservers?.();
    return {
      ok: true,
      issue_id: blocked.issue_id
    };
  }

  async cancelBlockedIssue(
    issue_identifier: string,
    cancel_reason: string | null = null
  ): Promise<{ ok: true; issue_id: string; moved_to_state: string } | { ok: false; code: string; message: string }> {
    const blocked = Array.from(this.state.blocked_inputs.values()).find((entry) => entry.issue_identifier === issue_identifier);
    if (!blocked) {
      return {
        ok: false,
        code: 'issue_not_blocked',
        message: `Issue ${issue_identifier} is not blocked`
      };
    }

    const targetState = this.resolveBacklogStateName();
    try {
      await this.ports.tracker.update_issue_state(blocked.issue_id, targetState);
    } catch (error) {
      return {
        ok: false,
        code: 'cancel_failed',
        message: error instanceof Error ? error.message : 'failed to move issue to backlog state'
      };
    }

    this.clearBlockedInput(blocked.issue_id, 'operator_cancelled_to_backlog');
    this.state.redispatch_progress?.delete(blocked.issue_id);
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.orchestration.redispatchCompletionGateBlocked,
      severity: 'info',
      issue_identifier,
      detail: cancel_reason?.trim() ? `cancelled to backlog: ${cancel_reason.trim()}` : 'cancelled to backlog'
    });
    this.ports.notifyObservers?.();
    return { ok: true, issue_id: blocked.issue_id, moved_to_state: targetState };
  }

  async submitBlockedIssueInput(params: {
    issue_identifier: string;
    request_id: string;
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
    const blocked = Array.from(this.state.blocked_inputs.values()).find((entry) => entry.issue_identifier === params.issue_identifier);
    if (!blocked) {
      return { ok: false, code: 'issue_not_blocked', message: `Issue ${params.issue_identifier} is not blocked` };
    }
    if (!blocked.pending_input) {
      return { ok: false, code: 'input_request_missing', message: 'Blocked issue has no pending input request payload' };
    }
    if (!blocked.pending_input.request_id || blocked.pending_input.request_id !== params.request_id) {
      return { ok: false, code: 'request_mismatch', message: 'Input request_id does not match current blocked request' };
    }

    if (blocked.pending_input.input_schema_type === 'options') {
      const q = blocked.pending_input.questions.find((question) => question.id === params.answer.question_id) ?? blocked.pending_input.questions[0];
      const options = q?.options ?? [];
      if (!params.answer.option_label || !options.some((option) => option.label === params.answer.option_label)) {
        return { ok: false, code: 'input_validation_failed', message: 'Answer must select a valid option label for the pending question' };
      }
    } else if (blocked.pending_input.input_schema_type === 'text') {
      if (!params.answer.text || !params.answer.text.trim()) {
        return { ok: false, code: 'input_validation_failed', message: 'Answer text is required for this input request' };
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
      const resumed = await this.resumeBlockedIssue(params.issue_identifier, nativeAttempt.resume_context ?? null, null, {
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

    const resumeContext = this.buildOperatorInputResumeContext(blocked, params.answer);
    const fallbackReasonCode = nativeAttempt.code;
    this.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.orchestration.blockedInputSubmitRequested,
      message: 'blocked input submit accepted',
      context: {
        issue_id: blocked.issue_id,
        issue_identifier: blocked.issue_identifier,
        request_id: params.request_id,
        input_schema_type: blocked.pending_input.input_schema_type,
        answer_applied: true,
        resume_mode: 'fallback',
        resume_reason_code: fallbackReasonCode
      }
    });
    this.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.orchestration.blockedInputSubmitFallbackUsed,
      message: 'blocked input resumed with fallback context',
      context: {
        issue_id: blocked.issue_id,
        issue_identifier: blocked.issue_identifier,
        request_id: params.request_id,
        resume_reason_code: fallbackReasonCode
      }
    });
    const resumed = await this.resumeBlockedIssue(params.issue_identifier, resumeContext, null, {
      request_id: params.request_id,
      resume_mode: 'fallback',
      resume_reason_code: fallbackReasonCode
    });
    if (!resumed.ok) {
      return resumed;
    }
    return {
      ok: true,
      issue_id: resumed.issue_id,
      request_id: params.request_id,
      resume_mode: 'fallback',
      resume_reason_code: fallbackReasonCode,
      requested_at: new Date().toISOString(),
      request_lineage: {
        previous_thread_id: blocked.previous_thread_id ?? null,
        previous_session_id: blocked.previous_session_id ?? null
      }
    };
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
        return 'codex_session_started';
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
    if (workspaceConflictPayload?.code === 'operator_action_required_workspace_conflict') {
      return 'operator_action_required_workspace_conflict';
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
    if (
      normalized.includes('workspace_unprovisioned_conflict') ||
      normalized.includes('worktree_branch_conflict')
    ) {
      return 'operator_action_required_workspace_conflict';
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
    conflict_files: Array<{ path: string; status: 'staged' | 'unstaged' | 'unknown' }>;
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
        conflict_files?: Array<{ path?: string; status?: string }>;
        resolution_hints?: string[];
      };
      return {
        code: typeof payload.code === 'string' ? payload.code : null,
        detail: typeof payload.detail === 'string' ? payload.detail : null,
        conflict_files: (payload.conflict_files ?? [])
          .filter((file) => typeof file?.path === 'string' && file.path.trim().length > 0)
          .map((file) => ({
            path: String(file.path),
            status: file?.status === 'staged' || file?.status === 'unstaged' ? file.status : 'unknown'
          })),
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
    const prefix = 'turn_input_required:';
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
