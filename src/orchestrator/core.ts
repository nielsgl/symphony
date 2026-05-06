import type { Issue } from '../tracker';
import type { StructuredLogger } from '../observability';
import { CANONICAL_EVENT } from '../observability/events';
import { REASON_CODES } from '../observability/reason-codes';
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
  BudgetRuntimeProjection,
  CircuitBreakerEntry,
  OperatorActionRecord,
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
  previous_session_id?: string | null;
  issue_snapshot?: Issue | null;
  progress_signals?: {
    commit_sha: string | null;
    checklist_checkpoint: string | null;
    state_marker: string | null;
  };
  budget?: BudgetRuntimeProjection;
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
    persisted_turn_ids: [...(entry.persisted_turn_ids ?? [])],
    recent_events: entry.recent_events.map((event) => ({ ...event })),
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
    current_phase: entry.current_phase,
    current_phase_at_ms: entry.current_phase_at_ms,
    phase_detail: entry.phase_detail,
    budget: entry.budget ? { ...entry.budget } : undefined
  };
}

function cloneOperatorAction(entry: OperatorActionRecord): OperatorActionRecord {
  return { ...entry };
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
    previous_session_id: entry.previous_session_id,
    last_phase: entry.last_phase,
    last_phase_at_ms: entry.last_phase_at_ms,
    last_phase_detail: entry.last_phase_detail,
    timer_handle: entry.timer_handle,
    progress_signals: entry.progress_signals ? { ...entry.progress_signals } : undefined,
    budget: entry.budget ? { ...entry.budget } : undefined
  };
}

