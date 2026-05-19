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

describe('LocalApiServer issue diagnostics', () => {
  it('serves bounded issue runtime diagnostics for running and blocked issues', async () => {
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            transcript_tool_call_diagnostics: Array.from({ length: 10 }, (_, index) => makeTranscriptDiagnostic(index)),
            tool_call_ledger: Object.fromEntries(
              Array.from({ length: 4 }, (_, index) => [
                `call-active-${index}`,
                {
                  call_id: `call-active-${index}`,
                  tool_name: 'linear_graphql',
                  thread_id: 'thread-1',
                  turn_id: 'turn-1',
                  session_id: 'session-1',
                  issue_id: 'issue-1',
                  issue_identifier: 'ABC-1',
                  run_id: 'run-1',
                  issue_run_id: 'issue-run-1',
                  attempt_id: 'attempt-1',
                  first_seen_at_ms: Date.parse('2026-04-10T10:01:00.000Z') + index * 1000,
                  last_seen_at_ms: Date.parse('2026-04-10T10:01:30.000Z') + index * 1000,
                  completed_at_ms: null,
                  completion_status: 'pending',
                  evidence_sources: ['session_transcript'],
                  start_evidence_source: 'session_transcript',
                  completion_evidence_source: null,
                  last_agent_message: 'waiting for linear_graphql output'
                }
              ])
            )
          })
        ]
      ]),
      blocked_inputs: new Map([
        [
          'issue-blocked',
          {
            issue_id: 'issue-blocked',
            issue_identifier: 'ABC-BLOCK',
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
            stop_reason_detail: 'missing Codex tool output',
            conflict_files: [],
            resolution_hints: ['Inspect diagnostics'],
            previous_thread_id: 'thread-blocked',
            previous_session_id: 'session-blocked',
            blocked_at_ms: Date.parse('2026-04-10T10:04:00.000Z'),
            requires_manual_resume: true,
            pending_input: null,
            tool_output_wait: {
              tool_name: 'linear_graphql',
              call_id: 'call-blocked',
              thread_id: 'thread-blocked',
              turn_id: 'turn-blocked',
              session_id: 'session-blocked',
              elapsed_wait_ms: 2000,
              last_agent_message: 'waiting for output',
              evidence_source: 'session_transcript',
              recommended_actions: ['Inspect diagnostics']
            },
            transcript_tool_call_diagnostics: [
              makeTranscriptDiagnostic(0, { lineage: 'active_owned', call_id: 'call-blocked' }),
              makeTranscriptDiagnostic(1, { lineage: 'prior_stale' }),
              makeTranscriptDiagnostic(2, { lineage: 'external_manual' }),
              makeTranscriptDiagnostic(3, { lineage: 'unattributed' })
            ],
            session_console: []
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
      nowMs: () => Date.parse('2026-04-10T10:05:00.000Z')
    });

    await server.listen();
    const address = server.address();

    const runningResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-1/diagnostics?limit=3&offset=1`);
    const runningPayload = (await runningResponse.json()) as {
      runtime_diagnostics: {
        status: string;
        transcript_tool_call_diagnostics: {
          metadata: { total_available_count: number; included_count: number; limit: number; offset: number; has_more: boolean };
          records: Array<{ call_id: string; lineage: string }>;
        };
        tool_call_ledger: { records: Array<{ call_id: string; completion_status: string }> };
      };
    };
    expect(runningResponse.status).toBe(200);
    expect(runningPayload.runtime_diagnostics.status).toBe('running');
    expect(runningPayload.runtime_diagnostics.transcript_tool_call_diagnostics.metadata).toMatchObject({
      total_available_count: 10,
      included_count: 3,
      limit: 3,
      offset: 1,
      has_more: true
    });
    expect(runningPayload.runtime_diagnostics.transcript_tool_call_diagnostics.records).toHaveLength(3);
    expect(runningPayload.runtime_diagnostics.tool_call_ledger.records[0]).toMatchObject({
      call_id: 'call-active-2',
      completion_status: 'pending'
    });

    const blockedResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-BLOCK/diagnostics?limit=2`);
    const blockedPayload = (await blockedResponse.json()) as {
      runtime_diagnostics: {
        status: string;
        missing_tool_output: { call_id: string; evidence_source: string } | null;
        transcript_tool_call_diagnostics: {
          metadata: { total_available_count: number; included_count: number; has_more: boolean };
          records: Array<{ lineage: string }>;
        };
      };
    };
    expect(blockedResponse.status).toBe(200);
    expect(blockedPayload.runtime_diagnostics.status).toBe('blocked');
    expect(blockedPayload.runtime_diagnostics.missing_tool_output).toMatchObject({
      call_id: 'call-blocked',
      evidence_source: 'session_transcript'
    });
    expect(blockedPayload.runtime_diagnostics.transcript_tool_call_diagnostics.metadata).toMatchObject({
      total_available_count: 4,
      included_count: 2,
      has_more: true
    });
    expect(new Set(blockedPayload.runtime_diagnostics.transcript_tool_call_diagnostics.records.map((record) => record.lineage))).toEqual(
      new Set(['unattributed', 'external_manual'])
    );
  });

  it('uses one state snapshot for mixed issue runtime and thread diagnostics', async () => {
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            transcript_tool_call_diagnostics: [makeTranscriptDiagnostic(0, { issue_identifier: 'ABC-1' })],
            tool_call_ledger: {
              call_active: {
                call_id: 'call_active',
                tool_name: 'linear_graphql',
                thread_id: 'thread-1',
                turn_id: 'turn-1',
                session_id: 'session-1',
                issue_id: 'issue-1',
                issue_identifier: 'ABC-1',
                run_id: 'run-1',
                issue_run_id: 'issue-run-1',
                attempt_id: 'attempt-1',
                first_seen_at_ms: Date.parse('2026-04-10T10:01:00.000Z'),
                last_seen_at_ms: Date.parse('2026-04-10T10:01:30.000Z'),
                completed_at_ms: null,
                completion_status: 'pending',
                evidence_sources: ['session_transcript'],
                start_evidence_source: 'session_transcript',
                completion_evidence_source: null,
                last_agent_message: 'waiting for linear_graphql output'
              }
            }
          })
        ]
      ])
    });
    const getStateSnapshot = vi.fn(() => state);

    server = new LocalApiServer({
      snapshotSource: { getStateSnapshot },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      diagnosticsSource: {
        reconstructThreadLineage: (threadId: string) =>
          threadId === 'thread-1' ? makeThreadLineage({ thread_id: 'thread-1', issue_identifier: 'ABC-1' }) : null
      } as never
    });

    await server.listen();
    const address = server.address();

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-1/diagnostics?limit=1`);
    const payload = (await response.json()) as {
      thread_id: string;
      runtime_diagnostics: {
        status: string;
        transcript_tool_call_diagnostics: { records: unknown[] };
        tool_call_ledger: { records: unknown[] };
      };
    };

    expect(response.status).toBe(200);
    expect(payload.thread_id).toBe('thread-1');
    expect(payload.runtime_diagnostics.status).toBe('running');
    expect(payload.runtime_diagnostics.transcript_tool_call_diagnostics.records).toHaveLength(1);
    expect(payload.runtime_diagnostics.tool_call_ledger.records).toHaveLength(1);
    expect(getStateSnapshot).toHaveBeenCalledTimes(1);
  });

  it('serves runtime-only issue diagnostics when thread diagnostics are unavailable', async () => {
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            thread_id: null,
            persisted_thread_id: null,
            transcript_tool_call_diagnostics: [makeTranscriptDiagnostic(0)]
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
        reconstructThreadLineage: () => null,
        reconstructLatestThreadLineageByIssueIdentifier: () => null
      } as never
    });

    await server.listen();
    const address = server.address();

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-1/diagnostics`);
    const payload = (await response.json()) as { issue_identifier: string; status: string; runtime_diagnostics?: unknown };

    expect(response.status).toBe(200);
    expect(payload.issue_identifier).toBe('ABC-1');
    expect(payload.status).toBe('running');
    expect(payload.runtime_diagnostics).toBeUndefined();
  });

  it('serves stalled-waiting issue diagnostics with safe operator guidance', async () => {
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            last_event: CANONICAL_EVENT.codex.rateLimitsUpdated,
            last_event_summary: 'rate limits updated',
            last_message: 'rate limits updated',
            running_waiting_started_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
            last_heartbeat_at_ms: Date.parse('2026-04-10T10:07:45.000Z'),
            last_codex_timestamp_ms: Date.parse('2026-04-10T10:07:45.000Z'),
            last_progress_transition_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
            stalled_waiting_since_ms: Date.parse('2026-04-10T10:05:00.000Z'),
            stalled_waiting_reason: REASON_CODES.turnWaitingThresholdExceeded,
            recent_events: [
              {
                at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
                event: CANONICAL_EVENT.codex.turnStarted,
                message: 'turn started'
              },
              {
                at_ms: Date.parse('2026-04-10T10:05:30.000Z'),
                event: CANONICAL_EVENT.codex.turnWaiting,
                message: 'waiting_for_turn_completion elapsed_s=330'
              },
              {
                at_ms: Date.parse('2026-04-10T10:07:45.000Z'),
                event: CANONICAL_EVENT.codex.rateLimitsUpdated,
                message: 'rate limits updated'
              }
            ]
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
      nowMs: () => Date.parse('2026-04-10T10:08:00.000Z')
    });

    await server.listen();
    const address = server.address();

    const stateResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const statePayload = (await stateResponse.json()) as {
      counts: { running_stalled_waiting_count: number };
      running: Array<{ progress_signal_state: string; last_event: string }>;
    };
    expect(stateResponse.status).toBe(200);
    expect(statePayload.counts.running_stalled_waiting_count).toBeGreaterThan(0);
    expect(statePayload.running[0]).toMatchObject({
      progress_signal_state: 'stalled_waiting',
      last_event: CANONICAL_EVENT.codex.rateLimitsUpdated
    });

    const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-1/diagnostics`);
    const diagnosticsPayload = (await diagnosticsResponse.json()) as {
      current_blocker: {
        classification: string;
        reason_code: string;
        reason_detail: string;
        time_since_progress: number;
        expected_auto_transition: string;
        recommended_actions: string[];
      };
    };
    expect(diagnosticsResponse.status).toBe(200);
    expect(diagnosticsPayload.current_blocker).toMatchObject({
      classification: 'stalled_waiting',
      reason_code: REASON_CODES.turnWaitingThresholdExceeded,
      reason_detail: 'codex.turn.waiting heartbeat loop exceeded threshold',
      time_since_progress: 480000,
      expected_auto_transition: 'Automatic recovery may schedule a retry; otherwise the operator can cancel the current turn or requeue.'
    });
    expect(diagnosticsPayload.current_blocker.recommended_actions).toEqual([
      'Inspect issue diagnostics',
      'Cancel the current turn',
      'Requeue the run'
    ]);
  });

  it('serves thread-only issue diagnostics when runtime diagnostics are unavailable', async () => {
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
    const payload = (await response.json()) as { thread_id: string; issue_identifier: string; runtime_diagnostics: unknown };

    expect(response.status).toBe(200);
    expect(payload.thread_id).toBe('thread-complete');
    expect(payload.issue_identifier).toBe('ABC-1');
    expect(payload.runtime_diagnostics).toBeNull();
  });

  it('projects recent stopped terminal runs from durable history through explicit recovery endpoint', async () => {
    const listRunHistory = vi.fn(() => [
      {
        run_id: 'run-nie-68',
        issue_id: 'issue-nie-68',
        issue_identifier: 'NIE-68',
        started_at: '2026-05-05T10:00:00.000Z',
        ended_at: '2026-05-05T10:10:00.000Z',
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
    ]);
    const reconstructThreadLineage = vi.fn(() => null);

    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      diagnosticsSource: makeDiagnosticsSource({
        listRunHistory,
        reconstructThreadLineage
      })
    });

    await server.listen();
    const address = server.address();

    const stateResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const statePayload = (await stateResponse.json()) as {
      counts: { stopped: number };
      stopped_runs: unknown[];
    };
    expect(stateResponse.status).toBe(200);
    expect(statePayload.counts.stopped).toBe(0);
    expect(statePayload.stopped_runs).toEqual([]);
    expect(listRunHistory).not.toHaveBeenCalled();
    expect(reconstructThreadLineage).not.toHaveBeenCalled();

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/stopped-runs/recovery`);
    const payload = (await response.json()) as {
      counts: { running: number; blocked: number; stopped: number };
      stopped_runs: Array<{
        issue_identifier: string;
        run_id: string;
        terminal_status: string;
        terminal_reason_code: string | null;
        root_cause_reason_code: string | null;
        root_cause_reason_detail: string | null;
        recovery_status: string;
        resume_valid: boolean;
        thread_id: string | null;
        session_id: string | null;
      }>;
    };

    expect(response.status).toBe(200);
    expect(payload.counts.stopped).toBe(1);
    expect(payload.stopped_runs[0]).toMatchObject({
      issue_identifier: 'NIE-68',
      run_id: 'run-nie-68',
      terminal_status: 'cancelled',
      terminal_reason_code: 'non_active_state_transition',
      root_cause_reason_code: REASON_CODES.missingToolOutput,
      root_cause_reason_detail: 'missing Codex tool output for call_123',
      recovery_status: 'inspect_forensics',
      resume_valid: false,
      thread_id: 'thread-nie-68',
      session_id: 'session-nie-68'
    });
    expect(listRunHistory).toHaveBeenCalledWith(25);
    expect(reconstructThreadLineage).toHaveBeenCalledWith('thread-nie-68');
  });

  it('passes resume override payload through POST /api/v1/issues/:issue_identifier/resume', async () => {
    const resumeBlockedIssue = vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3' }));
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      issueControlSource: {
        resumeBlockedIssue,
        cancelBlockedIssue: vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3', moved_to_state: 'Todo' })),
        submitBlockedIssueInput: vi.fn(async () => ({
          ok: true as const,
          issue_id: 'issue-3',
          request_id: 'req-1',
          resume_mode: 'fallback' as const,
          resume_reason_code: 'transport_unsupported',
          requested_at: '2026-05-04T00:00:00.000Z',
          request_lineage: { previous_thread_id: null, previous_session_id: null }
        }))
      }
    });

    await server.listen();
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        resume_override_reason: 'operator_override_push_additional_commit',
        reason_note: 'operator pushed additional commit'
      })
    });
    expect(response.status).toBe(202);
    expect(resumeBlockedIssue).toHaveBeenCalledWith('ABC-3', {
      resume_override_reason: 'operator_override_push_additional_commit',
      actor: undefined,
      reason_note: 'operator pushed additional commit'
    });
  });

  it('returns 405 for unsupported methods on defined routes', async () => {
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

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`, {
      method: 'POST'
    });
    const payload = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(405);
    expect(payload.error.code).toBe('method_not_allowed');

    const refreshGetResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/refresh`, {
      method: 'GET'
    });
    const refreshGetPayload = (await refreshGetResponse.json()) as { error: { code: string } };

    expect(refreshGetResponse.status).toBe(405);
    expect(refreshGetPayload.error.code).toBe('method_not_allowed');
  });

  it('returns typed degraded diagnostics for route mismatch and supports canonical issue-detail route', async () => {
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () =>
          makeState({
            running: new Map([['issue-1', makeRunningEntry()]])
          })
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      }
    });

    await server.listen();
    const address = server.address();

    const issueResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-1`);
    const issuePayload = (await issueResponse.json()) as { status: string; api_degraded_mode: boolean };
    expect(issueResponse.status).toBe(200);
    expect(issuePayload.status).toBe('running');
    expect(issuePayload.api_degraded_mode).toBe(false);

    const missingRouteResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-1/detail`);
    const missingRoutePayload = (await missingRouteResponse.json()) as {
      error: { code: string };
      api_degraded_mode: boolean;
      api_degraded_reason_code: string;
      api_degraded_routes: string[];
    };
    expect(missingRouteResponse.status).toBe(404);
    expect(missingRoutePayload).toMatchObject({
      error: { code: 'api_degraded_route_not_found' },
      api_degraded_mode: true,
      api_degraded_reason_code: 'route_not_found'
    });
    expect(missingRoutePayload.api_degraded_routes).toContain('/api/v1/issues/:issue_identifier');
  });

  it('serves telemetry summary and query API contract fields', async () => {
    const runningEntry = makeRunningEntry({
      issue: makeIssue({ identifier: 'ABC-1' }),
      identifier: 'ABC-1',
      worker_host: 'worker-a',
      started_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
      last_codex_timestamp_ms: Date.parse('2026-04-10T10:05:00.000Z'),
      last_progress_transition_at_ms: Date.parse('2026-04-10T10:01:00.000Z'),
      tokens: { input_tokens: 100, output_tokens: 50, total_tokens: 150 }
    });
    const state = makeState({
      running: new Map([['issue-1', runningEntry]]),
      blocked_inputs: new Map([
        [
          'issue-2',
          {
            issue_id: 'issue-2',
            issue_identifier: 'ABC-2',
            attempt: 3,
            worker_host: 'worker-b',
            workspace_path: '/tmp/symphony/ABC-2',
            provisioner_type: 'worktree',
            branch_name: 'feature/ABC-2',
            repo_root: '/tmp/source',
            workspace_exists: true,
            workspace_git_status: 'dirty',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: 'operator_action_required_workspace_conflict',
            stop_reason_detail: 'workspace conflict',
            conflict_files: [{ path: 'tmp.log', status: 'unstaged', classification: 'unknown_non_ephemeral' }],
            resolution_hints: ['resolve conflict'],
            previous_thread_id: 'thread-blocked',
            previous_session_id: 'session-blocked',
            blocked_at_ms: Date.parse('2026-04-10T10:06:00.000Z'),
            requires_manual_resume: true,
            pending_input: null,
            session_console: [],
            budget: {
              budget_usage_tokens: 300,
              budget_limit_tokens: 1000,
              budget_window_minutes: 60,
              budget_status: 'warning',
              budget_policy: 'block_requires_resume'
            }
          }
        ]
      ]),
      retry_attempts: new Map([
        [
          'issue-3',
          {
            issue_id: 'issue-3',
            identifier: 'ABC-3',
            attempt: 4,
            due_at_ms: Date.parse('2026-04-10T10:07:00.000Z'),
            error: 'retry loop',
            worker_host: 'worker-c',
            workspace_path: '/tmp/symphony/ABC-3',
            provisioner_type: 'worktree',
            branch_name: 'feature/ABC-3',
            repo_root: '/tmp/source',
            workspace_exists: true,
            workspace_git_status: 'clean',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: 'retry_backoff',
            stop_reason_detail: 'retry loop',
            previous_thread_id: 'thread-retry',
            previous_session_id: 'session-retry',
            timer_handle: {},
            budget: {
              budget_usage_tokens: 200,
              budget_limit_tokens: 1000,
              budget_window_minutes: 60,
              budget_status: 'warning',
              budget_policy: 'block_requires_resume'
            }
          }
        ]
      ])
    });

    server = new LocalApiServer({
      snapshotSource: { getStateSnapshot: () => state },
      refreshSource: { tick: vi.fn(async () => undefined) },
      diagnosticsSource: {
        listRunHistory: () => [
          {
            run_id: 'run-1',
            issue_id: 'issue-1',
            issue_identifier: 'ABC-1',
            started_at: '2026-04-10T10:00:00.000Z',
            ended_at: '2026-04-10T10:05:00.000Z',
            terminal_status: 'succeeded',
            error_code: null,
            session_ids: ['thread-complete']
          }
        ],
        reconstructThreadLineage: (threadId: string) => (threadId === 'thread-complete' ? makeThreadLineage({ thread_id: threadId }) : null),
        getRuntimeResolution: () => ({
          workflow_path: '/tmp/WORKFLOW.md',
          workflow_dir: '/tmp',
          workspace_root: '/tmp/workspaces',
          workspace_root_source: 'workflow',
          server: { host: '127.0.0.1', port: 3000 },
          provisioner_type: 'worktree',
          repo_root: '/tmp/source',
          base_ref: 'origin/main',
          branch_name_template: 'feature/{identifier}',
          effective_codex_model: 'gpt-5.4',
          effective_reasoning_effort: 'medium',
          effective_extra_flags_count: 0,
          codex_resolution_mode: 'typed'
        })
      } as unknown as NonNullable<ConstructorParameters<typeof LocalApiServer>[0]['diagnosticsSource']>
    });
    await server.listen();
    const address = server.address();

    const summaryResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/telemetry/summary?from=2026-04-10T09:59:00.000Z&to=2026-04-10T10:08:00.000Z`);
    const summary = (await summaryResponse.json()) as {
      sample_count: number;
      stuck_turn_rate: number;
      retry_loop_rate: number;
      time_to_first_progress_p50: number;
      time_to_first_progress_p95: number;
      time_to_first_progress_p99: number;
      tool_latency_p50: Record<string, number>;
      tool_latency_p95: Record<string, number>;
      tool_latency_p99: Record<string, number>;
      token_burn_rate: number;
      burn_without_progress_rate: number;
      top_blocker_classes: Array<{ classification: string; count: number }>;
      worst_tools: Array<{ tool_name: string; p95_latency_ms: number }>;
    };
    expect(summaryResponse.status).toBe(200);
    expect(summary.sample_count).toBeGreaterThanOrEqual(5);
    expect(summary).toHaveProperty('stuck_turn_rate');
    expect(summary).toHaveProperty('retry_loop_rate');
    expect(summary).toHaveProperty('time_to_first_progress_p50');
    expect(summary).toHaveProperty('time_to_first_progress_p95');
    expect(summary).toHaveProperty('time_to_first_progress_p99');
    expect(summary).toHaveProperty('tool_latency_p50');
    expect(summary).toHaveProperty('tool_latency_p95');
    expect(summary).toHaveProperty('tool_latency_p99');
    expect(summary.tool_latency_p95.exec_command).toBe(2000);
    expect(summary.token_burn_rate).toBeGreaterThan(0);
    expect(summary.burn_without_progress_rate).toBeGreaterThan(0);
    expect(summary.top_blocker_classes.some((entry) => entry.classification === 'blocked_input')).toBe(true);
    expect(summary.top_blocker_classes.some((entry) => entry.classification === 'succeeded')).toBe(false);
    expect(summary.worst_tools[0]).toMatchObject({ tool_name: 'exec_command', p95_latency_ms: 2000 });

    const queryResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/telemetry/query?issue_identifier=ABC-1&tool_name=exec_command&model=gpt-5.4`);
    const query = (await queryResponse.json()) as {
      result_count: number;
      events: Array<{ issue_identifier: string; tool_name: string; model: string; workflow_hash: string }>;
    };
    expect(queryResponse.status).toBe(200);
    expect(query.result_count).toBe(1);
    expect(query.events[0]).toMatchObject({
      issue_identifier: 'ABC-1',
      tool_name: 'exec_command',
      model: 'gpt-5.4'
    });
    expect(query.events[0]?.workflow_hash).toMatch(/^[a-f0-9]{12}$/);
  });
});
