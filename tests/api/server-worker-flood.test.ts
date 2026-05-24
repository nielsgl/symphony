import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  CANONICAL_EVENT,
  LocalApiServer,
  REASON_CODES,
  closeServerAfterEach,
  makeDiagnosticsSource,
  makeIssue,
  makeRunningEntry,
  makeState,
  readSseEvents
} from './server-test-harness';

let server: LocalApiServer | null = null;

closeServerAfterEach(
  () => server,
  (nextServer) => {
    server = nextServer;
  }
);

async function fetchWithin(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function workerFloodState(nowMs: number) {
  const running = new Map(
    Array.from({ length: 6 }, (_value, index) => {
      const issueIdentifier = `NIE-FLOOD-${index + 1}`;
      const issueId = `issue-flood-${index + 1}`;
      const entry = makeRunningEntry({
        issue: makeIssue({ id: issueId, identifier: issueIdentifier, title: `Flood worker ${index + 1}` }),
        identifier: issueIdentifier,
        run_id: `run-flood-${index + 1}`,
        issue_run_id: `issue-run-flood-${index + 1}`,
        attempt_id: `attempt-flood-${index + 1}`,
        worker_instance_id: `worker-flood-${index + 1}`,
        session_id: `session-flood-${index + 1}`,
        thread_id: `thread-flood-${index + 1}`,
        turn_id: `turn-flood-${index + 1}`,
        codex_app_server_pid: `${9000 + index}`,
        last_event: CANONICAL_EVENT.codex.turnWaiting,
        last_event_summary: 'codex turn waiting: waiting for tool output',
        last_message: 'waiting for tool output',
        tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        last_reported_tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        token_telemetry_status: 'pending',
        token_telemetry_last_source: null,
        token_telemetry_last_at_ms: null,
        running_waiting_started_at_ms: nowMs - 45_000,
        stalled_waiting_since_ms: nowMs - 5 * 60_000,
        stalled_waiting_reason: REASON_CODES.turnWaitingThresholdExceeded,
        last_heartbeat_at_ms: nowMs - 500,
        last_progress_transition_at_ms: nowMs - 8 * 60_000,
        current_phase: 'planning',
        current_phase_at_ms: nowMs - 8 * 60_000,
        phase_detail: 'planning heartbeat flood',
        rate_limits: {
          primary: {
            used_percent: 96 + index,
            resets_in_seconds: 60 + index
          }
        },
        recent_events: Array.from({ length: 12 }, (_event, eventIndex) => ({
          at_ms: nowMs - eventIndex * 250,
          event:
            eventIndex % 3 === 0
              ? CANONICAL_EVENT.codex.phasePlanning
              : eventIndex % 3 === 1
                ? CANONICAL_EVENT.codex.turnWaiting
                : CANONICAL_EVENT.codex.rateLimitsUpdated,
          message:
            eventIndex % 3 === 0
              ? 'planning heartbeat'
              : eventIndex % 3 === 1
                ? 'waiting for tool output'
                : 'rate limits updated'
        }))
      });
      return [issueId, entry] as const;
    })
  );

  return makeState({
    running,
    codex_rate_limits: {
      aggregate: {
        used_percent: 99,
        resets_in_seconds: 30
      }
    },
    quiescence: {
      safe_to_shutdown: false,
      state: 'blocked',
      updated_at_ms: nowMs,
      blockers: [
        {
          category: 'active_worker',
          count: running.size,
          issue_identifiers: Array.from(running.values()).map((entry) => entry.identifier),
          detail: 'Active worker flood is in progress.'
        }
      ],
      blocker_counts: {
        active_worker: running.size,
        live_codex_app_server_process: running.size,
        pending_retry: 0,
        in_flight_tracker_write: 0,
        persistence_history_write: 0,
        unknown_degraded_blocker_source_health: 0,
        stale_runtime: 0,
        unknown_current_build_identity: 0
      },
      warnings: [],
      restart_guidance: {
        safe_to_restart: false,
        recommended_action: 'wait_for_true_shutdown_blockers',
        pending_work: [
          {
            state: 'running',
            count: running.size,
            maintenance_eligible: false
          }
        ],
        detail: 'Wait for noisy active workers before restart.'
      }
    }
  });
}

describe('LocalApiServer live worker flood responsiveness', () => {
  it('keeps state, diagnostics, and SSE snapshots bounded under worker heartbeat and rate-limit pressure', async () => {
    const previousCodexHome = process.env.SYMPHONY_CODEX_HOME;
    const codexHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-worker-flood-empty-codex-home-'));
    process.env.SYMPHONY_CODEX_HOME = codexHomeDir;

    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: ConstructorParameters<typeof LocalApiServer>[0]['logger'] = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    let now = Date.parse('2026-05-12T10:00:00.000Z');
    const state = workerFloodState(now);

    server = new LocalApiServer({
      host: '127.0.0.1',
      port: 0,
      snapshotSource: {
        getStateSnapshot: vi.fn(() => state)
      },
      refreshSource: { tick: async () => {} },
      diagnosticsSource: makeDiagnosticsSource(),
      logger,
      nowMs: () => {
        now += 5;
        return now;
      }
    });
    await server.listen();
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const streamResponse = await fetch(`${baseUrl}/api/v1/events`);
    const [stateResponse, diagnosticsResponse, events] = await Promise.all([
      fetchWithin(`${baseUrl}/api/v1/state`, 750),
      fetchWithin(`${baseUrl}/api/v1/diagnostics`, 750),
      readSseEvents(streamResponse, 1, 750)
    ]);
    const statePayload = (await stateResponse.json()) as {
      api_degraded_mode: boolean;
      running: Array<{ stalled_waiting: boolean; rate_limits: Record<string, unknown> | null }>;
      rate_limits: Record<string, unknown> | null;
      health: { control_plane?: { endpoints: Array<{ endpoint: string; transport: string }> } };
      worker_event_pressure?: {
        active_worker_count: number;
        waiting_worker_count: number;
        rate_limited_worker_count: number;
        recent_worker_event_count: number;
        recent_waiting_event_count: number;
        recent_rate_limit_event_count: number;
        degraded: boolean;
        reason_code: string | null;
      };
    };
    const diagnosticsPayload = (await diagnosticsResponse.json()) as {
      token_enrichment: { status: string; degraded: boolean; reason_code: string | null };
      worker_event_pressure?: {
        active_worker_count: number;
        waiting_worker_count: number;
        rate_limited_worker_count: number;
        recent_worker_event_count: number;
        recent_waiting_event_count: number;
        recent_rate_limit_event_count: number;
        degraded: boolean;
        reason_code: string | null;
      };
      control_plane: {
        endpoints: Array<{
          endpoint: string;
          transport: string;
          last_enrichment_status: string | null;
          last_enrichment_degraded: boolean | null;
          last_enrichment_reason_code: string | null;
          last_broadcast_client_count: number | null;
        }>;
      };
    };
    const diagnosticsAfterResponse = await fetchWithin(`${baseUrl}/api/v1/diagnostics`, 750);
    const diagnosticsAfterPayload = (await diagnosticsAfterResponse.json()) as {
      control_plane: {
        endpoints: Array<{
          endpoint: string;
          transport: string;
        }>;
      };
    };
    const stateSnapshotEvent = events.find((entry) => entry.data.type === 'state_snapshot');
    const ssePayload = stateSnapshotEvent?.data.payload as {
      state?: {
        running: Array<{ stalled_waiting: boolean; rate_limits: Record<string, unknown> | null }>;
        api_degraded_mode: boolean;
        worker_event_pressure?: {
          active_worker_count: number;
          degraded: boolean;
          reason_code: string | null;
        };
      };
    };

    expect(stateResponse.status).toBe(200);
    expect(diagnosticsResponse.status).toBe(200);
    expect(streamResponse.status).toBe(200);
    expect(statePayload.running).toHaveLength(6);
    expect(statePayload.running.every((entry) => entry.stalled_waiting && entry.rate_limits)).toBe(true);
    expect(statePayload.rate_limits).toMatchObject({ aggregate: { used_percent: 99 } });
    expect(statePayload.api_degraded_mode).toBe(false);
    expect(statePayload.worker_event_pressure).toMatchObject({
      active_worker_count: 6,
      waiting_worker_count: 6,
      rate_limited_worker_count: 6,
      recent_worker_event_count: 72,
      recent_waiting_event_count: 48,
      recent_rate_limit_event_count: 24,
      degraded: true,
      reason_code: REASON_CODES.workerEventPressure
    });
    expect(diagnosticsPayload.token_enrichment).toMatchObject({
      status: 'degraded',
      degraded: true,
      reason_code: REASON_CODES.liveTokenFallbackNotOnHotPath
    });
    expect(diagnosticsPayload.worker_event_pressure).toMatchObject({
      active_worker_count: 6,
      waiting_worker_count: 6,
      rate_limited_worker_count: 6,
      recent_worker_event_count: 72,
      recent_waiting_event_count: 48,
      recent_rate_limit_event_count: 24,
      degraded: true,
      reason_code: REASON_CODES.workerEventPressure
    });
    expect(ssePayload?.state?.running).toHaveLength(6);
    expect(ssePayload?.state?.running.every((entry) => entry.stalled_waiting && entry.rate_limits)).toBe(true);
    expect(ssePayload?.state?.api_degraded_mode).toBe(false);
    expect(ssePayload?.state?.worker_event_pressure).toMatchObject({
      active_worker_count: 6,
      degraded: true,
      reason_code: REASON_CODES.workerEventPressure
    });

    const stateHealth = diagnosticsPayload.control_plane.endpoints.find((entry) => entry.endpoint === '/api/v1/state');
    const diagnosticsHealth = diagnosticsPayload.control_plane.endpoints.find((entry) => entry.endpoint === '/api/v1/diagnostics');
    const sseHealth = diagnosticsPayload.control_plane.endpoints.find(
      (entry) => entry.endpoint === '/api/v1/events:state_snapshot' && entry.transport === 'sse'
    );
    expect(stateHealth).toMatchObject({
      last_enrichment_status: 'degraded',
      last_enrichment_degraded: true,
      last_enrichment_reason_code: REASON_CODES.liveTokenFallbackNotOnHotPath
    });
    expect(diagnosticsAfterResponse.status).toBe(200);
    expect(diagnosticsHealth).toBeUndefined();
    expect(diagnosticsAfterPayload.control_plane.endpoints.find((entry) => entry.endpoint === '/api/v1/diagnostics')).toBeDefined();
    expect(sseHealth).toMatchObject({
      last_broadcast_client_count: 1,
      last_enrichment_status: 'degraded',
      last_enrichment_degraded: true,
      last_enrichment_reason_code: REASON_CODES.liveTokenFallbackNotOnHotPath
    });
    expect(logs.some((entry) => entry.event === CANONICAL_EVENT.api.stateRequested)).toBe(true);

    if (previousCodexHome === undefined) {
      delete process.env.SYMPHONY_CODEX_HOME;
    } else {
      process.env.SYMPHONY_CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(codexHomeDir, { recursive: true, force: true });
  });
});
