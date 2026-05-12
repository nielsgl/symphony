import type {
  BlockedEntry,
  OrchestratorState,
  RetryEntry,
  RunningEntry
} from '../orchestrator';
import type { ExecutionGraphThreadLineage } from '../persistence';
import { REASON_CODES, requireReasonCodeDefinition } from '../observability/reason-codes';
import {
  DYNAMIC_TOOL_CONSOLE_RECOVERY_ACTION,
  parseDynamicToolCapabilityMismatchDetail,
  UNSUPPORTED_DYNAMIC_TOOL_CONSOLE_RESUME_REASON_CODE
} from '../observability/dynamic-tool-capability';
import type {
  ThreadDiagnosticsCapabilityWarning,
  ThreadDiagnosticsBlocker,
  ThreadDiagnosticsBlockerClassification,
  ThreadDiagnosticsEvent,
  ThreadDiagnosticsResponse,
  ThreadDiagnosticsStatus
} from './types';
import { projectMissingToolOutputRecovery, type MissingToolOutputRecoveryEvidence } from './missing-tool-output-recovery';

interface RuntimeMatch {
  issue_id: string;
  running: RunningEntry | null;
  retry: RetryEntry | null;
  blocked: BlockedEntry | null;
}

function toMs(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function durationMs(startedAtMs: number, endedAtMs: number | null): number | null {
  return endedAtMs === null ? null : Math.max(0, endedAtMs - startedAtMs);
}

function normalizeStatus(status: string, endedAtMs: number | null): ThreadDiagnosticsStatus {
  if (status === 'cancelled') {
    return 'cancelled';
  }
  if (status === 'failed') {
    return 'failed';
  }
  if (status === 'blocked' || status === 'retrying') {
    return 'stalled';
  }
  if (status === 'succeeded') {
    return 'completed';
  }
  return endedAtMs === null ? 'running' : 'completed';
}

function isWaitEvent(event: string, reasonCode: string | null): boolean {
  const normalized = `${event} ${reasonCode ?? ''}`.toLowerCase();
  return normalized.includes('waiting') || normalized.includes('heartbeat') || normalized.includes('wait');
}

function isMeaningfulProgress(event: ThreadDiagnosticsEvent): boolean {
  if (isWaitEvent(event.event, event.reason_code)) {
    return false;
  }
  return !event.event.toLowerCase().includes('heartbeat');
}

function sortTimeline(events: ThreadDiagnosticsEvent[]): ThreadDiagnosticsEvent[] {
  return [...events].sort((left, right) => {
    if (left.at_ms !== right.at_ms) {
      return left.at_ms - right.at_ms;
    }
    const eventCompare = left.event.localeCompare(right.event);
    if (eventCompare !== 0) {
      return eventCompare;
    }
    return (left.turn_id ?? '').localeCompare(right.turn_id ?? '');
  });
}

function lastMeaningfulProgressAtMs(events: ThreadDiagnosticsEvent[]): number | null {
  const meaningful = events.filter(isMeaningfulProgress);
  return meaningful.length ? meaningful[meaningful.length - 1]!.at_ms : null;
}

function projectRuntimeEventEvidence(
  event: RunningEntry['recent_events'][number],
  context: {
    thread_id: string;
    turn_id: string | null;
    session_id: string | null;
    fallback_reason_code?: string | null;
    fallback_reason_detail?: string | null;
  }
): ThreadDiagnosticsEvent {
  return {
    at_ms: event.at_ms,
    event: event.event,
    reason_code: event.reason_code ?? context.fallback_reason_code ?? null,
    reason_detail: event.message ?? context.fallback_reason_detail ?? null,
    ...(event.request_method !== undefined ? { request_method: event.request_method } : {}),
    ...(event.request_category !== undefined ? { request_category: event.request_category } : {}),
    ...(event.tool_call_id !== undefined ? { tool_call_id: event.tool_call_id } : {}),
    ...(event.tool_name !== undefined ? { tool_name: event.tool_name } : {}),
    ...(event.protocol_warning !== undefined ? { protocol_warning: { ...event.protocol_warning } } : {}),
    ...(event.model_reroute !== undefined
      ? { model_reroute: event.model_reroute ? { ...event.model_reroute } : null }
      : {}),
    ...(event.requested_model !== undefined ? { requested_model: event.requested_model } : {}),
    ...(event.effective_model !== undefined ? { effective_model: event.effective_model } : {}),
    thread_id: context.thread_id,
    turn_id: context.turn_id,
    session_id: context.session_id
  };
}

function blockerDetails(classification: ThreadDiagnosticsBlockerClassification): {
  actionability: ThreadDiagnosticsBlocker['actionability'];
  recommended_actions: string[];
} {
  switch (classification) {
    case REASON_CODES.missingToolOutput:
      return {
        actionability: 'required',
        recommended_actions: ['Inspect the Codex thread', 'Resume the blocked run', 'Cancel the blocked run']
      };
    case 'stalled_waiting':
      return {
        actionability: 'required',
        recommended_actions: ['Inspect issue diagnostics', 'Cancel the current turn', 'Requeue the run']
      };
    case 'tool_waiting_long':
      return {
        actionability: 'recommended',
        recommended_actions: ['Inspect the active Codex turn and resume, cancel, or retry the run if the wait is not expected.']
      };
    case 'tracker_transition_pending':
      return {
        actionability: 'recommended',
        recommended_actions: ['Inspect tracker state transition logs and retry tracker reconciliation after confirming remote state.']
      };
    case 'input_required_pending':
      return {
        actionability: 'required',
        recommended_actions: ['Submit the pending input response or cancel the blocked run.']
      };
    case 'workspace_integrity_conflict':
      return {
        actionability: 'required',
        recommended_actions: ['Inspect workspace conflicts, preserve user changes, and resume after resolving integrity findings.']
      };
    case 'retry_backoff_wait':
      return {
        actionability: 'none',
        recommended_actions: ['Wait for the scheduled retry or manually resume if the backoff should be bypassed.']
      };
    case 'codex_no_progress':
      return {
        actionability: 'recommended',
        recommended_actions: ['Review the last Codex output and either provide guidance, retry, or cancel the stalled run.']
      };
  }
}

function buildBlocker(
  classification: ThreadDiagnosticsBlockerClassification,
  reasonCode: string | null,
  reasonDetail: string | null,
  timeSinceProgress: number | null = null,
  toolOutputWait: ThreadDiagnosticsBlocker['tool_output_wait'] = null,
  missingToolOutputRecovery: MissingToolOutputRecoveryEvidence | null = null
): ThreadDiagnosticsBlocker {
  const reasonDefinition = reasonCode ? requireReasonCodeDefinition(reasonCode) : null;
  const details = blockerDetails(classification);
  return {
    classification,
    reason_code: reasonCode,
    reason_detail: reasonDetail,
    time_since_progress: timeSinceProgress,
    ...details,
    recommended_actions: toolOutputWait?.recommended_actions ?? details.recommended_actions,
    expected_auto_transition: reasonDefinition?.expected_transition ?? null,
    ...(toolOutputWait ? { tool_output_wait: { ...toolOutputWait, recommended_actions: [...toolOutputWait.recommended_actions] } } : {}),
    ...(missingToolOutputRecovery ? { missing_tool_output_recovery: missingToolOutputRecovery } : {})
  };
}

function capabilityWarningsFromToolSpans(
  threadId: string,
  spans: Array<{
    tool_name: string;
    turn_id: string | null;
    reason_code: string | null;
    reason_detail: string | null;
  }>
): ThreadDiagnosticsCapabilityWarning[] {
  return spans.flatMap((span) => {
    const detail = parseDynamicToolCapabilityMismatchDetail(span.reason_detail);
    if (!detail && span.reason_code !== UNSUPPORTED_DYNAMIC_TOOL_CONSOLE_RESUME_REASON_CODE) {
      return [];
    }

    return [
      {
        reason_code: UNSUPPORTED_DYNAMIC_TOOL_CONSOLE_RESUME_REASON_CODE,
        source_environment: detail?.source_environment ?? 'console_tui',
        attempted_tool_name: detail?.attempted_tool_name ?? span.tool_name,
        call_id: detail?.call_id ?? null,
        thread_id: threadId,
        turn_id: span.turn_id,
        unsupported_capability_message:
          detail?.unsupported_capability_message ?? 'Dynamic tool calls are not available in TUI yet.',
        recommended_recovery_action: detail?.recommended_recovery_action ?? DYNAMIC_TOOL_CONSOLE_RECOVERY_ACTION
      }
    ];
  });
}

export function classifyThreadBlocker(params: {
  reason_code: string | null;
  reason_detail: string | null;
  status?: string | null;
  has_conflict_files?: boolean;
  has_pending_input?: boolean;
  stalled_waiting?: boolean;
  retrying?: boolean;
  time_since_progress?: number | null;
  tool_output_wait?: ThreadDiagnosticsBlocker['tool_output_wait'];
  missing_tool_output_recovery?: MissingToolOutputRecoveryEvidence | null;
}): ThreadDiagnosticsBlocker | null {
  const reasonCode = params.reason_code;
  const reasonDetail = params.reason_detail;
  const normalized = `${reasonCode ?? ''} ${reasonDetail ?? ''} ${params.status ?? ''}`.toLowerCase();

  if (
    reasonCode === REASON_CODES.missingToolOutput ||
    reasonCode === REASON_CODES.missingToolOutputRecoveryExhausted ||
    reasonCode === REASON_CODES.missingToolOutputRecoveryStartFailed ||
    reasonCode === REASON_CODES.missingToolOutputRecoveryUnsafe
  ) {
    return buildBlocker(
      REASON_CODES.missingToolOutput,
      reasonCode,
      reasonDetail,
      params.time_since_progress ?? null,
      params.tool_output_wait ?? null,
      params.missing_tool_output_recovery ?? null
    );
  }
  if (params.retrying || normalized.includes('retry')) {
    return buildBlocker('retry_backoff_wait', reasonCode, reasonDetail, params.time_since_progress ?? null);
  }
  if (params.stalled_waiting || reasonCode === REASON_CODES.turnWaitingThresholdExceeded) {
    return buildBlocker('stalled_waiting', reasonCode, reasonDetail, params.time_since_progress ?? null);
  }
  if (params.has_conflict_files || normalized.includes('workspace') || normalized.includes('conflict')) {
    return buildBlocker('workspace_integrity_conflict', reasonCode, reasonDetail, params.time_since_progress ?? null);
  }
  if (params.has_pending_input || reasonCode === REASON_CODES.turnInputRequired || normalized.includes('input_required')) {
    return buildBlocker('input_required_pending', reasonCode, reasonDetail, params.time_since_progress ?? null);
  }
  if (normalized.includes('tracker') || normalized.includes('transition')) {
    return buildBlocker('tracker_transition_pending', reasonCode, reasonDetail, params.time_since_progress ?? null);
  }
  if (normalized.includes('no_progress') || normalized.includes('no progress') || normalized.includes('stalled')) {
    return buildBlocker('codex_no_progress', reasonCode, reasonDetail, params.time_since_progress ?? null);
  }
  if (params.status === 'blocked') {
    return buildBlocker('codex_no_progress', reasonCode, reasonDetail, params.time_since_progress ?? null);
  }
  return null;
}

function findRuntimeByThreadId(state: OrchestratorState, threadId: string): RuntimeMatch | null {
  for (const [issueId, running] of state.running.entries()) {
    if (running.thread_id === threadId || running.persisted_thread_id === threadId) {
      return {
        issue_id: issueId,
        running,
        retry: state.retry_attempts.get(issueId) ?? null,
        blocked: state.blocked_inputs.get(issueId) ?? null
      };
    }
  }
  for (const blocked of state.blocked_inputs.values()) {
    if (blocked.previous_thread_id === threadId) {
      return {
        issue_id: blocked.issue_id,
        running: state.running.get(blocked.issue_id) ?? null,
        retry: state.retry_attempts.get(blocked.issue_id) ?? null,
        blocked
      };
    }
  }
  for (const retry of state.retry_attempts.values()) {
    if (retry.previous_thread_id === threadId) {
      return {
        issue_id: retry.issue_id,
        running: state.running.get(retry.issue_id) ?? null,
        retry,
        blocked: state.blocked_inputs.get(retry.issue_id) ?? null
      };
    }
  }
  return null;
}

function findRuntimeByIssueIdentifier(state: OrchestratorState, issueIdentifier: string): RuntimeMatch | null {
  const runningEntry = Array.from(state.running.entries()).find(([, entry]) => entry.identifier === issueIdentifier);
  const retryEntry = Array.from(state.retry_attempts.values()).find((entry) => entry.identifier === issueIdentifier);
  const blockedEntry = Array.from(state.blocked_inputs.values()).find((entry) => entry.issue_identifier === issueIdentifier);
  const issueId = runningEntry?.[0] ?? retryEntry?.issue_id ?? blockedEntry?.issue_id;
  if (!issueId) {
    return null;
  }
  return {
    issue_id: issueId,
    running: runningEntry?.[1] ?? state.running.get(issueId) ?? null,
    retry: retryEntry ?? state.retry_attempts.get(issueId) ?? null,
    blocked: blockedEntry ?? state.blocked_inputs.get(issueId) ?? null
  };
}

function diagnosticsFromRuntime(threadId: string, match: RuntimeMatch, nowMs: number = Date.now()): ThreadDiagnosticsResponse {
  const source = match.running;
  const retry = match.retry;
  const blocked = match.blocked;
  const issueIdentifier = source?.identifier ?? retry?.identifier ?? blocked?.issue_identifier ?? '';
  const attempt = source?.retry_attempt ?? retry?.attempt ?? blocked?.attempt ?? 0;
  const sessionId = source?.session_id ?? blocked?.previous_session_id ?? retry?.previous_session_id ?? null;
  const blockedConsole = blocked
    ? blocked.session_console?.map((event) =>
        projectRuntimeEventEvidence(event, {
          thread_id: threadId,
          turn_id: null,
          session_id: sessionId,
          fallback_reason_code: blocked.stop_reason_code,
          fallback_reason_detail: blocked.stop_reason_detail
        })
      ) ?? []
    : [];
  const timeline = sortTimeline([
    ...(source?.recent_events ?? []).map((event) =>
      projectRuntimeEventEvidence(event, {
        thread_id: threadId,
        turn_id: source?.turn_id ?? null,
        session_id: sessionId
      })
    ),
    ...blockedConsole
  ]);
  const waitAnchor = source?.running_waiting_started_at_ms ?? source?.stalled_waiting_since_ms ?? null;
  const wait_spans = waitAnchor
    ? [
        {
          started_at_ms: waitAnchor,
          ended_at_ms: null,
          duration_ms: null,
          status: source?.stalled_waiting_reason ? 'blocked' : 'running',
          reason_code: source?.stalled_waiting_reason ?? null,
          reason_detail: source?.stalled_waiting_reason ? 'codex.turn.waiting heartbeat loop exceeded threshold' : null
        }
      ]
    : [];
  const retryTimeSinceProgress =
    typeof retry?.last_progress_checkpoint_at === 'number' ? Math.max(0, nowMs - retry.last_progress_checkpoint_at) : null;
  const blockedTimeSinceProgress =
    typeof blocked?.last_progress_checkpoint_at === 'number' ? Math.max(0, nowMs - blocked.last_progress_checkpoint_at) : null;
  const currentBlocker = blocked
    ? classifyThreadBlocker({
        reason_code: blocked.stop_reason_code,
        reason_detail: blocked.stop_reason_detail,
        status: 'blocked',
        has_conflict_files: blocked.conflict_files.length > 0,
        has_pending_input: Boolean(blocked.pending_input),
        time_since_progress: blockedTimeSinceProgress,
        tool_output_wait: blocked.tool_output_wait ?? null,
        missing_tool_output_recovery: projectMissingToolOutputRecovery(blocked)
      })
    : retry
      ? classifyThreadBlocker({
          reason_code: retry.stop_reason_code,
          reason_detail: retry.stop_reason_detail ?? retry.error,
          status: 'retrying',
          retrying: true,
          time_since_progress: retryTimeSinceProgress,
          missing_tool_output_recovery: projectMissingToolOutputRecovery(retry)
        })
      : classifyThreadBlocker({
          reason_code: source?.recovery?.reason_code ?? source?.stalled_waiting_reason ?? null,
          reason_detail:
            source?.stalled_waiting_reason === REASON_CODES.turnWaitingThresholdExceeded
              ? 'codex.turn.waiting heartbeat loop exceeded threshold'
              : source?.recovery?.prompt_summary ?? source?.last_event_summary ?? source?.last_message ?? null,
          status: source?.recovery || source?.stalled_waiting_reason ? 'blocked' : 'running',
          has_pending_input: Boolean(source?.awaiting_input_since_ms),
          stalled_waiting: Boolean(source?.stalled_waiting_since_ms && source?.stalled_waiting_reason),
          missing_tool_output_recovery: source ? projectMissingToolOutputRecovery(source) : null,
          time_since_progress:
            typeof source?.last_progress_transition_at_ms === 'number'
              ? Math.max(0, nowMs - source.last_progress_transition_at_ms)
              : null
        });

  const timelineLastMeaningfulProgress = lastMeaningfulProgressAtMs(timeline);
  const runtimeLastMeaningfulProgress =
    timelineLastMeaningfulProgress ??
    (typeof source?.last_progress_transition_at_ms === 'number'
      ? source.last_progress_transition_at_ms
      : typeof retry?.last_progress_checkpoint_at === 'number'
        ? retry.last_progress_checkpoint_at
        : typeof blocked?.last_progress_checkpoint_at === 'number'
          ? blocked.last_progress_checkpoint_at
          : null);

  return {
    thread_id: threadId,
    issue_identifier: issueIdentifier,
    attempt,
    status: blocked || retry || currentBlocker ? 'stalled' : 'running',
    timeline,
    phase_spans: [],
    tool_spans: [],
    wait_spans,
    capability_warnings: [],
    current_blocker: currentBlocker,
    last_meaningful_progress_at_ms: runtimeLastMeaningfulProgress
  };
}

function diagnosticsFromLineage(lineage: ExecutionGraphThreadLineage, nowMs: number = Date.now()): ThreadDiagnosticsResponse {
  const threadId = lineage.thread.thread_id;
  const threadEndedAtMs = toMs(lineage.thread.ended_at);
  const timeline = sortTimeline([
    {
      at_ms: toMs(lineage.issue_run.started_at) ?? 0,
      event: 'issue_run.started',
      reason_code: lineage.issue_run.reason_code,
      reason_detail: lineage.issue_run.reason_detail,
      thread_id: threadId,
      turn_id: null,
      session_id: null
    },
    {
      at_ms: toMs(lineage.attempt.started_at) ?? 0,
      event: 'attempt.started',
      reason_code: lineage.attempt.reason_code,
      reason_detail: lineage.attempt.reason_detail,
      thread_id: threadId,
      turn_id: null,
      session_id: null
    },
    {
      at_ms: toMs(lineage.thread.started_at) ?? 0,
      event: 'thread.started',
      reason_code: lineage.thread.reason_code,
      reason_detail: lineage.thread.reason_detail,
      thread_id: threadId,
      turn_id: null,
      session_id: null
    },
    ...lineage.turns.flatMap((turn) => [
      {
        at_ms: toMs(turn.started_at) ?? 0,
        event: 'turn.started',
        reason_code: turn.reason_code,
        reason_detail: turn.reason_detail,
        thread_id: threadId,
        turn_id: turn.turn_id,
        session_id: null
      },
      ...(turn.ended_at
        ? [
            {
              at_ms: toMs(turn.ended_at) ?? 0,
              event: 'turn.ended',
              reason_code: turn.reason_code,
              reason_detail: turn.reason_detail,
              thread_id: threadId,
              turn_id: turn.turn_id,
              session_id: null
            }
          ]
        : []),
      ...turn.state_transitions.map((transition) => ({
        at_ms: toMs(transition.transitioned_at) ?? 0,
        event: 'state.transition',
        reason_code: transition.reason_code,
        reason_detail: transition.reason_detail,
        thread_id: threadId,
        turn_id: transition.turn_id,
        session_id: null
      }))
    ]),
    ...lineage.state_transitions.map((transition) => ({
      at_ms: toMs(transition.transitioned_at) ?? 0,
      event: 'state.transition',
      reason_code: transition.reason_code,
      reason_detail: transition.reason_detail,
      thread_id: threadId,
      turn_id: transition.turn_id,
      session_id: null
    }))
  ].filter((event) => Number.isFinite(event.at_ms)));
  const phase_spans = lineage.turns.flatMap((turn) =>
    turn.phase_spans.map((span) => {
      const startedAtMs = toMs(span.started_at) ?? 0;
      const endedAtMs = toMs(span.ended_at);
      return {
        phase: span.phase,
        started_at_ms: startedAtMs,
        ended_at_ms: endedAtMs,
        duration_ms: durationMs(startedAtMs, endedAtMs),
        status: span.status,
        reason_code: span.reason_code,
        reason_detail: span.reason_detail
      };
    })
  );
  const tool_spans = lineage.turns.flatMap((turn) =>
    turn.tool_spans.map((span) => {
      const startedAtMs = toMs(span.started_at) ?? 0;
      const endedAtMs = toMs(span.ended_at);
      return {
        tool_name: span.tool_name,
        turn_id: turn.turn_id,
        started_at_ms: startedAtMs,
        ended_at_ms: endedAtMs,
        duration_ms: durationMs(startedAtMs, endedAtMs),
        status: span.status,
        reason_code: span.reason_code,
        reason_detail: span.reason_detail
      };
    })
  );
  const wait_spans = timeline
    .filter((event) => isWaitEvent(event.event, event.reason_code))
    .map((event) => ({
      started_at_ms: event.at_ms,
      ended_at_ms: null,
      duration_ms: null,
      status: 'running',
      reason_code: event.reason_code,
      reason_detail: event.reason_detail
    }));
  const finalTransition = [...lineage.state_transitions].sort((left, right) => {
    const leftAt = toMs(left.transitioned_at) ?? 0;
    const rightAt = toMs(right.transitioned_at) ?? 0;
    return rightAt - leftAt;
  })[0];
  const currentBlocker = classifyThreadBlocker({
    reason_code: finalTransition?.reason_code ?? lineage.thread.reason_code,
    reason_detail: finalTransition?.reason_detail ?? lineage.thread.reason_detail,
    status: finalTransition?.status ?? lineage.thread.status,
    time_since_progress:
      lastMeaningfulProgressAtMs(timeline) === null
        ? null
        : Math.max(0, nowMs - lastMeaningfulProgressAtMs(timeline)!)
  });
  return {
    thread_id: threadId,
    issue_identifier: lineage.issue_run.issue_identifier,
    attempt: lineage.attempt.attempt_number,
    status: currentBlocker ? 'stalled' : normalizeStatus(lineage.thread.status, threadEndedAtMs),
    timeline,
    phase_spans,
    tool_spans,
    wait_spans,
    capability_warnings: capabilityWarningsFromToolSpans(threadId, tool_spans),
    current_blocker: currentBlocker,
    last_meaningful_progress_at_ms: lastMeaningfulProgressAtMs(timeline)
  };
}

function mergeTimelineEvents(events: ThreadDiagnosticsEvent[]): ThreadDiagnosticsEvent[] {
  const eventsByKey = new Map<string, ThreadDiagnosticsEvent>();
  for (const event of sortTimeline(events)) {
    eventsByKey.set(
      [
        event.at_ms,
        event.event,
        event.reason_code ?? '',
        event.reason_detail ?? '',
        event.thread_id,
        event.turn_id ?? '',
        event.session_id ?? ''
      ].join('\u0000'),
      event
    );
  }
  return sortTimeline([...eventsByKey.values()]);
}

function mergeRuntimeWithLineage(
  threadId: string,
  match: RuntimeMatch,
  lineage: ExecutionGraphThreadLineage,
  nowMs?: number
): ThreadDiagnosticsResponse {
  const persisted = diagnosticsFromLineage(lineage, nowMs);
  const runtime = diagnosticsFromRuntime(threadId, match, nowMs);
  const timeline = mergeTimelineEvents([...persisted.timeline, ...runtime.timeline]);
  const wait_spans = [...persisted.wait_spans, ...runtime.wait_spans].sort((left, right) => {
    if (left.started_at_ms !== right.started_at_ms) {
      return left.started_at_ms - right.started_at_ms;
    }
    return (left.reason_code ?? '').localeCompare(right.reason_code ?? '');
  });

  return {
    ...persisted,
    thread_id: threadId,
    issue_identifier: runtime.issue_identifier || persisted.issue_identifier,
    attempt: runtime.attempt,
    status: runtime.status,
    timeline,
    wait_spans,
    capability_warnings: persisted.capability_warnings,
    current_blocker: runtime.current_blocker ?? persisted.current_blocker,
    last_meaningful_progress_at_ms: lastMeaningfulProgressAtMs(timeline)
  };
}

export function buildThreadDiagnosticsByThreadId(params: {
  state: OrchestratorState;
  thread_id: string;
  lineage: ExecutionGraphThreadLineage | null;
  now_ms?: number;
}): ThreadDiagnosticsResponse | null {
  const runtimeMatch = findRuntimeByThreadId(params.state, params.thread_id);
  if (runtimeMatch) {
    if (params.lineage) {
      return mergeRuntimeWithLineage(params.thread_id, runtimeMatch, params.lineage, params.now_ms);
    }
    return diagnosticsFromRuntime(params.thread_id, runtimeMatch, params.now_ms);
  }
  if (params.lineage) {
    return diagnosticsFromLineage(params.lineage, params.now_ms);
  }
  return null;
}

export function buildThreadDiagnosticsFromLineage(params: {
  lineage: ExecutionGraphThreadLineage;
  now_ms?: number;
}): ThreadDiagnosticsResponse {
  return diagnosticsFromLineage(params.lineage, params.now_ms);
}

export function buildThreadDiagnosticsByIssueIdentifier(params: {
  state: OrchestratorState;
  issue_identifier: string;
  reconstructThreadLineage?: (threadId: string) => ExecutionGraphThreadLineage | null;
  reconstructLatestThreadLineageByIssueIdentifier?: (issueIdentifier: string) => ExecutionGraphThreadLineage | null;
  now_ms?: number;
}): ThreadDiagnosticsResponse | null {
  const runtimeMatch = findRuntimeByIssueIdentifier(params.state, params.issue_identifier);
  if (!runtimeMatch) {
    const lineage = params.reconstructLatestThreadLineageByIssueIdentifier?.(params.issue_identifier) ?? null;
    return lineage ? diagnosticsFromLineage(lineage, params.now_ms) : null;
  }
  const threadId = runtimeMatch.running?.thread_id ?? runtimeMatch.running?.persisted_thread_id ?? runtimeMatch.blocked?.previous_thread_id ?? runtimeMatch.retry?.previous_thread_id;
  if (!threadId) {
    const lineage = params.reconstructLatestThreadLineageByIssueIdentifier?.(params.issue_identifier) ?? null;
    return lineage ? diagnosticsFromLineage(lineage, params.now_ms) : null;
  }
  const lineage = params.reconstructThreadLineage?.(threadId) ?? null;
  if (lineage) {
    return mergeRuntimeWithLineage(threadId, runtimeMatch, lineage, params.now_ms);
  }
  return diagnosticsFromRuntime(threadId, runtimeMatch, params.now_ms);
}
