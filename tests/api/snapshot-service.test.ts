import { describe, expect, it } from 'vitest';

import { SnapshotService } from '../../src/api';
import type { OrchestratorState } from '../../src/orchestrator';
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
    session_id: 'thread-1-turn-3',
    turn_count: 3,
    last_event: 'turn_completed',
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
        event: 'turn_completed',
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
      ])
    });

    const projected = service.projectState(state);
    expect(projected.counts.running).toBe(1);
    expect(projected.codex_totals.seconds_running).toBe(100);
    expect(projected.health.dispatch_validation).toBe('ok');
    expect(projected.running[0]?.session_id).toBe('thread-1-turn-3');
    expect(projected.running[0]?.turn_count).toBe(3);
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
                event: 'turn_started',
                message: null
              },
              {
                at_ms: Date.parse('2026-04-10T10:01:45.000Z'),
                event: 'turn_completed',
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
    expect(issue.recent_events).toHaveLength(2);
    expect(issue.recent_events[1]?.event).toBe('turn_completed');
  });
});
