import { REASON_CODES } from '../observability/reason-codes';
import type { BlockedEntry, MissingToolOutputRecoveryState, RetryEntry, RunningEntry, ToolCallEvidenceSource } from '../orchestrator';

export type MissingToolOutputRecoveryOutcomeStatus =
  | 'not_started'
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'manual_action_required';

export interface MissingToolOutputRecoveryEvidence {
  status: MissingToolOutputRecoveryOutcomeStatus;
  headline: string;
  next_action: string;
  original_tool_name: string | null;
  original_call_id: string | null;
  evidence_source: ToolCallEvidenceSource | null;
  elapsed_wait_ms: number | null;
  active_ownership: {
    issue_id: string;
    issue_identifier: string;
    run_id: string | null;
    issue_run_id: string | null;
    attempt_id: string | null;
    thread_id: string | null;
    turn_id: string | null;
    session_id: string | null;
    codex_app_server_pid: string | null;
    app_server_owned: boolean;
  };
  interrupt_cancel_result: {
    status: 'not_started' | 'succeeded' | 'failed' | 'unknown';
    reason_code: string | null;
    detail: string | null;
  };
  replacement_turn: {
    thread_id: string | null;
    turn_id: string | null;
    session_id: string | null;
  };
  guarded_prompt_dispatch: {
    status: 'not_started' | 'sent' | 'failed' | 'unknown';
    prompt_hash: string | null;
    prompt_summary: string | null;
  };
  final_outcome: {
    result: MissingToolOutputRecoveryState['last_result'] | null;
    reason_code: string | null;
    detail: string | null;
  };
}

type RunningRecoveryProjectionEntry = Pick<
  RunningEntry,
  | 'issue'
  | 'identifier'
  | 'run_id'
  | 'issue_run_id'
  | 'attempt_id'
  | 'thread_id'
  | 'turn_id'
  | 'session_id'
  | 'codex_app_server_pid'
  | 'recovery'
> & { tool_output_wait?: BlockedEntry['tool_output_wait'] };

type BlockedRecoveryProjectionEntry = Pick<
  BlockedEntry,
  | 'issue_id'
  | 'issue_identifier'
  | 'issue_run_id'
  | 'previous_attempt_id'
  | 'previous_thread_id'
  | 'previous_session_id'
  | 'tool_output_wait'
  | 'recovery'
>;

type RetryRecoveryProjectionEntry = Pick<
  RetryEntry,
  | 'issue_id'
  | 'identifier'
  | 'issue_run_id'
  | 'previous_attempt_id'
  | 'previous_thread_id'
  | 'previous_session_id'
  | 'recovery'
> & { tool_output_wait?: BlockedEntry['tool_output_wait'] };

type RecoveryProjectionEntry =
  | RunningRecoveryProjectionEntry
  | BlockedRecoveryProjectionEntry
  | RetryRecoveryProjectionEntry;

function hasIssue(entry: RecoveryProjectionEntry): entry is RunningRecoveryProjectionEntry {
  return 'issue' in entry;
}

function isBlockedEntry(entry: RecoveryProjectionEntry): entry is BlockedRecoveryProjectionEntry {
  return 'issue_identifier' in entry;
}

function issueId(entry: RecoveryProjectionEntry): string {
  return hasIssue(entry) ? entry.issue.id : entry.issue_id;
}

function issueIdentifier(entry: RecoveryProjectionEntry): string {
  return hasIssue(entry) ? entry.identifier : isBlockedEntry(entry) ? entry.issue_identifier : entry.identifier;
}

function runId(entry: RecoveryProjectionEntry): string | null {
  return hasIssue(entry) ? entry.run_id ?? null : null;
}

function issueRunId(entry: RecoveryProjectionEntry): string | null {
  return hasIssue(entry) ? entry.issue_run_id ?? null : entry.issue_run_id ?? null;
}

function attemptId(entry: RecoveryProjectionEntry): string | null {
  return hasIssue(entry) ? entry.attempt_id ?? null : entry.previous_attempt_id ?? null;
}

function currentThreadId(entry: RecoveryProjectionEntry, recovery: MissingToolOutputRecoveryState | null): string | null {
  return hasIssue(entry) ? entry.thread_id ?? null : recovery?.previous_thread_id ?? entry.previous_thread_id ?? null;
}

function currentTurnId(entry: RecoveryProjectionEntry, recovery: MissingToolOutputRecoveryState | null): string | null {
  return hasIssue(entry) ? entry.turn_id ?? null : recovery?.previous_turn_id ?? entry.tool_output_wait?.turn_id ?? null;
}

function currentSessionId(entry: RecoveryProjectionEntry, recovery: MissingToolOutputRecoveryState | null): string | null {
  return hasIssue(entry) ? entry.session_id ?? null : recovery?.previous_session_id ?? entry.previous_session_id ?? null;
}

