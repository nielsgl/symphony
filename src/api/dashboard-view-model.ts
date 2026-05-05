import { CANONICAL_EVENT } from '../observability/events';

export const ACTION_REQUIRED_REASON_LABELS: Record<string, string> = {
  operator_action_required_workspace_conflict: 'Workspace Conflict',
  operator_action_required_no_progress_redispatch_blocked: 'No Progress Redispatch Blocked',
  awaiting_human_review_scope_incomplete: 'Awaiting Human Review (Scope Incomplete)'
};

export interface ActionRequiredSummary {
  total: number;
  grouped: Record<string, number>;
}

export interface DashboardBlockedEntry {
  stop_reason_code?: string | null;
  stop_reason_detail?: string | null;
}

export function getActionRequiredLabel(code: string | null | undefined): string {
  return ACTION_REQUIRED_REASON_LABELS[code ?? ''] ?? (code || 'unknown');
}

export function isActionRequiredCode(code: string | null | undefined): boolean {
  return Boolean(code && ACTION_REQUIRED_REASON_LABELS[code]);
}

export function summarizeActionRequired(entries: DashboardBlockedEntry[]): ActionRequiredSummary {
  const grouped: Record<string, number> = {};
  for (const entry of entries) {
    const code = entry.stop_reason_code ?? '';
    if (!isActionRequiredCode(code)) {
      continue;
    }
    grouped[code] = (grouped[code] ?? 0) + 1;
  }
  const total = Object.values(grouped).reduce((sum, value) => sum + value, 0);
  return { total, grouped };
}

export type OperatorTransitionType =
  | 'completion_gate_blocked'
  | 'circuit_breaker_opened'
  | 'resume_accepted'
  | 'resume_rejected'
  | 'cancel_accepted'
  | 'cancel_rejected';

export interface OperatorTransitionEntry {
  at: string;
  issue_identifier: string;
  transition: OperatorTransitionType;
  label: string;
  result: 'success' | 'failure';
  detail: string;
}

interface TimelineMarker {
  at?: string | null;
  detail?: string | null;
}

interface RuntimeEvent {
  at?: string | null;
  event?: string | null;
  message?: string | null;
}

const DETAIL_TRANSITION_MAP: Record<string, OperatorTransitionType> = {
  'completion gate blocked redispatch because no progress signal was detected': 'completion_gate_blocked',
  'pr is open but scope is incomplete and no progress signal was detected': 'completion_gate_blocked',
  'respawn circuit breaker opened': 'circuit_breaker_opened',
  'resume accepted': 'resume_accepted',
  'resume rejected': 'resume_rejected',
  'cancel accepted': 'cancel_accepted',
  'cancel rejected': 'cancel_rejected'
};

const RUNTIME_EVENT_TRANSITION_MAP: Record<string, OperatorTransitionType> = {
  [CANONICAL_EVENT.orchestration.redispatchCompletionGateBlocked]: 'completion_gate_blocked',
  [CANONICAL_EVENT.orchestration.redispatchCircuitBreakerOpened]: 'circuit_breaker_opened',
  [CANONICAL_EVENT.orchestration.blockedInputResumed]: 'resume_accepted'
};

function normalizeDetail(detail: string | null | undefined): string {
  return (detail ?? '').trim().toLowerCase();
}

function describeTransition(transition: OperatorTransitionType): {
  label: string;
  result: 'success' | 'failure';
  defaultDetail: string;
} {
  switch (transition) {
    case 'completion_gate_blocked':
      return { label: 'Completion Gate Blocked', result: 'failure', defaultDetail: 'No progress signal detected in redispatch window.' };
    case 'circuit_breaker_opened':
      return { label: 'Circuit Breaker Opened', result: 'failure', defaultDetail: 'Respawn threshold reached; operator intervention required.' };
    case 'resume_accepted':
      return { label: 'Resume Accepted', result: 'success', defaultDetail: 'Resume request accepted and redispatch restarted.' };
    case 'resume_rejected':
      return { label: 'Resume Rejected', result: 'failure', defaultDetail: 'Resume request rejected; resolve blocking condition first.' };
    case 'cancel_accepted':
      return { label: 'Cancel Accepted', result: 'success', defaultDetail: 'Issue returned to backlog.' };
    case 'cancel_rejected':
      return { label: 'Cancel Rejected', result: 'failure', defaultDetail: 'Cancel request rejected; tracker state unchanged.' };
  }
}

export function deriveOperatorTransitions(params: {
  issueIdentifier: string;
  phaseTimeline?: TimelineMarker[];
  recentEvents?: RuntimeEvent[];
  blockedStopReasonCode?: string | null;
  blockedStopReasonDetail?: string | null;
}): OperatorTransitionEntry[] {
  const transitions: OperatorTransitionEntry[] = [];
  const seen = new Set<string>();

  const addTransition = (at: string | null | undefined, transition: OperatorTransitionType, detail: string | null | undefined) => {
    const key = `${transition}:${at ?? 'n/a'}:${detail ?? ''}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const descriptor = describeTransition(transition);
    transitions.push({
      at: at || 'n/a',
      issue_identifier: params.issueIdentifier,
      transition,
      label: descriptor.label,
      result: descriptor.result,
      detail: detail && detail.trim().length ? detail : descriptor.defaultDetail
    });
  };

  for (const marker of params.phaseTimeline ?? []) {
    const normalized = normalizeDetail(marker.detail);
    const transition = DETAIL_TRANSITION_MAP[normalized];
    if (transition) {
      addTransition(marker.at, transition, marker.detail ?? null);
    }
  }

  for (const event of params.recentEvents ?? []) {
    const eventName = event.event ?? '';
    const transition = RUNTIME_EVENT_TRANSITION_MAP[eventName];
    if (transition) {
      addTransition(event.at, transition, event.message ?? null);
    }
    const mappedByMessage = DETAIL_TRANSITION_MAP[normalizeDetail(event.message)];
    if (mappedByMessage) {
      addTransition(event.at, mappedByMessage, event.message ?? null);
    }
  }

  const blockedCode = params.blockedStopReasonCode ?? null;
  if (
    blockedCode === 'operator_action_required_no_progress_redispatch_blocked' ||
    blockedCode === 'awaiting_human_review_scope_incomplete'
  ) {
    addTransition('n/a', 'completion_gate_blocked', params.blockedStopReasonDetail ?? null);
  }

  return transitions.sort((a, b) => {
    const atA = Date.parse(a.at);
    const atB = Date.parse(b.at);
    if (Number.isFinite(atA) && Number.isFinite(atB)) {
      return atA - atB;
    }
    if (Number.isFinite(atA)) {
      return -1;
    }
    if (Number.isFinite(atB)) {
      return 1;
    }
    return a.label.localeCompare(b.label);
  });
}
