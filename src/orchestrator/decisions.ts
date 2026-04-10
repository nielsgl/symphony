import type { Issue } from '../tracker';
import type { OrchestratorConfig, OrchestratorState } from './types';

function normalizeStateName(state: string): string {
  return state.trim().toLowerCase();
}

function compareNullableNumberAscending(a: number | null, b: number | null): number {
  if (a === null && b === null) {
    return 0;
  }

  if (a === null) {
    return 1;
  }

  if (b === null) {
    return -1;
  }

  return a - b;
}

function compareNullableDateAscending(a: Date | null, b: Date | null): number {
  if (!a && !b) {
    return 0;
  }

  if (!a) {
    return 1;
  }

  if (!b) {
    return -1;
  }

  return a.getTime() - b.getTime();
}

export interface EligibilityResult {
  eligible: boolean;
  reason:
    | 'missing_required_fields'
    | 'not_active'
    | 'terminal'
    | 'already_running'
    | 'already_claimed'
    | 'global_slots_exhausted'
    | 'state_slots_exhausted'
    | 'todo_blocked'
    | 'eligible';
}

export function hasRequiredFields(issue: Issue): boolean {
  return Boolean(issue.id && issue.identifier && issue.title && issue.state);
}

export function isTerminalState(issueState: string, config: OrchestratorConfig): boolean {
  const normalizedState = normalizeStateName(issueState);
  return config.terminal_states.some((state) => normalizeStateName(state) === normalizedState);
}

export function isActiveState(issueState: string, config: OrchestratorConfig): boolean {
  const normalizedState = normalizeStateName(issueState);
  return config.active_states.some((state) => normalizeStateName(state) === normalizedState);
}

export function availableGlobalSlots(state: OrchestratorState): number {
  return Math.max(state.max_concurrent_agents - state.running.size, 0);
}

export function availableStateSlots(issueState: string, config: OrchestratorConfig, state: OrchestratorState): number {
  const normalizedState = normalizeStateName(issueState);
  const perStateLimit = config.max_concurrent_agents_by_state[normalizedState] ?? state.max_concurrent_agents;

  let runningInState = 0;
  for (const runningEntry of state.running.values()) {
    if (normalizeStateName(runningEntry.issue.state) === normalizedState) {
      runningInState += 1;
    }
  }

  return Math.max(perStateLimit - runningInState, 0);
}

export function shouldDispatchIssue(
  issue: Issue,
  state: OrchestratorState,
  config: OrchestratorConfig,
  options: { skipClaimCheckForIssueId?: string } = {}
): EligibilityResult {
  if (!hasRequiredFields(issue)) {
    return { eligible: false, reason: 'missing_required_fields' };
  }

  if (!isActiveState(issue.state, config)) {
    return { eligible: false, reason: 'not_active' };
  }

  if (isTerminalState(issue.state, config)) {
    return { eligible: false, reason: 'terminal' };
  }

  if (state.running.has(issue.id)) {
    return { eligible: false, reason: 'already_running' };
  }

  if (state.claimed.has(issue.id) && issue.id !== options.skipClaimCheckForIssueId) {
    return { eligible: false, reason: 'already_claimed' };
  }

  if (availableGlobalSlots(state) <= 0) {
    return { eligible: false, reason: 'global_slots_exhausted' };
  }

  if (availableStateSlots(issue.state, config, state) <= 0) {
    return { eligible: false, reason: 'state_slots_exhausted' };
  }

  if (normalizeStateName(issue.state) === 'todo') {
    const hasNonTerminalBlocker = issue.blocked_by.some((blocker) => {
      if (!blocker.state) {
        return true;
      }

      return !isTerminalState(blocker.state, config);
    });

    if (hasNonTerminalBlocker) {
      return { eligible: false, reason: 'todo_blocked' };
    }
  }

  return { eligible: true, reason: 'eligible' };
}

export function sortCandidatesForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const byPriority = compareNullableNumberAscending(a.priority, b.priority);
    if (byPriority !== 0) {
      return byPriority;
    }

    const byCreatedAt = compareNullableDateAscending(a.created_at, b.created_at);
    if (byCreatedAt !== 0) {
      return byCreatedAt;
    }

    return a.identifier.localeCompare(b.identifier);
  });
}

export function computeFailureBackoffMs(attempt: number, maxRetryBackoffMs: number): number {
  const attemptIndex = Math.max(attempt, 1);
  const computed = 10000 * 2 ** (attemptIndex - 1);
  return Math.min(computed, maxRetryBackoffMs);
}

export function nextAttempt(attempt: number | null): number {
  if (attempt === null) {
    return 1;
  }

  return attempt + 1;
}
