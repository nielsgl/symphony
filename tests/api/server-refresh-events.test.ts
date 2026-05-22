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

async function waitForMockCallCount(mock: ReturnType<typeof vi.fn>, expectedCalls: number, timeoutMs: number = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (mock.mock.calls.length < expectedCalls && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(mock).toHaveBeenCalledTimes(expectedCalls);
}

describe('LocalApiServer refresh and events', () => {
  it('accepts refresh requests and coalesces requests inside the scheduled flush window', async () => {
    const tick = vi.fn(async () => undefined);

    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick
      },
      refreshCoalesceWindowMs: 60_000
    });

    await server.listen();
    const address = server.address();

    // API-level coalescing is defined for requests accepted while a scheduled
    // refresh flush is pending; it is not a Promise.all request ordering
    // guarantee across the HTTP server and the coalescer's timer.
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

  it('coalesces API refresh requests while a manual refresh tick is in flight', async () => {
    const currentTick = deferred();
    const tick = vi.fn(async () => await currentTick.promise);

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
    expect(first.status).toBe(202);

    await waitForMockCallCount(tick, 1);

    const second = await fetch(`http://127.0.0.1:${address.port}/api/v1/refresh`, { method: 'POST' });
    const third = await fetch(`http://127.0.0.1:${address.port}/api/v1/refresh`, { method: 'POST' });
    const secondPayload = (await second.json()) as { coalesced: boolean };
    const thirdPayload = (await third.json()) as { coalesced: boolean };

    expect(second.status).toBe(202);
    expect(third.status).toBe(202);
    expect(secondPayload.coalesced).toBe(true);
    expect(thirdPayload.coalesced).toBe(true);

    currentTick.resolve();
    await waitForMockCallCount(tick, 2);
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

  it('serves SSE state snapshots without stopped-run diagnostic fan-out', async () => {
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            transcript_tool_call_diagnostics: Array.from({ length: 200 }, (_, index) => makeTranscriptDiagnostic(index))
          })
        ]
      ])
    });
    const listRunHistory = vi.fn(() => [
      {
        run_id: 'run-stopped',
        issue_id: 'issue-stopped',
        issue_identifier: 'ABC-STOPPED',
        started_at: '2026-04-10T09:00:00.000Z',
        ended_at: '2026-04-10T09:05:00.000Z',
        terminal_status: 'failed',
        error_code: 'failed_phase',
        session_ids: ['thread-stopped'],
        thread_id: 'thread-stopped'
      }
    ]);
    const reconstructThreadLineage = vi.fn(() => makeThreadLineage({ thread_id: 'thread-stopped' }));

    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => state
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

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/events`);
    expect(response.status).toBe(200);

    const events = await readSseEvents(response, 1);
    const stateSnapshotEvent = events.find((entry) => entry.data.type === 'state_snapshot');
    expect(stateSnapshotEvent).toBeDefined();
    const payload = stateSnapshotEvent?.data.payload as {
      state?: {
        running?: Array<Record<string, unknown>>;
        stopped_runs?: unknown[];
        counts?: { stopped: number };
      };
    };

    expect(listRunHistory).not.toHaveBeenCalled();
    expect(reconstructThreadLineage).not.toHaveBeenCalled();
    expect(payload.state?.stopped_runs).toEqual([]);
    expect(payload.state?.counts?.stopped).toBe(0);
    expect(JSON.stringify(payload.state)).not.toContain('transcript_tool_call_diagnostics');
    expect(JSON.stringify(payload.state)).not.toContain('active_issue_id');
    expect(payload.state?.running?.[0]).toHaveProperty('transcript_tool_call_diagnostic_summary');

    const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const diagnosticsPayload = (await diagnosticsResponse.json()) as {
      stream: {
        live_client_count: number;
        last_client_connected_at: string | null;
        last_snapshot_broadcast_at: string | null;
        last_snapshot_broadcast_latency_ms: number | null;
        last_snapshot_broadcast_status: string | null;
        last_snapshot_broadcast_error: string | null;
      };
      control_plane: {
        endpoints: Array<{ endpoint: string; transport: string; last_payload_bytes: number | null; last_broadcast_client_count: number | null }>;
      };
    };
    const sseHealth = diagnosticsPayload.control_plane.endpoints.find(
      (entry) => entry.endpoint === '/api/v1/events:state_snapshot'
    );
    expect(sseHealth).toMatchObject({
      endpoint: '/api/v1/events:state_snapshot',
      transport: 'sse',
      last_broadcast_client_count: 1
    });
    expect(sseHealth?.last_payload_bytes).toBeGreaterThan(0);
    expect(diagnosticsPayload.stream).toMatchObject({
      last_snapshot_broadcast_status: 'ok',
      last_snapshot_broadcast_error: null
    });
    expect(diagnosticsPayload.stream.live_client_count).toBeGreaterThanOrEqual(0);
    expect(diagnosticsPayload.stream.last_client_connected_at).toBeTruthy();
    expect(diagnosticsPayload.stream.last_snapshot_broadcast_at).toBeTruthy();
    expect(diagnosticsPayload.stream.last_snapshot_broadcast_latency_ms).toEqual(expect.any(Number));
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
});