function resolveStatus(recovery: MissingToolOutputRecoveryState | null): MissingToolOutputRecoveryOutcomeStatus {
  if (!recovery) {
    return 'not_started';
  }
  switch (recovery.last_result) {
    case 'started':
      return 'in_progress';
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return recovery.last_result_reason_code === REASON_CODES.missingToolOutputRecoveryUnsafe
        ? 'manual_action_required'
        : 'failed';
    case 'blocked':
      return 'manual_action_required';
  }
}

function headline(status: MissingToolOutputRecoveryOutcomeStatus): string {
  switch (status) {
    case 'not_started':
      return 'Missing tool output detected';
    case 'in_progress':
      return 'Guarded missing-output recovery is in progress';
    case 'succeeded':
      return 'Guarded missing-output recovery succeeded';
    case 'failed':
      return 'Guarded missing-output recovery failed';
    case 'manual_action_required':
      return 'Missing-output recovery needs operator action';
  }
}

function nextAction(status: MissingToolOutputRecoveryOutcomeStatus): string {
  switch (status) {
    case 'not_started':
      return 'Inspect the active Codex thread and wait for automatic recovery or resume manually if configured recovery is unavailable.';
    case 'in_progress':
      return 'Monitor the replacement guarded recovery turn; do not treat external transcript activity as owned recovery success.';
    case 'succeeded':
      return 'Review the replacement turn and continue monitoring the active Symphony-owned lineage.';
    case 'failed':
      return 'Inspect the interrupt/start failure and decide whether to manually resume or cancel the run.';
    case 'manual_action_required':
      return 'Inspect current external state for the original tool action before manually resuming, retrying, or cancelling.';
  }
}

export function projectMissingToolOutputRecovery(
  entry: RecoveryProjectionEntry
): MissingToolOutputRecoveryEvidence | null {
  const recovery = entry.recovery ?? null;
  const toolWait = entry.tool_output_wait ?? null;
  if (!recovery && !toolWait) {
    return null;
  }
  const status = resolveStatus(recovery);
  const originalToolName = recovery?.last_tool_name ?? toolWait?.tool_name ?? null;
  const originalCallId = recovery?.last_call_id ?? toolWait?.call_id ?? null;
  const evidenceSource = recovery?.evidence_source ?? toolWait?.evidence_source ?? null;
  const elapsedWaitMs = recovery?.elapsed_wait_ms ?? toolWait?.elapsed_wait_ms ?? null;
  const previousThreadId = recovery?.previous_thread_id ?? toolWait?.thread_id ?? null;
  const previousTurnId = recovery?.previous_turn_id ?? toolWait?.turn_id ?? null;
  const previousSessionId = recovery?.previous_session_id ?? toolWait?.session_id ?? null;
  const threadId = currentThreadId(entry, recovery);
  const turnId = currentTurnId(entry, recovery);
  const sessionId = currentSessionId(entry, recovery);

  return {
    status,
    headline: headline(status),
    next_action: nextAction(status),
    original_tool_name: originalToolName,
    original_call_id: originalCallId,
    evidence_source: evidenceSource,
    elapsed_wait_ms: elapsedWaitMs,
    active_ownership: {
      issue_id: issueId(entry),
      issue_identifier: issueIdentifier(entry),
      run_id: runId(entry),
      issue_run_id: issueRunId(entry),
      attempt_id: attemptId(entry),
      thread_id: threadId,
      turn_id: turnId,
      session_id: sessionId,
      codex_app_server_pid: hasIssue(entry) ? entry.codex_app_server_pid ?? null : null,
      app_server_owned: hasIssue(entry) ? Boolean(entry.codex_app_server_pid || entry.run_id || entry.issue_run_id) : false
    },
    interrupt_cancel_result: {
      status: recovery ? 'succeeded' : 'not_started',
      reason_code: recovery ? REASON_CODES.missingToolOutputRecoveryInterrupted : null,
      detail: recovery
        ? `interrupted previous turn ${previousTurnId ?? 'unknown'} on thread ${previousThreadId ?? 'unknown'}`
        : null
    },
    replacement_turn: {
      thread_id: recovery ? threadId : null,
      turn_id: recovery && turnId !== previousTurnId ? turnId : null,
      session_id: recovery && sessionId !== previousSessionId ? sessionId : null
    },
    guarded_prompt_dispatch: {
      status: recovery
        ? recovery.last_result === 'failed' && recovery.last_result_reason_code === REASON_CODES.missingToolOutputRecoveryStartFailed
          ? 'failed'
          : 'sent'
        : 'not_started',
      prompt_hash: recovery?.prompt_hash ?? null,
      prompt_summary: recovery?.prompt_summary ?? null
    },
    final_outcome: {
      result: recovery?.last_result ?? null,
      reason_code: recovery?.last_result_reason_code ?? null,
      detail: recovery?.last_result_detail ?? null
    }
  };
}
