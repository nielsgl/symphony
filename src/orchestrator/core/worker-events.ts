import { CANONICAL_EVENT } from '../../observability/events';
import type {
  QuarantinedWorkerEventReason,
  ReleasedWorkerRecord,
  RunningEntry,
  WorkerExitDetails,
  WorkerObservabilityEvent
} from '../types';

export type WorkerActivityState = 'advancing' | 'active_but_opaque' | 'heartbeat_only' | 'stale';

export interface WorkerActivityClassification {
  latest_meaningful_progress_at_ms: number | null;
  latest_liveness_at_ms: number | null;
  latest_thread_activity_at_ms: number | null;
  activity_state: WorkerActivityState;
}

type InactiveWorkerPidEntry = {
  pid: string;
  recorded_at_ms: number;
  reason: string;
  thread_id: string | null;
  turn_id: string | null;
  session_id: string | null;
};

export interface WorkerEventLineageState {
  inactive_worker_pids?: Map<string, InactiveWorkerPidEntry[]>;
  released_workers?: Map<string, ReleasedWorkerRecord[]>;
}

export function humanizeWorkerEvent(event: WorkerObservabilityEvent): string {
  const base = event.event.replace(/[._/]+/g, ' ').trim();
  if (event.detail && event.detail.trim().length > 0) {
    return `${base}: ${event.detail.trim()}`;
  }

  return base;
}

export function normalizeCodexAppServerPid(pid: number | string | null | undefined): string | null {
  return pid === undefined || pid === null ? null : String(pid);
}

export function normalizeWorkerInstanceId(workerInstanceId: string | null | undefined): string | null {
  const trimmed = workerInstanceId?.trim();
  return trimmed ? trimmed : null;
}

export function severityForRuntimeEvent(eventName: string): 'info' | 'warn' | 'error' {
  if (eventName.includes('failed') || eventName.includes('error')) {
    return 'error';
  }
  if (eventName.includes('retry') || eventName.includes('validation') || eventName.includes('unsupported')) {
    return 'warn';
  }
  return 'info';
}

export function isTerminalTurnEvent(event: string): boolean {
  return (
    event === CANONICAL_EVENT.codex.turnCompleted ||
    event === CANONICAL_EVENT.codex.turnFailed ||
    event === CANONICAL_EVENT.codex.turnCancelled
  );
}

export function shouldResetRunningWaitEpisode(event: string): boolean {
  return (
    isTerminalTurnEvent(event) ||
    event === CANONICAL_EVENT.codex.turnStarted ||
    event === CANONICAL_EVENT.codex.promptSent ||
    event === CANONICAL_EVENT.codex.turnInputRequired ||
    event === CANONICAL_EVENT.codex.startupFailed ||
    event === CANONICAL_EVENT.codex.phaseImplementation ||
    event === CANONICAL_EVENT.codex.phaseValidation ||
    event === CANONICAL_EVENT.codex.toolCallStarted ||
    event === CANONICAL_EVENT.codex.toolCallCompleted ||
    event === CANONICAL_EVENT.codex.toolCallFailed
  );
}

export function staleWorkerEventReasonForRunningEntry(params: {
  runningEntry: RunningEntry;
  workerEvent: WorkerObservabilityEvent;
  inactiveWorkerEntries: InactiveWorkerPidEntry[];
}): QuarantinedWorkerEventReason | null {
  const { runningEntry, workerEvent, inactiveWorkerEntries } = params;
  const eventPid = normalizeCodexAppServerPid(workerEvent.codex_app_server_pid);
  const eventWorkerInstanceId = normalizeWorkerInstanceId(workerEvent.worker_instance_id);
  if (
    eventWorkerInstanceId &&
    runningEntry.worker_instance_id &&
    eventWorkerInstanceId !== runningEntry.worker_instance_id
  ) {
    return 'worker_identity_mismatch';
  }

  if (eventPid && isInactiveWorkerPid(inactiveWorkerEntries, eventPid)) {
    return 'inactive_worker_pid';
  }

  if (!eventPid && isInactiveWorkerLineage(inactiveWorkerEntries, workerEvent)) {
    return 'lineage_mismatch';
  }

  if (eventPid && runningEntry.codex_app_server_pid && eventPid !== runningEntry.codex_app_server_pid) {
    return 'worker_identity_mismatch';
  }

  if (runningEntry.thread_id && workerEvent.thread_id && workerEvent.thread_id !== runningEntry.thread_id) {
    return 'lineage_mismatch';
  }

  if (isSameThreadContinuationTurnStart(runningEntry, workerEvent)) {
    return null;
  }

  if (isSameThreadRecoveryTurnStart(runningEntry, workerEvent)) {
    return null;
  }

  if (isPreviousRecoveryTurnEvent(runningEntry, workerEvent)) {
    return 'lineage_mismatch';
  }

  if (isTerminalTurnResidue(runningEntry, workerEvent)) {
    return 'terminal_residue';
  }

  if (runningEntry.turn_id && workerEvent.turn_id && workerEvent.turn_id !== runningEntry.turn_id) {
    return 'lineage_mismatch';
  }

  return runningEntry.session_id && workerEvent.session_id && workerEvent.session_id !== runningEntry.session_id
    ? 'lineage_mismatch'
    : null;
}

