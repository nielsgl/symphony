import { describe, expect, it } from 'vitest';

import {
  explainOperatorRuntimeState,
  OPERATOR_EXPLAINER_VERSION,
  toOperatorExplainerHint
} from '../../src/observability/operator-explainer-map';

describe('operator explainer map', () => {
  it('exports a deterministic versioned locked-schema explainer', () => {
    const first = explainOperatorRuntimeState({
      state_class: 'running',
      reason_code: 'codex.turn.completed',
      reason_detail: 'codex turn completed: done'
    });
    const second = explainOperatorRuntimeState({
      state_class: 'running',
      reason_code: 'codex.turn.completed',
      reason_detail: 'codex turn completed: done'
    });

    expect(first.version).toBe(OPERATOR_EXPLAINER_VERSION);
    expect(Object.keys(first)).toEqual([
      'version',
      'classification',
      'actionability',
      'headline',
      'detail',
      'recommended_action',
      'expected_transition',
      'reason_code',
      'reason_detail'
    ]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toMatchObject({
      classification: 'healthy',
      actionability: 'none',
      headline: 'Run is progressing'
    });
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
      recommended_action: 'Inspect recent events and decide whether to resume/cancel/restart',
      expected_transition: null,
      reason_code: 'turn_waiting_threshold_exceeded',
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
      reason_code: 'turn_input_required'
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
      reason_code: 'worker_stalled'
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
      reason_code: 'operator_action_required_workspace_conflict'
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
      reason_code: 'worker_failed'
    });
  });

  it('derives compact row hints from the full explainer', () => {
    const explainer = explainOperatorRuntimeState({
      state_class: 'blocked',
      reason_code: 'turn_input_required',
      reason_detail: 'operator input required'
    });

    expect(toOperatorExplainerHint(explainer)).toEqual({
      classification: 'blocked_input',
      actionability: 'required',
      headline: 'Run is blocked on operator input'
    });
  });
});
