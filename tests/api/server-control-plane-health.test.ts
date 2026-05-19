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
import type { DurableIdentity, EventLoopHealthSummary, ForensicsBundle } from './server-test-harness';

let server: LocalApiServer | null = null;

closeServerAfterEach(
  () => server,
  (nextServer) => {
    server = nextServer;
  }
);

describe('LocalApiServer control-plane health', () => {
  it('keeps the 2026-05-08 overload class bounded across polling, detail, SSE, refresh, and telemetry', async () => {
    const diagnosticsPerRun = 200;
    const running = new Map(
      Array.from({ length: 4 }, (_, runIndex) => {
        const issueId = `issue-overload-${runIndex + 1}`;
        const issueIdentifier = `ABC-OVERLOAD-${runIndex + 1}`;
        const observedBase = runIndex * diagnosticsPerRun;
        return [
          issueId,
          makeRunningEntry({
            issue: makeIssue({ id: issueId, identifier: issueIdentifier }),
            identifier: issueIdentifier,
            run_id: `run-overload-${runIndex + 1}`,
            issue_run_id: `issue-run-overload-${runIndex + 1}`,
            attempt_id: `attempt-overload-${runIndex + 1}`,
            session_id: `session-overload-${runIndex + 1}`,
            thread_id: `thread-overload-${runIndex + 1}`,
            turn_id: `turn-overload-${runIndex + 1}`,
            worker_host: 'laptop-1',
            tokens: {
              input_tokens: 250_000 + runIndex,
              output_tokens: 125_000 + runIndex,
              total_tokens: 375_000 + runIndex,
              model_context_window: 1_000_000
            },
            transcript_tool_call_diagnostics: Array.from({ length: diagnosticsPerRun }, (_, diagnosticIndex) =>
              makeTranscriptDiagnostic(observedBase + diagnosticIndex, {
                issue_id: issueId,
                issue_identifier: issueIdentifier,
                run_id: `run-overload-${runIndex + 1}`,
                issue_run_id: `issue-run-overload-${runIndex + 1}`,
                attempt_id: `attempt-overload-${runIndex + 1}`,
                active_issue_id: issueId,
                active_issue_identifier: issueIdentifier,
                active_run_id: `run-overload-${runIndex + 1}`,
                active_issue_run_id: `issue-run-overload-${runIndex + 1}`,
                active_attempt_id: `attempt-overload-${runIndex + 1}`
              })
            ),
            tool_call_ledger: {
              [`call-overload-${runIndex + 1}`]: {
                call_id: `call-overload-${runIndex + 1}`,
                tool_name: 'exec_command',
                thread_id: `thread-overload-${runIndex + 1}`,
                turn_id: `turn-overload-${runIndex + 1}`,
                session_id: `session-overload-${runIndex + 1}`,
                issue_id: issueId,
                issue_identifier: issueIdentifier,
                run_id: `run-overload-${runIndex + 1}`,
                issue_run_id: `issue-run-overload-${runIndex + 1}`,
                attempt_id: `attempt-overload-${runIndex + 1}`,
                first_seen_at_ms: Date.parse('2026-04-10T10:01:00.000Z') + runIndex,
                last_seen_at_ms: Date.parse('2026-04-10T10:02:00.000Z') + runIndex,
                completed_at_ms: null,
                completion_status: 'pending',
                evidence_sources: ['session_transcript'],
                start_evidence_source: 'session_transcript',
                completion_evidence_source: null,
                last_agent_message: 'waiting for exec_command output'
              }
            },
            tool_output_wait:
              runIndex === 0
                ? {
                    tool_name: 'exec_command',
                    call_id: 'call-overload-1',
                    thread_id: 'thread-overload-1',
                    turn_id: 'turn-overload-1',
                    session_id: 'session-overload-1',
                    elapsed_wait_ms: 51_000,
                    last_agent_message: 'waiting for exec_command output',
                    evidence_source: 'session_transcript',
                    recommended_actions: ['Inspect diagnostics']
                  }
                : null
          })
        ];
      })
    );
    const state = makeState({
      running,
      codex_totals: {
        input_tokens: 1_000_000,
        output_tokens: 500_000,
        total_tokens: 1_500_000,
        seconds_running: 0
      }
    });
    const getStateSnapshot = vi.fn(() => state);
    const listRunHistory = vi.fn((limit: number) =>
      Array.from({ length: Math.min(limit, 30) }, (_, index) => ({
        run_id: `run-stopped-${index}`,
        issue_id: `issue-stopped-${index}`,
        issue_identifier: `ABC-STOPPED-${index}`,
        started_at: '2026-04-10T09:00:00.000Z',
        ended_at: '2026-04-10T09:05:00.000Z',
        terminal_status: 'failed',
        error_code: 'failed_phase',
        session_ids: [`thread-stopped-${index}`],
        thread_id: `thread-stopped-${index}`
      }))
    );
    const reconstructThreadLineage = vi.fn((threadId: string) => makeThreadLineage({ thread_id: threadId }));
    const refreshTick = vi.fn(async () => undefined);

    server = new LocalApiServer({
      snapshotSource: { getStateSnapshot },
      refreshSource: { tick: refreshTick },
      diagnosticsSource: makeDiagnosticsSource({
        listRunHistory,
        reconstructThreadLineage
      }),
      nowMs: () => Date.parse('2026-04-10T10:05:00.000Z')
    });
    await server.listen();
    const address = server.address();

    const firstStateResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const firstStateBody = await firstStateResponse.text();
    const firstStatePayload = JSON.parse(firstStateBody) as {
      running: Array<{
        tokens: { total_tokens: number };
        transcript_tool_call_diagnostic_summary: {
          detailed_diagnostics_available: boolean;
          total_count: number;
          active_missing_tool_output: { active: boolean; call_id: string | null };
        };
      }>;
      stopped_runs: unknown[];
      counts: { stopped: number };
    };
    const secondStateResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const secondStateBody = await secondStateResponse.text();

    expect(firstStateResponse.status).toBe(200);
    expect(secondStateResponse.status).toBe(200);
    expect(getStateSnapshot.mock.calls.slice(0, 2)).toEqual([
      [{ includeTranscriptToolCallDiagnostics: false }],
      [{ includeTranscriptToolCallDiagnostics: false }]
    ]);
    expect(Buffer.byteLength(firstStateBody, 'utf8')).toBeLessThan(120_000);
    expect(Buffer.byteLength(secondStateBody, 'utf8')).toBeLessThan(120_000);
    expect(firstStateBody).not.toContain('transcript_tool_call_diagnostics');
    expect(firstStateBody).not.toContain('active_issue_id');
    expect(firstStatePayload.running).toHaveLength(4);
    expect(firstStatePayload.running.every((entry) => entry.transcript_tool_call_diagnostic_summary.total_count === diagnosticsPerRun)).toBe(true);
    expect(firstStatePayload.running[0]?.transcript_tool_call_diagnostic_summary).toMatchObject({
      detailed_diagnostics_available: true,
      active_missing_tool_output: {
        active: true,
        call_id: 'call-overload-1'
      }
    });
    expect(firstStatePayload.running[3]?.tokens.total_tokens).toBe(375_003);
    expect(firstStatePayload.stopped_runs).toEqual([]);
    expect(firstStatePayload.counts.stopped).toBe(0);
    expect(listRunHistory).not.toHaveBeenCalled();
    expect(reconstructThreadLineage).not.toHaveBeenCalled();

    const stoppedRunRecoveryResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/stopped-runs/recovery`);
    const stoppedRunRecoveryPayload = (await stoppedRunRecoveryResponse.json()) as {
      stopped_runs: unknown[];
      counts: { stopped: number };
    };
    expect(stoppedRunRecoveryResponse.status).toBe(200);
    expect(stoppedRunRecoveryPayload.stopped_runs.length).toBeLessThanOrEqual(25);
    expect(stoppedRunRecoveryPayload.counts.stopped).toBe(stoppedRunRecoveryPayload.stopped_runs.length);
    expect(listRunHistory).toHaveBeenCalledTimes(1);
    expect(listRunHistory).toHaveBeenCalledWith(25);
    expect(reconstructThreadLineage).toHaveBeenCalledTimes(25);

    const snapshotCallsBeforeRefresh = getStateSnapshot.mock.calls.length;
    const refreshResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/refresh`, { method: 'POST' });
    expect(refreshResponse.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(refreshTick).toHaveBeenCalledTimes(1);
    expect(getStateSnapshot).toHaveBeenCalledTimes(snapshotCallsBeforeRefresh);

    const snapshotCallsBeforeDetail = getStateSnapshot.mock.calls.length;
    const detailResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-OVERLOAD-1/diagnostics?limit=5`);
    const detailPayload = (await detailResponse.json()) as {
      runtime_diagnostics: {
        missing_tool_output: { call_id: string } | null;
        transcript_tool_call_diagnostics: {
          metadata: { total_available_count: number; included_count: number; has_more: boolean };
          records: Array<{ lineage: string }>;
        };
        tool_call_ledger: {
          records: Array<{ call_id: string; completion_status: string }>;
        };
      };
    };
    expect(detailResponse.status).toBe(200);
    expect(getStateSnapshot).toHaveBeenCalledTimes(snapshotCallsBeforeDetail + 1);
    expect(getStateSnapshot.mock.calls.at(-1)).toEqual([]);
    expect(detailPayload.runtime_diagnostics.missing_tool_output).toMatchObject({ call_id: 'call-overload-1' });
    expect(detailPayload.runtime_diagnostics.transcript_tool_call_diagnostics.metadata).toMatchObject({
      total_available_count: diagnosticsPerRun,
      included_count: 5,
      has_more: true
    });
    expect(new Set(detailPayload.runtime_diagnostics.transcript_tool_call_diagnostics.records.map((record) => record.lineage))).toEqual(
      new Set(['unattributed', 'external_manual', 'prior_stale', 'active_owned'])
    );
    expect(detailPayload.runtime_diagnostics.tool_call_ledger.records[0]).toMatchObject({
      call_id: 'call-overload-1',
      completion_status: 'pending'
    });

    const runHistoryCallsBeforeSse = listRunHistory.mock.calls.length;
    const streamResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/events`);
    const events = await readSseEvents(streamResponse, 1);
    const stateSnapshotEvent = events.find((entry) => entry.data.type === 'state_snapshot');
    const sseStateBody = JSON.stringify(stateSnapshotEvent?.data.payload);
    expect(streamResponse.status).toBe(200);
    expect(getStateSnapshot.mock.calls.at(-1)).toEqual([{ includeTranscriptToolCallDiagnostics: false }]);
    expect(sseStateBody).not.toContain('transcript_tool_call_diagnostics');
    expect(sseStateBody).not.toContain('active_issue_id');
    expect(listRunHistory).toHaveBeenCalledTimes(runHistoryCallsBeforeSse);

    const telemetryResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/telemetry/summary?limit=10`);
    const telemetryPayload = (await telemetryResponse.json()) as { sample_count: number; token_burn_rate: number };
    expect(telemetryResponse.status).toBe(200);
    expect(getStateSnapshot.mock.calls.at(-1)).toEqual([{ includeTranscriptToolCallDiagnostics: false }]);
    expect(telemetryPayload.sample_count).toBeGreaterThanOrEqual(4);
    expect(telemetryPayload.token_burn_rate).toBeGreaterThan(0);
    expect(JSON.stringify(telemetryPayload)).not.toContain('transcript_tool_call_diagnostics');

    const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const diagnosticsPayload = (await diagnosticsResponse.json()) as {
      control_plane: {
        endpoints: Array<{ endpoint: string; last_payload_bytes: number | null }>;
      };
    };
    expect(diagnosticsResponse.status).toBe(200);
    expect(getStateSnapshot.mock.calls.at(-1)).toEqual([{ includeTranscriptToolCallDiagnostics: false }]);
    expect(diagnosticsPayload.control_plane.endpoints.find((entry) => entry.endpoint === '/api/v1/state')?.last_payload_bytes).toBeLessThan(120_000);
    expect(JSON.stringify(diagnosticsPayload.control_plane)).not.toContain('transcript_tool_call_diagnostics');
  });

  it('records compact control-plane latency and payload health for state snapshots', async () => {
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry()
        ]
      ])
    });
    let now = Date.parse('2026-04-10T10:05:00.000Z');

    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => state
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      diagnosticsSource: makeDiagnosticsSource(),
      nowMs: () => {
        now += 5;
        return now;
      }
    });

    await server.listen();
    const address = server.address();

    const stateResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const statePayload = (await stateResponse.json()) as {
      health: {
        control_plane?: {
          event_loop: {
            delay: { resolution_ms: number; max_ms: number | null };
          } | null;
        };
      };
    };
    expect(stateResponse.status).toBe(200);
    expect(statePayload.health.control_plane?.event_loop).toMatchObject({
      delay: { resolution_ms: 20 }
    });

    const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const diagnosticsPayload = (await diagnosticsResponse.json()) as {
      control_plane: {
        sample_limit: number;
        worst_health: string;
        event_loop: {
          delay: { max_ms: number | null };
          utilization: { utilization: number };
        } | null;
        endpoints: Array<{
          endpoint: string;
          transport: string;
          sample_count: number;
          last_duration_ms: number | null;
          last_payload_bytes: number | null;
          last_request_queue_delay_ms: number | null;
          last_projection_duration_ms: number | null;
          last_enrichment_duration_ms: number | null;
          last_serialization_duration_ms: number | null;
          last_snapshot_age_ms: number | null;
          last_snapshot_freshness_state: string | null;
          last_event_loop_delay_ms: number | null;
          last_event_loop_utilization: number | null;
        }>;
      };
    };

    const stateHealth = diagnosticsPayload.control_plane.endpoints.find((entry) => entry.endpoint === '/api/v1/state');
    expect(diagnosticsResponse.status).toBe(200);
    expect(diagnosticsPayload.control_plane.sample_limit).toBe(40);
    expect(stateHealth).toMatchObject({
      endpoint: '/api/v1/state',
      transport: 'http',
      sample_count: 1,
      last_snapshot_freshness_state: 'fresh'
    });
    expect(stateHealth?.last_duration_ms).toBeGreaterThan(0);
    expect(stateHealth?.last_payload_bytes).toBeGreaterThan(0);
    expect(stateHealth?.last_request_queue_delay_ms).toBeGreaterThanOrEqual(0);
    expect(stateHealth?.last_projection_duration_ms).toBeGreaterThan(0);
    expect(stateHealth?.last_enrichment_duration_ms).toBeGreaterThanOrEqual(0);
    expect(stateHealth?.last_serialization_duration_ms).toBeGreaterThan(0);
    expect(stateHealth?.last_snapshot_age_ms).toBeGreaterThanOrEqual(0);
    if (stateHealth?.last_event_loop_delay_ms !== null) {
      expect(stateHealth?.last_event_loop_delay_ms).toBeGreaterThanOrEqual(0);
    }
    expect(stateHealth?.last_event_loop_utilization).toBeGreaterThanOrEqual(0);
    expect(diagnosticsPayload.control_plane.event_loop).toMatchObject({
      delay: { resolution_ms: 20 },
      utilization: { utilization: expect.any(Number) }
    });
    expect(JSON.stringify(diagnosticsPayload.control_plane)).not.toContain('samples');
    expect(JSON.stringify(diagnosticsPayload.control_plane)).not.toContain('transcript_tool_call_diagnostics');
  });

  it('classifies queued state service separately from fast handler work', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: ConstructorParameters<typeof LocalApiServer>[0]['logger'] = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    let now = Date.parse('2026-04-10T10:05:00.000Z');
    const timingValues = [1_000, 6_250, 6_250, 6_250];
    let timingCall = 0;

    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      diagnosticsSource: makeDiagnosticsSource(),
      logger,
      nowMs: () => {
        now += 1;
        return now;
      },
      requestTimingNowMs: () => timingValues[Math.min(timingCall++, timingValues.length - 1)]!,
      controlPlaneHealth: {
        thresholds: {
          slow_request_queue_delay_ms: 1_000,
          degraded_request_queue_delay_ms: 5_000
        }
      }
    });

    await server.listen();
    const address = server.address();

    const stateResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const diagnosticsPayload = (await diagnosticsResponse.json()) as {
      control_plane: {
        endpoints: Array<{
          endpoint: string;
          health: string;
          last_duration_ms: number | null;
          last_request_queue_delay_ms: number | null;
          last_projection_duration_ms: number | null;
        }>;
      };
    };

    const stateRequestedLog = logs.find((entry) => entry.event === CANONICAL_EVENT.api.stateRequested);
    const pressureLog = logs.find((entry) => entry.event === CANONICAL_EVENT.api.stateSnapshotDegraded);
    const stateHealth = diagnosticsPayload.control_plane.endpoints.find((entry) => entry.endpoint === '/api/v1/state');
    expect(stateResponse.status).toBe(200);
    expect(stateRequestedLog?.context.request_queue_delay_ms).toBe(5250);
    expect(stateRequestedLog?.context.control_plane_health).toBe('degraded');
    expect(stateRequestedLog?.context.duration_ms).toEqual(expect.any(Number));
    expect(stateRequestedLog?.context.projection_duration_ms).toEqual(expect.any(Number));
    expect(pressureLog?.context).toMatchObject({
      endpoint: '/api/v1/state',
      health: 'degraded',
      request_queue_delay_ms: 5250
    });
    expect(stateHealth).toMatchObject({
      health: 'degraded',
      last_request_queue_delay_ms: 5250
    });
    expect(stateHealth?.last_duration_ms).toBeLessThan(1_000);
    expect(stateHealth?.last_projection_duration_ms).toBeLessThan(1_000);
  });

  it('classifies event-loop starvation separately from fast handler work', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: ConstructorParameters<typeof LocalApiServer>[0]['logger'] = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    const eventLoopHealthMonitor = new StaticEventLoopHealthMonitor(makeEventLoopSummary());

    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      diagnosticsSource: makeDiagnosticsSource(),
      eventLoopHealthMonitor,
      logger,
      requestTimingNowMs: () => 1_000
    });

    await server.listen();
    const address = server.address();

    const stateResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const diagnosticsPayload = (await diagnosticsResponse.json()) as {
      control_plane: {
        event_loop: { delay: { max_ms: number | null }; utilization: { utilization: number } } | null;
        endpoints: Array<{
          endpoint: string;
          health: string;
          last_duration_ms: number | null;
          last_request_queue_delay_ms: number | null;
          last_event_loop_delay_ms: number | null;
        }>;
      };
    };

    const stateRequestedLog = logs.find((entry) => entry.event === CANONICAL_EVENT.api.stateRequested);
    const pressureLog = logs.find((entry) => entry.event === CANONICAL_EVENT.api.stateSnapshotDegraded);
    const stateHealth = diagnosticsPayload.control_plane.endpoints.find((entry) => entry.endpoint === '/api/v1/state');
    expect(stateResponse.status).toBe(200);
    expect(diagnosticsPayload.control_plane.event_loop).toMatchObject({
      delay: { max_ms: 5250 },
      utilization: { utilization: 0.999 }
    });
    expect(stateRequestedLog?.context).toMatchObject({
      request_queue_delay_ms: 0,
      event_loop_delay_ms: 5250,
      event_loop_utilization: 0.999,
      control_plane_health: 'degraded'
    });
    expect(pressureLog?.context).toMatchObject({
      endpoint: '/api/v1/state',
      health: 'degraded',
      event_loop_delay_ms: 5250
    });
    expect(stateHealth).toMatchObject({
      health: 'degraded',
      last_request_queue_delay_ms: 0,
      last_event_loop_delay_ms: 5250
    });
    expect(stateHealth?.last_duration_ms).toBeLessThan(1_000);
  });

  it('serves diagnostics from the rolling event-loop window without mutating it', async () => {
    const eventLoopHealthMonitor = new StaticEventLoopHealthMonitor(
      makeEventLoopSummary({
        observed_at: '2026-05-13T15:04:30.000Z',
        sample_window_ms: 30_000,
        delay: {
          resolution_ms: 20,
          min_ms: 1,
          mean_ms: 20,
          max_ms: 4_100,
          p50_ms: 10,
          p95_ms: 3_900,
          p99_ms: 4_100
        }
      })
    );

    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      diagnosticsSource: makeDiagnosticsSource(),
      eventLoopHealthMonitor
    });

    await server.listen();
    const address = server.address();

    const stateResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const firstDiagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const secondDiagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const statePayload = (await stateResponse.json()) as {
      health: { control_plane?: { event_loop: EventLoopHealthSummary | null } };
    };
    const firstDiagnosticsPayload = (await firstDiagnosticsResponse.json()) as {
      control_plane: { event_loop: EventLoopHealthSummary | null };
    };
    const secondDiagnosticsPayload = (await secondDiagnosticsResponse.json()) as {
      control_plane: { event_loop: EventLoopHealthSummary | null };
    };

    expect(stateResponse.status).toBe(200);
    expect(firstDiagnosticsResponse.status).toBe(200);
    expect(secondDiagnosticsResponse.status).toBe(200);
    expect(statePayload.health.control_plane?.event_loop).toMatchObject({
      sample_window_ms: 30_000,
      delay: { max_ms: 4100, p95_ms: 3900 }
    });
    expect(firstDiagnosticsPayload.control_plane.event_loop).toMatchObject({
      sample_window_ms: 30_000,
      delay: { max_ms: 4100, p95_ms: 3900 }
    });
    expect(secondDiagnosticsPayload.control_plane.event_loop).toMatchObject({
      sample_window_ms: 30_000,
      delay: { max_ms: 4100, p95_ms: 3900 }
    });
    expect(eventLoopHealthMonitor.summaries.map((summary) => summary.delay.max_ms)).toEqual(
      eventLoopHealthMonitor.summaries.map(() => 4100)
    );
  });

  it('does not count keep-alive socket idle time as request queue delay', async () => {
    const timingValues = [1_000, 1_000, 10_000, 10_000, 10_000, 10_000];
    let timingCall = 0;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      diagnosticsSource: makeDiagnosticsSource(),
      requestTimingNowMs: () => timingValues[Math.min(timingCall++, timingValues.length - 1)]!
    });

    await server.listen();
    const address = server.address();
    const requestState = () =>
      new Promise<{ reusedSocket: boolean; statusCode: number | undefined }>((resolve, reject) => {
        const request = http.request(
          {
            agent,
            host: '127.0.0.1',
            method: 'GET',
            path: '/api/v1/state',
            port: address.port
          },
          (response) => {
            response.resume();
            response.on('end', () => {
              resolve({ reusedSocket: request.reusedSocket, statusCode: response.statusCode });
            });
          }
        );
        request.on('error', reject);
        request.end();
      });

    const first = await requestState();
    const second = await requestState();
    const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const diagnosticsPayload = (await diagnosticsResponse.json()) as {
      control_plane: {
        endpoints: Array<{
          endpoint: string;
          sample_count: number;
          max_request_queue_delay_ms: number | null;
          last_request_queue_delay_ms: number | null;
        }>;
      };
    };
    agent.destroy();

    const stateHealth = diagnosticsPayload.control_plane.endpoints.find((entry) => entry.endpoint === '/api/v1/state');
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.reusedSocket).toBe(true);
    expect(stateHealth).toMatchObject({
      sample_count: 2,
      max_request_queue_delay_ms: 0,
      last_request_queue_delay_ms: 0
    });
  });

  it('classifies degraded state payload pressure and emits typed snapshot pressure logs', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: ConstructorParameters<typeof LocalApiServer>[0]['logger'] = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };

    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () =>
          makeState({
            running: new Map([
              [
                'issue-1',
                makeRunningEntry({
                  last_message: 'x'.repeat(200)
                })
              ]
            ])
          })
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      diagnosticsSource: makeDiagnosticsSource(),
      logger,
      controlPlaneHealth: {
        thresholds: {
          large_payload_bytes: 1,
          degraded_payload_bytes: 2
        }
      }
    });

    await server.listen();
    const address = server.address();

    const stateResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const diagnosticsPayload = (await diagnosticsResponse.json()) as {
      control_plane: {
        worst_health: string;
        endpoints: Array<{ endpoint: string; health: string; last_payload_bytes: number | null }>;
      };
    };

    const pressureLog = logs.find((entry) => entry.event === CANONICAL_EVENT.api.stateSnapshotDegraded);
    const stateHealth = diagnosticsPayload.control_plane.endpoints.find((entry) => entry.endpoint === '/api/v1/state');
    expect(stateResponse.status).toBe(200);
    expect(diagnosticsPayload.control_plane.worst_health).toBe('degraded');
    expect(stateHealth?.health).toBe('degraded');
    expect(stateHealth?.last_payload_bytes).toBeGreaterThan(2);
    expect(pressureLog?.context).toMatchObject({
      endpoint: '/api/v1/state',
      transport: 'http',
      health: 'degraded'
    });
    expect(pressureLog?.context.payload_bytes).toBeGreaterThan(2);
    expect(pressureLog?.context).toHaveProperty('duration_ms');
    expect(pressureLog?.context).toHaveProperty('request_queue_delay_ms');
    expect(pressureLog?.context).toHaveProperty('projection_duration_ms');
    expect(pressureLog?.context).toHaveProperty('serialization_duration_ms');
    expect(pressureLog?.context).toHaveProperty('event_loop_delay_ms');
    expect(pressureLog?.context).toHaveProperty('event_loop_utilization');
  });
});
