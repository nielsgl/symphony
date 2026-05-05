import { describe, expect, it } from 'vitest';

import {
  deriveOperatorTransitions,
  formatBudgetStatusLabel,
  formatBudgetSummary,
  getActionRequiredLabel,
  isActionRequiredCode,
  summarizeActionRequired
} from '../../src/api/dashboard-view-model';

describe('dashboard view model', () => {
  it('summarizes action-required blocked reasons with grouped counts', () => {
    const summary = summarizeActionRequired([
      { stop_reason_code: 'operator_action_required_workspace_conflict' },
      { stop_reason_code: 'operator_action_required_workspace_conflict' },
      { stop_reason_code: 'awaiting_human_review_scope_incomplete' },
      { stop_reason_code: 'manual_resume' }
    ]);

    expect(summary.total).toBe(3);
    expect(summary.grouped).toEqual({
      operator_action_required_workspace_conflict: 2,
      awaiting_human_review_scope_incomplete: 1
    });
  });

  it('identifies supported action-required reason codes', () => {
    expect(isActionRequiredCode('operator_action_required_no_progress_redispatch_blocked')).toBe(true);
    expect(isActionRequiredCode('operator_action_required_budget_limit_exceeded')).toBe(true);
    expect(getActionRequiredLabel('awaiting_human_review_scope_incomplete')).toBe('Awaiting Human Review (Scope Incomplete)');
    expect(getActionRequiredLabel('attempt_terminated_budget_limit_exceeded')).toBe('Budget Limit Terminated Attempt');
    expect(isActionRequiredCode('manual_resume')).toBe(false);
  });

  it('formats operator-visible budget status without treating unavailable telemetry as zero', () => {
    expect(formatBudgetStatusLabel('hard_limited')).toBe('Hard limited');
    expect(
      formatBudgetSummary({
        budget_usage_tokens: 105,
        budget_limit_tokens: 100,
        budget_window_minutes: 1440,
        budget_status: 'hard_limited',
        budget_policy: 'block_requires_resume',
        budget_message: 'Budget hard limit exceeded. Continuation blocked until manual resume.'
      })
    ).toBe(
      'Budget: Hard limited | 105 / 100 tokens | window 1,440m | policy block_requires_resume | Budget hard limit exceeded. Continuation blocked until manual resume.'
    );
    expect(
      formatBudgetSummary({
        budget_usage_tokens: null,
        budget_limit_tokens: 100,
        budget_window_minutes: 60,
        budget_status: 'telemetry_unavailable',
        budget_policy: 'terminate_attempt'
      })
    ).toBe('Budget: Telemetry unavailable | usage unavailable | window 60m | policy terminate_attempt');
  });

  it('derives explicit operator transition entries from canonical events and blocked reason state', () => {
    const transitions = deriveOperatorTransitions({
      issueIdentifier: 'ABC-17',
      blockedStopReasonCode: 'awaiting_human_review_scope_incomplete',
      blockedStopReasonDetail: 'PR is open but scope is incomplete and no progress signal was detected',
      phaseTimeline: [
        {
          at: '2026-05-05T11:01:00.000Z',
          detail: 'completion gate blocked redispatch because no progress signal was detected'
        }
      ],
      recentEvents: [
        {
          at: '2026-05-05T11:02:00.000Z',
          event: 'orchestrator.redispatch.circuit_breaker_opened',
          message: 'respawn circuit breaker opened'
        },
        {
          at: '2026-05-05T11:03:00.000Z',
          message: 'resume accepted'
        },
        {
          at: '2026-05-05T11:04:00.000Z',
          message: 'resume rejected'
        },
        {
          at: '2026-05-05T11:05:00.000Z',
          message: 'cancel accepted'
        },
        {
          at: '2026-05-05T11:06:00.000Z',
          message: 'cancel rejected'
        }
      ]
    });

    expect(transitions.map((entry) => entry.label)).toEqual([
      'Completion Gate Blocked',
      'Circuit Breaker Opened',
      'Resume Accepted',
      'Resume Rejected',
      'Cancel Accepted',
      'Cancel Rejected',
      'Completion Gate Blocked'
    ]);
    expect(transitions[1]).toMatchObject({
      issue_identifier: 'ABC-17',
      result: 'failure',
      label: 'Circuit Breaker Opened'
    });
  });
});
