export const OPERATOR_EXPLAINER_VERSION = '2026-05-05.v1';

export type OperatorExplainerClassification =
  | 'healthy'
  | 'awaiting_input'
  | 'stalled_waiting'
  | 'retrying'
  | 'blocked_input'
  | 'failed';

export type OperatorExplainerActionability = 'none' | 'recommended' | 'required';

export interface OperatorExplainer {
  version: string;
  classification: OperatorExplainerClassification;
  actionability: OperatorExplainerActionability;
  headline: string;
  detail: string | null;
  recommended_action: string | null;
  expected_transition: string | null;
  reason_code: string | null;
  reason_detail: string | null;
}

export interface OperatorExplainerHint {
  classification: string;
  actionability: string;
  headline: string;
}

export interface OperatorExplainerInput {
  state_class: 'running' | 'retrying' | 'blocked' | 'failed';
  awaiting_input?: boolean;
  stalled_waiting?: boolean;
  stalled_waiting_reason?: 'turn_waiting_threshold_exceeded' | null;
  reason_code?: string | null;
  reason_detail?: string | null;
  expected_transition_detail?: string | null;
}

function normalized(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildExplainer(params: Omit<OperatorExplainer, 'version'>): OperatorExplainer {
  return {
    version: OPERATOR_EXPLAINER_VERSION,
    classification: params.classification,
    actionability: params.actionability,
    headline: params.headline,
    detail: params.detail,
    recommended_action: params.recommended_action,
    expected_transition: params.expected_transition,
    reason_code: params.reason_code,
    reason_detail: params.reason_detail
  };
}

export function toOperatorExplainerHint(explainer: OperatorExplainer): OperatorExplainerHint {
  return {
    classification: explainer.classification,
    actionability: explainer.actionability,
    headline: explainer.headline
  };
}

export function explainOperatorRuntimeState(input: OperatorExplainerInput): OperatorExplainer {
  const reasonCode = normalized(input.reason_code);
  const reasonDetail = normalized(input.reason_detail);
  const expectedTransition = normalized(input.expected_transition_detail);

  if (input.state_class === 'failed') {
    return buildExplainer({
      classification: 'failed',
      actionability: 'required',
      headline: 'Run failed',
      detail: reasonDetail ?? 'The run reached a failed runtime state.',
      recommended_action: 'Inspect the failure detail and restart after resolving the cause',
      expected_transition: null,
      reason_code: reasonCode,
      reason_detail: reasonDetail
    });
  }

  if (input.state_class === 'blocked') {
    return buildExplainer({
      classification: 'blocked_input',
      actionability: 'required',
      headline: 'Run is blocked on operator input',
      detail: reasonDetail ?? 'The orchestrator paused this run until an operator resolves the blocking condition.',
      recommended_action: 'Review the blocked input details, provide input or resolve the conflict, then resume or cancel',
      expected_transition: null,
      reason_code: reasonCode,
      reason_detail: reasonDetail
    });
  }

  if (input.state_class === 'retrying') {
    return buildExplainer({
      classification: 'retrying',
      actionability: 'recommended',
      headline: 'Run is waiting to retry',
      detail: reasonDetail ?? 'The orchestrator scheduled an automatic retry after a recoverable stop.',
      recommended_action: 'Monitor the retry; intervene only if the same reason repeats',
      expected_transition: expectedTransition ?? 'Automatic retry at the scheduled due time',
      reason_code: reasonCode,
      reason_detail: reasonDetail
    });
  }

  if (input.stalled_waiting && input.stalled_waiting_reason === 'turn_waiting_threshold_exceeded') {
    return buildExplainer({
      classification: 'stalled_waiting',
      actionability: 'required',
      headline: 'Run is alive but waiting too long',
      detail: 'The run is still alive through codex.turn.waiting heartbeats after the configured wait threshold.',
      recommended_action: 'Inspect recent events and decide whether to resume/cancel/restart',
      expected_transition: null,
      reason_code: 'turn_waiting_threshold_exceeded',
      reason_detail: reasonDetail ?? 'codex.turn.waiting heartbeat loop exceeded threshold'
    });
  }

  if (input.awaiting_input) {
    return buildExplainer({
      classification: 'awaiting_input',
      actionability: 'required',
      headline: 'Run is awaiting operator input',
      detail: reasonDetail ?? 'Codex requested input that requires an operator response.',
      recommended_action: 'Open the issue detail and answer the pending input request',
      expected_transition: 'Run continues after input is submitted',
      reason_code: reasonCode ?? 'turn_input_required',
      reason_detail: reasonDetail
    });
  }

  return buildExplainer({
    classification: 'healthy',
    actionability: 'none',
    headline: 'Run is progressing',
    detail: reasonDetail,
    recommended_action: null,
    expected_transition: expectedTransition ?? 'Run continues until completion or a runtime signal changes state',
    reason_code: reasonCode,
    reason_detail: reasonDetail
  });
}
