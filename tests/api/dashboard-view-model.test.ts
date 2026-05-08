import { describe, expect, it } from 'vitest';

import {
  buildStoppedRunRecoveryEntries,
  deriveOperatorTransitions,
  formatBudgetStatusLabel,
  formatBudgetSummary,
  getActionRequiredLabel,
  isActionRequiredCode,
  summarizeActionRequired
} from '../../src/api/dashboard-view-model';
import { REASON_CODES } from '../../src/observability/reason-codes';

describe('dashboard view model', () => {
  it('returns an empty stopped-run recovery view when durable history has no stopped terminal runs', () => {
    expect(buildStoppedRunRecoveryEntries({ runs: [] })).toEqual([]);
    expect(
      buildStoppedRunRecoveryEntries({
        runs: [
          {
            run_id: 'run-active',
            issue_id: 'issue-active',
            issue_identifier: 'ABC-ACTIVE',
            started_at: '2026-04-10T10:00:00.000Z',
            ended_at: null,
            completed_at: null,
            terminal_status: null,
            error_code: null,
            terminal_reason_code: null,
            terminal_reason_detail: null,
            root_cause_status: null,
            root_cause_reason_code: null,
            root_cause_reason_detail: null,
            root_cause_at: null,
            session_id: null,
            thread_id: null,
            turn_id: null,
            session_ids: []
          }
        ]
      })
    ).toEqual([]);
  });

  it('projects a hidden stopped NIE-68-style cancellation with terminal and root-cause reasons separated', () => {
    const entries = buildStoppedRunRecoveryEntries({
      runs: [
        {
          run_id: 'run-nie-68',
          issue_id: 'issue-nie-68',
          issue_identifier: 'NIE-68',
          started_at: '2026-05-05T10:00:00.000Z',
          ended_at: '2026-05-05T10:10:00.000Z',
          completed_at: '2026-05-05T10:10:00.000Z',
          terminal_status: 'cancelled',
          error_code: 'non_active_state_transition',
          terminal_reason_code: 'non_active_state_transition',
          terminal_reason_detail: 'Issue left active states during reconciliation.',
          root_cause_status: 'blocked',
          root_cause_reason_code: REASON_CODES.missingToolOutput,
          root_cause_reason_detail: 'missing Codex tool output for call_123',
          root_cause_at: '2026-05-05T10:05:00.000Z',
          session_id: 'session-nie-68',
          thread_id: 'thread-nie-68',
          turn_id: 'turn-nie-68',
          session_ids: ['session-nie-68']
        }
      ]
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      run_id: 'run-nie-68',
      issue_identifier: 'NIE-68',
      terminal_status: 'cancelled',
      terminal_reason_code: 'non_active_state_transition',
      root_cause_reason_code: REASON_CODES.missingToolOutput,
      root_cause_reason_detail: 'missing Codex tool output for call_123',
      recovery_status: 'inspect_forensics',
      resume_valid: false,
      thread_id: 'thread-nie-68',
      session_id: 'session-nie-68',
      last_relevant_at: '2026-05-05T10:05:00.000Z'
    });
    expect(entries[0]?.actions.inspect_forensics_url).toBe('/api/v1/issues/NIE-68/forensics/export');
    expect(entries[0]?.actions.inspect_thread_url).toBe('/api/v1/history/threads/thread-nie-68');
    expect(entries[0]?.resume_disabled_reason).toContain('No active blocked run');
  });

  it('orders multiple stopped runs by root-cause or terminal timestamp', () => {
    const entries = buildStoppedRunRecoveryEntries({
      runs: [
        {
          run_id: 'run-old',
          issue_id: 'issue-old',
          issue_identifier: 'ABC-OLD',
          started_at: '2026-04-10T10:00:00.000Z',
          ended_at: '2026-04-10T10:10:00.000Z',
          completed_at: '2026-04-10T10:10:00.000Z',
          terminal_status: 'failed',
          error_code: 'failure',
          terminal_reason_code: 'failure',
          terminal_reason_detail: null,
          root_cause_status: null,
          root_cause_reason_code: null,
          root_cause_reason_detail: null,
          root_cause_at: null,
          session_id: null,
          thread_id: null,
          turn_id: null,
          session_ids: []
        },
        {
          run_id: 'run-new',
          issue_id: 'issue-new',
          issue_identifier: 'ABC-NEW',
          started_at: '2026-04-10T11:00:00.000Z',
          ended_at: '2026-04-10T11:10:00.000Z',
          completed_at: '2026-04-10T11:10:00.000Z',
          terminal_status: 'cancelled',
          error_code: 'non_active_state_transition',
          terminal_reason_code: 'non_active_state_transition',
          terminal_reason_detail: null,
          root_cause_status: 'blocked',
          root_cause_reason_code: REASON_CODES.turnWaitingThresholdExceeded,
          root_cause_reason_detail: null,
          root_cause_at: '2026-04-10T11:12:00.000Z',
          session_id: null,
          thread_id: null,
          turn_id: null,
          session_ids: []
        }
      ]
    });

    expect(entries.map((entry) => entry.run_id)).toEqual(['run-new', 'run-old']);
  });

  it('marks stopped runs related to active blocked issues and gates resume on capability mismatch', () => {
    const entries = buildStoppedRunRecoveryEntries({
      runs: [
        {
          run_id: 'run-active-blocked',
          issue_id: 'issue-active-blocked',
          issue_identifier: 'ABC-BLOCKED',
          started_at: '2026-04-10T10:00:00.000Z',
          ended_at: '2026-04-10T10:10:00.000Z',
          completed_at: '2026-04-10T10:10:00.000Z',
          terminal_status: 'cancelled',
          error_code: 'non_active_state_transition',
          terminal_reason_code: 'non_active_state_transition',
          terminal_reason_detail: null,
          root_cause_status: 'blocked',
          root_cause_reason_code: REASON_CODES.missingToolOutput,
          root_cause_reason_detail: null,
          root_cause_at: null,
          session_id: 'session-active',
          thread_id: 'thread-active',
          turn_id: 'turn-active',
          session_ids: ['session-active']
        },
        {
          run_id: 'run-mismatch',
          issue_id: 'issue-mismatch',
          issue_identifier: 'ABC-MISMATCH',
          started_at: '2026-04-10T10:00:00.000Z',
          ended_at: '2026-04-10T10:10:00.000Z',
          completed_at: '2026-04-10T10:10:00.000Z',
          terminal_status: 'cancelled',
          error_code: 'non_active_state_transition',
          terminal_reason_code: 'non_active_state_transition',
          terminal_reason_detail: null,
          root_cause_status: 'blocked',
          root_cause_reason_code: REASON_CODES.missingToolOutput,
          root_cause_reason_detail: null,
          root_cause_at: null,
          session_id: 'session-mismatch',
          thread_id: 'thread-mismatch',
          turn_id: 'turn-mismatch',
          session_ids: ['session-mismatch']
        }
      ],
      activeIssueIdentifiers: new Set(['ABC-BLOCKED', 'ABC-MISMATCH']),
      blockedIssueIdentifiers: new Set(['ABC-BLOCKED', 'ABC-MISMATCH']),
      capabilityWarningsByThreadId: new Map([
        [
          'thread-mismatch',
          [
            {
              reason_code: 'unsupported_dynamic_tool_console_resume',
              source_environment: 'console_tui',
              attempted_tool_name: 'linear_graphql',
              call_id: 'call_1',
              thread_id: 'thread-mismatch',
              turn_id: 'turn-mismatch',
              unsupported_capability_message: 'Dynamic tools are unavailable.',
              recommended_recovery_action: 'Use a native runtime continuation.'
            }
          ]
        ]
      ])
    });

    expect(entries.find((entry) => entry.run_id === 'run-active-blocked')).toMatchObject({
      active_issue_present: true,
      recovery_status: 'resume_available',
      resume_valid: true,
      actions: {
        resume_url: '/api/v1/issues/ABC-BLOCKED/resume'
      }
    });
    expect(entries.find((entry) => entry.run_id === 'run-mismatch')).toMatchObject({
      active_issue_present: true,
      capability_mismatch: true,
      recovery_status: 'capability_mismatch',
      resume_valid: false,
      actions: {
        resume_url: null
      }
    });
  });

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
    expect(isActionRequiredCode(REASON_CODES.missingToolOutput)).toBe(true);
    expect(getActionRequiredLabel(REASON_CODES.missingToolOutput)).toBe('Missing Tool Output');
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
