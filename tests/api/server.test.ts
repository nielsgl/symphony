import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalApiServer } from '../../src/api';
import type { OrchestratorState } from '../../src/orchestrator';
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
    ...overrides
  };
}

let server: LocalApiServer | null = null;

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

describe('LocalApiServer', () => {
  it('serves GET /api/v1/state with required baseline fields', async () => {
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          {
            issue: makeIssue(),
            identifier: 'ABC-1',
            worker_handle: {},
            monitor_handle: {},
            retry_attempt: 0,
            started_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
            last_codex_timestamp_ms: Date.parse('2026-04-10T10:01:00.000Z')
          }
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
  });

  it('serves GET /api/v1/:issue_identifier projection and returns 404 for unknown issue', async () => {
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          {
            issue: makeIssue({ identifier: 'ABC-1' }),
            identifier: 'ABC-1',
            worker_handle: {},
            monitor_handle: {},
            retry_attempt: 3,
            started_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
            last_codex_timestamp_ms: null
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
      }
    });

    await server.listen();
    const address = server.address();

    const knownResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/ABC-1`);
    const knownPayload = (await knownResponse.json()) as Record<string, unknown>;
    expect(knownResponse.status).toBe(200);
    expect(knownPayload.issue_identifier).toBe('ABC-1');
    expect(knownPayload.status).toBe('running');

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
});
