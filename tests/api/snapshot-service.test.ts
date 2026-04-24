import { describe, expect, it } from 'vitest';

import { SnapshotService } from '../../src/api';
import type { OrchestratorState } from '../../src/orchestrator';
import { CANONICAL_EVENT } from '../../src/observability/events';
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
    session_id: 'thread-1-turn-3',
    thread_id: 'thread-1',
    turn_id: 'turn-3',
    codex_app_server_pid: '12345',
    turn_count: 3,
    last_event: CANONICAL_EVENT.codex.turnCompleted,
    last_event_summary: 'codex turn completed: done',
    last_message: 'done',
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
            last_codex_timestamp_ms: null
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
    expect(projected.codex_totals.seconds_running).toBe(100);
    expect(projected.health.dispatch_validation).toBe('ok');
    expect(projected.running[0]?.session_id).toBe('thread-1-turn-3');
    expect(projected.running[0]?.thread_id).toBe('thread-1');
    expect(projected.running[0]?.turn_id).toBe('turn-3');
    expect(projected.running[0]?.codex_app_server_pid).toBe('12345');
    expect(projected.running[0]?.last_event_summary).toBe('codex turn completed: done');
    expect(projected.running[0]?.turn_count).toBe(3);
    expect(projected.running[0]?.workspace_path).toBe('/tmp/symphony/ABC-1');
    expect(projected.retrying[0]?.worker_host).toBe('build-1');
    expect(projected.retrying[0]?.workspace_path).toBe('/tmp/symphony/ABC-2');
    expect(projected.retrying[0]?.stop_reason_code).toBe('turn_input_required');
  });

  it('throws issue_not_found for unknown issue projection', () => {
    const service = new SnapshotService();
    const state = makeState();

    expect(() => service.projectIssue(state, 'ABC-404')).toThrow('Issue ABC-404 is not in runtime state');
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
            stop_reason_code: 'turn_input_required',
            stop_reason_detail: 'tool requestUserInput could not be auto-answered',
            previous_thread_id: 'thread-prev',
            previous_session_id: 'thread-prev-turn-prev',
            timer_handle: {}
          }
        ]
      ])
    });

    const issue = service.projectIssue(state, 'ABC-1');
    expect(issue.retry).toEqual({
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
      stop_reason_code: 'turn_input_required',
      stop_reason_detail: 'tool requestUserInput could not be auto-answered',
      previous_thread_id: 'thread-prev',
      previous_session_id: 'thread-prev-turn-prev'
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
            stop_reason_code: 'turn_input_required',
            stop_reason_detail: 'tool requestUserInput could not be auto-answered',
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
    expect(projected.retry).toEqual({
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
      stop_reason_code: 'turn_input_required',
      stop_reason_detail: 'tool requestUserInput could not be auto-answered',
      previous_thread_id: 'thread-prev',
      previous_session_id: 'thread-prev-turn-prev'
    });
  });
});
