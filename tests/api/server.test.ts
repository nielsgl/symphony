import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LocalApiServer } from '../../src/api';
import { LocalApiError } from '../../src/api/errors';
import { replayForensicsBundle, type ForensicsBundle } from '../../src/api/forensics';
import type { OrchestratorState } from '../../src/orchestrator';
import { CANONICAL_EVENT, EVENT_VOCABULARY_VERSION } from '../../src/observability/events';
import type { ExecutionGraphThreadLineage } from '../../src/persistence';
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
    session_id: 'thread-1-turn-1',
    thread_id: 'thread-1',
    turn_id: 'turn-1',
    codex_app_server_pid: '9999',
    turn_count: 2,
    last_event: CANONICAL_EVENT.codex.turnCompleted,
    last_event_summary: 'codex turn completed: completed work',
    last_message: 'completed work',
    tokens: {
      input_tokens: 12,
      output_tokens: 8,
      total_tokens: 20
    },
    last_reported_tokens: {
      input_tokens: 12,
      output_tokens: 8,
      total_tokens: 20
    },
    token_telemetry_status: 'available' as const,
    token_telemetry_last_source: 'terminal_turn_summary',
    token_telemetry_last_at_ms: Date.parse('2026-04-10T10:01:00.000Z'),
    token_telemetry_turn_started_at_ms: Date.parse('2026-04-10T10:00:30.000Z'),
    token_telemetry_warning_emitted: false,
    recent_events: [
      {
        at_ms: Date.parse('2026-04-10T10:00:30.000Z'),
        event: CANONICAL_EVENT.codex.turnStarted,
        message: null
      },
      {
        at_ms: Date.parse('2026-04-10T10:01:00.000Z'),
        event: CANONICAL_EVENT.codex.turnCompleted,
        message: 'completed work'
      }
    ],
    started_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
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
      sparkline_10m: Array.from({ length: 24 }, () => 0),
      sample_count: 0
    },
    recent_runtime_events: [],
    ...overrides
  };
}

function makeThreadLineage(overrides: {
  thread_id?: string;
  issue_identifier?: string;
  thread_status?: 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'retrying';
  thread_ended_at?: string | null;
} = {}): ExecutionGraphThreadLineage {
  const threadId = overrides.thread_id ?? 'thread-complete';
  const issueIdentifier = overrides.issue_identifier ?? 'ABC-1';
  const threadStatus = overrides.thread_status ?? 'succeeded';
  return {
    issue_run: {
      issue_run_id: 'issue_run_1',
      issue_id: 'issue-1',
      issue_identifier: issueIdentifier,
      started_at: '2026-04-10T10:00:00.000Z',
      ended_at: overrides.thread_ended_at ?? '2026-04-10T10:02:00.000Z',
      status: threadStatus,
      reason_code: null,
      reason_detail: null
    },
    attempt: {
      attempt_id: 'attempt_1',
      issue_run_id: 'issue_run_1',
      attempt_number: 2,
      started_at: '2026-04-10T10:00:01.000Z',
      ended_at: overrides.thread_ended_at ?? '2026-04-10T10:02:00.000Z',
      status: threadStatus,
      reason_code: null,
      reason_detail: null
    },
    thread: {
      thread_id: threadId,
      attempt_id: 'attempt_1',
      started_at: '2026-04-10T10:00:02.000Z',
      ended_at: overrides.thread_ended_at ?? '2026-04-10T10:02:00.000Z',
      status: threadStatus,
      reason_code: null,
      reason_detail: null
    },
    turns: [
      {
        turn_id: 'turn-1',
        thread_id: threadId,
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
        thread_id: threadId,
        turn_id: null,
        from_status: 'running',
        to_status: threadStatus,
        transitioned_at: '2026-04-10T10:02:00.000Z',
        status: threadStatus,
        reason_code: threadStatus === 'succeeded' ? 'completed' : null,
        reason_detail: null
      }
    ]
  };
}

let server: LocalApiServer | null = null;

async function readSseEvents(
  response: Response,
  expectedCount: number,
  timeoutMs: number = 4000
): Promise<Array<{ id?: number; event?: string; data: Record<string, unknown> }>> {
  if (!response.body) {
    throw new Error('expected stream body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ id?: number; event?: string; data: Record<string, unknown> }> = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;

  while (events.length < expectedCount && Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 250)
      )
    ]);

    if (result.done || !result.value) {
      continue;
    }

    buffer += decoder.decode(result.value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const lines = block.split('\n');
      let id: number | undefined;
      let eventName: string | undefined;
      let dataLine = '';
      for (const line of lines) {
        if (line.startsWith('id: ')) {
          id = Number.parseInt(line.slice(4), 10);
          continue;
        }
        if (line.startsWith('event: ')) {
          eventName = line.slice(7);
          continue;
        }
        if (line.startsWith('data: ')) {
          dataLine += line.slice(6);
        }
      }
      if (!dataLine) {
        continue;
      }
      events.push({
        id,
        event: eventName,
        data: JSON.parse(dataLine) as Record<string, unknown>
      });
      if (events.length >= expectedCount) {
        break;
      }
    }
  }

  await reader.cancel();
  return events;
}

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