export function captureMissingToolOutputRecoveryReplacementLineage(
  runningEntry: RunningEntry,
  workerEvent: WorkerObservabilityEvent
): void {
  const recovery = runningEntry.recovery ?? null;
  if (!recovery || recovery.last_result !== 'started' || workerEvent.event !== CANONICAL_EVENT.codex.turnStarted) {
    return;
  }

  const replacementTurnId = workerEvent.turn_id ?? runningEntry.turn_id ?? null;
  if (!replacementTurnId || replacementTurnId === recovery.previous_turn_id) {
    return;
  }

  const replacementThreadId = workerEvent.thread_id ?? runningEntry.thread_id ?? recovery.previous_thread_id ?? null;
  if (recovery.previous_thread_id && replacementThreadId && replacementThreadId !== recovery.previous_thread_id) {
    return;
  }

  runningEntry.recovery = {
    ...recovery,
    replacement_thread_id: replacementThreadId,
    replacement_turn_id: replacementTurnId,
    replacement_session_id: workerEvent.session_id ?? runningEntry.session_id ?? null
  };
}

export function pruneInactiveWorkerPidsForIssue(params: {
  state: WorkerEventLineageState;
  issueId: string;
  nowMs: number;
  ttlMs: number;
}): InactiveWorkerPidEntry[] {
  const { state, issueId, nowMs, ttlMs } = params;
  const entries = state.inactive_worker_pids?.get(issueId) ?? [];
  if (entries.length === 0) {
    return [];
  }

  const activeEntries = entries.filter(
    (entry) => Number.isFinite(entry.recorded_at_ms) && nowMs - entry.recorded_at_ms < Math.max(0, ttlMs)
  );
  if (activeEntries.length === entries.length) {
    return entries;
  }

  if (!state.inactive_worker_pids) {
    state.inactive_worker_pids = new Map();
  }
  if (activeEntries.length > 0) {
    state.inactive_worker_pids.set(issueId, activeEntries);
  } else {
    state.inactive_worker_pids.delete(issueId);
  }
  return activeEntries;
}

export function rememberInactiveWorkerPid(params: {
  state: WorkerEventLineageState;
  runningEntry: RunningEntry;
  reason: string;
  nowMs: number;
  ttlMs: number;
}): void {
  const { state, runningEntry, reason, nowMs, ttlMs } = params;
  const pid = runningEntry.codex_app_server_pid;
  if (!pid && !runningEntry.thread_id && !runningEntry.turn_id && !runningEntry.session_id) {
    return;
  }
  const issueId = runningEntry.issue.id;
  const existing = pruneInactiveWorkerPidsForIssue({ state, issueId, nowMs, ttlMs });
  const next = [
    ...existing.filter((entry) => !(entry.pid === (pid ?? '') && entry.turn_id === (runningEntry.turn_id ?? null))),
    {
      pid: pid ?? '',
      recorded_at_ms: nowMs,
      reason,
      thread_id: runningEntry.thread_id ?? null,
      turn_id: runningEntry.turn_id ?? null,
      session_id: runningEntry.session_id ?? null
    }
  ].slice(-20);
  if (!state.inactive_worker_pids) {
    state.inactive_worker_pids = new Map();
  }
  state.inactive_worker_pids.set(issueId, next);
}

