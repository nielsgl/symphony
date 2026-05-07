import { describe, expect, it } from 'vitest';

import { SnapshotService } from '../../src/api';
import type { OrchestratorState } from '../../src/orchestrator';
import { CANONICAL_EVENT } from '../../src/observability/events';
import { REASON_CODES } from '../../src/observability/reason-codes';
import type { Issue } from '../../src/tracker';

function makeRunningEntry(overrides: Record<string, unknown> = {}) {
  return {
    issue: makeIssue(),
    identifier: 'ABC-1',
    run_id: 'run-1',
    worker_handle: {},
    monitor_handle: {},
    retry_attempt: 0,
    workspace_path: '/tmp/symphony/ABC-1',
    provisioner_type: 'none',
    branch_name: null,
    repo_root: null,
    workspace_exists: true,
    workspace_git_status: 'unknown' as const,
    workspace_provisioned: false,
    workspace_is_git_worktree: false,
    session_id: 'thread-1-turn-3',
    thread_id: 'thread-1',
    turn_id: 'turn-3',
    codex_app_server_pid: '12345',
    turn_count: 3,
    last_event: CANONICAL_EVENT.codex.turnCompleted,
    last_event_summary: 'codex turn completed: done',
    last_message: 'done',
    awaiting_input_since_ms: null,
    pending_input_preview: null,
    stalled_waiting_since_ms: null,
    stalled_waiting_reason: null,
    tokens: {
      input_tokens: 11,
      output_tokens: 5,
      total_tokens: 16
    },
    last_reported_tokens: {
      input_tokens: 11,
      output_tokens: 5,
      total_tokens: 16
    },
    token_telemetry_status: 'available' as const,
    token_telemetry_last_source: 'terminal_turn_summary',
    token_telemetry_last_at_ms: Date.parse('2026-04-10T10:01:00.000Z'),
    token_telemetry_turn_started_at_ms: Date.parse('2026-04-10T10:01:00.000Z'),
    token_telemetry_warning_emitted: false,
    recent_events: [
      {
        at_ms: Date.parse('2026-04-10T10:01:00.000Z'),
        event: CANONICAL_EVENT.codex.turnCompleted,
        message: 'done'
      }
    ],
    started_at_ms: Date.parse('2026-04-10T10:01:00.000Z'),
    last_codex_timestamp_ms: Date.parse('2026-04-10T10:01:00.000Z'),
    ...overrides
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    identifier: 'ABC-1',
    title: 'Issue ABC-1',
    description: null,
    priority: 1,
    state: 'In Progress',
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: new Date('2026-04-10T10:00:00.000Z'),
    updated_at: new Date('2026-04-10T10:00:00.000Z'),
    ...overrides
  };
}

function makeState(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
    poll_interval_ms: 30_000,
    max_concurrent_agents: 10,
    running: new Map(),
    claimed: new Set(),
    retry_attempts: new Map(),
    blocked_inputs: new Map(),
    circuit_breakers: new Map(),
    budget_usage_samples: new Map(),
    completed: new Set(),
    codex_totals: {
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
      seconds_running: 40
    },
    codex_rate_limits: null,
    health: {
      dispatch_validation: 'ok',
      last_error: null
    },
    throughput: {
      current_tps: 0,
      avg_tps_60s: 0,
      window_seconds: 600,
      sparkline_10m: Array.from({ length: 24 }, () => 0),
      sample_count: 0
    },
    recent_runtime_events: [],
    ...overrides
  };
}

