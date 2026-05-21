import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  CANONICAL_EVENT,
  EVENT_VOCABULARY_VERSION,
  LocalApiError,
  LocalApiServer,
  REASON_CODES,
  StaticEventLoopHealthMonitor,
  closeServerAfterEach,
  deferred,
  makeDiagnosticsSource,
  makeEventLoopSummary,
  makeIssue,
  makeProjectHistoryIdentity,
  makeProjectHistorySummary,
  makeProjectHistoryTimeline,
  makeRunningEntry,
  makeState,
  makeThreadLineage,
  makeTranscriptDiagnostic,
  readSseEvents,
  replayForensicsBundle
} from './server-test-harness';
import type { DurableIdentity, ForensicsBundle } from './server-test-harness';

let server: LocalApiServer | null = null;

closeServerAfterEach(
  () => server,
  (nextServer) => {
    server = nextServer;
  }
);

describe('LocalApiServer state API', () => {
  it('[SPEC-13.7-1][SPEC-17.6-1] serves GET /api/v1/state with required baseline fields', async () => {
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry()
        ]
      ]),
      retry_attempts: new Map([
        [
          'issue-2',
          {
            issue_id: 'issue-2',
            identifier: 'ABC-2',
            attempt: 2,
            due_at_ms: Date.parse('2026-04-10T10:02:00.000Z'),
            error: 'no available orchestrator slots',
            worker_host: 'build-1',
            workspace_path: '/tmp/symphony/ABC-2',
            provisioner_type: 'worktree',
            branch_name: 'feature/ABC-2',
            repo_root: '/tmp/source',
            workspace_exists: true,
            workspace_git_status: 'clean',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: 'slots_exhausted',
            stop_reason_detail: 'no available orchestrator slots',
            previous_thread_id: 'thread-prev',
            previous_session_id: 'thread-prev-turn-prev',
            timer_handle: {}
          }
        ]
      ])
    });

    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => state
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      nowMs: () => Date.parse('2026-04-10T10:03:00.000Z')
    });

    await server.listen();
    const address = server.address();

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload).toHaveProperty('generated_at');
    expect(payload).toHaveProperty('counts');
    expect(payload).toHaveProperty('running');
    expect(payload).toHaveProperty('retrying');
    expect(payload).toHaveProperty('blocked');
    expect(payload).toHaveProperty('codex_totals');
    expect(payload).toHaveProperty('rate_limits');
    expect(payload).toHaveProperty('health');
    expect(
      (
        payload.counts as {
          running: number;
          retrying: number;
          blocked: number;
          stopped: number;
          running_stalled_waiting_count: number;
          running_awaiting_input_count: number;
        }
      ).running
    ).toBe(1);
    expect((payload.counts as { retrying: number }).retrying).toBe(1);
    expect((payload.counts as { blocked: number }).blocked).toBe(0);
    expect((payload.counts as { stopped: number }).stopped).toBe(0);
    expect(payload).toHaveProperty('stopped_runs');
    expect((payload.counts as { running_stalled_waiting_count: number }).running_stalled_waiting_count).toBe(0);
    expect((payload.counts as { running_awaiting_input_count: number }).running_awaiting_input_count).toBe(0);
    expect(
      (
        payload.running as Array<{
          workspace_path: string;
          provisioner_type: string;
          workspace_git_status: string;
          workspace_exists: boolean;
          operator_explainer_hint: { classification: string; actionability: string; headline: string };
        }>
      )[0]
    ).toMatchObject({
      workspace_path: '/tmp/symphony/ABC-1',
      provisioner_type: 'none',
      workspace_git_status: 'unknown',
      workspace_exists: true,
      operator_explainer_hint: {
        classification: 'healthy',
        actionability: 'none',
        headline: 'Run is progressing'
      }
    });
    expect(
      (
        payload.retrying as Array<{
          worker_host: string;
          workspace_path: string;
          provisioner_type: string;
          branch_name: string;
          repo_root: string;
        }>
      )[0]
    ).toMatchObject({
      worker_host: 'build-1',
      workspace_path: '/tmp/symphony/ABC-2',
      provisioner_type: 'worktree',
      branch_name: 'feature/ABC-2',
      repo_root: '/tmp/source'
    });
  });

  it('serves drain mode and quiescence state on GET /api/v1/state', async () => {
    const state = makeState({
      drain_mode: {
        active: true,
        entered_at_ms: Date.parse('2026-04-10T10:00:30.000Z'),
        updated_at_ms: Date.parse('2026-04-10T10:01:00.000Z'),
        reason: 'safe runtime restart'
      },
      quiescence: {
        safe_to_shutdown: false,
        state: 'blocked',
        updated_at_ms: Date.parse('2026-04-10T10:01:00.000Z'),
        blockers: [
          {
            category: 'active_worker',
            count: 1,
            detail: 'ABC-1 is still running',
            issue_identifiers: ['ABC-1']
          },
          {
            category: 'pending_retry',
            count: 1,
            detail: 'ABC-2 has a pending retry',
            issue_identifiers: ['ABC-2']
          }
        ],
        blocker_counts: {
          active_worker: 1,
          live_codex_app_server_process: 0,
          pending_retry: 1,
          in_flight_tracker_write: 0,
          persistence_history_write: 0,
          unknown_degraded_blocker_source_health: 0
        }
      }
    } as any);

    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => state
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      nowMs: () => Date.parse('2026-04-10T10:03:00.000Z')
    });

    await server.listen();
    const address = server.address();

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const payload = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(payload.drain_mode).toEqual({
      active: true,
      entered_at: '2026-04-10T10:00:30.000Z',
      entered_at_ms: Date.parse('2026-04-10T10:00:30.000Z'),
      updated_at: '2026-04-10T10:01:00.000Z',
      updated_at_ms: Date.parse('2026-04-10T10:01:00.000Z'),
      reason: 'safe runtime restart'
    });
    expect(payload.quiescence).toMatchObject({
      safe_to_shutdown: false,
      state: 'blocked',
      updated_at: '2026-04-10T10:01:00.000Z',
      blocker_counts: {
        active_worker: 1,
        pending_retry: 1
      }
    });
    expect(payload.quiescence.blockers).toContainEqual({
      category: 'active_worker',
      count: 1,
      detail: 'ABC-1 is still running',
      issue_identifiers: ['ABC-1']
    });
  });

  it('lets operators enter, read, and exit Drain Mode through the API control surface', async () => {
    const readDrainMode = vi
      .fn()
      .mockReturnValueOnce({
        active: false,
        entered_at_ms: null,
        updated_at_ms: null,
        reason: null
      })
      .mockReturnValueOnce({
        active: true,
        entered_at_ms: Date.parse('2026-04-10T10:04:00.000Z'),
        updated_at_ms: Date.parse('2026-04-10T10:04:00.000Z'),
        reason: 'operator restart'
      })
      .mockReturnValueOnce({
        active: false,
        entered_at_ms: null,
        updated_at_ms: Date.parse('2026-04-10T10:05:00.000Z'),
        reason: 'restart complete'
      });
    const enterDrainMode = vi.fn(() => readDrainMode());
    const exitDrainMode = vi.fn(() => readDrainMode());

    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      drainControlSource: {
        readDrainMode,
        enterDrainMode,
        exitDrainMode
      },
      nowMs: () => Date.parse('2026-04-10T10:03:00.000Z')
    });

    await server.listen();
    const address = server.address();

    const initial = await fetch(`http://127.0.0.1:${address.port}/api/v1/drain-mode`);
    const enter = await fetch(`http://127.0.0.1:${address.port}/api/v1/drain-mode/enter`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'operator restart' })
    });
    const exit = await fetch(`http://127.0.0.1:${address.port}/api/v1/drain-mode/exit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'restart complete' })
    });

    expect(initial.status).toBe(200);
    expect((await initial.json()).drain_mode).toMatchObject({ active: false });
    expect(enter.status).toBe(202);
    expect((await enter.json()).drain_mode).toMatchObject({
      active: true,
      reason: 'operator restart',
      entered_at: '2026-04-10T10:04:00.000Z'
    });
    expect(exit.status).toBe(202);
    expect((await exit.json()).drain_mode).toMatchObject({
      active: false,
      reason: 'restart complete',
      updated_at: '2026-04-10T10:05:00.000Z'
    });
    expect(enterDrainMode).toHaveBeenCalledWith({ reason: 'operator restart' });
    expect(exitDrainMode).toHaveBeenCalledWith({ reason: 'restart complete' });
  });

  it('serves GET /api/v1/state with bounded transcript diagnostic summaries instead of raw records', async () => {
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            transcript_tool_call_diagnostics: Array.from({ length: 200 }, (_, index) => makeTranscriptDiagnostic(index))
          })
        ],
        [
          'issue-2',
          makeRunningEntry({
            issue: makeIssue({ id: 'issue-2', identifier: 'ABC-2' }),
            identifier: 'ABC-2',
            transcript_tool_call_diagnostics: Array.from({ length: 200 }, (_, index) =>
              makeTranscriptDiagnostic(index + 200, { active_issue_id: 'issue-2', active_issue_identifier: 'ABC-2' })
            )
          })
        ]
      ])
    });

    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => state
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      nowMs: () => Date.parse('2026-04-10T10:05:00.000Z')
    });

    await server.listen();
    const address = server.address();

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const payload = (await response.json()) as {
      running: Array<Record<string, unknown> & {
        transcript_tool_call_diagnostic_summary: {
          detailed_diagnostics_available: boolean;
          total_count: number;
          newest_observed_at: string | null;
          counts_by_lineage: Record<string, number>;
          counts_by_kind: Record<string, number>;
        };
      }>;
    };

    expect(response.status).toBe(200);
    expect(payload.running).toHaveLength(2);
    expect(payload.running[0]).not.toHaveProperty('transcript_tool_call_diagnostics');
    expect(JSON.stringify(payload)).not.toContain('"transcript_tool_call_diagnostics"');
    expect(JSON.stringify(payload)).not.toContain('"active_issue_id"');
    expect(payload.running[0]?.transcript_tool_call_diagnostic_summary).toMatchObject({
      detailed_diagnostics_available: true,
      total_count: 200,
      newest_observed_at: '2026-04-10T10:04:19.000Z',
      counts_by_lineage: {
        active_owned: 50,
        prior_stale: 50,
        external_manual: 50,
        unattributed: 50
      },
      counts_by_kind: {
        function_call: 100,
        function_call_output: 100
      }
    });
    expect(JSON.stringify(payload).length).toBeLessThan(25_000);
  });

  it('returns snapshot_unavailable payload when snapshot source throws', async () => {
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => {
          throw new Error('snapshot unavailable');
        }
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      }
    });

    await server.listen();
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const payload = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(200);
    expect(payload.error.code).toBe('snapshot_unavailable');
    expect(payload.error.message).toContain('Snapshot unavailable');
  });

  it('returns snapshot_timeout payload when snapshot source throws timeout error', async () => {
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => {
          throw new LocalApiError('snapshot_timeout', 'state snapshot timed out', 503);
        }
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      }
    });

    await server.listen();
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const payload = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(200);
    expect(payload.error.code).toBe('snapshot_timeout');
    expect(payload.error.message).toContain('Snapshot timed out');
  });

  it('emits state_snapshot envelope with error payload when snapshot retrieval fails', async () => {
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => {
          throw new Error('snapshot unavailable');
        }
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      }
    });

    await server.listen();
    const address = server.address();
    const streamResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/events`);
    expect(streamResponse.status).toBe(200);

    const events = await readSseEvents(streamResponse, 1);
    const stateSnapshotEvent = events.find((entry) => entry.data.type === 'state_snapshot');
    expect(stateSnapshotEvent).toBeDefined();
    const payload = stateSnapshotEvent?.data.payload as {
      state?: { error?: { code?: string } };
    };
    expect(payload.state?.error?.code).toBe('snapshot_unavailable');
  });

  it('returns failed health semantics for UI health banner rendering', async () => {
    const state = makeState({
      health: {
        dispatch_validation: 'failed',
        last_error: 'dispatch preflight rejected dispatch'
      }
    });

    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => state
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      }
    });

    await server.listen();
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const payload = (await response.json()) as {
      health: { dispatch_validation: 'ok' | 'failed'; last_error: string | null };
    };

    expect(payload.health.dispatch_validation).toBe('failed');
    expect(payload.health.last_error).toContain('dispatch preflight');
  });

  it('honors dashboard observability config for refresh/render cadence', async () => {
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      dashboardConfig: {
        dashboard_enabled: false,
        refresh_ms: 1800,
        render_interval_ms: 750
      }
    });

    await server.listen();
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/dashboard/client.js`);
    const script = await response.text();

    expect(response.status).toBe(200);
    expect(script).toContain('"dashboard_enabled":false');
    expect(script).toContain('"refresh_ms":1800');
    expect(script).toContain('"render_interval_ms":750');
  });
});