export function rememberReleasedWorker(params: {
  state: WorkerEventLineageState;
  runningEntry: RunningEntry;
  reason: string;
  cleanupWorkspace: boolean;
  nowMs: number;
}): void {
  const { state, runningEntry, reason, cleanupWorkspace, nowMs } = params;
  const issueId = runningEntry.issue.id;
  const existing = state.released_workers?.get(issueId) ?? [];
  const next = [
    ...existing,
    {
      released_at_ms: nowMs,
      reason,
      cleanup_workspace: cleanupWorkspace,
      worker_instance_id: runningEntry.worker_instance_id ?? null,
      codex_app_server_pid: runningEntry.codex_app_server_pid ?? null,
      thread_id: runningEntry.thread_id ?? null,
      turn_id: runningEntry.turn_id ?? null,
      session_id: runningEntry.session_id ?? null
    }
  ].slice(-20);
  if (!state.released_workers) {
    state.released_workers = new Map();
  }
  state.released_workers.set(issueId, next);
}

export function findReleasedWorkerRecord(
  releasedWorkers: Map<string, ReleasedWorkerRecord[]> | undefined,
  issueId: string,
  details: WorkerExitDetails
): ReleasedWorkerRecord | null {
  const released = releasedWorkers?.get(issueId) ?? [];
  if (released.length === 0) {
    return null;
  }
  const workerInstanceId = normalizeWorkerInstanceId(details.worker_instance_id);
  const pid = normalizeCodexAppServerPid(details.codex_app_server_pid);
  return (
    released.find((entry) => {
      if (workerInstanceId && entry.worker_instance_id === workerInstanceId) {
        return true;
      }
      if (pid && entry.codex_app_server_pid === pid) {
        return true;
      }
      if (details.turn_id && entry.turn_id === details.turn_id) {
        return true;
      }
      if (details.session_id && entry.session_id === details.session_id) {
        return true;
      }
      return false;
    }) ?? null
  );
}

export function classifyWorkerActivity(params: {
  runningEntry: RunningEntry;
  observedAtMs: number;
  waitThresholdMs: number;
}): WorkerActivityClassification {
  const { runningEntry, observedAtMs, waitThresholdMs } = params;
  const latestMeaningfulProgressAtMs = Math.max(
    0,
    runningEntry.last_progress_transition_at_ms ?? runningEntry.started_at_ms,
    ...Object.values(runningEntry.tool_call_ledger ?? {}).map((entry) => entry.last_seen_at_ms),
    ...Object.values(runningEntry.outstanding_tool_calls ?? {}).map((entry) => entry.last_waiting_at_ms ?? entry.started_at_ms)
  );
  const latestThreadActivityAtMs = runningEntry.codex_thread_activity_at_ms ?? null;
  const latestLivenessAtMs = Math.max(
    0,
    runningEntry.last_codex_timestamp_ms ?? runningEntry.started_at_ms,
    runningEntry.last_heartbeat_at_ms ?? 0,
    latestThreadActivityAtMs ?? 0
  );
  const normalizedMeaningful = latestMeaningfulProgressAtMs > 0 ? latestMeaningfulProgressAtMs : null;
  const normalizedLiveness = latestLivenessAtMs > 0 ? latestLivenessAtMs : null;
  const meaningfulAgeMs = normalizedMeaningful === null ? Number.POSITIVE_INFINITY : observedAtMs - normalizedMeaningful;
  const livenessAgeMs = normalizedLiveness === null ? Number.POSITIVE_INFINITY : observedAtMs - normalizedLiveness;
  const hasFreshLiveness = waitThresholdMs <= 0 || livenessAgeMs <= waitThresholdMs;
  const hasFreshThreadActivity =
    latestThreadActivityAtMs !== null && (waitThresholdMs <= 0 || observedAtMs - latestThreadActivityAtMs <= waitThresholdMs);
  const waitingLike = runningEntry.last_event === CANONICAL_EVENT.codex.turnWaiting || runningEntry.running_waiting_started_at_ms != null;
  const activityState: WorkerActivityState =
    meaningfulAgeMs <= waitThresholdMs
      ? 'advancing'
      : hasFreshThreadActivity
        ? 'active_but_opaque'
        : hasFreshLiveness || waitingLike
          ? 'heartbeat_only'
          : 'stale';

  return {
    latest_meaningful_progress_at_ms: normalizedMeaningful,
    latest_liveness_at_ms: normalizedLiveness,
    latest_thread_activity_at_ms: latestThreadActivityAtMs,
    activity_state: activityState
  };
}

