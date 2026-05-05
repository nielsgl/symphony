import {
  CANONICAL_REASON_CODE_REGISTRY,
  getReasonCodeDefinition,
  isReasonCode,
  REASON_CODES,
  REASON_CODE_REGISTRY_VERSION,
  requireReasonCodeDefinition,
  type ReasonCode,
  type ReasonCodeActionability,
  type ReasonCodeClassification
} from './reason-codes';

export const OPERATOR_EXPLAINER_VERSION = '2026-05-05.v2';

export type OperatorExplainerClassification = ReasonCodeClassification;
export type OperatorExplainerActionability = ReasonCodeActionability;

export interface OperatorExplainer {
  version: string;
  registry_version: string;
  classification: OperatorExplainerClassification;
  actionability: OperatorExplainerActionability;
  headline: string;
  detail: string | null;
  recommended_actions: string[];
  expected_transition: string | null;
  reason_code: ReasonCode;
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
  stalled_waiting_reason?: typeof REASON_CODES.turnWaitingThresholdExceeded | null;
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

function fallbackReasonCodeForState(input: OperatorExplainerInput): ReasonCode {
  if (input.stalled_waiting && input.stalled_waiting_reason === REASON_CODES.turnWaitingThresholdExceeded) {
    return REASON_CODES.turnWaitingThresholdExceeded;
  }
  if (input.awaiting_input) {
    return REASON_CODES.turnInputRequired;
  }
  switch (input.state_class) {
    case 'running':
      return REASON_CODES.normalCompletion;
    case 'retrying':
      return REASON_CODES.workerExitAbnormal;
    case 'blocked':
      return REASON_CODES.turnInputRequired;
    case 'failed':
      return REASON_CODES.unknownRuntimeReason;
  }
}

function resolveReasonCode(input: OperatorExplainerInput): ReasonCode {
  const reasonCode = normalized(input.reason_code);
  if (reasonCode) {
    return isReasonCode(reasonCode) ? reasonCode : REASON_CODES.unknownRuntimeReason;
  }
  return fallbackReasonCodeForState(input);
}

export function toOperatorExplainerHint(explainer: OperatorExplainer): OperatorExplainerHint {
  return {
    classification: explainer.classification,
    actionability: explainer.actionability,
    headline: explainer.headline
  };
}

export function explainOperatorRuntimeState(input: OperatorExplainerInput): OperatorExplainer {
  const reasonCode = resolveReasonCode(input);
  const definition = requireReasonCodeDefinition(reasonCode);
  const reasonDetail = normalized(input.reason_detail);
  const expectedTransition = normalized(input.expected_transition_detail);

  return {
    version: OPERATOR_EXPLAINER_VERSION,
    registry_version: REASON_CODE_REGISTRY_VERSION,
    classification: definition.classification,
    actionability: definition.actionability,
    headline: definition.headline,
    detail: reasonDetail ?? definition.detail,
    recommended_actions: [...definition.recommended_actions],
    expected_transition: expectedTransition ?? definition.expected_transition,
    reason_code: definition.reason_code as ReasonCode,
    reason_detail: reasonDetail
  };
}

export function listOperatorExplainerReasonCodes(): ReasonCode[] {
  return Object.keys(CANONICAL_REASON_CODE_REGISTRY).sort() as ReasonCode[];
}
