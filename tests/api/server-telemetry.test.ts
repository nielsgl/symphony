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

describe('LocalApiServer telemetry API', () => {
  it('serves telemetry from bounded targeted projection instead of full state diagnostics', async () => {
    const listRunHistory = vi.fn(() => [
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
    ]);
    const reconstructThreadLineage = vi.fn((threadId: string) =>
      threadId === 'thread-complete' ? makeThreadLineage({ thread_id: threadId }) : null
    );

    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () =>
          makeState({
            running: new Map([
              [
                'issue-1',
                makeRunningEntry({
                  issue: makeIssue({ identifier: 'ABC-1' }),
                  identifier: 'ABC-1',
                  thread_id: 'thread-live',
                  transcript_tool_call_diagnostics: Array.from({ length: 200 }, (_, index) => makeTranscriptDiagnostic(index))
                })
              ]
            ])
          })
      },
      refreshSource: { tick: vi.fn(async () => undefined) },
      diagnosticsSource: makeDiagnosticsSource({
        listRunHistory,
        reconstructThreadLineage
      })
    });
    await server.listen();
    const address = server.address();

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/telemetry/query?tool_name=exec_command`);
    const payload = (await response.json()) as { result_count: number };

    expect(response.status).toBe(200);
    expect(payload.result_count).toBe(1);
    expect(listRunHistory).toHaveBeenCalledTimes(1);
    expect(listRunHistory).toHaveBeenCalledWith(500);
    expect(reconstructThreadLineage).toHaveBeenCalledTimes(1);
    expect(reconstructThreadLineage).toHaveBeenCalledWith('thread-complete');
  });

  it('returns deterministic empty-window telemetry responses and typed validation errors', async () => {
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () =>
          makeState({
            running: new Map([['issue-1', makeRunningEntry()]])
          })
      },
      refreshSource: { tick: vi.fn(async () => undefined) }
    });
    await server.listen();
    const address = server.address();

    const emptyResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/telemetry/summary?from=2026-04-11T00:00:00.000Z&to=2026-04-11T01:00:00.000Z`);
    const empty = (await emptyResponse.json()) as {
      sample_count: number;
      stuck_turn_rate: number;
      retry_loop_rate: number;
      token_burn_rate: number;
      burn_without_progress_rate: number;
      tool_latency_p50: Record<string, number>;
      top_blocker_classes: unknown[];
    };
    expect(emptyResponse.status).toBe(200);
    expect(empty).toMatchObject({
      sample_count: 0,
      stuck_turn_rate: 0,
      retry_loop_rate: 0,
      token_burn_rate: 0,
      burn_without_progress_rate: 0,
      tool_latency_p50: {},
      top_blocker_classes: []
    });

    const invalidWindowResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/telemetry/query?from=2026-04-11T01:00:00.000Z&to=2026-04-11T00:00:00.000Z`);
    const invalidWindow = (await invalidWindowResponse.json()) as { error: { code: string } };
    expect(invalidWindowResponse.status).toBe(400);
    expect(invalidWindow.error.code).toBe('invalid_time_window');

    const invalidFilterResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/telemetry/query?classification=`);
    const invalidFilter = (await invalidFilterResponse.json()) as { error: { code: string } };
    expect(invalidFilterResponse.status).toBe(400);
    expect(invalidFilter.error.code).toBe('invalid_query_filter');

    const partialLimitResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/telemetry/query?limit=10abc`);
    const partialLimit = (await partialLimitResponse.json()) as { error: { code: string } };
    expect(partialLimitResponse.status).toBe(400);
    expect(partialLimit.error.code).toBe('invalid_query_filter');

    const fractionalLimitResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/telemetry/query?limit=1.5`);
    const fractionalLimit = (await fractionalLimitResponse.json()) as { error: { code: string } };
    expect(fractionalLimitResponse.status).toBe(400);
    expect(fractionalLimit.error.code).toBe('invalid_query_filter');
  });

  it('aggregates high-volume telemetry samples deterministically', async () => {
    const running = new Map<string, ReturnType<typeof makeRunningEntry>>();
    for (let index = 0; index < 1500; index += 1) {
      running.set(
        `issue-${index}`,
        makeRunningEntry({
          issue: makeIssue({ id: `issue-${index}`, identifier: `ABC-${index}` }),
          identifier: `ABC-${index}`,
          worker_host: index % 2 === 0 ? 'worker-even' : 'worker-odd',
          thread_id: `thread-${index}`,
          turn_id: `turn-${index}`,
          started_at_ms: Date.parse('2026-04-10T10:00:00.000Z') + index,
          last_codex_timestamp_ms: Date.parse('2026-04-10T10:01:00.000Z') + index,
          stalled_waiting_since_ms: index % 10 === 0 ? Date.parse('2026-04-10T10:00:30.000Z') + index : null,
          stalled_waiting_reason: index % 10 === 0 ? 'turn_waiting_threshold_exceeded' : null,
          tokens: {
            input_tokens: index,
            output_tokens: 1,
            total_tokens: index + 1
          }
        })
      );
    }

    server = new LocalApiServer({
      snapshotSource: { getStateSnapshot: () => makeState({ running }) },
      refreshSource: { tick: vi.fn(async () => undefined) }
    });
    await server.listen();
    const address = server.address();

    const defaultQueryResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/telemetry/query?worker_host=worker-even`);
    const defaultQuery = (await defaultQueryResponse.json()) as { result_count: number; events: Array<{ worker_host: string }> };
    expect(defaultQueryResponse.status).toBe(200);
    expect(defaultQuery.result_count).toBe(500);
    expect(defaultQuery.events.every((event) => event.worker_host === 'worker-even')).toBe(true);

    const summaryResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/telemetry/summary?worker_host=worker-even`);
    const summary = (await summaryResponse.json()) as {
      sample_count: number;
      stuck_turn_rate: number;
      burn_without_progress_rate: number;
      top_blocker_classes: Array<{ classification: string; count: number }>;
    };
    expect(summaryResponse.status).toBe(200);
    expect(summary.sample_count).toBe(750);
    expect(summary.stuck_turn_rate).toBe(0.2);
    expect(summary.burn_without_progress_rate).toBeGreaterThan(0);
    expect(summary.top_blocker_classes).toContainEqual(
      expect.objectContaining({ classification: 'stalled_waiting', count: 150 })
    );

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/telemetry/query?worker_host=worker-even&limit=10000`);
    const payload = (await response.json()) as { result_count: number; events: Array<{ worker_host: string }> };
    expect(response.status).toBe(200);
    expect(payload.result_count).toBe(750);
    expect(payload.events.every((event) => event.worker_host === 'worker-even')).toBe(true);
  });

  it('maps typed expired input submission to 409 conflict envelope', async () => {
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      issueControlSource: {
        resumeBlockedIssue: vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3' })),
        cancelBlockedIssue: vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3', moved_to_state: 'Todo' })),
        submitBlockedIssueInput: vi.fn(async () => ({
          ok: false as const,
          code: 'input_submission_expired',
          message: 'Input request_id does not match current blocked request'
        }))
      }
    });

    await server.listen();
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request_id: 'req-1',
        reason_note: 'answer request',
        answer: { text: 'continue' }
      })
    });
    const payload = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe('input_submission_expired');
  });

  it('returns invalid_ui_state when ui-state JSON body is malformed', async () => {
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
          run_count: 0,
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
          sinks: ['stderr', 'file']
        }),
        listRunHistory: () => [],
        getUiState: () => null,
        setUiState: () => undefined,
        getPromptFallbackActive: () => false,
        getRuntimeResolution: () => ({
          workflow_path: '/tmp/WORKFLOW.md',
          workflow_dir: '/tmp',
          workspace_root: '/tmp/workspaces',
          workspace_root_source: 'workflow',
          server: {
            host: '127.0.0.1',
            port: 3000
          },
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
      }
    });

    await server.listen();
    const address = server.address();

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/ui-state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"state":'
    });

    const payload = (await response.json()) as { error: { code: string; message: string } };
    expect(response.status).toBe(400);
    expect(payload.error.code).toBe('invalid_ui_state');
  });
});
