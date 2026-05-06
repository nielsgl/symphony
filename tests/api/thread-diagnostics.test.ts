import { describe, expect, it } from 'vitest';

import { classifyThreadBlocker } from '../../src/api';

describe('thread diagnostics blocker classification', () => {
  it.each([
    [
      'tool_waiting_long',
      'recommended',
      {
        reason_code: 'turn_waiting_threshold_exceeded',
        reason_detail: 'codex.turn.waiting heartbeat loop exceeded threshold',
        stalled_waiting: true
      }
    ],
    [
      'tracker_transition_pending',
      'recommended',
      {
        reason_code: 'tracker_transition_failed',
        reason_detail: 'tracker transition pending'
      }
    ],
    [
      'input_required_pending',
      'required',
      {
        reason_code: 'turn_input_required',
        reason_detail: 'operator input required',
        has_pending_input: true
      }
    ],
    [
      'codex_no_progress',
      'recommended',
      {
        reason_code: 'operator_action_required_no_progress_redispatch_blocked',
        reason_detail: 'no progress observed'
      }
    ],
    [
      'workspace_integrity_conflict',
      'required',
      {
        reason_code: 'workspace_integrity_failed',
        reason_detail: 'workspace conflict detected',
        has_conflict_files: true
      }
    ],
    [
      'retry_backoff_wait',
      'none',
      {
        reason_code: 'worker_stalled',
        reason_detail: 'retry scheduled',
        retrying: true
      }
    ]
  ])('classifies %s deterministically with locked actionability %s', (classification, actionability, input) => {
    const blocker = classifyThreadBlocker(input);

    expect(blocker).toMatchObject({
      classification,
      reason_code: input.reason_code,
      reason_detail: input.reason_detail,
      actionability
    });
    expect(['none', 'recommended', 'required']).toContain(blocker?.actionability);
    expect(blocker?.recommended_actions.length).toBeGreaterThan(0);
    expect(blocker).toHaveProperty('time_since_progress');
    expect(blocker).toHaveProperty('expected_auto_transition');
  });
});
