import type { Issue } from '../tracker';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { StructuredLogger } from '../observability';
import { CANONICAL_EVENT } from '../observability/events';
import { REASON_CODES } from '../observability/reason-codes';
import {
  buildOperatorInputResumeContext as coordinateBuildOperatorInputResumeContext,
  cancelBlockedIssue as coordinateCancelBlockedIssue,
  clearBlockedInput as coordinateClearBlockedInput,
  persistBlockedInputEvent as coordinatePersistBlockedInputEvent,
  persistTicketBlocker as coordinatePersistTicketBlocker,
  recordOperatorAction as coordinateRecordOperatorAction,
  resolveBacklogStateName as coordinateResolveBacklogStateName,
  resumeBlockedIssue as coordinateResumeBlockedIssue,
  scheduleBlockedInput as coordinateScheduleBlockedInput,
  submitBlockedIssueInput as coordinateSubmitBlockedIssueInput,
  submitBlockedIssueInputNative as coordinateSubmitBlockedIssueInputNative,
  ticketBlockerTypeForBlockedEntry as coordinateTicketBlockerTypeForBlockedEntry,
  type BlockedInputCoordinatorContext,
  type BlockedInputScheduleParams,
  type SubmitBlockedIssueInputNativeResult
} from './core/blocked-input-coordinator';
import { coordinateDispatchIssue, coordinateDispatchTick, type DispatchCoordinatorContext } from './core/dispatch-coordinator';
import {
  addRuntimeSecondsFromEntry as coordinateAddRuntimeSecondsFromEntry,
  completeRunRecord as coordinateCompleteRunRecord,
  terminateRunningIssue as coordinateTerminateRunningIssue,
  type RunCompletionCoordinatorContext,
  workerTerminationAllowsRecovery as coordinateWorkerTerminationAllowsRecovery,
  workerTerminationInterruptStatus as coordinateWorkerTerminationInterruptStatus
} from './core/run-completion-coordinator';
import { coordinateRetryTimer, type RetryTimerCoordinatorContext } from './core/retry-timer-coordinator';
import { coordinateWorkerExit, type WorkerExitCoordinatorContext } from './core/worker-exit-coordinator';
import { parseDynamicToolCapabilityMismatchDetail } from '../observability/dynamic-tool-capability';
import { isKnownPhaseMarker, isTerminalPhaseMarker, phaseMarkerOrder, type PhaseMarker, type PhaseMarkerName } from '../observability';
import { ThroughputTracker } from '../observability/throughput';
import {
  computeFailureBackoffMs,
  isActiveState,
  isTerminalState,
  shouldDispatchIssue
} from './decisions';
import {
  applyBudgetBlockedTerminationEvidence,
  applyBudgetTelemetryUnavailable,
  computeIssueBudgetProjection,
  defaultBudgetProjection,
  evaluateBudgetEnforcement,
  recordIssueBudgetUsageSample,
  updateRunningBudgetProjection,
  type BudgetHardLimitDecision,
  type BudgetUsageSample
} from './core/budget';
import {
  cloneBlockedEntry,
  cloneCircuitBreakerEntry,
  cloneDispatchBackpressureState,
  cloneOperatorAction,
  cloneReleasedWorkerRecord,
  cloneRetryEntry,
  cloneRunningEntry
} from './core/snapshot-cloning';
import {
  beginExecutionGraphWorkerTurnObservation,
  persistExecutionGraphRetryTransition as persistExecutionGraphRetryTransitionHelper,
  persistExecutionGraphStateTransition as persistExecutionGraphStateTransitionHelper,
  persistOperationalFactsForIssue as persistOperationalFactsForIssueHelper,
  persistTicketEvidenceReferenceForThread as persistTicketEvidenceReferenceForThreadHelper,
  persistPreSpawnExecutionGraphAttempt as persistPreSpawnExecutionGraphAttemptHelper,
  queuePersistExecutionGraphWorkerEvent as queuePersistExecutionGraphWorkerEventHelper,
  recordHistoryWriteFailure as recordHistoryWriteFailureHelper,
  type DispatchGraphContext
} from './core/execution-graph-persistence';
import {
  applyBlockedWorkerEventQuarantine,
  buildMissingToolOutputBlockDetails,
  buildMissingToolOutputRecoveryPrompt,
  buildMissingToolOutputRecoveryState,
  buildRecoveryStartFailedBlockDetails,
  normalizeOperatorReasonNote,
  reasonNoteRequiredFailure,
  workerTerminationExceptionResult,
  workerTerminationResultContext,
  workerTerminationResultDetail
} from './core/blocked-input-recovery';
import {
  applyWorkerEvent,
  classifyWorkerActivity,
  isTerminalTurnEvent,
  normalizeCodexAppServerPid,
  normalizeWorkerInstanceId,
  rememberInactiveWorkerPid,
  rememberReleasedWorker,
  shouldResetRunningWaitEpisode,
  workerEventLooksLikeTrackerComment
} from './core/worker-events';
import {
  classifyProgressSignals,
  emptyDispatchBackpressureState,
  getBackpressureRetryDelayMs,
  isFreshDispatchState,
  isHandoffFreshDispatchState,
  isKnownReviewHandoffTransition,
  normalizeStateName
} from './core/retry-backpressure';
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
  TranscriptToolCallLineage,
  TranscriptToolCallDiagnostic,
  WorkerCompletionReason,
  WorkerExitDetails,
  WorkerObservabilityEvent,
  WorkerExitReason,
  WorkerTerminationResult
} from './types';