describe('LocalApiServer', () => {
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
          running_stalled_waiting_count: number;
          running_awaiting_input_count: number;
        }
      ).running
    ).toBe(1);
    expect((payload.counts as { retrying: number }).retrying).toBe(1);
    expect((payload.counts as { blocked: number }).blocked).toBe(0);
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

  it('fills running total tokens from CODEX_HOME state sqlite when protocol totals are absent', async () => {
    const codexHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-'));
    const dbPath = path.join(codexHomeDir, 'state_5.sqlite');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sqlite = require('node:sqlite') as {
      DatabaseSync: new (path: string) => {
        exec: (sql: string) => void;
        close: () => void;
      };
    };
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        tokens_used INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO threads (id, tokens_used) VALUES ('thread-live-1', 321);
    `);
    db.close();

    const previousCodexHome = process.env.SYMPHONY_CODEX_HOME;
    process.env.SYMPHONY_CODEX_HOME = codexHomeDir;

    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            thread_id: 'thread-live-1',
            tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            last_reported_tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            token_telemetry_status: 'pending',
            token_telemetry_last_source: null,
            token_telemetry_last_at_ms: null
          })
        ]
      ]),
      codex_totals: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        seconds_running: 0
      }
    });

    server = new LocalApiServer({
      host: '127.0.0.1',
      port: 0,
      snapshotSource: {
        getStateSnapshot: () => state
      },
      refreshSource: { tick: async () => {} }
    });
    await server.listen();
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const payload = (await response.json()) as {
      codex_totals: { total_tokens: number };
      running: Array<{
        token_telemetry_status: string;
        token_telemetry_last_source: string | null;
        token_telemetry_last_at_ms: number | null;
        tokens: { total_tokens: number; input_tokens: number; output_tokens: number };
      }>;
    };

    expect(response.status).toBe(200);
    expect(payload.codex_totals.total_tokens).toBe(321);
    expect(payload.running[0]?.tokens.total_tokens).toBe(321);
    expect(typeof payload.running[0]?.tokens.total_tokens).toBe('number');
    expect(typeof payload.running[0]?.tokens.input_tokens).toBe('number');
    expect(typeof payload.running[0]?.tokens.output_tokens).toBe('number');
    expect(payload.running[0]?.token_telemetry_status).toBe('available');
    expect(payload.running[0]?.token_telemetry_last_source).toBe('codex_home_state_sqlite');
    expect(typeof payload.running[0]?.token_telemetry_last_at_ms).toBe('number');

    const issueResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/ABC-1`);
    const issuePayload = (await issueResponse.json()) as {
      operator_explainer: { version: string; classification: string; actionability: string; headline: string };
      running: {
        token_telemetry_status: string;
        token_telemetry_last_source: string | null;
        token_telemetry_last_at_ms: number | null;
        tokens: { total_tokens: number };
      };
    };
    expect(issueResponse.status).toBe(200);
    expect(issuePayload.operator_explainer).toMatchObject({
      version: expect.any(String),
      classification: 'healthy',
      actionability: 'none',
      headline: 'Run is progressing'
    });
    expect(issuePayload.running.tokens.total_tokens).toBe(321);
    expect(issuePayload.running.token_telemetry_status).toBe('available');
    expect(issuePayload.running.token_telemetry_last_source).toBe('codex_home_state_sqlite');
    expect(typeof issuePayload.running.token_telemetry_last_at_ms).toBe('number');

    if (previousCodexHome === undefined) {
      delete process.env.SYMPHONY_CODEX_HOME;
    } else {
      process.env.SYMPHONY_CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(codexHomeDir, { recursive: true, force: true });
  });

  it('keeps alternate CODEX_HOME no-telemetry projections pending with threshold warning evidence', async () => {
    const codexHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-empty-codex-home-'));
    const previousCodexHome = process.env.SYMPHONY_CODEX_HOME;
    process.env.SYMPHONY_CODEX_HOME = codexHomeDir;

    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            thread_id: 'thread-no-telemetry',
            tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            last_reported_tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            token_telemetry_status: 'pending',
            token_telemetry_last_source: null,
            token_telemetry_last_at_ms: null
          })
        ]
      ]),
      recent_runtime_events: [
        {
          at_ms: Date.parse('2026-04-10T10:02:30.000Z'),
          event: CANONICAL_EVENT.codex.tokenTelemetryMissingThresholdExceeded,
          severity: 'warn',
          issue_identifier: 'ABC-1',
          detail: 'token_telemetry_status=pending elapsed_ms=120001'
        }
      ]
    });

    server = new LocalApiServer({
      host: '127.0.0.1',
      port: 0,
      snapshotSource: {
        getStateSnapshot: () => state
      },
      refreshSource: { tick: async () => {} }
    });
    await server.listen();
    const address = server.address();

    const stateResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const statePayload = (await stateResponse.json()) as {
      running: Array<{
        token_telemetry_status: string;
        token_telemetry_last_source: string | null;
        token_telemetry_last_at_ms: number | null;
        tokens: { total_tokens: number };
      }>;
      recent_runtime_events: Array<{ event: string; severity: string; detail?: string }>;
    };
    const issueResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/ABC-1`);
    const issuePayload = (await issueResponse.json()) as {
      running: {
        token_telemetry_status: string;
        token_telemetry_last_source: string | null;
        token_telemetry_last_at_ms: number | null;
        tokens: { total_tokens: number };
      };
    };

    expect(stateResponse.status).toBe(200);
    expect(issueResponse.status).toBe(200);
    expect(statePayload.running[0]?.tokens.total_tokens).toBe(0);
    expect(statePayload.running[0]?.token_telemetry_status).toBe('pending');
    expect(statePayload.running[0]?.token_telemetry_last_source).toBeNull();
    expect(statePayload.running[0]?.token_telemetry_last_at_ms).toBeNull();
    expect(issuePayload.running.tokens.total_tokens).toBe(0);
    expect(issuePayload.running.token_telemetry_status).toBe('pending');
    expect(
      statePayload.recent_runtime_events.some(
        (event) =>
          event.event === CANONICAL_EVENT.codex.tokenTelemetryMissingThresholdExceeded && event.severity === 'warn'
      )
    ).toBe(true);

    if (previousCodexHome === undefined) {
      delete process.env.SYMPHONY_CODEX_HOME;
    } else {
      process.env.SYMPHONY_CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(codexHomeDir, { recursive: true, force: true });
  });

  it('serves GET /api/v1/:issue_identifier projection and returns 404 for unknown issue', async () => {
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            issue: makeIssue({ identifier: 'ABC-1' }),
            retry_attempt: 3,
            last_codex_timestamp_ms: null
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
        getActiveProfile: () => ({
          name: 'balanced',
          approval_policy: 'on-request',
          thread_sandbox: 'workspace-write',
          turn_sandbox_policy: { type: 'workspace' },
          user_input_policy: 'fail_attempt'
        }),
        getPersistenceHealth: () => ({
          enabled: true,
          db_path: '/tmp/test.sqlite',
          retention_days: 14,
          run_count: 1,
          last_pruned_at: null,
          integrity_ok: true
        }),
        getLoggingHealth: () => ({
          root: '/tmp/log',
          active_file: '/tmp/log/symphony.log',
          rotation: { max_bytes: 10485760, max_files: 5 },
          sinks: ['stderr', 'file']
        }),
        listRunHistory: () => [
          {
            run_id: 'run-1',
            issue_id: 'issue-1',
            issue_identifier: 'ABC-1',
            started_at: '2026-04-10T10:00:00.000Z',
            ended_at: '2026-04-10T10:01:00.000Z',
            terminal_status: 'succeeded',
            error_code: null,
            session_ids: ['thread-1-turn-1']
          }
        ],
        getUiState: () => ({
          selected_issue: 'ABC-1',
          filters: { status: 'all', query: '' },
          panel_state: { issue_detail_open: true }
        }),
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
        }),
        getBreakerStatuses: () => [
          {
            issue_id: 'issue-1',
            issue_identifier: 'ABC-1',
            breaker_active: true,
            breaker_hit_count: 4,
            breaker_window_minutes: 30,
            breaker_first_hit_at: '2026-04-10T10:00:00.000Z',
            breaker_last_hit_at: '2026-04-10T10:03:00.000Z'
          }
        ],
        getBlockedLatchStats: () => ({
          blocked_latch_active_count: 1,
          blocked_event_quarantine_total: 2,
          blocked_event_allowlist_total: 0,
          blocked_event_reject_total: 0,
          blocked_latch_violation_total: 0
        })
      }
    });

    await server.listen();
    const address = server.address();

    const knownResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/ABC-1`);
    const knownPayload = (await knownResponse.json()) as Record<string, unknown>;
    expect(knownResponse.status).toBe(200);
    expect(knownPayload.issue_identifier).toBe('ABC-1');
    expect(knownPayload.status).toBe('running');
    expect((knownPayload.workspace as { host: string | null }).host).toBeNull();
    expect((knownPayload.running as { session_id: string | null }).session_id).toBe('thread-1-turn-1');
    expect((knownPayload.running as { thread_id: string | null }).thread_id).toBe('thread-1');
    expect((knownPayload.running as { turn_id: string | null }).turn_id).toBe('turn-1');
    expect((knownPayload.running as { codex_app_server_pid: string | null }).codex_app_server_pid).toBe('9999');
    expect((knownPayload.running as { workspace_path: string | null }).workspace_path).toBe('/tmp/symphony/ABC-1');
    expect((knownPayload.logs as { codex_session_logs: unknown[] }).codex_session_logs).toEqual([]);
    expect(knownPayload.tracked).toEqual({});

    const missingResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/ABC-999`);
    const missingPayload = (await missingResponse.json()) as { error: { code: string; message: string } };
    expect(missingResponse.status).toBe(404);
    expect(missingPayload.error.code).toBe('issue_not_found');
    expect(missingPayload.error.message).toContain('ABC-999');
  });

  it('projects blocked issues and resumes them via POST /api/v1/issues/:issue_identifier/resume', async () => {
    const state = makeState({
      operator_actions: new Map([
        [
          'issue-3',
          [
            {
              action: 'resume',
              requested_at_ms: Date.parse('2026-04-10T10:04:00.000Z'),
              result: 'rejected',
              result_code: 'resume_failed',
              message: 'requires progress'
            }
          ]
        ]
      ]),
      blocked_inputs: new Map([
        [
          'issue-3',
          {
            issue_id: 'issue-3',
            issue_identifier: 'ABC-3',
            attempt: 2,
            worker_host: 'build-2',
            workspace_path: '/tmp/symphony/ABC-3',
            provisioner_type: 'worktree',
            branch_name: 'feature/ABC-3',
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
            blocked_at_ms: Date.parse('2026-04-10T10:03:00.000Z'),
            requires_manual_resume: true,
            pending_input: null,
            session_console: []
          }
        ]
      ])
    });
    const resumeBlockedIssue = vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3' }));

    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => state
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

    const stateResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const statePayload = (await stateResponse.json()) as {
      counts: { blocked: number };
      blocked: Array<{
        issue_identifier: string;
        requires_manual_resume: boolean;
        turn_control_state: string;
        progress_signal_state: string;
        operator_actions: Array<{ action: string; result: string }>;
      }>;
    };
    expect(stateResponse.status).toBe(200);
    expect(statePayload.counts.blocked).toBe(1);
    expect(statePayload.blocked[0]).toMatchObject({
      issue_identifier: 'ABC-3',
      requires_manual_resume: true,
      turn_control_state: 'blocked_manual_resume',
      progress_signal_state: 'advancing',
      operator_actions: [{ action: 'resume', result: 'rejected' }],
      conflict_files: [{ path: 'src/orchestrator/core.ts', status: 'unstaged' }]
    });

    const issueResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/ABC-3`);
    const issuePayload = (await issueResponse.json()) as {
      status: string;
      operator_actions: Array<{ action: string; result: string }>;
      blocked: { stop_reason_code: string; requires_manual_resume: boolean; turn_control_state: string };
    };
    expect(issueResponse.status).toBe(200);
    expect(issuePayload.status).toBe('blocked');
    expect(issuePayload.blocked).toMatchObject({
      stop_reason_code: 'operator_action_required_workspace_conflict',
      requires_manual_resume: true,
      turn_control_state: 'blocked_manual_resume',
      resolution_hints: ['Resolve branch/worktree mismatch before manual resume.']
    });
    expect(issuePayload.operator_actions).toEqual([{ action: 'resume', requested_at_ms: Date.parse('2026-04-10T10:04:00.000Z'), result: 'rejected', result_code: 'resume_failed', message: 'requires progress' }]);

    const resumeResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason_note: 'operator resolved conflict' })
    });
    const resumePayload = (await resumeResponse.json()) as { resumed: boolean; issue_identifier: string };
    expect(resumeResponse.status).toBe(202);
    expect(resumePayload).toMatchObject({
      resumed: true,
      issue_identifier: 'ABC-3'
    });
    expect(resumeBlockedIssue).toHaveBeenCalledWith('ABC-3', { actor: undefined, reason_note: 'operator resolved conflict' });
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

  it('requires confirmation before dispatching cancel blocked issue requests', async () => {
    const cancelBlockedIssue = vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3', moved_to_state: 'Todo' }));
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      issueControlSource: {
        resumeBlockedIssue: vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3' })),
        cancelBlockedIssue,
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
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cancel_reason: 'operator_cancel_return_to_backlog' })
    });
    const payload = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe('confirmation_required');
    expect(cancelBlockedIssue).not.toHaveBeenCalled();
  });

  it('accepts confirmed cancel blocked issue requests and returns destination state', async () => {
    const cancelBlockedIssue = vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3', moved_to_state: 'Todo' }));
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      issueControlSource: {
        resumeBlockedIssue: vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3' })),
        cancelBlockedIssue,
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
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cancel_reason: 'operator_cancel_return_to_backlog', confirmed: true })
    });
    const payload = (await response.json()) as { cancelled: boolean; issue_identifier: string; moved_to_state: string };

    expect(response.status).toBe(202);
    expect(payload.cancelled).toBe(true);
    expect(payload.issue_identifier).toBe('ABC-3');
    expect(payload.moved_to_state).toBe('Todo');
    expect(cancelBlockedIssue).toHaveBeenCalledWith('ABC-3', {
      actor: undefined,
      cancel_reason: 'operator_cancel_return_to_backlog',
      confirmed: true,
      reason_note: 'operator_cancel_return_to_backlog'
    });
  });

  it('accepts operator action console requests for cancel-turn, requeue, and retry-step', async () => {
    const cancelCurrentTurn = vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3' }));
    const requeueIssue = vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3', retry_attempt: 2 }));
    const retryLastFailedStep = vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3', retry_attempt: 3 }));
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      issueControlSource: {
        cancelCurrentTurn,
        requeueIssue,
        retryLastFailedStep,
        resumeBlockedIssue: vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3' })),
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
    const cancelResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/cancel-turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'ops@example.test', reason_note: 'stalled', confirmed: true })
    });
    const requeueResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/requeue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'ops@example.test', reason_note: 'rerun', confirmed: true })
    });
    const retryResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/retry-step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'ops@example.test', reason_note: 'retry failed step' })
    });

    expect(cancelResponse.status).toBe(202);
    expect(requeueResponse.status).toBe(202);
    expect(retryResponse.status).toBe(202);
    expect(cancelCurrentTurn).toHaveBeenCalledWith('ABC-3', {
      actor: 'ops@example.test',
      confirmed: true,
      reason_note: 'stalled'
    });
    expect(requeueIssue).toHaveBeenCalledWith('ABC-3', {
      actor: 'ops@example.test',
      confirmed: true,
      reason_note: 'rerun'
    });
    expect(retryLastFailedStep).toHaveBeenCalledWith('ABC-3', {
      actor: 'ops@example.test',
      reason_note: 'retry failed step'
    });
  });

  it('rejects missing or blank reason notes before dispatching operator actions', async () => {
    const cancelCurrentTurn = vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3' }));
    const requeueIssue = vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3', retry_attempt: 2 }));
    const retryLastFailedStep = vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3', retry_attempt: 3 }));
    const resumeBlockedIssue = vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3' }));
    const cancelBlockedIssue = vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3', moved_to_state: 'Todo' }));
    const submitBlockedIssueInput = vi.fn(async () => ({
      ok: true as const,
      issue_id: 'issue-3',
      request_id: 'req-1',
      resume_mode: 'fallback' as const,
      resume_reason_code: 'transport_unsupported',
      requested_at: '2026-05-04T00:00:00.000Z',
      request_lineage: { previous_thread_id: null, previous_session_id: null }
    }));
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      issueControlSource: {
        cancelCurrentTurn,
        requeueIssue,
        retryLastFailedStep,
        resumeBlockedIssue,
        cancelBlockedIssue,
        submitBlockedIssueInput
      }
    });

    await server.listen();
    const address = server.address();
    const requests = [
      fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/cancel-turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true })
      }),
      fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/requeue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason_note: '   ', confirmed: true })
      }),
      fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/retry-step`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      }),
      fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/resume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resume_override_reason: 'operator_override_push_additional_commit' })
      }),
      fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true })
      }),
      fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request_id: 'req-1', answer: { text: 'continue' } })
      })
    ];
    const responses = await Promise.all(requests);
    const payloads = await Promise.all(responses.map(async (response) => response.json() as Promise<{ error: { code: string } }>));

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400, 400]);
    expect(payloads.map((payload) => payload.error.code)).toEqual([
      'reason_note_required',
      'reason_note_required',
      'reason_note_required',
      'reason_note_required',
      'reason_note_required',
      'reason_note_required'
    ]);
    expect(cancelCurrentTurn).not.toHaveBeenCalled();
    expect(requeueIssue).not.toHaveBeenCalled();
    expect(retryLastFailedStep).not.toHaveBeenCalled();
    expect(resumeBlockedIssue).not.toHaveBeenCalled();
    expect(cancelBlockedIssue).not.toHaveBeenCalled();
    expect(submitBlockedIssueInput).not.toHaveBeenCalled();
  });

  it('maps unsupported operator transitions to typed conflict envelopes', async () => {
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      issueControlSource: {
        retryLastFailedStep: vi.fn(async () => ({
          ok: false as const,
          code: 'unsupported_transition',
          message: 'Issue ABC-3 has no failed or stalled retry step'
        })),
        resumeBlockedIssue: vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3' })),
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
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/retry-step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason_note: 'try anyway' })
    });
    const payload = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe('unsupported_transition');
  });

  it('accepts blocked input submit requests and resumes issue', async () => {
    const submitBlockedIssueInput = vi.fn(async () => ({
      ok: true as const,
      issue_id: 'issue-3',
      request_id: 'req-42',
      resume_mode: 'fallback' as const,
      resume_reason_code: 'transport_unsupported',
      requested_at: '2026-05-04T00:00:00.000Z',
      request_lineage: { previous_thread_id: 'thread-1', previous_session_id: 'session-1' }
    }));
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
        submitBlockedIssueInput
      }
    });

    await server.listen();
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request_id: 'req-42',
        actor: 'ops@example.test',
        reason_note: 'continue with answer',
        answer: { question_id: 'q-1', option_label: 'Continue' }
      })
    });
    const payload = (await response.json()) as {
      resumed: boolean;
      issue_identifier: string;
      request_id: string;
      resume_mode: string;
      resume_reason_code: string;
      request_lineage: { previous_thread_id: string | null; previous_session_id: string | null };
      requested_at: string;
    };

    expect(response.status).toBe(202);
    expect(payload.resumed).toBe(true);
    expect(payload.issue_identifier).toBe('ABC-3');
    expect(payload.request_id).toBe('req-42');
    expect(payload.resume_mode).toBe('fallback');
    expect(payload.resume_reason_code).toBe('transport_unsupported');
    expect(typeof payload.requested_at).toBe('string');
    expect(submitBlockedIssueInput).toHaveBeenCalledWith({
      issueIdentifier: 'ABC-3',
      request_id: 'req-42',
      actor: 'ops@example.test',
      reason_note: 'continue with answer',
      answer: { question_id: 'q-1', option_label: 'Continue' }
    });
  });

  it('returns 400 envelope when blocked input submit payload is invalid', async () => {
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

    const invalidJsonResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{'
    });
    const invalidJsonPayload = (await invalidJsonResponse.json()) as { error: { code: string } };
    expect(invalidJsonResponse.status).toBe(400);
    expect(invalidJsonPayload.error.code).toBe('invalid_input_submit');

    const missingFieldsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: 'req-42' })
    });
    const missingFieldsPayload = (await missingFieldsResponse.json()) as { error: { code: string } };
    expect(missingFieldsResponse.status).toBe(400);
    expect(missingFieldsPayload.error.code).toBe('invalid_input_submit');
  });

  it('maps blocked input submit validation failures to 422 envelope', async () => {
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
          code: 'invalid_answer',
          message: 'Answer payload is invalid for pending request schema'
        }))
      }
    });

    await server.listen();
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request_id: 'req-42',
        reason_note: 'answer request',
        answer: { text: '' }
      })
    });
    const payload = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(422);
    expect(payload.error.code).toBe('invalid_answer');
  });

  it('accepts refresh requests and coalesces bursts', async () => {
    const tick = vi.fn(async () => undefined);

    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick
      }
    });

    await server.listen();
    const address = server.address();

    const first = await fetch(`http://127.0.0.1:${address.port}/api/v1/refresh`, { method: 'POST' });
    const second = await fetch(`http://127.0.0.1:${address.port}/api/v1/refresh`, { method: 'POST' });

    const firstPayload = (await first.json()) as { queued: boolean; coalesced: boolean; operations: string[] };
    const secondPayload = (await second.json()) as { queued: boolean; coalesced: boolean; operations: string[] };

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(firstPayload.queued).toBe(true);
    expect(firstPayload.coalesced).toBe(false);
    expect(firstPayload.operations).toEqual(['poll', 'reconcile']);
    expect(secondPayload.coalesced).toBe(true);
  });

  it('serves embedded dashboard HTML at root path', async () => {
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
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    const payload = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(payload).toContain('Symphony Operator Control');
    expect(payload).toContain('/dashboard/client.js');
    expect(payload).toContain('/dashboard/styles.css');
  });

  it('serves shared dashboard script and styles assets', async () => {
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

    const scriptResponse = await fetch(`http://127.0.0.1:${address.port}/dashboard/client.js`);
    const scriptPayload = await scriptResponse.text();
    expect(scriptResponse.status).toBe(200);
    expect(scriptResponse.headers.get('content-type')).toContain('application/javascript');
    expect(scriptPayload).toContain('/api/v1/state');
    expect(scriptPayload).toContain('/api/v1/refresh');
    expect(scriptPayload).toContain('/api/v1/events');
    expect(scriptPayload).toContain('action-required-banner');
    expect(scriptPayload).toContain('api-degraded-banner');
    expect(scriptPayload).toContain('getTurnControlLabel');
    expect(scriptPayload).toContain('getProgressSignalLabel');
    expect(scriptPayload).toContain('getTokenConfidenceLabel');
    expect(scriptPayload).toContain('Operator Action Outcomes');
    expect(scriptPayload).toContain('Why not blocked:');
    expect(scriptPayload).toContain('operator_action_required_workspace_conflict');
    expect(scriptPayload).toContain('Awaiting Human Review (Scope Incomplete)');
    expect(scriptPayload).toContain('Blocked reason: \' + getActionRequiredLabel(payload.blocked.stop_reason_code)');
    expect(scriptPayload).toContain('formatApiError(payload, \'Request failed\')');
    expect(scriptPayload).toContain('setInterval(updateRuntimeClock, DASHBOARD_CONFIG.render_interval_ms)');

    const cssResponse = await fetch(`http://127.0.0.1:${address.port}/dashboard/styles.css`);
    const cssPayload = await cssResponse.text();
    expect(cssResponse.status).toBe(200);
    expect(cssResponse.headers.get('content-type')).toContain('text/css');
    expect(cssPayload).toContain('.layout');
    expect(cssPayload).toContain('.panel');
  });

  it('serves GET /api/v1/events as SSE and emits state snapshots with monotonic ids', async () => {
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry()
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

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    server.notifyStateChanged('test');
    server.notifyStateChanged('test');

    const events = await readSseEvents(response, 2);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0].event).toBe('symphony');
    expect((events[0].data.type as string) === 'state_snapshot' || (events[0].data.type as string) === 'runtime_health_changed').toBe(true);

    const ids = events.map((entry) => Number(entry.data.event_id)).filter((entry) => Number.isFinite(entry));
    expect(ids.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
  });

  it('emits refresh_accepted event envelopes on POST /api/v1/refresh', async () => {
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

    const streamResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/events`);
    expect(streamResponse.status).toBe(200);

    const refreshResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/refresh`, { method: 'POST' });
    expect(refreshResponse.status).toBe(202);

    const events = await readSseEvents(streamResponse, 2);
    const refreshEvent = events.find((entry) => entry.data.type === 'refresh_accepted');
    expect(refreshEvent).toBeDefined();
    expect(refreshEvent?.data.generated_at).toBeTypeOf('string');
  });

  it('logs bind diagnostics when the server begins listening', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];

    server = new LocalApiServer({
      host: '127.0.0.1',
      port: 0,
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      logger: {
        log: (params) => {
          logs.push({ event: params.event, context: params.context ?? {} });
        }
      }
    });

    await server.listen();

    const listening = logs.find((entry) => entry.event === CANONICAL_EVENT.api.serverListening);
    expect(listening).toBeDefined();
    expect(listening?.context.configured_port).toBe(0);
    expect(typeof listening?.context.port).toBe('number');
    expect(listening?.context.ephemeral_port).toBe(true);
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

  it('serves diagnostics, durable history, and ui continuity endpoints', async () => {
    const setUiState = vi.fn();

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
          run_count: 3,
          last_pruned_at: '2026-04-11T00:00:00.000Z',
          integrity_ok: true
        }),
        getLoggingHealth: () => ({
          root: '/tmp/log',
          active_file: '/tmp/log/symphony.log',
          rotation: { max_bytes: 10485760, max_files: 5 },
          sinks: ['stderr', 'file']
        }),
        listRunHistory: () => [
          {
            run_id: 'run-1',
            issue_id: 'issue-1',
            issue_identifier: 'ABC-1',
            started_at: '2026-04-10T10:00:00.000Z',
            ended_at: '2026-04-10T10:01:00.000Z',
            terminal_status: 'succeeded',
            error_code: null,
            session_ids: ['thread-1-turn-1']
          }
        ],
        reconstructThreadLineage: (threadId) =>
          threadId === 'thread-1'
            ? {
                issue_run: {
                  issue_run_id: 'issue_run_1',
                  issue_id: 'issue-1',
                  issue_identifier: 'ABC-1',
                  started_at: '2026-04-10T10:00:00.000Z',
                  ended_at: null,
                  status: 'running',
                  reason_code: 'dispatch_started',
                  reason_detail: null
                },
                attempt: {
                  attempt_id: 'attempt_1',
                  issue_run_id: 'issue_run_1',
                  attempt_number: 0,
                  started_at: '2026-04-10T10:00:01.000Z',
                  ended_at: null,
                  status: 'running',
                  reason_code: 'attempt_started',
                  reason_detail: null
                },
                thread: {
                  thread_id: 'thread-1',
                  attempt_id: 'attempt_1',
                  started_at: '2026-04-10T10:00:02.000Z',
                  ended_at: null,
                  status: 'running',
                  reason_code: 'codex_session_started',
                  reason_detail: null
                },
                turns: [],
                state_transitions: [
                  {
                    state_transition_id: 'state_transition_1',
                    issue_run_id: 'issue_run_1',
                    attempt_id: 'attempt_1',
                    thread_id: 'thread-1',
                    turn_id: null,
                    from_status: 'running',
                    to_status: 'retrying',
                    transitioned_at: '2026-04-10T10:01:00.000Z',
                    status: 'retrying',
                    reason_code: 'normal_completion',
                    reason_detail: 'continuation scheduled'
                  }
                ]
              }
            : null,
        getUiState: () => ({
          selected_issue: 'ABC-1',
          filters: { status: 'all', query: 'ABC' },
          panel_state: { issue_detail_open: false }
        }),
        setUiState,
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
        }),
        getBreakerStatuses: () => [
          {
            issue_id: 'issue-1',
            issue_identifier: 'ABC-1',
            breaker_active: true,
            breaker_hit_count: 4,
            breaker_window_minutes: 30,
            breaker_first_hit_at: '2026-04-10T10:00:00.000Z',
            breaker_last_hit_at: '2026-04-10T10:03:00.000Z'
          }
        ],
        getBlockedLatchStats: () => ({
          blocked_latch_active_count: 1,
          blocked_event_quarantine_total: 2,
          blocked_event_allowlist_total: 0,
          blocked_event_reject_total: 0,
          blocked_latch_violation_total: 0
        })
      }
    });

    await server.listen();
    const address = server.address();

    const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const diagnosticsPayload = (await diagnosticsResponse.json()) as {
      active_profile: { name: string };
      persistence: { retention_days: number };
      logging: { root: string; active_file: string; sinks: string[] };
      breaker_statuses: Array<{
        issue_identifier: string;
        breaker_active: boolean;
        breaker_hit_count: number;
        breaker_window_minutes: number;
        breaker_first_hit_at: string | null;
        breaker_last_hit_at: string | null;
      }>;
      event_vocabulary_version: string;
      workflow: {
        prompt_fallback_active: boolean;
      };
      token_accounting: {
        mode: string;
        canonical_precedence: string[];
        excludes_last_usage_for_totals: boolean;
        no_telemetry_warning_threshold_ms: number;
        observed_dimensions: {
          cached_input_tokens: boolean;
          reasoning_output_tokens: boolean;
          model_context_window: boolean;
        };
      };
      token_telemetry_status: 'unavailable' | 'pending' | 'available';
      token_telemetry_last_source: string | null;
      token_telemetry_last_at_ms: number | null;
      blocked_latch: {
        blocked_latch_active_count: number;
        blocked_event_quarantine_total: number;
        blocked_event_allowlist_total: number;
        blocked_event_reject_total: number;
        blocked_latch_violation_total: number;
      };
    };
    expect(diagnosticsResponse.status).toBe(200);
    expect(diagnosticsPayload.active_profile.name).toBe('balanced');
    expect(diagnosticsPayload.persistence.retention_days).toBe(14);
    expect(diagnosticsPayload.logging.root).toBe('/tmp/log');
    expect(diagnosticsPayload.logging.active_file).toBe('/tmp/log/symphony.log');
    expect(diagnosticsPayload.logging.sinks).toEqual(['stderr', 'file']);
    expect(diagnosticsPayload.breaker_statuses).toEqual([
      {
        issue_id: 'issue-1',
        issue_identifier: 'ABC-1',
        breaker_active: true,
        breaker_hit_count: 4,
        breaker_window_minutes: 30,
        breaker_first_hit_at: '2026-04-10T10:00:00.000Z',
        breaker_last_hit_at: '2026-04-10T10:03:00.000Z'
      }
    ]);
    expect(diagnosticsPayload.event_vocabulary_version).toBe(EVENT_VOCABULARY_VERSION);
    expect(diagnosticsPayload.workflow.prompt_fallback_active).toBe(false);
    expect(diagnosticsPayload.token_accounting.mode).toBe('strict_canonical');
    expect(diagnosticsPayload.token_accounting.canonical_precedence).toEqual([
      'terminal_turn_summary',
      'thread/tokenUsage/updated.params.tokenUsage.total',
      'params.info.total_token_usage',
      'params.info.totalTokenUsage',
      'params.total_token_usage',
      'params.totalTokenUsage',
      'params.usage.total_token_usage',
      'params.usage.totalTokenUsage',
      'last_token_usage',
      'persisted_fallback_usage'
    ]);
    expect(diagnosticsPayload.token_accounting.excludes_last_usage_for_totals).toBe(false);
    expect(diagnosticsPayload.token_accounting.no_telemetry_warning_threshold_ms).toBe(120_000);
    expect(diagnosticsPayload.token_telemetry_status).toBe('unavailable');
    expect(diagnosticsPayload.token_telemetry_last_source).toBeNull();
    expect(diagnosticsPayload.token_telemetry_last_at_ms).toBeNull();
    expect(diagnosticsPayload.blocked_latch).toEqual({
      blocked_latch_active_count: 1,
      blocked_event_quarantine_total: 2,
      blocked_event_allowlist_total: 0,
      blocked_event_reject_total: 0,
      blocked_latch_violation_total: 0
    });
    expect(diagnosticsPayload.token_accounting.observed_dimensions.cached_input_tokens).toBe(false);
    expect((diagnosticsPayload as Record<string, unknown>).runtime_resolution).toMatchObject({
      workflow_path: '/tmp/WORKFLOW.md',
      workspace_root: '/tmp/workspaces'
    });

    const historyResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/history?limit=1`);
    const historyPayload = (await historyResponse.json()) as { runs: Array<{ run_id: string }> };
    expect(historyResponse.status).toBe(200);
    expect(historyPayload.runs[0].run_id).toBe('run-1');

    const lineageResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/history/threads/thread-1`);
    const lineagePayload = (await lineageResponse.json()) as {
      lineage: {
        issue_run: { issue_identifier: string };
        thread: { thread_id: string };
        state_transitions: Array<{ to_status: string; reason_code: string | null }>;
      };
    };
    expect(lineageResponse.status).toBe(200);
    expect(lineagePayload.lineage.issue_run.issue_identifier).toBe('ABC-1');
    expect(lineagePayload.lineage.thread.thread_id).toBe('thread-1');
    expect(lineagePayload.lineage.state_transitions[0]).toMatchObject({
      to_status: 'retrying',
      reason_code: 'normal_completion'
    });

    const uiStateResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/ui-state`);
    const uiStatePayload = (await uiStateResponse.json()) as {
      state: { selected_issue: string | null; filters: { query: string } };
    };
    expect(uiStateResponse.status).toBe(200);
    expect(uiStatePayload.state.selected_issue).toBe('ABC-1');

    const saveResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/ui-state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        state: {
          selected_issue: 'ABC-2',
          filters: { status: 'running', query: 'token=secret123' },
          event_feed_filter: 'warn',
          panels: {
            throughput_open: false,
            runtime_events_open: true
          },
          panel_state: { issue_detail_open: true }
        }
      })
    });

    expect(saveResponse.status).toBe(202);
    expect(setUiState).toHaveBeenCalledWith({
      selected_issue: 'ABC-2',
      filters: { status: 'running', query: 'token=secret123' },
      event_feed_filter: 'warn',
      panels: {
        throughput_open: false,
        runtime_events_open: true
      },
      panel_state: { issue_detail_open: true }
    });
  });

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
    expect(byThreadPayload.current_blocker?.classification).toBe('tool_waiting_long');
    expect(byThreadPayload.current_blocker?.recommended_actions.length).toBeGreaterThan(0);
    expect(byThreadPayload.last_meaningful_progress_at_ms).toBe(Date.parse('2026-04-10T10:00:10.000Z'));

    const byIssueResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-1/diagnostics`);
    const byIssuePayload = (await byIssueResponse.json()) as { thread_id: string; current_blocker: { classification: string } };
    expect(byIssueResponse.status).toBe(200);
    expect(byIssuePayload.thread_id).toBe('thread-1');
    expect(byIssuePayload.current_blocker.classification).toBe('tool_waiting_long');
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
    expect(payload.current_blocker?.classification).toBe('tool_waiting_long');
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

  it('reports observed token accounting dimensions in diagnostics from state snapshot', async () => {
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            token_telemetry_status: 'available',
            token_telemetry_last_source: 'terminal_turn_summary',
            token_telemetry_last_at_ms: Date.parse('2026-04-10T10:01:00.000Z')
          })
        ]
      ]),
      codex_totals: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        cached_input_tokens: 25,
        reasoning_output_tokens: 7,
        model_context_window: 128000,
        seconds_running: 10
      }
    });

    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => state
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
          enabled: false,
          db_path: null,
          retention_days: 14,
          run_count: 0,
          last_pruned_at: null,
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
    const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const diagnosticsPayload = (await diagnosticsResponse.json()) as {
      token_accounting: {
        observed_dimensions: {
          cached_input_tokens: boolean;
          reasoning_output_tokens: boolean;
          model_context_window: boolean;
        };
      };
      token_telemetry_status: 'unavailable' | 'pending' | 'available';
      token_telemetry_last_source: string | null;
      token_telemetry_last_at_ms: number | null;
    };

    expect(diagnosticsResponse.status).toBe(200);
    expect(diagnosticsPayload.token_accounting.observed_dimensions).toEqual({
      cached_input_tokens: true,
      reasoning_output_tokens: true,
      model_context_window: true
    });
    expect(diagnosticsPayload.token_telemetry_status).toBe('available');
    expect(diagnosticsPayload.token_telemetry_last_source).toBe('terminal_turn_summary');
    expect(diagnosticsPayload.token_telemetry_last_at_ms).toBe(Date.parse('2026-04-10T10:01:00.000Z'));
    expect((diagnosticsPayload as Record<string, unknown>).runtime_resolution).toMatchObject({
      workflow_path: '/tmp/WORKFLOW.md',
      workspace_root: '/tmp/workspaces',
      workspace_root_source: 'workflow'
    });
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

  it('supports workflow path switch and force reload controls when configured', async () => {
    const switchWorkflowPath = vi.fn(async (workflowPath: string) => ({
      workflow_path: workflowPath,
      applied: true
    }));
    const forceReload = vi.fn(async () => ({
      workflow_path: '/tmp/WORKFLOW.md',
      applied: true
    }));

    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      workflowControlSource: {
        switchWorkflowPath,
        forceReload
      }
    });

    await server.listen();
    const address = server.address();

    const switchResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/workflow/path`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow_path: '/tmp/WORKFLOW.next.md' })
    });
    expect(switchResponse.status).toBe(202);
    expect(switchWorkflowPath).toHaveBeenCalledWith('/tmp/WORKFLOW.next.md');

    const forceResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/workflow/reload`, {
      method: 'POST'
    });
    expect(forceResponse.status).toBe(202);
    expect(forceReload).toHaveBeenCalledTimes(1);
  });

  it('returns deterministic workflow control errors for invalid payload or failed reload', async () => {
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      workflowControlSource: {
        switchWorkflowPath: vi.fn(async () => ({
          workflow_path: '/tmp/WORKFLOW.md',
          applied: false,
          error: 'parse failed'
        })),
        forceReload: vi.fn(async () => ({
          workflow_path: '/tmp/WORKFLOW.md',
          applied: false,
          error: 'reload failed'
        }))
      }
    });

    await server.listen();
    const address = server.address();

    const invalidResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/workflow/path`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    expect(invalidResponse.status).toBe(400);
    expect((await invalidResponse.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'invalid_workflow_path' }
    });

    const failedSwitchResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/workflow/path`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow_path: '/tmp/WORKFLOW.md' })
    });
    expect(failedSwitchResponse.status).toBe(422);
    expect((await failedSwitchResponse.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'workflow_reload_failed' }
    });

    const failedReloadResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/workflow/reload`, {
      method: 'POST'
    });
    expect(failedReloadResponse.status).toBe(422);
    expect((await failedReloadResponse.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'workflow_reload_failed' }
    });
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