describe('SnapshotService', () => {
  it('projects orchestrator state into API state contract and includes active runtime seconds', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:02:00.000Z')
    });

    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            last_codex_timestamp_ms: null,
            tool_call_ledger: {
              'call-api-1': {
                call_id: 'call-api-1',
                tool_name: 'linear_graphql',
                thread_id: 'thread-1',
                turn_id: 'turn-3',
                session_id: 'thread-1-turn-3',
                issue_id: 'issue-1',
                issue_identifier: 'ABC-1',
                run_id: 'run-1',
                issue_run_id: 'issue-run-1',
                attempt_id: 'attempt-1',
                first_seen_at_ms: Date.parse('2026-04-10T10:01:05.000Z'),
                last_seen_at_ms: Date.parse('2026-04-10T10:01:07.000Z'),
                completed_at_ms: Date.parse('2026-04-10T10:01:07.000Z'),
                completion_status: 'completed',
                evidence_sources: ['app_server_protocol', 'worker_event'],
                start_evidence_source: 'app_server_protocol',
                completion_evidence_source: 'worker_event',
                last_agent_message: 'waiting for linear_graphql output'
              }
            }
          })
        ]
      ]),
      retry_attempts: new Map([
        [
          'issue-2',
          {
            issue_id: 'issue-2',
            identifier: 'ABC-2',
            attempt: 1,
            due_at_ms: Date.parse('2026-04-10T10:02:30.000Z'),
            error: 'retrying',
            worker_host: 'build-1',
            workspace_path: '/tmp/symphony/ABC-2',
            provisioner_type: 'worktree',
            branch_name: 'feature/ABC-2',
            repo_root: '/tmp/source',
            workspace_exists: true,
            workspace_git_status: 'clean',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: 'turn_input_required',
            stop_reason_detail: 'tool requestUserInput could not be auto-answered',
            previous_thread_id: 'thread-prev',
            previous_session_id: 'thread-prev-turn-prev',
            timer_handle: {}
          }
        ]
      ])
    });

    const projected = service.projectState(state);
    expect(projected.counts.running).toBe(1);
    expect(projected.counts.blocked).toBe(0);
    expect(projected.counts.running_stalled_waiting_count).toBe(0);
    expect(projected.counts.running_awaiting_input_count).toBe(0);
    expect(projected.codex_totals.seconds_running).toBe(100);
    expect(projected.health.dispatch_validation).toBe('ok');
    expect(projected.running[0]?.session_id).toBe('thread-1-turn-3');
    expect(projected.running[0]?.thread_id).toBe('thread-1');
    expect(projected.running[0]?.turn_id).toBe('turn-3');
    expect(projected.running[0]?.codex_app_server_pid).toBe('12345');
    expect(projected.running[0]?.last_event_summary).toBe('codex turn completed: done');
    expect(projected.running[0]?.turn_count).toBe(3);
    expect(projected.running[0]?.awaiting_input).toBe(false);
    expect(projected.running[0]?.pending_input_preview).toBeNull();
    expect(projected.running[0]?.stalled_waiting).toBe(false);
    expect(projected.running[0]?.operator_explainer_hint).toEqual({
      classification: 'healthy',
      actionability: 'none',
      headline: 'Run is progressing'
    });
    expect(projected.running[0]?.workspace_path).toBe('/tmp/symphony/ABC-1');
    expect(projected.running[0]?.token_telemetry_status).toBe('available');
    expect(projected.running[0]?.token_telemetry_last_source).toBe('terminal_turn_summary');
    expect(projected.running[0]?.token_telemetry_last_at_ms).toBe(Date.parse('2026-04-10T10:01:00.000Z'));
    expect(projected.snapshot_generated_at_ms).toBe(Date.parse('2026-04-10T10:02:00.000Z'));
    expect(projected.snapshot_age_ms).toBe(0);
    expect(projected.snapshot_freshness_state).toBe('fresh');
    expect(projected.api_degraded_mode).toBe(false);
    expect(projected.running[0]?.turn_control_state).toBe('agent_turn');
    expect(projected.running[0]?.progress_signal_state).toBe('advancing');
    expect(projected.running[0]?.token_telemetry_confidence).toBe('observed_live');
    expect(projected.running[0]?.budget_status).toBe('ok');
    expect(projected.running[0]?.budget_usage_tokens).toBeNull();
    expect(projected.running[0]?.tool_call_ledger).toEqual([
      {
        call_id: 'call-api-1',
        tool_name: 'linear_graphql',
        thread_id: 'thread-1',
        turn_id: 'turn-3',
        session_id: 'thread-1-turn-3',
        issue_id: 'issue-1',
        issue_identifier: 'ABC-1',
        run_id: 'run-1',
        issue_run_id: 'issue-run-1',
        attempt_id: 'attempt-1',
        first_seen_at: '2026-04-10T10:01:05.000Z',
        first_seen_at_ms: Date.parse('2026-04-10T10:01:05.000Z'),
        last_seen_at: '2026-04-10T10:01:07.000Z',
        last_seen_at_ms: Date.parse('2026-04-10T10:01:07.000Z'),
        completed_at: '2026-04-10T10:01:07.000Z',
        completed_at_ms: Date.parse('2026-04-10T10:01:07.000Z'),
        completion_status: 'completed',
        evidence_sources: ['app_server_protocol', 'worker_event'],
        start_evidence_source: 'app_server_protocol',
        completion_evidence_source: 'worker_event',
        last_agent_message: 'waiting for linear_graphql output'
      }
    ]);
    expect(projected.retrying[0]?.worker_host).toBe('build-1');
    expect(projected.retrying[0]?.workspace_path).toBe('/tmp/symphony/ABC-2');
    expect(projected.retrying[0]?.stop_reason_code).toBe('turn_input_required');
  });

  it('computes snapshot freshness from the source snapshot timestamp', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:02:40.000Z')
    });

    const projected = service.projectState(
      makeState({
        snapshot_generated_at_ms: Date.parse('2026-04-10T10:02:00.000Z')
      })
    );

    expect(projected.snapshot_generated_at_ms).toBe(Date.parse('2026-04-10T10:02:00.000Z'));
    expect(projected.snapshot_age_ms).toBe(40_000);
    expect(projected.snapshot_freshness_state).toBe('stale');
  });

  it('projects additive budget fields for running and blocked rows', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:05:00.000Z')
    });
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            budget: {
              budget_usage_tokens: 80,
              budget_limit_tokens: 100,
              budget_window_minutes: 1440,
              budget_status: 'warning',
              budget_policy: 'block_requires_resume',
              budget_message: null
            }
          })
        ]
      ]),
      blocked_inputs: new Map([
        [
          'issue-2',
          {
            issue_id: 'issue-2',
            issue_identifier: 'ABC-2',
            attempt: 1,
            worker_host: null,
            workspace_path: null,
            provisioner_type: null,
            branch_name: null,
            repo_root: null,
            workspace_exists: false,
            workspace_git_status: null,
            workspace_provisioned: false,
            workspace_is_git_worktree: false,
            stop_reason_code: 'operator_action_required_budget_limit_exceeded',
            stop_reason_detail: 'Budget hard limit exceeded. Continuation blocked until manual resume.',
            conflict_files: [],
            resolution_hints: [],
            previous_thread_id: null,
            previous_session_id: null,
            blocked_at_ms: Date.parse('2026-04-10T10:04:00.000Z'),
            requires_manual_resume: true,
            budget: {
              budget_usage_tokens: 105,
              budget_limit_tokens: 100,
              budget_window_minutes: 1440,
              budget_status: 'hard_limited',
              budget_policy: 'block_requires_resume',
              budget_message: 'Budget hard limit exceeded. Continuation blocked until manual resume.'
            }
          }
        ]
      ])
    });

    const projected = service.projectState(state);
    expect(projected.running[0]).toMatchObject({
      budget_usage_tokens: 80,
      budget_limit_tokens: 100,
      budget_window_minutes: 1440,
      budget_status: 'warning',
      budget_policy: 'block_requires_resume'
    });
    expect(projected.blocked[0]).toMatchObject({
      budget_usage_tokens: 105,
      budget_status: 'hard_limited',
      budget_message: 'Budget hard limit exceeded. Continuation blocked until manual resume.'
    });

    const issue = service.projectIssue(state, 'ABC-2');
    expect(issue.blocked).toMatchObject({
      budget_usage_tokens: 105,
      budget_status: 'hard_limited',
      budget_policy: 'block_requires_resume'
    });
  });

  it('projects running awaiting-input and stalled-waiting fields with redacted preview', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:05:00.000Z')
    });
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            awaiting_input_since_ms: Date.parse('2026-04-10T10:04:00.000Z'),
            pending_input_preview: {
              type: 'turn_input_required',
              prompt_preview: 'email admin@example.com api_key=abc123',
              option_count: 2
            },
            stalled_waiting_since_ms: Date.parse('2026-04-10T10:03:00.000Z'),
            stalled_waiting_reason: 'turn_waiting_threshold_exceeded',
            last_progress_transition_at_ms: Date.parse('2026-04-10T10:04:00.000Z')
          })
        ]
      ])
    });
    const projected = service.projectState(state);
    expect(projected.running[0]?.awaiting_input).toBe(true);
    expect(projected.running[0]?.awaiting_input_since_ms).toBe(Date.parse('2026-04-10T10:04:00.000Z'));
    expect(projected.running[0]?.pending_input_preview?.prompt_preview).toContain('***REDACTED***');
    expect(projected.running[0]?.stalled_waiting).toBe(true);
    expect(projected.running[0]?.stalled_waiting_reason).toBe('turn_waiting_threshold_exceeded');
    expect(projected.running[0]?.turn_control_state).toBe('operator_turn');
    expect(projected.running[0]?.progress_signal_state).toBe('stalled_waiting');
    expect(projected.running[0]?.not_blocked_explainer_code).toBe('awaiting_classifier_transition');
    expect(projected.counts.running_stalled_waiting_count).toBe(1);
    expect(projected.counts.running_awaiting_input_count).toBe(0);
    expect(projected.running[0]?.operator_explainer_hint).toEqual({
      classification: 'stalled_waiting',
      actionability: 'required',
      headline: 'Run is alive but waiting too long'
    });
    expect(projected.running[0]?.current_blocker_class).toBe('stalled_waiting');
    expect(projected.running[0]?.time_since_progress).toBe(60000);
    expect(projected.running[0]?.last_successful_step).toBe('codex.turn.completed: done');

    const issue = service.projectIssue(state, 'ABC-1');
    expect(issue.operator_explainer).toMatchObject({
      version: expect.any(String),
      classification: 'stalled_waiting',
      actionability: 'required',
      headline: 'Run is alive but waiting too long',
      detail: expect.any(String),
      recommended_actions: ['Inspect recent events and decide whether to resume, cancel, or restart'],
      expected_transition: null,
      reason_code: 'turn_waiting_threshold_exceeded',
      reason_detail: 'codex.turn.waiting heartbeat loop exceeded threshold'
    });
    expect(JSON.stringify(issue.operator_explainer)).toBe(JSON.stringify(service.projectIssue(state, 'ABC-1').operator_explainer));
  });

  it('projects active long-running waiting turns with fresh thread activity as heartbeat-only without stalled-waiting blockers', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:06:30.000Z')
    });
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            last_event: CANONICAL_EVENT.codex.turnWaiting,
            last_event_summary: 'codex turn waiting: waiting_for_turn_completion elapsed_s=390',
            last_message: 'waiting_for_turn_completion elapsed_s=390',
            running_waiting_started_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
            last_heartbeat_at_ms: Date.parse('2026-04-10T10:06:30.000Z'),
            last_codex_timestamp_ms: Date.parse('2026-04-10T10:06:30.000Z'),
            last_progress_transition_at_ms: Date.parse('2026-04-10T10:06:30.000Z'),
            stalled_waiting_since_ms: Date.parse('2026-04-10T10:11:00.000Z'),
            stalled_waiting_reason: null,
            tokens: {
              input_tokens: 20,
              output_tokens: 15,
              total_tokens: 35
            },
            last_reported_tokens: {
              input_tokens: 20,
              output_tokens: 15,
              total_tokens: 35
            },
            recent_events: [
              {
                at_ms: Date.parse('2026-04-10T10:06:30.000Z'),
                event: CANONICAL_EVENT.codex.turnWaiting,
                message: 'waiting_for_turn_completion elapsed_s=390'
              }
            ]
          })
        ]
      ])
    });

    const projected = service.projectState(state);

    expect(projected.running[0]?.stalled_waiting).toBe(false);
    expect(projected.running[0]?.stalled_waiting_since_ms).toBeNull();
    expect(projected.running[0]?.stalled_waiting_reason).toBeNull();
    expect(projected.running[0]?.progress_signal_state).toBe('heartbeat_only');
    expect(projected.counts.running_stalled_waiting_count).toBe(0);
    expect(projected.running[0]?.operator_explainer_hint?.classification).not.toBe('stalled_waiting');

    const issue = service.projectIssue(state, 'ABC-1');
    expect(issue.operator_explainer).toMatchObject({
      classification: 'healthy',
      actionability: 'none'
    });
    expect(issue.operator_explainer.reason_detail).not.toBe('codex.turn.waiting heartbeat loop exceeded threshold');
  });

  it('truncates pending input previews by UTF-8 characters after redaction', () => {
    const service = new SnapshotService();
    const prompt = `${'界'.repeat(170)} operator@example.com`;
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            awaiting_input_since_ms: Date.parse('2026-04-10T10:04:00.000Z'),
            pending_input_preview: {
              type: 'turn_input_required',
              prompt_preview: prompt,
              option_count: 1
            }
          })
        ]
      ])
    });

    const projected = service.projectState(state);
    const preview = projected.running[0]?.pending_input_preview?.prompt_preview ?? '';
    expect(Array.from(preview)).toHaveLength(160);
    expect(preview).toBe('界'.repeat(160));
    expect(preview).not.toContain('operator@example.com');

    const issue = service.projectIssue(state, 'ABC-1');
    const issuePreview = issue.running?.pending_input_preview?.prompt_preview ?? '';
    expect(Array.from(issuePreview)).toHaveLength(160);
    expect(issuePreview).toBe('界'.repeat(160));
  });

  it('throws issue_not_found for unknown issue projection', () => {
    const service = new SnapshotService();
    const state = makeState();

    expect(() => service.projectIssue(state, 'ABC-404')).toThrow('Issue ABC-404 is not in runtime state');
  });

  it('projects blocked issue payload with blocked status and details', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:05:00.000Z')
    });
    const state = makeState({
      blocked_inputs: new Map([
        [
          'issue-9',
          {
            issue_id: 'issue-9',
            issue_identifier: 'ABC-9',
            attempt: 4,
            worker_host: 'build-9',
            workspace_path: '/tmp/symphony/ABC-9',
            provisioner_type: 'worktree',
            branch_name: 'feature/ABC-9',
            repo_root: '/tmp/source',
            workspace_exists: true,
            workspace_git_status: 'clean',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: 'operator_action_required_workspace_conflict',
            stop_reason_detail: 'workspace_unprovisioned_conflict: worktree_branch_conflict',
            conflict_files: [{ path: 'src/orchestrator/core.ts', status: 'unstaged' }],
            resolution_hints: ['Resolve branch/worktree mismatch before manual resume.'],
            previous_thread_id: 'thread-prev',
            previous_session_id: 'thread-prev-turn-prev',
            blocked_at_ms: Date.parse('2026-04-10T10:04:00.000Z'),
            requires_manual_resume: true,
            pending_input: null,
            session_console: []
          }
        ]
      ])
    });

    const projected = service.projectIssue(state, 'ABC-9');
    expect(projected.status).toBe('blocked');
    expect(projected.retry).toBeNull();
    expect(projected.blocked).toMatchObject({
      stop_reason_code: 'operator_action_required_workspace_conflict',
      progress_signal_state: 'advancing',
      previous_session_id: 'thread-prev-turn-prev',
      requires_manual_resume: true,
      conflict_files: [{ path: 'src/orchestrator/core.ts', status: 'unstaged' }]
    });
  });

  it('projects missing-tool-output blocked diagnostics as actionable API data', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:05:00.000Z')
    });
    const state = makeState({
      blocked_inputs: new Map([
        [
          'issue-tool',
          {
            issue_id: 'issue-tool',
            issue_identifier: 'ABC-TOOL',
            attempt: 1,
            worker_host: null,
            workspace_path: null,
            provisioner_type: null,
            branch_name: null,
            repo_root: null,
            workspace_exists: true,
            workspace_git_status: 'clean',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: REASON_CODES.missingToolOutput,
            stop_reason_detail:
              'tool_name=linear_graphql call_id=call_pfKTUH5GFubLHpXfln7UScnU thread_id=thread-1 turn_id=turn-1 session_id=session-1 elapsed_wait_ms=2000',
            conflict_files: [],
            resolution_hints: ['Inspect the Codex thread', 'Resume the blocked run', 'Cancel the blocked run'],
            previous_thread_id: 'thread-1',
            previous_session_id: 'session-1',
            blocked_at_ms: Date.parse('2026-04-10T10:04:00.000Z'),
            requires_manual_resume: true,
            pending_input: null,
            tool_output_wait: {
              tool_name: 'linear_graphql',
              call_id: 'call_pfKTUH5GFubLHpXfln7UScnU',
              thread_id: 'thread-1',
              turn_id: 'turn-1',
              session_id: 'session-1',
              elapsed_wait_ms: 2000,
              last_agent_message: 'waiting for linear_graphql output',
              recommended_actions: ['Inspect the Codex thread', 'Resume the blocked run', 'Cancel the blocked run']
            },
            session_console: []
          }
        ]
      ])
    });

    const stateProjection = service.projectState(state);
    expect(stateProjection.counts.blocked).toBe(1);
    expect(stateProjection.blocked[0]).toMatchObject({
      stop_reason_code: REASON_CODES.missingToolOutput,
      requires_manual_resume: true,
      turn_control_state: 'blocked_manual_resume',
      progress_signal_state: 'stalled_waiting',
      tool_output_wait: {
        tool_name: 'linear_graphql',
        call_id: 'call_pfKTUH5GFubLHpXfln7UScnU',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        session_id: 'session-1',
        elapsed_wait_ms: 2000,
        last_agent_message: 'waiting for linear_graphql output',
        recommended_actions: ['Inspect the Codex thread', 'Resume the blocked run', 'Cancel the blocked run']
      }
    });

    const issueProjection = service.projectIssue(state, 'ABC-TOOL');
    expect(issueProjection.status).toBe('blocked');
    expect(issueProjection.blocked?.tool_output_wait?.call_id).toBe('call_pfKTUH5GFubLHpXfln7UScnU');
    expect(issueProjection.operator_explainer.reason_code).toBe(REASON_CODES.missingToolOutput);
  });

  it('only projects no-progress blocked issues as stalled waiting', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:05:00.000Z')
    });
    const state = makeState({
      blocked_inputs: new Map([
        [
          'issue-stalled',
          {
            issue_id: 'issue-stalled',
            issue_identifier: 'ABC-STALLED',
            attempt: 2,
            worker_host: null,
            workspace_path: null,
            provisioner_type: null,
            branch_name: null,
            repo_root: null,
            workspace_exists: true,
            workspace_git_status: 'clean',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: 'operator_action_required_no_progress_redispatch_blocked',
            stop_reason_detail: 'completion gate blocked redispatch because no progress signal was detected',
            conflict_files: [],
            resolution_hints: [],
            previous_thread_id: null,
            previous_session_id: null,
            blocked_at_ms: Date.parse('2026-04-10T10:04:00.000Z'),
            requires_manual_resume: true,
            last_progress_checkpoint_at: null,
            pending_input: null,
            session_console: []
          }
        ]
      ])
    });

    const projected = service.projectIssue(state, 'ABC-STALLED');
    expect(projected.blocked?.progress_signal_state).toBe('stalled_waiting');
    expect(projected.blocked?.last_progress_transition_at_ms).toBeNull();
  });

  it('projects failed last-phase detail as root cause separate from current operator latch', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:05:00.000Z')
    });
    const state = makeState({
      blocked_inputs: new Map([
        [
          'issue-dirty',
          {
            issue_id: 'issue-dirty',
            issue_identifier: 'ABC-DIRTY',
            attempt: 2,
            worker_host: null,
            workspace_path: null,
            provisioner_type: 'worktree',
            branch_name: 'feature/ABC-DIRTY',
            repo_root: '/repo/root',
            workspace_exists: false,
            workspace_git_status: 'dirty',
            workspace_provisioned: false,
            workspace_is_git_worktree: false,
            stop_reason_code: 'operator_action_required_no_progress_redispatch_blocked',
            stop_reason_detail: 'completion gate blocked redispatch because no progress signal was detected',
            conflict_files: [],
            resolution_hints: [],
            previous_thread_id: null,
            previous_session_id: null,
            blocked_at_ms: Date.parse('2026-04-10T10:04:00.000Z'),
            requires_manual_resume: true,
            last_phase: 'failed',
            last_phase_detail: 'workspace_provision_failed: worktree_dirty_repo',
            pending_input: null,
            session_console: []
          }
        ]
      ])
    });

    const stateProjection = service.projectState(state);
    expect(stateProjection.blocked[0]).toMatchObject({
      stop_reason_code: 'operator_action_required_no_progress_redispatch_blocked',
      current_operator_block: {
        reason_code: 'operator_action_required_no_progress_redispatch_blocked',
        detail: 'completion gate blocked redispatch because no progress signal was detected'
      },
      root_cause: {
        phase: 'failed',
        reason_code: 'worktree_dirty_repo',
        summary: 'Workspace provisioning failed: repo root has uncommitted or untracked files.',
        detail: 'workspace_provision_failed: worktree_dirty_repo',
        remediation_hint: 'Clean, commit, or ignore the dirty repo files, then requeue or resume.',
        differs_from_current_operator_block: true
      }
    });

    const issueProjection = service.projectIssue(state, 'ABC-DIRTY');
    expect(issueProjection.blocked?.root_cause?.reason_code).toBe('worktree_dirty_repo');
    expect(issueProjection.blocked?.current_operator_block.reason_code).toBe(
      'operator_action_required_no_progress_redispatch_blocked'
    );
  });

  it('projects breaker metadata on state and issue blocked payloads', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:05:00.000Z')
    });
    const state = makeState({
      blocked_inputs: new Map([
        [
          'issue-9',
          {
            issue_id: 'issue-9',
            issue_identifier: 'ABC-9',
            attempt: 4,
            worker_host: null,
            workspace_path: null,
            provisioner_type: null,
            branch_name: null,
            repo_root: null,
            workspace_exists: true,
            workspace_git_status: 'dirty',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: 'operator_action_required_no_progress_redispatch_blocked',
            stop_reason_detail: 'blocked',
            conflict_files: [],
            resolution_hints: [],
            previous_thread_id: null,
            previous_session_id: null,
            blocked_at_ms: Date.parse('2026-04-10T10:04:00.000Z'),
            requires_manual_resume: true,
            pending_input: null,
            session_console: []
          }
        ]
      ]),
      circuit_breakers: new Map([
        [
          'issue-9',
          {
            issue_id: 'issue-9',
            issue_identifier: 'ABC-9',
            breaker_active: true,
            breaker_hit_count: 5,
            breaker_window_minutes: 30,
            breaker_first_hit_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
            breaker_last_hit_at_ms: Date.parse('2026-04-10T10:04:00.000Z')
          }
        ]
      ])
    });

    const stateProjection = service.projectState(state);
    expect(stateProjection.blocked[0]).toMatchObject({
      issue_identifier: 'ABC-9',
      operator_explainer_hint: {
        classification: 'blocked_input',
        actionability: 'required',
        headline: 'Run is blocked on operator input'
      },
      breaker_active: true,
      breaker_hit_count: 5,
      breaker_window_minutes: 30,
      breaker_first_hit_at: '2026-04-10T10:00:00.000Z',
      breaker_last_hit_at: '2026-04-10T10:04:00.000Z'
    });

    const issueProjection = service.projectIssue(state, 'ABC-9');
    expect(issueProjection.status).toBe('blocked');
    expect(issueProjection.operator_explainer).toMatchObject({
      classification: 'blocked_input',
      actionability: 'required',
      reason_code: 'operator_action_required_no_progress_redispatch_blocked'
    });
    expect(issueProjection.blocked?.stop_reason_code).toBe('operator_action_required_no_progress_redispatch_blocked');
  });

  it('projects failed health state and issue recent events for diagnostics', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:02:00.000Z')
    });

    const state = makeState({
      health: {
        dispatch_validation: 'failed',
        last_error: 'dispatch preflight rejected dispatch'
      },
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            recent_events: [
              {
                at_ms: Date.parse('2026-04-10T10:01:30.000Z'),
                event: CANONICAL_EVENT.codex.turnStarted,
                message: null
              },
              {
                at_ms: Date.parse('2026-04-10T10:01:45.000Z'),
                event: CANONICAL_EVENT.codex.turnCompleted,
                message: 'done'
              }
            ]
          })
        ]
      ])
    });

    const projected = service.projectState(state);
    expect(projected.health.dispatch_validation).toBe('failed');
    expect(projected.health.last_error).toContain('dispatch preflight');

    const issue = service.projectIssue(state, 'ABC-1');
    expect(issue.workspace.path).toBe('/tmp/symphony/ABC-1');
    expect(issue.workspace.host).toBeNull();
    expect(issue.running?.thread_id).toBe('thread-1');
    expect(issue.running?.turn_id).toBe('turn-3');
    expect(issue.running?.codex_app_server_pid).toBe('12345');
    expect(issue.running?.last_event_summary).toBe('codex turn completed: done');
    expect(issue.recent_events).toHaveLength(2);
    expect(issue.recent_events[1]?.event).toBe(CANONICAL_EVENT.codex.turnCompleted);
    expect(issue.logs.codex_session_logs).toEqual([]);
    expect(issue.tracked).toEqual({});
  });

  it('projects active recent events separately from stale same-issue diagnostics', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:02:00.000Z')
    });

    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            thread_id: 'fresh-thread',
            turn_id: 'fresh-turn',
            session_id: 'fresh-session',
            codex_app_server_pid: '2002',
            last_event: CANONICAL_EVENT.codex.turnStarted,
            last_event_summary: 'codex turn started',
            last_message: null,
            last_codex_timestamp_ms: Date.parse('2026-04-10T10:01:30.000Z'),
            recent_events: [
              {
                at_ms: Date.parse('2026-04-10T10:01:30.000Z'),
                event: CANONICAL_EVENT.codex.turnStarted,
                message: null
              }
            ],
            quarantined_event_count: 1,
            last_quarantined_event_at_ms: Date.parse('2026-04-10T10:01:45.000Z'),
            quarantined_events: [
              {
                at_ms: Date.parse('2026-04-10T10:01:45.000Z'),
                event: CANONICAL_EVENT.codex.turnWaiting,
                message: 'late prior-review heartbeat',
                codex_app_server_pid: '1001',
                thread_id: 'review-thread',
                turn_id: 'review-turn',
                session_id: 'review-session',
                active_codex_app_server_pid: '2002',
                active_thread_id: 'fresh-thread',
                active_turn_id: 'fresh-turn',
                active_session_id: 'fresh-session',
                reason: 'lineage_mismatch'
              }
            ]
          })
        ]
      ])
    });

    const issue = service.projectIssue(state, 'ABC-1');
    expect(issue.running?.thread_id).toBe('fresh-thread');
    expect(issue.running?.codex_app_server_pid).toBe('2002');
    expect(issue.running?.quarantined_event_count).toBe(1);
    expect(issue.recent_events).toEqual([
      {
        at: '2026-04-10T10:01:30.000Z',
        event: CANONICAL_EVENT.codex.turnStarted,
        message: null
      }
    ]);
    expect(issue.stale_events).toEqual([
      {
        at: '2026-04-10T10:01:45.000Z',
        event: CANONICAL_EVENT.codex.turnWaiting,
        message: 'late prior-review heartbeat',
        codex_app_server_pid: '1001',
        thread_id: 'review-thread',
        turn_id: 'review-turn',
        session_id: 'review-session',
        active_codex_app_server_pid: '2002',
        active_thread_id: 'fresh-thread',
        active_turn_id: 'fresh-turn',
        active_session_id: 'fresh-session',
        reason: 'lineage_mismatch'
      }
    ]);

    const projectedState = service.projectState(state);
    expect(projectedState.running[0]?.thread_id).toBe('fresh-thread');
    expect(projectedState.running[0]?.codex_app_server_pid).toBe('2002');
    expect(projectedState.running[0]?.quarantined_event_count).toBe(1);
  });

  it('projects running issue retry metadata with worker and workspace context when queued', () => {
    const service = new SnapshotService();
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry()
        ]
      ]),
      retry_attempts: new Map([
        [
          'issue-1',
          {
            issue_id: 'issue-1',
            identifier: 'ABC-1',
            attempt: 1,
            due_at_ms: Date.parse('2026-04-10T10:03:00.000Z'),
            error: 'retrying',
            worker_host: 'build-2',
            workspace_path: '/tmp/symphony/ABC-1',
            provisioner_type: 'worktree',
            branch_name: 'feature/ABC-1',
            repo_root: '/tmp/source',
            workspace_exists: true,
            workspace_git_status: 'dirty',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: 'turn_input_required',
            stop_reason_detail: 'tool requestUserInput could not be auto-answered',
            conflict_files: [],
            resolution_hints: [],
            previous_thread_id: 'thread-prev',
            previous_session_id: 'thread-prev-turn-prev',
            timer_handle: {}
          }
        ]
      ])
    });

    const issue = service.projectIssue(state, 'ABC-1');
    expect(issue.retry).toMatchObject({
      attempt: 1,
      due_at: '2026-04-10T10:03:00.000Z',
      error: 'retrying',
      worker_host: 'build-2',
      workspace_path: '/tmp/symphony/ABC-1',
      provisioner_type: 'worktree',
      branch_name: 'feature/ABC-1',
      repo_root: '/tmp/source',
      workspace_exists: true,
      workspace_git_status: 'dirty',
      workspace_provisioned: true,
      workspace_is_git_worktree: true,
      copy_ignored_applied: false,
      copy_ignored_status: null,
      copy_ignored_summary: null,
      stop_reason_code: 'turn_input_required',
      stop_reason_detail: 'tool requestUserInput could not be auto-answered',
      previous_thread_id: 'thread-prev',
      previous_session_id: 'thread-prev-turn-prev',
      last_phase: null,
      last_phase_at: null,
      last_phase_detail: null
    });
    expect(issue.operator_explainer).toMatchObject({
      classification: 'healthy',
      actionability: 'none'
    });
    expect(issue.retry).toMatchObject({
      stop_reason_code: 'turn_input_required'
    });
  });

  it('projects enriched optional token dimensions without breaking baseline token fields', () => {
    const service = new SnapshotService({
      nowMs: () => Date.parse('2026-04-10T10:02:00.000Z')
    });

    const state = makeState({
      codex_totals: {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
        cached_input_tokens: 4,
        reasoning_output_tokens: 3,
        model_context_window: 200000,
        seconds_running: 40
      },
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            tokens: {
              input_tokens: 11,
              output_tokens: 5,
              total_tokens: 16,
              cached_input_tokens: 2,
              reasoning_output_tokens: 1,
              model_context_window: 200000
            }
          })
        ]
      ])
    });

    const projected = service.projectState(state);
    expect(projected.codex_totals.total_tokens).toBe(30);
    expect(projected.codex_totals.cached_input_tokens).toBe(4);
    expect(projected.codex_totals.reasoning_output_tokens).toBe(3);
    expect(projected.codex_totals.model_context_window).toBe(200000);
    expect(projected.running[0]?.tokens.cached_input_tokens).toBe(2);
    expect(projected.running[0]?.tokens.reasoning_output_tokens).toBe(1);
    expect(projected.running[0]?.tokens.model_context_window).toBe(200000);
  });

  it('projects retry-only issue payload with retry workspace and host context', () => {
    const service = new SnapshotService();
    const state = makeState({
      retry_attempts: new Map([
        [
          'issue-2',
          {
            issue_id: 'issue-2',
            identifier: 'ABC-2',
            attempt: 2,
            due_at_ms: Date.parse('2026-04-10T10:02:30.000Z'),
            error: 'retrying',
            worker_host: 'build-1',
            workspace_path: '/tmp/symphony/ABC-2',
            provisioner_type: 'worktree',
            branch_name: 'feature/ABC-2',
            repo_root: '/tmp/source',
            workspace_exists: true,
            workspace_git_status: 'clean',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: 'turn_input_required',
            stop_reason_detail: 'tool requestUserInput could not be auto-answered',
            conflict_files: [],
            resolution_hints: [],
            previous_thread_id: 'thread-prev',
            previous_session_id: 'thread-prev-turn-prev',
            timer_handle: {}
          }
        ]
      ])
    });

    const projected = service.projectIssue(state, 'ABC-2');
    expect(projected.status).toBe('retrying');
    expect(projected.workspace).toEqual({
      host: 'build-1',
      path: '/tmp/symphony/ABC-2'
    });
    expect(projected.retry).toMatchObject({
      attempt: 2,
      due_at: '2026-04-10T10:02:30.000Z',
      error: 'retrying',
      worker_host: 'build-1',
      workspace_path: '/tmp/symphony/ABC-2',
      provisioner_type: 'worktree',
      branch_name: 'feature/ABC-2',
      repo_root: '/tmp/source',
      workspace_exists: true,
      workspace_git_status: 'clean',
      workspace_provisioned: true,
      workspace_is_git_worktree: true,
      copy_ignored_applied: false,
      copy_ignored_status: null,
      copy_ignored_summary: null,
      stop_reason_code: 'turn_input_required',
      stop_reason_detail: 'tool requestUserInput could not be auto-answered',
      previous_thread_id: 'thread-prev',
      previous_session_id: 'thread-prev-turn-prev',
      last_phase: null,
      last_phase_at: null,
      last_phase_detail: null
    });
    expect(projected.operator_explainer).toMatchObject({
      classification: 'awaiting_input',
      actionability: 'required',
      expected_transition: 'Automatic retry at 2026-04-10T10:02:30.000Z',
      reason_code: 'turn_input_required'
    });
  });
});