const DEFAULT_INACTIVE_WORKER_PID_TTL_MS = 60 * 60 * 1000;
const CODEX_SESSION_TRANSCRIPT_CANDIDATE_CACHE_TTL_MS = 15_000;
const CODEX_SESSION_TRANSCRIPT_MAX_CANDIDATE_FILES = 40;
const CODEX_SESSION_TRANSCRIPT_MAX_DISCOVERY_FILES = 20;
const CODEX_SESSION_TRANSCRIPT_MAX_PROBE_BYTES = 256 * 1024;
const CODEX_SESSION_TRANSCRIPT_MAX_SCAN_BYTES = 256 * 1024;
const CODEX_SESSION_TRANSCRIPT_MAX_FILE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CODEX_SESSION_TRANSCRIPT_MAX_WALL_CLOCK_MS = 20;
const CODEX_SESSION_TRANSCRIPT_MAX_DEPTH = 5;

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
        dispatch_backpressure: emptyDispatchBackpressureState(getBackpressureRetryDelayMs(this.config))
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
          this.state.health.dispatch_backpressure ?? emptyDispatchBackpressureState(getBackpressureRetryDelayMs(this.config))
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
      ...(this.state.health.dispatch_backpressure ?? emptyDispatchBackpressureState(getBackpressureRetryDelayMs(this.config))),
      retry_delay_ms: getBackpressureRetryDelayMs(this.config)
    };
  }

  async tick(reason: TickReason): Promise<void> {
    await this.runSerializedOperation(() => this.tickOnce(reason));
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

  private dispatchCoordinatorContext(): DispatchCoordinatorContext {
    return {
      state: this.state,
      config: this.config,
      tracker: this.ports.tracker,
      dispatchPreflight: () => this.ports.dispatchPreflight(),
      spawnWorker: (params) => this.ports.spawnWorker(params),
      cancelRetryTimer: (timerHandle) => this.ports.cancelRetryTimer(timerHandle),
      notifyObservers: this.ports.notifyObservers ? () => this.ports.notifyObservers?.() : undefined,
      getControlPlaneHealth: this.ports.getControlPlaneHealth ? () => this.ports.getControlPlaneHealth!() : undefined,
      getHostLoad: this.ports.getHostLoad ? () => this.ports.getHostLoad!() : undefined,
      persistence: this.persistence,
      logger: this.logger,
      nowMs: () => this.nowMs(),
      hooks: {
        reconcileRunningIssues: () => this.reconcileRunningIssues(),
        reconcileBlockedInputs: () => this.reconcileBlockedInputs(),
        recordDuplicateDispatchSkipped: (issue, retryAttempt) => this.recordDuplicateDispatchSkipped(issue, retryAttempt),
        delayDispatchForBackpressure: (issue, attempt, backpressure) =>
          this.delayDispatchForBackpressure(issue, attempt, backpressure),
        emitPhaseMarker: (issueId, marker) => this.emitPhaseMarker(issueId, marker),
        recordRuntimeEvent: (params) => this.recordRuntimeEvent(params),
        selectWorkerHost: () => this.selectWorkerHost(),
        persistPreSpawnExecutionGraphAttempt: (params) => this.persistPreSpawnExecutionGraphAttempt(params),
        scheduleRetry: (params) => this.scheduleRetry(params),
        workerInstanceIdFromHandle: (workerHandle) => this.workerInstanceIdFromHandle(workerHandle),
        computeBudgetProjection: (issueId, currentAttemptTokens, telemetryStatus, forcedStatus, forcedMessage) =>
          this.computeBudgetProjection(issueId, currentAttemptTokens, telemetryStatus, forcedStatus, forcedMessage),
        persistOperationalFactsForIssue: (issue, runningEntry, observedAt) =>
          this.persistOperationalFactsForIssue(issue, runningEntry, observedAt),
        recordHistoryWriteFailure: (operation, reasonCode, error) =>
          this.recordHistoryWriteFailure(operation, reasonCode, error)
      }
    };
  }

  private async tickOnce(reason: TickReason): Promise<void> {
    await coordinateDispatchTick(this.dispatchCoordinatorContext(), reason);
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

  private runCompletionCoordinatorContext(): RunCompletionCoordinatorContext {
    return {
      state: this.state,
      config: this.config,
      terminateWorker: (params) => this.ports.terminateWorker(params),
      cancelRetryTimer: (timerHandle) => this.ports.cancelRetryTimer(timerHandle),
      notifyObservers: this.ports.notifyObservers ? () => this.ports.notifyObservers?.() : undefined,
      persistence: this.persistence,
      logger: this.logger,
      nowMs: () => this.nowMs(),
      hooks: {
        recordHistoryWriteFailure: (operation, reasonCode, error) =>
          this.recordHistoryWriteFailure(operation, reasonCode, error),
        persistExecutionGraphStateTransition: (runningEntry, toStatus, status, reasonCode, reasonDetail) =>
          this.persistExecutionGraphStateTransition(runningEntry, toStatus, status, reasonCode, reasonDetail)
      }
    };
  }

  onWorkerEvent(issue_id: string, workerEvent: WorkerObservabilityEvent): void {
    applyWorkerEvent({
      state: this.state,
      issueId: issue_id,
      workerEvent,
      inactiveWorkerPidTtlMs: this.config.inactive_worker_pid_ttl_ms ?? DEFAULT_INACTIVE_WORKER_PID_TTL_MS,
      runningWaitThresholdMs: this.config.progress_stalled_waiting_ms ?? this.config.running_wait_stall_threshold_ms ?? 300_000,
      nowMs: () => this.nowMs(),
      logger: this.logger,
      notifyObservers: () => this.ports.notifyObservers?.(),
      quarantineBlockedWorkerEvent: (blockedEntry, event, reason) => this.quarantineBlockedWorkerEvent(blockedEntry, event, reason),
      captureWorkerProgressSignal: (runningEntry, event) => this.captureWorkerProgressSignal(runningEntry, event),
      maybeEmitHeartbeatOnly: (issueId, runningEntry, observedAtMs) => this.maybeEmitHeartbeatOnly(issueId, runningEntry, observedAtMs),
      resetRunningWaitEpisode: (runningEntry, progressAtMs) => this.resetRunningWaitEpisode(runningEntry, progressAtMs),
      isMeaningfulWorkerProgressEvent: (event) => this.isMeaningfulWorkerProgressEvent(event),
      observeThroughput: (sample) => this.throughputTracker.observe(sample),
      updateOutstandingToolCalls: (runningEntry, event) => this.updateOutstandingToolCalls(runningEntry, event),
      updateBudgetProjection: (issueId, runningEntry, totalTokens) =>
        updateRunningBudgetProjection({
          budget: this.config.budget,
          budgetSamples: this.budgetUsageSamples(),
          nowMs: this.nowMs(),
          issueId,
          runningEntry,
          currentAttemptTokens: totalTokens,
          telemetryStatus: 'available'
        }),
      maybeEmitTokenTelemetryWarning: (runningEntry, eventAtMs) => this.maybeEmitTokenTelemetryWarning(runningEntry, eventAtMs),
      maybeEmitBudgetTelemetryUnavailable: (runningEntry, event) => this.maybeEmitBudgetTelemetryUnavailable(runningEntry, event),
      maybeEnforceBudget: (issueId, runningEntry, timestampMs) => this.maybeEnforceBudget(issueId, runningEntry, timestampMs),
      persistSession: (params) => this.persistence?.recordSession(params) ?? Promise.resolve(),
      persistRunEvent: (params) => this.persistence?.recordEvent(params) ?? Promise.resolve(),
      beginExecutionGraphWorkerTurnObservation: (runningEntry, event) =>
        beginExecutionGraphWorkerTurnObservation(runningEntry, event),
      queuePersistExecutionGraphWorkerEvent: (issueId, runningEntry, event, turnAlreadyObserved) =>
        this.queuePersistExecutionGraphWorkerEvent(issueId, runningEntry, event, turnAlreadyObserved),
      recordRuntimeEvent: (params) => this.recordRuntimeEvent(params),
      emitExplicitPhaseMarker: (issueId, event) => this.emitExplicitPhaseMarker(issueId, event),
      emitMappedPhaseMarker: (issueId, event) => this.emitMappedPhaseMarker(issueId, event),
      hasOutstandingToolCallEvidence: (runningEntry) => this.hasOutstandingToolCallEvidence(runningEntry),
      maybeClassifyRunningWaitStall: (issueId, runningEntry, observedAtMs) =>
        this.maybeClassifyRunningWaitStall(issueId, runningEntry, observedAtMs)
    });
  }

  private queuePersistExecutionGraphWorkerEvent(
    issueId: string,
    runningEntry: RunningEntry,
    workerEvent: WorkerObservabilityEvent,
    turnAlreadyObserved: boolean
  ): void {
    queuePersistExecutionGraphWorkerEventHelper({
      queues: this.executionGraphPersistenceQueues,
      issueId,
      runningEntry,
      workerEvent,
      turnAlreadyObserved,
      persistedPhaseSpanKeys: this.persistedPhaseSpanKeys,
      persistence: this.persistence,
      logger: this.logger,
      recordHistoryWriteFailure: (operation, reasonCode, error) => this.recordHistoryWriteFailure(operation, reasonCode, error)
    });
  }

  private async recordHistoryWriteFailure(operation: string, reasonCode: string, error: unknown): Promise<void> {
    await recordHistoryWriteFailureHelper(this.persistence, operation, reasonCode, error);
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
    await persistExecutionGraphStateTransitionHelper({
      runningEntry,
      toStatus,
      status,
      reasonCode,
      reasonDetail,
      nowMs: () => this.nowMs(),
      persistence: this.persistence,
      logger: this.logger,
      recordHistoryWriteFailure: (operation, failureReasonCode, error) =>
        this.recordHistoryWriteFailure(operation, failureReasonCode, error)
    });
  }

  private async persistTicketEvidenceReferenceForThread(
    runningEntry: RunningEntry,
    workerEvent: WorkerObservabilityEvent,
    threadId: string,
    recordedAt: string
  ): Promise<void> {
    await persistTicketEvidenceReferenceForThreadHelper({
      runningEntry,
      workerEvent,
      threadId,
      recordedAt,
      persistence: this.persistence,
      logger: this.logger,
      recordHistoryWriteFailure: (operation, failureReasonCode, error) =>
        this.recordHistoryWriteFailure(operation, failureReasonCode, error)
    });
  }

  private async persistOperationalFactsForIssue(issue: Issue, runningEntry: RunningEntry, observedAt: string): Promise<void> {
    await persistOperationalFactsForIssueHelper({
      issue,
      runningEntry,
      observedAt,
      persistence: this.persistence,
      logger: this.logger,
      recordHistoryWriteFailure: (operation, failureReasonCode, error) =>
        this.recordHistoryWriteFailure(operation, failureReasonCode, error)
    });
  }

  private async persistExecutionGraphRetryTransition(
    retryEntry: RetryEntry,
    toStatus: string,
    status: 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'retrying',
    reasonCode: string,
    reasonDetail: string | null
  ): Promise<void> {
    await persistExecutionGraphRetryTransitionHelper({
      retryEntry,
      toStatus,
      status,
      reasonCode,
      reasonDetail,
      nowMs: () => this.nowMs(),
      persistence: this.persistence,
      logger: this.logger,
      recordHistoryWriteFailure: (operation, failureReasonCode, error) =>
        this.recordHistoryWriteFailure(operation, failureReasonCode, error)
    });
  }

  private async persistPreSpawnExecutionGraphAttempt(params: {
    issue: Issue;
    attempt: number | null;
    graphContext: DispatchGraphContext;
    status: 'failed' | 'blocked';
    reasonCode: string;
    reasonDetail: string | null;
  }): Promise<DispatchGraphContext> {
    return persistPreSpawnExecutionGraphAttemptHelper({
      ...params,
      nowMs: () => this.nowMs(),
      persistence: this.persistence,
      logger: this.logger,
      recordHistoryWriteFailure: (operation, failureReasonCode, error) =>
        this.recordHistoryWriteFailure(operation, failureReasonCode, error)
    });
  }

  private budgetUsageSamples(): Map<string, BudgetUsageSample[]> {
    const budgetSamples = this.state.budget_usage_samples ?? new Map<string, BudgetUsageSample[]>();
    this.state.budget_usage_samples = budgetSamples;
    return budgetSamples;
  }

  private computeBudgetProjection(
    issueId: string,
    currentAttemptTokens: number,
    telemetryStatus: 'available' | 'pending' | 'unavailable',
    forcedStatus?: BudgetRuntimeProjection['budget_status'],
    forcedMessage?: string | null
  ): BudgetRuntimeProjection {
    return computeIssueBudgetProjection({
      budget: this.config.budget,
      budgetSamples: this.budgetUsageSamples(),
      nowMs: this.nowMs(),
      issueId,
      currentAttemptTokens,
      telemetryStatus,
      forcedStatus,
      forcedMessage
    });
  }

  private maybeEmitBudgetTelemetryUnavailable(runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent): void {
    applyBudgetTelemetryUnavailable({
      budget: this.config.budget,
      budgetSamples: this.budgetUsageSamples(),
      nowMs: this.nowMs(),
      logger: this.logger,
      recordRuntimeEvent: (params) => this.recordRuntimeEvent(params),
      runningEntry,
      workerEvent
    });
  }

  private maybeEnforceBudget(issueId: string, runningEntry: RunningEntry, timestampMs: number): void {
    const decision = evaluateBudgetEnforcement({
      budget: this.config.budget,
      budgetSamples: this.budgetUsageSamples(),
      nowMs: this.nowMs(),
      logger: this.logger,
      recordRuntimeEvent: (params) => this.recordRuntimeEvent(params),
      issueId,
      runningEntry
    });
    if (!decision) {
      return;
    }
    this.enforceBudgetHardLimit(issueId, runningEntry, timestampMs, decision).catch((error) => {
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

  private async enforceBudgetHardLimit(
    issueId: string,
    running: RunningEntry,
    timestampMs: number,
    decision: BudgetHardLimitDecision
  ): Promise<void> {
    const budget = this.config.budget;
    if (!budget) {
      return;
    }

    this.emitPhaseMarker(issueId, {
      phase: decision.phase,
      detail: decision.stopReasonDetail,
      attempt: running.retry_attempt,
      thread_id: running.thread_id,
      session_id: running.session_id
    });

    this.addRuntimeSecondsFromEntry(running);
    this.recordBudgetUsageSample(issueId, running.tokens.total_tokens, timestampMs);
    this.state.running.delete(issueId);
    this.state.health.last_error = decision.stopReasonDetail;

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
        stop_reason_code: decision.stopReasonCode,
        stop_reason_detail: decision.stopReasonDetail,
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
        reason: decision.stopReasonCode
      });
    } catch (error) {
      if (budget.hard_limit_policy === 'block_requires_resume') {
        const unknownResult = workerTerminationExceptionResult(error);
        this.updateBudgetBlockedTerminationEvidence(
          issueId,
          workerTerminationResultDetail(decision.stopReasonDetail, unknownResult),
          unknownResult
        );
      }
      throw error;
    }

    const terminalReasonDetail = workerTerminationResultDetail(decision.stopReasonDetail, terminationResult);
    if (budget.hard_limit_policy === 'block_requires_resume') {
      this.updateBudgetBlockedTerminationEvidence(issueId, terminalReasonDetail, terminationResult);
    }
    await this.completeRunRecord(running, 'failed', decision.stopReasonCode, null, terminalReasonDetail);
  }

  private updateBudgetBlockedTerminationEvidence(
    issueId: string,
    stopReasonDetail: string,
    terminationResult: WorkerTerminationResult
  ): void {
    const blockedEntry = this.state.blocked_inputs.get(issueId);
    if (
      !applyBudgetBlockedTerminationEvidence({
        blockedEntry,
        stopReasonDetail,
        terminationResult
      })
    ) {
      return;
    }
    void this.persistence?.upsertBlockedInput?.(issueId, JSON.stringify(blockedEntry));
    this.ports.notifyObservers?.();
  }

  private recordBudgetUsageSample(issueId: string, totalTokens: number, timestampMs: number): void {
    recordIssueBudgetUsageSample({
      budget: this.config.budget,
      budgetSamples: this.budgetUsageSamples(),
      nowMs: timestampMs,
      issueId,
      totalTokens,
      timestampMs
    });
  }

  private quarantineBlockedWorkerEvent(
    blockedEntry: BlockedEntry,
    workerEvent: WorkerObservabilityEvent,
    reason: 'awaiting_operator_latch' | 'lineage_mismatch'
  ): void {
    applyBlockedWorkerEventQuarantine(blockedEntry, workerEvent, reason);
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

  private workerExitCoordinatorContext(): WorkerExitCoordinatorContext {
    return {
      state: this.state,
      config: this.config,
      ports: this.ports,
      persistence: this.persistence,
      logger: this.logger,
      nowMs: () => this.nowMs(),
      hooks: {
        normalStopForWorkerCompletion: (completionReason, refreshedState) =>
          this.normalStopForWorkerCompletion(completionReason, refreshedState),
        completeRunRecord: (runningEntry, terminalStatus, errorCode, recoveryOverride, terminalReasonDetail) =>
          this.completeRunRecord(runningEntry, terminalStatus, errorCode, recoveryOverride ?? null, terminalReasonDetail ?? null),
        scheduleRetry: (params) => this.scheduleRetry(params),
        scheduleBlockedInput: (params) => this.scheduleBlockedInput(params),
        scheduleRecoveryStartFailedBlock: (issueId, running, recoveryError) =>
          this.scheduleRecoveryStartFailedBlock(issueId, running, recoveryError),
        persistExecutionGraphStateTransition: (runningEntry, toStatus, status, reasonCode, reasonDetail) =>
          this.persistExecutionGraphStateTransition(runningEntry, toStatus, status, reasonCode, reasonDetail),
        emitPhaseMarker: (issueId, marker) => this.emitPhaseMarker(issueId, marker),
        recordRuntimeEvent: (params) => this.recordRuntimeEvent(params),
        addRuntimeSecondsFromEntry: (runningEntry) => this.addRuntimeSecondsFromEntry(runningEntry),
        recordBudgetUsageSample: (issueId, totalTokens, timestampMs) =>
          this.recordBudgetUsageSample(issueId, totalTokens, timestampMs),
        inferStopReasonCode: (stopError, fallback) => this.inferStopReasonCode(stopError, fallback),
        inferInputRequiredDetail: (inputError, fallbackReason) =>
          this.inferInputRequiredDetail(inputError, fallbackReason),
        inferWorkspaceConflictContext: (conflictError, fallbackReason) =>
          this.inferWorkspaceConflictContext(conflictError, fallbackReason)
      }
    };
  }

  async onWorkerExit(
    issue_id: string,
    reason: WorkerExitReason,
    error?: string,
    details: WorkerExitDetails = {}
  ): Promise<void> {
    await coordinateWorkerExit(this.workerExitCoordinatorContext(), issue_id, reason, error, details);
  }

  private async scheduleRecoveryStartFailedBlock(issueId: string, running: RunningEntry, error: string): Promise<void> {
    const { recovery, diagnostic, detail } = buildRecoveryStartFailedBlockDetails(running, error);

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

  private retryTimerCoordinatorContext(): RetryTimerCoordinatorContext {
    return {
      state: this.state,
      config: this.config,
      tracker: this.ports.tracker,
      cancelRetryTimer: (timerHandle) => this.ports.cancelRetryTimer(timerHandle),
      getControlPlaneHealth: this.ports.getControlPlaneHealth
        ? () => this.ports.getControlPlaneHealth!()
        : undefined,
      getHostLoad: this.ports.getHostLoad ? () => this.ports.getHostLoad!() : undefined,
      logger: this.logger,
      nowMs: () => this.nowMs(),
      hooks: {
        scheduleRetry: (params) => this.scheduleRetry(params),
        scheduleBlockedInput: (params) => this.scheduleBlockedInput(params),
        dispatchIssue: (issue, attempt, resumeContext, graphContext) =>
          this.dispatchIssue(issue, attempt, resumeContext ?? null, graphContext),
        workspaceAttemptResidueResumeContext: (retryEntry) => this.workspaceAttemptResidueResumeContext(retryEntry),
        upsertCircuitBreaker: (entry) => this.upsertCircuitBreaker(entry),
        persistExecutionGraphRetryTransition: (retryEntry, toStatus, status, reasonCode, reasonDetail) =>
          this.persistExecutionGraphRetryTransition(retryEntry, toStatus, status, reasonCode, reasonDetail),
        recordRuntimeEvent: (params) => this.recordRuntimeEvent(params)
      }
    };
  }

  async onRetryTimer(issue_id: string): Promise<void> {
    await this.runSerializedOperation(() => coordinateRetryTimer(this.retryTimerCoordinatorContext(), issue_id));
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

  private blockedInputCoordinatorContext(): BlockedInputCoordinatorContext {
    return {
      state: this.state,
      config: this.config,
      tracker: this.ports.tracker,
      cancelRetryTimer: (timerHandle) => this.ports.cancelRetryTimer(timerHandle),
      submitBlockedIssueInputNative: this.ports.submitBlockedIssueInputNative
        ? (params) => this.ports.submitBlockedIssueInputNative!(params)
        : undefined,
      notifyObservers: this.ports.notifyObservers ? () => this.ports.notifyObservers!() : undefined,
      persistence: this.persistence,
      logger: this.logger,
      nowMs: () => this.nowMs(),
      hooks: {
        getLastPhaseMarker: (issueId) => this.getLastPhaseMarker(issueId),
        inferInputSchemaType: (questions) => this.inferInputSchemaType(questions),
        upsertCircuitBreaker: (entry) => this.upsertCircuitBreaker(entry),
        clearCircuitBreaker: (issueId) => this.clearCircuitBreaker(issueId),
        recordHistoryWriteFailure: (operation, reasonCode, error) =>
          this.recordHistoryWriteFailure(operation, reasonCode, error),
        captureProgressSignals: (params) => this.captureProgressSignals(params),
        dispatchIssue: (issue, attempt, resumeContext, graphContext) =>
          this.dispatchIssue(issue, attempt, resumeContext ?? null, graphContext),
        scheduleRetry: (params) => this.scheduleRetry(params),
        describeIssueRuntimeState: (issueId) => this.describeIssueRuntimeState(issueId),
        targetIdentifiersFromRuntimeState: (issueId, runtimeState) =>
          this.targetIdentifiersFromRuntimeState(issueId, runtimeState),
        recordRuntimeEvent: (params) => this.recordRuntimeEvent(params)
      }
    };
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
        isHandoffFreshDispatchState(refreshedIssue.state, this.config) &&
        !this.didRunStartInState(runningEntry, refreshedIssue.state)
      ) {
        await this.terminateRunningIssue(refreshedIssue.id, false, REASON_CODES.handoffRelease);
        continue;
      }

      if (
        runningEntry.last_event === CANONICAL_EVENT.codex.turnCompleted &&
        isFreshDispatchState(refreshedIssue.state, this.config) &&
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
      if (runningEntry.last_event && shouldResetRunningWaitEpisode(runningEntry.last_event)) {
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
    await coordinateDispatchIssue(this.dispatchCoordinatorContext(), issue, attempt, resume_context, graphContext);
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
    await coordinateTerminateRunningIssue(this.runCompletionCoordinatorContext(), issue_id, cleanup_workspace, reason);
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
          ? getBackpressureRetryDelayMs(this.config)
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

  private async scheduleBlockedInput(params: BlockedInputScheduleParams): Promise<{ created: boolean }> {
    return coordinateScheduleBlockedInput(this.blockedInputCoordinatorContext(), params);
  }

  private clearBlockedInput(issue_id: string, reason: string): void {
    coordinateClearBlockedInput(this.blockedInputCoordinatorContext(), issue_id, reason);
  }

  private async persistTicketBlocker(blockedEntry: BlockedEntry): Promise<void> {
    await coordinatePersistTicketBlocker(this.blockedInputCoordinatorContext(), blockedEntry);
  }

  private async persistBlockedInputEvent(blockedEntry: BlockedEntry): Promise<void> {
    await coordinatePersistBlockedInputEvent(this.blockedInputCoordinatorContext(), blockedEntry);
  }

  private ticketBlockerTypeForBlockedEntry(blockedEntry: BlockedEntry): string {
    return coordinateTicketBlockerTypeForBlockedEntry(blockedEntry);
  }

  private resolveBacklogStateName(): string {
    return coordinateResolveBacklogStateName(this.blockedInputCoordinatorContext());
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
    return coordinateResumeBlockedIssue(
      this.blockedInputCoordinatorContext(),
      issue_identifier,
      resume_context,
      resume_override_reason,
      operator_context,
      resume_metadata
    );
  }

  async cancelBlockedIssue(
    issue_identifier: string,
    cancel_reason: string | null = null,
    operator_context: { actor?: string | null; reason_note?: string | null; confirmed?: boolean | null } | null = null
  ): Promise<{ ok: true; issue_id: string; moved_to_state: string } | { ok: false; code: string; message: string }> {
    return coordinateCancelBlockedIssue(this.blockedInputCoordinatorContext(), issue_identifier, cancel_reason, operator_context);
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
    return coordinateSubmitBlockedIssueInput(this.blockedInputCoordinatorContext(), params);
  }

  private async submitBlockedIssueInputNative(
    blocked: BlockedEntry,
    params: { issue_identifier: string; request_id: string; answer: { question_id?: string; option_label?: string; text?: string } }
  ): Promise<SubmitBlockedIssueInputNativeResult> {
    return coordinateSubmitBlockedIssueInputNative(this.blockedInputCoordinatorContext(), blocked, params);
  }

  private buildOperatorInputResumeContext(
    blocked: BlockedEntry,
    answer: { question_id?: string; option_label?: string; text?: string }
  ): string {
    return coordinateBuildOperatorInputResumeContext(blocked, answer);
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
    coordinateAddRuntimeSecondsFromEntry(this.runCompletionCoordinatorContext(), runningEntry);
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
    coordinateRecordOperatorAction(this.blockedInputCoordinatorContext(), issueId, action);
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

  private resetRunningWaitEpisode(runningEntry: RunningEntry, progressAtMs: number): void {
    runningEntry.running_waiting_started_at_ms = null;
    runningEntry.running_wait_stall_event_emitted = false;
    runningEntry.heartbeat_only_event_emitted = false;
    runningEntry.stalled_waiting_since_ms = null;
    runningEntry.stalled_waiting_reason = null;
    runningEntry.last_progress_transition_at_ms = progressAtMs;
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
    const activity = classifyWorkerActivity({
      runningEntry,
      observedAtMs,
      waitThresholdMs: this.config.progress_stalled_waiting_ms ?? this.config.running_wait_stall_threshold_ms ?? 300_000
    });
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

    rememberInactiveWorkerPid({
      state: this.state,
      runningEntry,
      reason: REASON_CODES.turnWaitingThresholdExceeded,
      nowMs: this.nowMs(),
      ttlMs: this.config.inactive_worker_pid_ttl_ms ?? DEFAULT_INACTIVE_WORKER_PID_TTL_MS
    });
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

    const activity = classifyWorkerActivity({
      runningEntry,
      observedAtMs,
      waitThresholdMs: this.config.progress_stalled_waiting_ms ?? this.config.running_wait_stall_threshold_ms ?? 300_000
    });
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

    rememberInactiveWorkerPid({
      state: this.state,
      runningEntry,
      reason: REASON_CODES.workerOpaqueActivityHardTimeout,
      nowMs: this.nowMs(),
      ttlMs: this.config.inactive_worker_pid_ttl_ms ?? DEFAULT_INACTIVE_WORKER_PID_TTL_MS
    });
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

    rememberInactiveWorkerPid({
      state: this.state,
      runningEntry,
      reason: REASON_CODES.issueStateRefreshFailed,
      nowMs: this.nowMs(),
      ttlMs: this.config.inactive_worker_pid_ttl_ms ?? DEFAULT_INACTIVE_WORKER_PID_TTL_MS
    });
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

    if (!isKnownReviewHandoffTransition({ startedState, currentState: issue.state, config: this.config })) {
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
    const reasons = classifyProgressSignals(signals);
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
      return workerEventLooksLikeTrackerComment(event);
    });
  }

  private captureWorkerProgressSignal(runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent): void {
    if (!workerEventLooksLikeTrackerComment(workerEvent)) {
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

    rememberInactiveWorkerPid({
      state: this.state,
      runningEntry,
      reason: REASON_CODES.turnWaitingThresholdExceeded,
      nowMs: this.nowMs(),
      ttlMs: this.config.inactive_worker_pid_ttl_ms ?? DEFAULT_INACTIVE_WORKER_PID_TTL_MS
    });
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
    rememberReleasedWorker({
      state: this.state,
      runningEntry,
      reason: REASON_CODES.agentReviewHandoffProgressObserved,
      cleanupWorkspace: false,
      nowMs: this.nowMs()
    });
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

    if (isActiveState(handoffProgress.issue.state, this.config) && isFreshDispatchState(handoffProgress.issue.state, this.config)) {
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
        entries = this.sortCodexSessionDiscoveryEntries(
          fs.readdirSync(current.directory, { withFileTypes: true }),
          runningEntry
        );
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

  private sortCodexSessionDiscoveryEntries(entries: fs.Dirent[], runningEntry: RunningEntry): fs.Dirent[] {
    const activeTranscriptTimeMs = runningEntry.started_at_ms;
    return [...entries].sort((left, right) => {
      const leftTranscript = left.isFile() && left.name.endsWith('.jsonl');
      const rightTranscript = right.isFile() && right.name.endsWith('.jsonl');
      if (leftTranscript !== rightTranscript) {
        return leftTranscript ? -1 : 1;
      }
      if (leftTranscript && rightTranscript) {
        const leftDistance = this.codexSessionTranscriptFilenameDistanceMs(left.name, activeTranscriptTimeMs);
        const rightDistance = this.codexSessionTranscriptFilenameDistanceMs(right.name, activeTranscriptTimeMs);
        if (leftDistance !== null || rightDistance !== null) {
          if (leftDistance === null) {
            return 1;
          }
          if (rightDistance === null) {
            return -1;
          }
          if (leftDistance !== rightDistance) {
            return leftDistance - rightDistance;
          }
        }
        return right.name.localeCompare(left.name);
      }
      const leftDirectory = left.isDirectory();
      const rightDirectory = right.isDirectory();
      if (leftDirectory !== rightDirectory) {
        return leftDirectory ? -1 : 1;
      }
      if (leftDirectory && rightDirectory) {
        return left.name.localeCompare(right.name);
      }
      return left.name.localeCompare(right.name);
    });
  }

  private codexSessionTranscriptFilenameDistanceMs(filename: string, activeTranscriptTimeMs: number): number | null {
    const match = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3})Z)?-/u.exec(filename);
    if (!match) {
      return null;
    }
    const [, year, month, day, hour, minute, second, millisecond] = match;
    const filenameTimeMs = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(millisecond ?? 0)
    );
    const distanceMs = Math.abs(filenameTimeMs - activeTranscriptTimeMs);
    return distanceMs <= CODEX_SESSION_TRANSCRIPT_MAX_FILE_AGE_MS ? distanceMs : null;
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
    const recoveryPrompt = buildMissingToolOutputRecoveryPrompt(runningEntry, missingToolOutput, {
      previousThreadId,
      previousTurnId,
      previousSessionId,
      elapsedWaitMs
    });
    const attemptCount = (runningEntry.recovery?.attempt_count ?? 0) + 1;
    const recovery = buildMissingToolOutputRecoveryState(runningEntry, missingToolOutput, {
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
    rememberInactiveWorkerPid({
      state: this.state,
      runningEntry,
      reason: REASON_CODES.missingToolOutputRecoveryInterrupted,
      nowMs: this.nowMs(),
      ttlMs: this.config.inactive_worker_pid_ttl_ms ?? DEFAULT_INACTIVE_WORKER_PID_TTL_MS
    });
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

  private workerTerminationAllowsRecovery(result: WorkerTerminationResult): boolean {
    return coordinateWorkerTerminationAllowsRecovery(result);
  }

  private workerTerminationInterruptStatus(
    result: WorkerTerminationResult
  ): NonNullable<MissingToolOutputRecoveryState['interrupt_cancel_result']>['status'] {
    return coordinateWorkerTerminationInterruptStatus(result);
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

    const { recommendedActions, diagnostic, detail } = buildMissingToolOutputBlockDetails({
      runningEntry,
      missingToolOutput,
      observedAtMs,
      stopReasonCode,
      stopReasonDetailPrefix
    });

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

    rememberInactiveWorkerPid({
      state: this.state,
      runningEntry,
      reason: stopReasonCode,
      nowMs: this.nowMs(),
      ttlMs: this.config.inactive_worker_pid_ttl_ms ?? DEFAULT_INACTIVE_WORKER_PID_TTL_MS
    });
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
    await coordinateCompleteRunRecord(
      this.runCompletionCoordinatorContext(),
      runningEntry,
      terminal_status,
      error_code,
      recoveryOverride,
      terminalReasonDetail
    );
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
