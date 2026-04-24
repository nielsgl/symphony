import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalApiServer } from '../../src/api';
import { LocalApiError } from '../../src/api/errors';
import type { OrchestratorState } from '../../src/orchestrator';
import { CANONICAL_EVENT, EVENT_VOCABULARY_VERSION } from '../../src/observability/events';
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
    expect(payload).toHaveProperty('codex_totals');
    expect(payload).toHaveProperty('rate_limits');
    expect(payload).toHaveProperty('health');
    expect((payload.counts as { running: number; retrying: number }).running).toBe(1);
    expect((payload.counts as { running: number; retrying: number }).retrying).toBe(1);
    expect((payload.running as Array<{ workspace_path: string }>)[0]).toMatchObject({
      workspace_path: '/tmp/symphony/ABC-1'
    });
    expect((payload.retrying as Array<{ worker_host: string; workspace_path: string }>)[0]).toMatchObject({
      worker_host: 'build-1',
      workspace_path: '/tmp/symphony/ABC-2'
    });
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
          last_error_code: null
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
          last_error_code: null
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
      event_vocabulary_version: string;
      workflow: {
        prompt_fallback_active: boolean;
      };
      token_accounting: {
        mode: string;
        canonical_precedence: string[];
        observed_dimensions: {
          cached_input_tokens: boolean;
          reasoning_output_tokens: boolean;
          model_context_window: boolean;
        };
      };
    };
    expect(diagnosticsResponse.status).toBe(200);
    expect(diagnosticsPayload.active_profile.name).toBe('balanced');
    expect(diagnosticsPayload.persistence.retention_days).toBe(14);
    expect(diagnosticsPayload.logging.root).toBe('/tmp/log');
    expect(diagnosticsPayload.logging.active_file).toBe('/tmp/log/symphony.log');
    expect(diagnosticsPayload.logging.sinks).toEqual(['stderr', 'file']);
    expect(diagnosticsPayload.event_vocabulary_version).toBe(EVENT_VOCABULARY_VERSION);
    expect(diagnosticsPayload.workflow.prompt_fallback_active).toBe(false);
    expect(diagnosticsPayload.token_accounting.mode).toBe('strict_canonical');
    expect(diagnosticsPayload.token_accounting.canonical_precedence).toEqual([
      'thread/tokenUsage/updated.params.tokenUsage.total',
      'params.info.total_token_usage',
      'params.info.totalTokenUsage',
      'params.total_token_usage',
      'params.totalTokenUsage'
    ]);
    expect(diagnosticsPayload.token_accounting.observed_dimensions.cached_input_tokens).toBe(false);
    expect((diagnosticsPayload as Record<string, unknown>).runtime_resolution).toMatchObject({
      workflow_path: '/tmp/WORKFLOW.md',
      workspace_root: '/tmp/workspaces'
    });

    const historyResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/history?limit=1`);
    const historyPayload = (await historyResponse.json()) as { runs: Array<{ run_id: string }> };
    expect(historyResponse.status).toBe(200);
    expect(historyPayload.runs[0].run_id).toBe('run-1');

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

  it('reports observed token accounting dimensions in diagnostics from state snapshot', async () => {
    const state = makeState({
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
          last_error_code: null
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
    };

    expect(diagnosticsResponse.status).toBe(200);
    expect(diagnosticsPayload.token_accounting.observed_dimensions).toEqual({
      cached_input_tokens: true,
      reasoning_output_tokens: true,
      model_context_window: true
    });
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
          last_error_code: null
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
