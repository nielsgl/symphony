import type { OperatorActionRecord, OrchestratorState, RunningEntry } from '../../orchestrator';

export function projectOperatorActions(state: OrchestratorState, issueId: string, runningEntry?: RunningEntry) {
  return (state.operator_actions?.get(issueId) ?? [])
    .filter((action) => !runningEntry || actionBelongsToRunningEntry(action, runningEntry))
    .map((action) => ({ ...action }));
}

export function actionBelongsToRunningEntry(action: OperatorActionRecord, entry: RunningEntry): boolean {
  if (action.requested_at_ms < entry.started_at_ms) {
    return false;
  }
  const target = action.target_identifiers;
  if (!target) {
    return true;
  }
  if (target.run_id && entry.run_id && target.run_id !== entry.run_id) {
    return false;
  }
  if (target.attempt_id && entry.attempt_id && target.attempt_id !== entry.attempt_id) {
    return false;
  }
  if (target.thread_id && entry.thread_id && target.thread_id !== entry.thread_id) {
    return false;
  }
  if (target.turn_id && entry.turn_id && target.turn_id !== entry.turn_id) {
    return false;
  }
  if (target.session_id && entry.session_id && target.session_id !== entry.session_id) {
    return false;
  }
  return true;
}