function cloneBlockedEntry(entry: BlockedEntry): BlockedEntry {
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
    session_console: (entry.session_console ?? []).map((event) => ({ ...event })),
    quarantined_events: (entry.quarantined_events ?? []).map((event) => ({ ...event })),
    quarantined_event_count: entry.quarantined_event_count ?? 0,
    last_quarantined_event_at_ms: entry.last_quarantined_event_at_ms ?? null
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
  private hostRoundRobinIndex: number;

  constructor(options: OrchestratorOptions) {
    this.config = options.config;
    this.config.no_telemetry_warning_threshold_ms = this.config.no_telemetry_warning_threshold_ms ?? 120_000;
    this.config.progress_heartbeat_only_warn_ms = this.config.progress_heartbeat_only_warn_ms ?? 120_000;
    this.config.progress_stalled_waiting_ms = this.config.progress_stalled_waiting_ms ?? this.config.running_wait_stall_threshold_ms ?? 300_000;
    this.config.running_wait_stall_threshold_ms = this.config.progress_stalled_waiting_ms;
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
      snapshot_generated_at_ms: this.nowMs(),
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
      budget_usage_samples: new Map(
        Array.from((this.state.budget_usage_samples ?? new Map<string, Array<{ at_ms: number; total_tokens: number }>>()).entries()).map(([issueId, samples]) => [
          issueId,
          samples.map((sample) => ({ ...sample }))
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
    no_telemetry_warning_threshold_ms?: number;
    running_wait_stall_threshold_ms?: number;
    progress_heartbeat_only_warn_ms?: number;
    progress_stalled_waiting_ms?: number;
    worker_hosts?: string[];
    max_concurrent_agents_per_host?: number | null;
    phase_markers_enabled?: boolean;
    phase_timeline_limit?: number;
    budget?: OrchestratorOptions['config']['budget'];
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
    this.config.no_telemetry_warning_threshold_ms = config.no_telemetry_warning_threshold_ms ?? 120_000;
    this.config.progress_heartbeat_only_warn_ms = config.progress_heartbeat_only_warn_ms ?? 120_000;
    this.config.progress_stalled_waiting_ms = config.progress_stalled_waiting_ms ?? config.running_wait_stall_threshold_ms ?? 300_000;
    this.config.running_wait_stall_threshold_ms = this.config.progress_stalled_waiting_ms;
    this.config.worker_hosts = config.worker_hosts ? [...config.worker_hosts] : [];
    this.config.max_concurrent_agents_per_host = config.max_concurrent_agents_per_host ?? null;
    this.config.phase_markers_enabled = config.phase_markers_enabled ?? true;
    this.config.phase_timeline_limit = config.phase_timeline_limit ?? 30;
    this.config.budget = config.budget;
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

      if (this.state.circuit_breakers.get(issue.id)?.breaker_active) {
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
      const blockedEntry = this.state.blocked_inputs.get(issue_id);
      if (blockedEntry?.awaiting_operator) {
        this.quarantineBlockedWorkerEvent(blockedEntry, workerEvent, 'awaiting_operator_latch');
      }
      return;
    }

    runningEntry.last_codex_timestamp_ms = workerEvent.timestamp_ms;
    runningEntry.last_event = workerEvent.event;
    runningEntry.last_event_summary = humanizeWorkerEvent(workerEvent);
    runningEntry.last_message = workerEvent.detail ?? null;
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
      this.maybeClassifyRunningWaitStall(issue_id, runningEntry, workerEvent.timestamp_ms);
    } else if (this.shouldResetRunningWaitEpisode(workerEvent.event)) {
      runningEntry.running_waiting_started_at_ms = null;
      runningEntry.running_wait_stall_event_emitted = false;
      runningEntry.heartbeat_only_event_emitted = false;
      runningEntry.stalled_waiting_since_ms = null;
      runningEntry.stalled_waiting_reason = null;
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

    void this.persistExecutionGraphWorkerEvent(issue_id, runningEntry, workerEvent);

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

  private async persistExecutionGraphWorkerEvent(
    issueId: string,
    runningEntry: RunningEntry,
    workerEvent: WorkerObservabilityEvent
  ): Promise<void> {
    if (!this.persistence || !runningEntry.issue_run_id || !runningEntry.attempt_id) {
      return;
    }

    try {
      const at = asIso(workerEvent.timestamp_ms);
      const threadId = workerEvent.thread_id ?? runningEntry.thread_id;
      const turnId = workerEvent.turn_id ?? runningEntry.turn_id;

      if (threadId && runningEntry.persisted_thread_id !== threadId) {
        runningEntry.persisted_thread_id = threadId;
        await this.persistence.appendThread?.({
          attempt_id: runningEntry.attempt_id,
          thread_id: threadId,
          started_at: at,
          status: 'running',
          reason_code: REASON_CODES.codexSessionStarted,
          reason_detail: workerEvent.session_id ?? runningEntry.session_id
        });
      }

      const persistedTurnIds = (runningEntry.persisted_turn_ids ??= []);
      if (threadId && turnId && !persistedTurnIds.includes(turnId)) {
        persistedTurnIds.push(turnId);
        await this.persistence.appendTurn?.({
          thread_id: threadId,
          turn_id: turnId,
          turn_index: Math.max(0, runningEntry.turn_count - 1),
          started_at: at,
          status: this.executionGraphStatusForWorkerEvent(workerEvent.event),
          reason_code: this.reasonCodeForWorkerEvent(workerEvent.event),
          reason_detail: workerEvent.detail ?? null
        });
      }

      if (turnId) {
        const phase = this.phaseSpanNameForWorkerEvent(workerEvent.event);
        if (phase) {
          await this.persistence.appendPhaseSpan?.({
            turn_id: turnId,
            phase,
            started_at: at,
            ended_at: at,
            status: this.executionGraphStatusForWorkerEvent(workerEvent.event),
            reason_code: this.reasonCodeForWorkerEvent(workerEvent.event),
            reason_detail: workerEvent.detail ?? null
          });
        }

        const toolName = this.toolNameForWorkerEvent(workerEvent);
        if (toolName) {
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
    } catch {
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.persistence.recordEventFailed,
        message: `failed to persist execution graph event for ${runningEntry.identifier}`,
        context: {
          issue_id: issueId,
          issue_identifier: runningEntry.identifier,
          session_id: runningEntry.session_id,
          thread_id: runningEntry.thread_id,
          turn_id: runningEntry.turn_id,
          event: workerEvent.event
        }
      });
    }
  }

  private executionGraphStatusForWorkerEvent(eventName: string): 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' {
    switch (eventName) {
      case CANONICAL_EVENT.codex.turnCompleted:
      case CANONICAL_EVENT.codex.toolCallCompleted:
        return 'succeeded';
      case CANONICAL_EVENT.codex.turnFailed:
      case CANONICAL_EVENT.codex.toolCallFailed:
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
      workerEvent.event !== CANONICAL_EVENT.codex.toolCallFailed &&
      workerEvent.event !== CANONICAL_EVENT.codex.unsupportedToolCall
    ) {
      return null;
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
    } catch {
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
        turn_id: null,
        from_status: null,
        to_status: toStatus,
        transitioned_at: asIso(this.nowMs()),
        status,
        reason_code: reasonCode,
        reason_detail: reasonDetail
      });
    } catch {
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
      }

      return {
        issue_run_id: issueRunId,
        previous_attempt_id: attemptId ?? params.graphContext.previous_attempt_id ?? null
      };
    } catch {
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

    await this.ports.terminateWorker({
      issue_id: issueId,
      worker_handle: running.worker_handle,
      cleanup_workspace: false,
      reason: stopReasonCode
    });
    await this.completeRunRecord(running, 'failed', stopReasonCode);
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

  async onWorkerExit(issue_id: string, reason: WorkerExitReason, error?: string): Promise<void> {
    const running = this.state.running.get(issue_id);
    if (!running) {
      return;
    }

    this.state.running.delete(issue_id);
    this.addRuntimeSecondsFromEntry(running);
    this.recordBudgetUsageSample(issue_id, running.tokens.total_tokens, this.nowMs());

    if (reason === 'normal') {
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
        previous_session_id: running.session_id,
        issue_snapshot: running.issue,
        budget: running.budget
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
      const stopReasonCode = this.inferStopReasonCode(error, REASON_CODES.workerExitAbnormal);
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
        previous_session_id: running.session_id,
        issue_snapshot: running.issue,
        budget: running.budget
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
          issue_run_id: retryEntry.issue_run_id,
          previous_attempt_id: retryEntry.previous_attempt_id,
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
          stop_reason_code: REASON_CODES.slotsExhausted,
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
        ? REASON_CODES.awaitingHumanReviewScopeIncomplete
        : REASON_CODES.operatorNoProgressRedispatchBlocked;
      const stopReasonDetail = gateEvaluation.awaiting_human_review_scope_incomplete
        ? 'PR is open but scope is incomplete and no progress signal was detected'
        : 'completion gate blocked redispatch because no progress signal was detected';
      const blockedResult = await this.scheduleBlockedInput({
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
        ],
        apply_circuit_breaker: gateEvaluation.breaker_hit
      });
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
            next_operator_action: 'issue.resume',
            next_operator_action_endpoint: '/api/v1/issues/:issue_identifier/resume'
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
            next_operator_action: 'issue.resume',
            next_operator_action_endpoint: '/api/v1/issues/:issue_identifier/resume'
          }
        });
      }
      return;
    }

    await this.dispatchIssue(issue, retryEntry.attempt, null, {
      issue_run_id: retryEntry.issue_run_id,
      previous_attempt_id: retryEntry.previous_attempt_id
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
    const awaitingHuman = Boolean(sample.pr_open && noProgress);
    return {
      allow_redispatch: !noProgress,
      awaiting_human_review_scope_incomplete: awaitingHuman,
      breaker_hit: breakerHit,
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
      this.state.blocked_inputs.set(entry.issue_id, cloneBlockedEntry(entry));
      this.state.claimed.add(entry.issue_id);
    }
    for (const [issueId, actions] of params.operator_actions ?? new Map<string, OperatorActionRecord[]>()) {
      this.state.operator_actions?.set(issueId, actions.map((action) => cloneOperatorAction(action)).slice(-20));
    }
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
    const now = this.nowMs();
    const waitThresholdMs = this.config.running_wait_stall_threshold_ms ?? 300_000;

    for (const [issueId, runningEntry] of Array.from(this.state.running.entries())) {
      const elapsedMs = now - (runningEntry.last_codex_timestamp_ms ?? runningEntry.started_at_ms);
      if (
        waitThresholdMs > 0 &&
        runningEntry.last_event === CANONICAL_EVENT.codex.turnWaiting
      ) {
        this.maybeEmitHeartbeatOnly(issueId, runningEntry, now);
        this.maybeClassifyRunningWaitStall(issueId, runningEntry, now);
      }
      if (runningEntry.last_event && this.shouldResetRunningWaitEpisode(runningEntry.last_event)) {
        runningEntry.running_waiting_started_at_ms = null;
        runningEntry.running_wait_stall_event_emitted = false;
        runningEntry.heartbeat_only_event_emitted = false;
        runningEntry.stalled_waiting_since_ms = null;
        runningEntry.stalled_waiting_reason = null;
      }
      if (this.config.stall_timeout_ms <= 0) {
        continue;
      }
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

  private async dispatchIssue(
    issue: Issue,
    attempt: number | null,
    resume_context: string | null = null,
    graphContext: DispatchGraphContext = {}
  ): Promise<void> {
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
      run_id: null,
      issue_run_id: graphContext.issue_run_id ?? null,
      attempt_id: null,
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
      budget_warning_emitted: false,
      budget_hard_limit_enforced: false,
      budget: this.computeBudgetProjection(issue.id, 0, 'unavailable'),
      recent_events: [],
      started_at_ms: startedAtMs,
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
        const startedAt = asIso(runningEntry.started_at_ms);
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
      previous_session_id: params.previous_session_id ?? null,
      last_phase: this.getLastPhaseMarker(params.issue_id)?.phase ?? null,
      last_phase_at_ms: this.getLastPhaseMarker(params.issue_id)?.at_ms ?? null,
      last_phase_detail: this.getLastPhaseMarker(params.issue_id)?.detail ?? null,
      progress_signals: resolvedProgressSignals,
      budget: params.budget ? { ...params.budget } : undefined,
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
            state_marker: params.progress_signals.state_marker ?? null
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

  async cancelCurrentTurn(
    issue_identifier: string,
    params: { actor?: string | null; reason_note?: string | null; confirmed?: boolean | null } = {}
  ): Promise<{ ok: true; issue_id: string } | { ok: false; code: string; message: string }> {
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
        reason_note: params.reason_note ?? null,
        pre_state: preState,
        post_state: this.describeIssueRuntimeState(running.issue.id)
      });
      return { ok: false, code: 'confirmation_required', message: 'Cancel current turn requires explicit confirmation' };
    }

    await this.terminateRunningIssue(running.issue.id, false, params.reason_note?.trim() || 'operator_cancel_current_turn');
    this.recordOperatorAction(running.issue.id, {
      action: 'cancel',
      requested_at_ms: this.nowMs(),
      result: 'accepted',
      result_code: 'current_turn_cancelled',
      message: 'current turn cancelled',
      actor: params.actor ?? null,
      reason_note: params.reason_note ?? null,
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
          reason_note: params.reason_note ?? null,
          pre_state: preState,
          post_state: this.describeIssueRuntimeState(running.issue.id)
        });
        return { ok: false, code: 'confirmation_required', message: 'Requeue from a running turn requires explicit confirmation' };
      }
      await this.terminateRunningIssue(running.issue.id, false, params.reason_note?.trim() || 'operator_requeue_issue');
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
        stop_reason_detail: params.reason_note?.trim() || 'operator requeue requested',
        previous_thread_id: running.thread_id,
        previous_session_id: running.session_id,
        issue_snapshot: running.issue
      });
      this.recordOperatorAction(running.issue.id, {
        action: 'requeue',
        requested_at_ms: this.nowMs(),
        result: 'accepted',
        result_code: 'requeue_scheduled',
        message: 'issue requeued',
        actor: params.actor ?? null,
        reason_note: params.reason_note ?? null,
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
        stop_reason_detail: params.reason_note?.trim() || 'operator requeue requested',
        previous_thread_id: blocked.previous_thread_id,
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
        reason_note: params.reason_note ?? null,
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
        stop_reason_detail: params.reason_note?.trim() || 'operator requeue requested',
        previous_thread_id: retry.previous_thread_id,
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
        reason_note: params.reason_note ?? null,
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
      stop_reason_detail: params.reason_note?.trim() || 'operator retry-step requested',
      previous_thread_id: retry.previous_thread_id,
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
      reason_note: params.reason_note ?? null,
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
        reason_note: operator_context?.reason_note ?? resume_override_reason ?? null,
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
        reason_note: operator_context?.reason_note ?? resume_override_reason ?? null,
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
        reason_note: operator_context?.reason_note ?? resume_override_reason ?? null,
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
        reason_note: operator_context?.reason_note ?? resume_override_reason ?? null,
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
      reason_note: operator_context?.reason_note ?? resume_override_reason ?? null,
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
    const blocked = Array.from(this.state.blocked_inputs.values()).find((entry) => entry.issue_identifier === issue_identifier);
    if (!blocked) {
      return {
        ok: false,
        code: 'issue_not_blocked',
        message: `Issue ${issue_identifier} is not blocked`
      };
    }
    const preState = this.describeIssueRuntimeState(blocked.issue_id);
    if (operator_context && operator_context.confirmed !== true) {
      this.recordOperatorAction(blocked.issue_id, {
        action: 'cancel',
        requested_at_ms: this.nowMs(),
        result: 'rejected',
        result_code: 'confirmation_required',
        message: 'Cancel requires explicit confirmation',
        actor: operator_context?.actor ?? null,
        reason_note: operator_context?.reason_note ?? cancel_reason ?? null,
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
        reason_note: operator_context?.reason_note ?? cancel_reason ?? null,
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
      message: cancel_reason?.trim() ? `cancelled to backlog: ${cancel_reason.trim()}` : 'cancelled to backlog',
      actor: operator_context?.actor ?? null,
      reason_note: operator_context?.reason_note ?? cancel_reason ?? null,
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
      this.recordOperatorAction(blocked.issue_id, {
        action: 'submit_input',
        requested_at_ms: this.nowMs(),
        result: 'rejected',
        result_code: 'input_submission_not_answerable',
        message: 'Blocked issue has no pending input request payload'
      });
      return { ok: false, code: 'input_submission_not_answerable', message: 'Blocked issue has no pending input request payload' };
    }
    if (!blocked.pending_input.request_id || blocked.pending_input.request_id !== params.request_id) {
      this.recordOperatorAction(blocked.issue_id, {
        action: 'submit_input',
        requested_at_ms: this.nowMs(),
        result: 'rejected',
        result_code: 'input_submission_expired',
        message: 'Input request_id does not match current blocked request'
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
        message: 'Answer must select a valid option label for the pending question'
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
          message: 'Answer text is required for this input request'
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
      const resumed = await this.resumeBlockedIssue(params.issue_identifier, nativeAttempt.resume_context ?? null, null, null, {
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
      message: nativeAttempt.message ?? 'Input submission unavailable for this request'
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
        run_id: running.issue_run_id ?? running.run_id ?? null,
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
        run_id: blocked.issue_run_id ?? null,
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
        run_id: retry.issue_run_id ?? null,
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
      target_identifiers: action.target_identifiers ?? {
        issue_id: issueId,
        issue_identifier: typeof currentState.issue_identifier === 'string' ? currentState.issue_identifier : null,
        run_id: typeof currentState.run_id === 'string' ? currentState.run_id : null,
        attempt_id: typeof currentState.attempt_id === 'string' ? currentState.attempt_id : null,
        thread_id: typeof currentState.thread_id === 'string' ? currentState.thread_id : null,
        turn_id: typeof currentState.turn_id === 'string' ? currentState.turn_id : null
      },
      pre_state: action.pre_state ?? currentState,
      post_state: action.post_state ?? currentState
    };
    const existing = operatorActions.get(issueId) ?? [];
    const updated = [...existing, normalized].slice(-20);
    operatorActions.set(issueId, updated);
    void this.persistence?.upsertOperatorActions?.(issueId, JSON.stringify(updated));
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
      event === CANONICAL_EVENT.codex.startupFailed
    );
  }

  private maybeEmitHeartbeatOnly(issueId: string, runningEntry: RunningEntry, observedAtMs: number): void {
    const thresholdMs = this.config.progress_heartbeat_only_warn_ms ?? 120_000;
    if (thresholdMs <= 0 || runningEntry.last_event !== CANONICAL_EVENT.codex.turnWaiting) {
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

  private maybeClassifyRunningWaitStall(issueId: string, runningEntry: RunningEntry, observedAtMs: number): void {
    const waitThresholdMs = this.config.progress_stalled_waiting_ms ?? this.config.running_wait_stall_threshold_ms ?? 300_000;
    if (waitThresholdMs <= 0 || runningEntry.last_event !== CANONICAL_EVENT.codex.turnWaiting) {
      return;
    }

    const waitingStartedAtMs =
      runningEntry.running_waiting_started_at_ms ?? runningEntry.last_codex_timestamp_ms ?? runningEntry.started_at_ms;
    runningEntry.running_waiting_started_at_ms = waitingStartedAtMs;
    const thresholdCrossedAtMs = waitingStartedAtMs + waitThresholdMs;
    runningEntry.stalled_waiting_since_ms = thresholdCrossedAtMs;

    if (observedAtMs < thresholdCrossedAtMs) {
      runningEntry.stalled_waiting_reason = null;
      return;
    }

    runningEntry.stalled_waiting_reason = REASON_CODES.turnWaitingThresholdExceeded;
    if (runningEntry.running_wait_stall_event_emitted) {
      return;
    }

    runningEntry.running_wait_stall_event_emitted = true;
    const elapsedMs = Math.max(0, observedAtMs - waitingStartedAtMs);
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.progress.stalledWaitingDetected,
      severity: 'warn',
      issue_identifier: runningEntry.identifier,
      session_id: runningEntry.session_id ?? undefined,
      detail: `issue_id=${issueId} thread_id=${runningEntry.thread_id ?? 'unknown'} session_id=${runningEntry.session_id ?? 'unknown'} elapsed_ms=${elapsedMs}`
    });
    this.recordRuntimeEvent({
      event: CANONICAL_EVENT.orchestration.runningWaitStallThresholdExceeded,
      severity: 'warn',
      issue_identifier: runningEntry.identifier,
      session_id: runningEntry.session_id ?? undefined,
      detail: `issue_id=${issueId} thread_id=${runningEntry.thread_id ?? 'unknown'} session_id=${runningEntry.session_id ?? 'unknown'} elapsed_ms=${elapsedMs}`
    });
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