export function workerEventLooksLikeTrackerComment(
  workerEvent: Pick<WorkerObservabilityEvent, 'event' | 'tool_name' | 'request_method' | 'request_category'>
): boolean {
  const event = workerEvent.event?.toLowerCase() ?? '';
  const toolName = workerEvent.tool_name?.toLowerCase() ?? '';
  const requestMethod = workerEvent.request_method?.toLowerCase() ?? '';
  const requestCategory = workerEvent.request_category?.toLowerCase() ?? '';

  if (event === 'linear.comment.created' || event === 'linear.comment.updated') {
    return true;
  }

  const looksLikeLinearRequest = requestCategory === 'linear' || event.startsWith('linear.');
  return (
    looksLikeLinearRequest &&
    (toolName === 'save_comment' ||
      toolName === 'create_comment' ||
      requestMethod === 'save_comment' ||
      requestMethod === 'create_comment')
  );
}

function isInactiveWorkerPid(inactiveEntries: InactiveWorkerPidEntry[], pid: string): boolean {
  return inactiveEntries.some((entry) => entry.pid === pid);
}

function isInactiveWorkerLineage(
  inactiveEntries: InactiveWorkerPidEntry[],
  workerEvent: WorkerObservabilityEvent
): boolean {
  if (inactiveEntries.length === 0) {
    return false;
  }

  return inactiveEntries.some((entry) => {
    const turnMatches = Boolean(entry.turn_id) && workerEvent.turn_id === entry.turn_id;
    const sessionMatches = Boolean(entry.session_id) && workerEvent.session_id === entry.session_id;
    if (!turnMatches && !sessionMatches) {
      return false;
    }
    return !entry.thread_id || !workerEvent.thread_id || workerEvent.thread_id === entry.thread_id;
  });
}

function isSameThreadContinuationTurnStart(runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent): boolean {
  const turnId = workerEvent.turn_id;
  return (
    workerEvent.event === CANONICAL_EVENT.codex.turnStarted &&
    runningEntry.last_event === CANONICAL_EVENT.codex.turnCompleted &&
    Boolean(runningEntry.thread_id) &&
    workerEvent.thread_id === runningEntry.thread_id &&
    typeof turnId === 'string' &&
    !(runningEntry.persisted_turn_ids ?? []).includes(turnId) &&
    !(runningEntry.pending_persisted_turn_ids ?? []).includes(turnId)
  );
}

function isTerminalTurnResidue(runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent): boolean {
  if (!runningEntry.last_event || !isTerminalTurnEvent(runningEntry.last_event)) {
    return false;
  }
  if (workerEvent.event === CANONICAL_EVENT.codex.turnStarted) {
    return false;
  }

  const sameTurn = Boolean(runningEntry.turn_id) && workerEvent.turn_id === runningEntry.turn_id;
  const sameSession = Boolean(runningEntry.session_id) && workerEvent.session_id === runningEntry.session_id;
  const sameThread =
    !runningEntry.thread_id || !workerEvent.thread_id || workerEvent.thread_id === runningEntry.thread_id;
  const eventPid = normalizeCodexAppServerPid(workerEvent.codex_app_server_pid);
  const sameWorkerPid = Boolean(runningEntry.codex_app_server_pid) && eventPid === runningEntry.codex_app_server_pid;
  const hasEventLineage = Boolean(workerEvent.thread_id || workerEvent.turn_id || workerEvent.session_id || eventPid);
  return sameThread && (sameTurn || sameSession || sameWorkerPid || !hasEventLineage);
}

function isSameThreadRecoveryTurnStart(runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent): boolean {
  const turnId = workerEvent.turn_id;
  return (
    workerEvent.event === CANONICAL_EVENT.codex.turnStarted &&
    runningEntry.recovery?.last_result === 'started' &&
    Boolean(runningEntry.thread_id) &&
    workerEvent.thread_id === runningEntry.thread_id &&
    typeof turnId === 'string' &&
    turnId !== runningEntry.turn_id
  );
}

function isPreviousRecoveryTurnEvent(runningEntry: RunningEntry, workerEvent: WorkerObservabilityEvent): boolean {
  const recovery = runningEntry.recovery;
  if (!recovery || recovery.last_result !== 'started') {
    return false;
  }

  const matchesPreviousTurn = Boolean(recovery.previous_turn_id) && workerEvent.turn_id === recovery.previous_turn_id;
  const matchesPreviousSession =
    Boolean(recovery.previous_session_id) && workerEvent.session_id === recovery.previous_session_id;
  if (!matchesPreviousTurn && !matchesPreviousSession) {
    return false;
  }

  if (recovery.previous_thread_id && workerEvent.thread_id && workerEvent.thread_id !== recovery.previous_thread_id) {
    return false;
  }

  return true;
}
