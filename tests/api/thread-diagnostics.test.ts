import { describe, expect, it } from 'vitest';

import { buildThreadDiagnosticsByIssueIdentifier, classifyThreadBlocker } from '../../src/api';
import type { OrchestratorState, RunningEntry } from '../../src/orchestrator';
import { CANONICAL_EVENT } from '../../src/observability/events';
import type { Issue } from '../../src/tracker';

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

function makeRunningEntry(overrides: Partial<RunningEntry> = {}): RunningEntry {
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
    workspace_git_status: 'unknown',
    workspace_provisioned: false,
    workspace_is_git_worktree: false,
    session_id: 'thread-1-turn-1',
    thread_id: 'thread-1',
    turn_id: 'turn-1',
    codex_app_server_pid: '12345',
    turn_count: 1,
    last_event: CANONICAL_EVENT.codex.turnWaiting,
    last_event_summary: 'codex turn waiting: waiting_for_turn_completion elapsed_s=390',
    last_message: 'waiting_for_turn_completion elapsed_s=390',
    awaiting_input_since_ms: null,
    pending_input_preview: null,
    stalled_waiting_since_ms: null,
    stalled_waiting_reason: null,
    running_waiting_started_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
    last_progress_transition_at_ms: Date.parse('2026-04-10T10:06:30.000Z'),
    last_heartbeat_at_ms: Date.parse('2026-04-10T10:06:30.000Z'),
    heartbeat_only_event_emitted: true,
    running_wait_stall_event_emitted: false,
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
    token_telemetry_status: 'available',
    token_telemetry_last_source: 'worker_event_usage',
    token_telemetry_last_at_ms: Date.parse('2026-04-10T10:06:00.000Z'),
    token_telemetry_turn_started_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
    token_telemetry_warning_emitted: false,
    recent_events: [
      {
        at_ms: Date.parse('2026-04-10T10:06:30.000Z'),
        event: CANONICAL_EVENT.codex.turnWaiting,
        message: 'waiting_for_turn_completion elapsed_s=390'
      }
    ],
    started_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
    last_codex_timestamp_ms: Date.parse('2026-04-10T10:06:30.000Z'),
    ...overrides
  };
}

function makeState(running: RunningEntry): OrchestratorState {
  return {
    poll_interval_ms: 30_000,
    max_concurrent_agents: 10,
    running: new Map([[running.issue.id, running]]),
    claimed: new Set(),
    retry_attempts: new Map(),
    blocked_inputs: new Map(),
    circuit_breakers: new Map(),
    budget_usage_samples: new Map(),
    completed: new Set(),
    codex_totals: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      seconds_running: 0
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
      sparkline_10m: [],
      sample_count: 0
    },
    recent_runtime_events: []
  };
}

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

  it('reports active long-running waiting turns with fresh thread activity as running with no blocker', () => {
    const diagnostics = buildThreadDiagnosticsByIssueIdentifier({
      state: makeState(makeRunningEntry()),
      issue_identifier: 'ABC-1'
    });

    expect(diagnostics?.status).toBe('running');
    expect(diagnostics?.current_blocker).toBeNull();
    expect(diagnostics?.wait_spans[0]).toMatchObject({
      status: 'running',
      reason_code: null,
      reason_detail: null
    });
  });

  it('reports genuinely stale waiting turns with a deterministic blocker', () => {
    const diagnostics = buildThreadDiagnosticsByIssueIdentifier({
      state: makeState(
        makeRunningEntry({
          stalled_waiting_since_ms: Date.parse('2026-04-10T10:05:00.000Z'),
          stalled_waiting_reason: 'turn_waiting_threshold_exceeded',
          last_progress_transition_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
          recent_events: [
            {
              at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
              event: CANONICAL_EVENT.codex.turnWaiting,
              message: 'waiting heartbeat'
            }
          ]
        })
      ),
      issue_identifier: 'ABC-1'
    });

    expect(diagnostics?.status).toBe('stalled');
    expect(diagnostics?.current_blocker).toMatchObject({
      classification: 'tool_waiting_long',
      reason_code: 'turn_waiting_threshold_exceeded',
      actionability: 'recommended'
    });
    expect(diagnostics?.wait_spans[0]).toMatchObject({
      status: 'blocked',
      reason_code: 'turn_waiting_threshold_exceeded',
      reason_detail: 'codex.turn.waiting heartbeat loop exceeded threshold'
    });
  });
});
