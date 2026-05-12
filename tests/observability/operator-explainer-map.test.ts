import { describe, expect, it } from 'vitest';

import {
  explainOperatorRuntimeState,
  listOperatorExplainerReasonCodes,
  OPERATOR_EXPLAINER_VERSION,
  toOperatorExplainerHint
} from '../../src/observability/operator-explainer-map';
import {
  CANONICAL_REASON_CODE_REGISTRY,
  REASON_CODES,
  REASON_CODE_REGISTRY_VERSION,
  listReasonCodeDefinitions
} from '../../src/observability/reason-codes';

describe('operator explainer map', () => {
  it('exports a deterministic versioned locked-schema explainer', () => {
    const first = explainOperatorRuntimeState({
      state_class: 'running',
      reason_code: REASON_CODES.normalCompletion,
      reason_detail: 'codex turn completed: done'
    });
    const second = explainOperatorRuntimeState({
      state_class: 'running',
      reason_code: REASON_CODES.normalCompletion,
      reason_detail: 'codex turn completed: done'
    });

    expect(first.version).toBe(OPERATOR_EXPLAINER_VERSION);
    expect(Object.keys(first)).toEqual([
      'version',
      'registry_version',
      'classification',
      'actionability',
      'headline',
      'detail',
      'recommended_actions',
      'expected_transition',
      'reason_code',
      'reason_detail'
    ]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toMatchObject({
      registry_version: REASON_CODE_REGISTRY_VERSION,
      classification: 'healthy',
      actionability: 'none',
      headline: 'Run is progressing',
      reason_code: REASON_CODES.normalCompletion
    });
  });

  it('exhaustively exposes every canonical reason code to the explainer map', () => {
    const registryCodes = listReasonCodeDefinitions().map((definition) => definition.reason_code).sort();

    expect(listOperatorExplainerReasonCodes()).toEqual(registryCodes);
    for (const definition of listReasonCodeDefinitions()) {
      const explainer = explainOperatorRuntimeState({
        state_class: definition.classification === 'failed' ? 'failed' : definition.classification === 'blocked_input' ? 'blocked' : 'retrying',
        reason_code: definition.reason_code,
        reason_detail: 'custom detail'
      });

      expect(explainer).toMatchObject({
        registry_version: REASON_CODE_REGISTRY_VERSION,
        reason_code: definition.reason_code,
        classification: definition.classification,
        actionability: definition.actionability,
        headline: definition.headline,
        recommended_actions: definition.recommended_actions,
        reason_detail: 'custom detail'
      });
    }
  });

  it('keeps all registry entries on the locked explainer contract', () => {
    for (const [code, definition] of Object.entries(CANONICAL_REASON_CODE_REGISTRY)) {
      expect(definition.reason_code).toBe(code);
      expect(['none', 'recommended', 'required']).toContain(definition.actionability);
      expect(Array.isArray(definition.recommended_actions)).toBe(true);
      expect(definition.classification).toBeTruthy();
      expect(definition.headline).toBeTruthy();
    }
  });

  it('maps prolonged codex.turn.waiting heartbeat loops to action-required stalled waiting', () => {
    const explainer = explainOperatorRuntimeState({
      state_class: 'running',
      stalled_waiting: true,
      stalled_waiting_reason: 'turn_waiting_threshold_exceeded',
      reason_detail: 'codex.turn.waiting heartbeat loop exceeded threshold'
    });

    expect(explainer).toMatchObject({
      classification: 'stalled_waiting',
      actionability: 'required',
      headline: 'Run is alive but waiting too long',
      recommended_actions: ['Inspect issue diagnostics', 'Cancel the current turn', 'Requeue the run'],
      expected_transition:
        'Automatic recovery may schedule a retry; otherwise the operator can cancel the current turn or requeue.',
      reason_code: REASON_CODES.turnWaitingThresholdExceeded,
      reason_detail: 'codex.turn.waiting heartbeat loop exceeded threshold'
    });
  });

  it('maps awaiting input, retrying, blocked input, and failed states', () => {
    expect(
      explainOperatorRuntimeState({
        state_class: 'running',
        awaiting_input: true,
        reason_detail: 'request_user_input'
      })
    ).toMatchObject({
      classification: 'awaiting_input',
      actionability: 'required',
      reason_code: REASON_CODES.turnInputRequired
    });

    expect(
      explainOperatorRuntimeState({
        state_class: 'retrying',
        reason_code: 'worker_stalled',
        reason_detail: 'worker stalled',
        expected_transition_detail: 'Automatic retry at 2026-04-10T10:02:30.000Z'
      })
    ).toMatchObject({
      classification: 'retrying',
      actionability: 'recommended',
      expected_transition: 'Automatic retry at 2026-04-10T10:02:30.000Z',
      reason_code: REASON_CODES.workerStalled
    });

    expect(
      explainOperatorRuntimeState({
        state_class: 'blocked',
        reason_code: 'operator_action_required_workspace_conflict',
        reason_detail: 'workspace conflict'
      })
    ).toMatchObject({
      classification: 'blocked_input',
      actionability: 'required',
      reason_code: REASON_CODES.operatorWorkspaceConflict
    });

    expect(
      explainOperatorRuntimeState({
        state_class: 'failed',
        reason_code: 'worker_failed',
        reason_detail: 'terminal failure'
      })
    ).toMatchObject({
      classification: 'failed',
      actionability: 'required',
      reason_code: REASON_CODES.unknownRuntimeReason
    });
  });

  it('derives compact row hints from the full explainer', () => {
    const explainer = explainOperatorRuntimeState({
      state_class: 'blocked',
      reason_code: REASON_CODES.operatorWorkspaceConflict,
      reason_detail: 'operator input required'
    });

    expect(toOperatorExplainerHint(explainer)).toEqual({
      classification: 'blocked_input',
      actionability: 'required',
      headline: 'Run is blocked on operator input'
    });
  });
});
