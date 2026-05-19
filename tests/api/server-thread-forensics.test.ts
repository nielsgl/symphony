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

describe('LocalApiServer thread forensics', () => {
  it('serves canonical active thread diagnostics by thread id and issue identifier', async () => {
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            recent_events: [
              {
                at_ms: Date.parse('2026-04-10T10:00:10.000Z'),
                event: CANONICAL_EVENT.codex.turnStarted,
                message: 'turn started'
              },
              {
                at_ms: Date.parse('2026-04-10T10:00:20.000Z'),
                event: 'codex.turn.waiting',
                message: 'waiting for tool'
              },
              {
                at_ms: Date.parse('2026-04-10T10:00:25.000Z'),
                event: 'codex.turn.waiting',
                message: 'waiting heartbeat'
              }
            ],
            running_waiting_started_at_ms: Date.parse('2026-04-10T10:00:20.000Z'),
            stalled_waiting_since_ms: Date.parse('2026-04-10T10:05:20.000Z'),
            stalled_waiting_reason: 'turn_waiting_threshold_exceeded'
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
      }
    });

    await server.listen();
    const address = server.address();

    const byThreadResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/threads/thread-1`);
    const byThreadPayload = (await byThreadResponse.json()) as {
      thread_id: string;
      issue_identifier: string;
      attempt: number;
      status: string;
      timeline: Array<{
        at_ms: number;
        event: string;
        reason_code: string | null;
        reason_detail: string | null;
        thread_id: string;
        turn_id: string | null;
        session_id: string | null;
      }>;
      phase_spans: unknown[];
      tool_spans: unknown[];
      wait_spans: Array<{ started_at_ms: number; ended_at_ms: number | null; duration_ms: number | null }>;
      current_blocker: { classification: string; recommended_actions: string[] } | null;
      last_meaningful_progress_at_ms: number | null;
    };

    expect(byThreadResponse.status).toBe(200);
    expect(byThreadPayload).toMatchObject({
      thread_id: 'thread-1',
      issue_identifier: 'ABC-1',
      attempt: 0,
      status: 'stalled',
      phase_spans: [],
      tool_spans: []
    });
    expect(byThreadPayload.timeline.map((event) => event.at_ms)).toEqual([
      Date.parse('2026-04-10T10:00:10.000Z'),
      Date.parse('2026-04-10T10:00:20.000Z'),
      Date.parse('2026-04-10T10:00:25.000Z')
    ]);
    expect(byThreadPayload.timeline[0]).toHaveProperty('reason_code', null);
    expect(byThreadPayload.wait_spans[0]).toMatchObject({
      started_at_ms: Date.parse('2026-04-10T10:00:20.000Z'),
      ended_at_ms: null,
      duration_ms: null
    });
    expect(byThreadPayload.current_blocker?.classification).toBe('stalled_waiting');
    expect(byThreadPayload.current_blocker?.recommended_actions.length).toBeGreaterThan(0);
    expect(byThreadPayload.last_meaningful_progress_at_ms).toBe(Date.parse('2026-04-10T10:00:10.000Z'));

    const byIssueResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-1/diagnostics`);
    const byIssuePayload = (await byIssueResponse.json()) as { thread_id: string; current_blocker: { classification: string } };
    expect(byIssueResponse.status).toBe(200);
    expect(byIssuePayload.thread_id).toBe('thread-1');
    expect(byIssuePayload.current_blocker.classification).toBe('stalled_waiting');
  });

  it('serves deterministic persisted thread diagnostics with spans and additive null-safe fields', async () => {
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      diagnosticsSource: {
        reconstructThreadLineage: (threadId: string) =>
          threadId === 'thread-complete'
            ? {
                issue_run: {
                  issue_run_id: 'issue_run_1',
                  issue_id: 'issue-1',
                  issue_identifier: 'ABC-1',
                  started_at: '2026-04-10T10:00:00.000Z',
                  ended_at: '2026-04-10T10:02:00.000Z',
                  status: 'succeeded',
                  reason_code: null,
                  reason_detail: null
                },
                attempt: {
                  attempt_id: 'attempt_1',
                  issue_run_id: 'issue_run_1',
                  attempt_number: 2,
                  started_at: '2026-04-10T10:00:01.000Z',
                  ended_at: '2026-04-10T10:02:00.000Z',
                  status: 'succeeded',
                  reason_code: null,
                  reason_detail: null
                },
                thread: {
                  thread_id: 'thread-complete',
                  attempt_id: 'attempt_1',
                  started_at: '2026-04-10T10:00:02.000Z',
                  ended_at: '2026-04-10T10:02:00.000Z',
                  status: 'succeeded',
                  reason_code: null,
                  reason_detail: null
                },
                turns: [
                  {
                    turn_id: 'turn-1',
                    thread_id: 'thread-complete',
                    turn_index: 0,
                    started_at: '2026-04-10T10:00:04.000Z',
                    ended_at: '2026-04-10T10:01:00.000Z',
                    status: 'succeeded',
                    reason_code: 'turn_completed',
                    reason_detail: null,
                    phase_spans: [
                      {
                        phase_span_id: 'phase-1',
                        turn_id: 'turn-1',
                        phase: 'implementation',
                        started_at: '2026-04-10T10:00:05.000Z',
                        ended_at: '2026-04-10T10:00:15.000Z',
                        status: 'succeeded',
                        reason_code: null,
                        reason_detail: null
                      }
                    ],
                    tool_spans: [
                      {
                        tool_span_id: 'tool-1',
                        turn_id: 'turn-1',
                        tool_name: 'exec_command',
                        started_at: '2026-04-10T10:00:10.000Z',
                        ended_at: '2026-04-10T10:00:12.000Z',
                        status: 'succeeded',
                        reason_code: null,
                        reason_detail: null
                      }
                    ],
                    state_transitions: []
                  }
                ],
                state_transitions: [
                  {
                    state_transition_id: 'state-1',
                    issue_run_id: 'issue_run_1',
                    attempt_id: 'attempt_1',
                    thread_id: 'thread-complete',
                    turn_id: null,
                    from_status: 'running',
                    to_status: 'succeeded',
                    transitioned_at: '2026-04-10T10:02:00.000Z',
                    status: 'succeeded',
                    reason_code: 'completed',
                    reason_detail: null
                  }
                ]
              }
            : null
      } as never
    });

    await server.listen();
    const address = server.address();

    const firstResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/threads/thread-complete`);
    const secondResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/threads/thread-complete`);
    const firstPayload = (await firstResponse.json()) as Record<string, unknown>;
    const secondPayload = (await secondResponse.json()) as Record<string, unknown>;

    expect(firstResponse.status).toBe(200);
    expect(firstPayload).toEqual(secondPayload);
    expect(firstPayload).toMatchObject({
      thread_id: 'thread-complete',
      issue_identifier: 'ABC-1',
      attempt: 2,
      status: 'completed',
      current_blocker: null
    });
    expect(firstPayload).toHaveProperty('timeline');
    expect(firstPayload).toHaveProperty('phase_spans');
    expect(firstPayload).toHaveProperty('tool_spans');
    expect(firstPayload).toHaveProperty('wait_spans');
    expect(firstPayload).toHaveProperty('capability_warnings');
    expect(firstPayload.capability_warnings).toEqual([]);
    expect((firstPayload.phase_spans as Array<{ duration_ms: number }>)[0].duration_ms).toBe(10_000);
    expect((firstPayload.tool_spans as Array<{ tool_name: string; duration_ms: number }>)[0]).toMatchObject({
      tool_name: 'exec_command',
      duration_ms: 2_000
    });
    expect((firstPayload.timeline as Array<{ at_ms: number }>).map((event) => event.at_ms)).toEqual([
      Date.parse('2026-04-10T10:00:00.000Z'),
      Date.parse('2026-04-10T10:00:01.000Z'),
      Date.parse('2026-04-10T10:00:02.000Z'),
      Date.parse('2026-04-10T10:00:04.000Z'),
      Date.parse('2026-04-10T10:01:00.000Z'),
      Date.parse('2026-04-10T10:02:00.000Z')
    ]);
  });

  it('serves completed persisted diagnostics by issue identifier without active runtime state', async () => {
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      diagnosticsSource: {
        reconstructLatestThreadLineageByIssueIdentifier: (issueIdentifier: string) =>
          issueIdentifier === 'ABC-1' ? makeThreadLineage({ thread_id: 'thread-complete', issue_identifier: 'ABC-1' }) : null
      } as never
    });

    await server.listen();
    const address = server.address();

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-1/diagnostics`);
    const payload = (await response.json()) as {
      thread_id: string;
      issue_identifier: string;
      status: string;
      phase_spans: Array<{ phase: string }>;
      tool_spans: Array<{ tool_name: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      thread_id: 'thread-complete',
      issue_identifier: 'ABC-1',
      status: 'completed'
    });
    expect(payload.phase_spans[0]).toMatchObject({ phase: 'implementation' });
    expect(payload.tool_spans[0]).toMatchObject({ tool_name: 'exec_command' });
  });

  it('exports forensics bundles whose diagnostics replay with the same generated-at time', async () => {
    const blockedLineage = makeThreadLineage({
      thread_id: 'thread-blocked',
      issue_identifier: 'ABC-1',
      thread_status: 'blocked',
      thread_ended_at: null
    });
    const nowSpy = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(Date.parse('2026-04-10T10:06:00.000Z'))
      .mockReturnValueOnce(Date.parse('2026-04-10T10:06:00.000Z'))
      .mockReturnValue(Date.parse('2026-04-10T10:10:00.000Z'));
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      diagnosticsSource: {
        getActiveProfile: () => ({
          name: 'balanced',
          approval_policy: 'on-request',
          thread_sandbox: 'workspace-write',
          turn_sandbox_policy: { type: 'workspace' },
          user_input_policy: 'fail_attempt'
        }),
        getPersistenceHealth: () => ({
          enabled: true,
          db_path: '/tmp/runtime.sqlite',
          retention_days: 14,
          run_count: 1,
          last_pruned_at: null,
          last_prune_failure_at: null,
          last_prune_failure_reason: null,
          last_prune_failure_detail: null,
          integrity_ok: true
        }),
        getLoggingHealth: () => ({
          root: '/tmp/log',
          active_file: '/tmp/log/symphony.log',
          rotation: { max_bytes: 10485760, max_files: 5 },
          sinks: ['stderr']
        }),
        listRunHistory: () => [],
        reconstructLatestThreadLineageByIssueIdentifier: (issueIdentifier: string) =>
          issueIdentifier === 'ABC-1' ? blockedLineage : null,
        getUiState: () => null,
        setUiState: () => undefined,
        getPromptFallbackActive: () => false,
        getRuntimeResolution: () => ({
          workflow_path: '/tmp/WORKFLOW.md',
          workflow_dir: '/tmp',
          workspace_root: '/tmp/workspaces',
          workspace_root_source: 'workflow',
          server: { host: '127.0.0.1', port: 3000 },
          provisioner_type: 'none',
          repo_root: null,
          base_ref: null,
          branch_name_template: null
        }),
        getWorkspaceProvisioner: () => ({
          provisioner_type: 'none',
          repo_root: null,
          base_ref: null,
          branch_name_template: null,
          last_provision_result: null,
          last_teardown_result: null,
          last_error_code: null,
          last_verification_result: null,
          last_cleanup_on_failure_result: null,
          verification_mode: 'none',
          last_integrity_status: null,
          last_integrity_reason_code: null,
          last_integrity_checked_at: null,
          last_integrity_reconciled_at: null
        }),
        getWorkspaceCopyIgnored: () => ({
          enabled: false,
          include_file: '/tmp/.worktreeinclude',
          from: 'primary_worktree',
          conflict_policy: 'skip',
          require_gitignored: true,
          max_files: 10000,
          max_total_bytes: 5 * 1024 * 1024 * 1024,
          last_status: null,
          last_error_code: null,
          last_error_message: null,
          source_path: null,
          copied_files: 0,
          skipped_existing: 0,
          blocked_files: 0,
          bytes_copied: 0,
          duration_ms: 0
        })
      } as never
    });

    try {
      await server.listen();
      const address = server.address();

      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-1/forensics/export`);
      const bundle = (await response.json()) as ForensicsBundle;
      const replay = replayForensicsBundle(bundle, Date.parse('2026-04-10T10:30:00.000Z'));

      expect(response.status).toBe(200);
      expect(bundle.generated_at_ms).toBe(Date.parse('2026-04-10T10:06:00.000Z'));
      expect(replay.deterministic).toBe(true);
      expect(bundle.diagnostics.current_blocker?.time_since_progress).toBe(
        replay.diagnostics.current_blocker?.time_since_progress
      );
      expect(bundle.diagnostics).toEqual(replay.diagnostics);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('exports terminal-run forensics from durable history when issue is absent from runtime state and lineage', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-04-10T10:06:00.000Z'));
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      diagnosticsSource: makeDiagnosticsSource({
        listRunHistory: () => [
          {
            run_id: 'run-unfinished',
            issue_id: 'issue-stop',
            issue_identifier: 'ABC-STOP',
            started_at: '2026-04-10T10:04:00.000Z',
            ended_at: null,
            terminal_status: null,
            error_code: null,
            terminal_reason_code: null,
            terminal_reason_detail: null,
            root_cause_status: null,
            root_cause_reason_code: null,
            root_cause_reason_detail: null,
            root_cause_at: null,
            session_id: 'session-unfinished',
            thread_id: 'thread-unfinished',
            turn_id: 'turn-unfinished',
            session_ids: ['session-unfinished']
          },
          {
            run_id: 'run-stop',
            issue_id: 'issue-stop',
            issue_identifier: 'ABC-STOP',
            started_at: '2026-04-10T10:00:00.000Z',
            ended_at: '2026-04-10T10:05:00.000Z',
            terminal_status: 'cancelled',
            error_code: 'non_active_state_transition',
            terminal_reason_code: 'non_active_state_transition',
            terminal_reason_detail: null,
            root_cause_status: 'blocked',
            root_cause_reason_code: 'missing_tool_output',
            root_cause_reason_detail: 'tool_name=linear_graphql call_id=call-stop',
            root_cause_at: '2026-04-10T10:03:00.000Z',
            session_id: 'session-stop',
            thread_id: 'thread-stop',
            turn_id: 'turn-stop',
            session_ids: ['session-stop']
          }
        ],
        reconstructLatestThreadLineageByIssueIdentifier: () => null,
        reconstructThreadLineage: () => null
      })
    });

    try {
      await server.listen();
      const address = server.address();

      const stateResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
      const statePayload = (await stateResponse.json()) as { running: unknown[]; blocked: unknown[] };
      const historyResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/history`);
      const historyPayload = (await historyResponse.json()) as {
        runs: Array<{
          run_id: string;
          terminal_reason_code: string | null;
          root_cause_reason_code: string | null;
          thread_id: string | null;
          turn_id: string | null;
        }>;
      };
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-STOP/forensics/export`);
      const bundle = (await response.json()) as ForensicsBundle;
      const missingResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-MISSING/forensics/export`);
      const missingPayload = (await missingResponse.json()) as { error: { code: string } };

      expect(stateResponse.status).toBe(200);
      expect(statePayload.running).toEqual([]);
      expect(statePayload.blocked).toEqual([]);
      expect(historyResponse.status).toBe(200);
      expect(historyPayload.runs.find((run) => run.run_id === 'run-stop')).toMatchObject({
        run_id: 'run-stop',
        terminal_reason_code: 'non_active_state_transition',
        root_cause_reason_code: 'missing_tool_output',
        thread_id: 'thread-stop',
        turn_id: 'turn-stop'
      });
      expect(response.status).toBe(200);
      expect(bundle.terminal_run).toMatchObject({
        run_id: 'run-stop',
        issue_id: 'issue-stop',
        issue_identifier: 'ABC-STOP',
        session_id: 'session-stop',
        thread_id: 'thread-stop',
        turn_id: 'turn-stop',
        terminal_status: 'cancelled',
        terminal_reason_code: 'non_active_state_transition',
        root_cause_reason_code: 'missing_tool_output',
        root_cause_at: '2026-04-10T10:03:00.000Z',
        ended_at: '2026-04-10T10:05:00.000Z'
      });
      expect(bundle.diagnostics.timeline.map((entry) => entry.event)).toEqual([
        'run.started',
        'run.root_cause_diagnostic',
        'run.terminal'
      ]);
      expect(missingResponse.status).toBe(404);
      expect(missingPayload.error.code).toBe('forensics_bundle_not_found');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('returns typed not-found instead of terminal forensics when durable history only has an unfinished matching run', async () => {
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      diagnosticsSource: makeDiagnosticsSource({
        listRunHistory: () => [
          {
            run_id: 'run-unfinished-only',
            issue_id: 'issue-unfinished',
            issue_identifier: 'ABC-UNFINISHED',
            started_at: '2026-04-10T10:04:00.000Z',
            ended_at: null,
            terminal_status: null,
            error_code: null,
            terminal_reason_code: null,
            terminal_reason_detail: null,
            root_cause_status: null,
            root_cause_reason_code: null,
            root_cause_reason_detail: null,
            root_cause_at: null,
            session_id: 'session-unfinished',
            thread_id: 'thread-unfinished',
            turn_id: 'turn-unfinished',
            session_ids: ['session-unfinished']
          }
        ],
        reconstructLatestThreadLineageByIssueIdentifier: () => null,
        reconstructThreadLineage: () => null
      })
    });

    await server.listen();
    const address = server.address();

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-UNFINISHED/forensics/export`);
    const payload = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(404);
    expect(payload.error.code).toBe('forensics_bundle_not_found');
  });

  it('keeps persisted phase and tool spans when active runtime diagnostics also exist', async () => {
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            thread_id: 'thread-active',
            persisted_thread_id: 'thread-active',
            recent_events: [
              {
                at_ms: Date.parse('2026-04-10T10:03:00.000Z'),
                event: CANONICAL_EVENT.codex.turnWaiting,
                message: 'waiting heartbeat'
              }
            ],
            running_waiting_started_at_ms: Date.parse('2026-04-10T10:03:00.000Z'),
            stalled_waiting_since_ms: Date.parse('2026-04-10T10:08:00.000Z'),
            stalled_waiting_reason: 'turn_waiting_threshold_exceeded'
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
      diagnosticsSource: {
        reconstructThreadLineage: (threadId: string) =>
          threadId === 'thread-active'
            ? makeThreadLineage({
                thread_id: 'thread-active',
                issue_identifier: 'ABC-1',
                thread_status: 'running',
                thread_ended_at: null
              })
            : null
      } as never
    });

    await server.listen();
    const address = server.address();

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/threads/thread-active`);
    const payload = (await response.json()) as {
      status: string;
      phase_spans: Array<{ phase: string; duration_ms: number }>;
      tool_spans: Array<{ tool_name: string; duration_ms: number }>;
      wait_spans: Array<{ started_at_ms: number }>;
      current_blocker: { classification: string } | null;
      timeline: Array<{ event: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.status).toBe('stalled');
    expect(payload.phase_spans[0]).toMatchObject({ phase: 'implementation', duration_ms: 10_000 });
    expect(payload.tool_spans[0]).toMatchObject({ tool_name: 'exec_command', duration_ms: 2_000 });
    expect(payload.wait_spans[0]).toMatchObject({ started_at_ms: Date.parse('2026-04-10T10:03:00.000Z') });
    expect(payload.current_blocker?.classification).toBe('stalled_waiting');
    expect(payload.timeline.map((event) => event.event)).toContain(CANONICAL_EVENT.codex.turnWaiting);
  });

  it('returns typed not-found errors for missing thread diagnostics', async () => {
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      }
    });

    await server.listen();
    const address = server.address();

    const threadResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/threads/missing-thread`);
    const threadPayload = (await threadResponse.json()) as { error: { code: string; message: string } };
    expect(threadResponse.status).toBe(404);
    expect(threadPayload.error.code).toBe('thread_diagnostics_not_found');
    expect(threadPayload.error.message).toContain('missing-thread');

    const issueResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-404/diagnostics`);
    const issuePayload = (await issueResponse.json()) as { error: { code: string; message: string } };
    expect(issueResponse.status).toBe(404);
    expect(issuePayload.error.code).toBe('thread_diagnostics_not_found');
    expect(issuePayload.error.message).toContain('ABC-404');
  });
});
