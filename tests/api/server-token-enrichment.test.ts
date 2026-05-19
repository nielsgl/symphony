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

describe('LocalApiServer token enrichment', () => {
  it('fills state and issue-detail running total tokens from CODEX_HOME state sqlite when protocol totals are absent', async () => {
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
      codex_totals: { total_tokens: number; input_tokens: number; output_tokens: number; token_split_status?: string };
      running: Array<{
        token_telemetry_status: string;
        token_telemetry_last_source: string | null;
        token_telemetry_last_at_ms: number | null;
        token_telemetry_confidence: string;
        token_telemetry_source: string | null;
        tokens: { total_tokens: number; input_tokens: number; output_tokens: number; token_split_status?: string };
      }>;
    };

    expect(response.status).toBe(200);
    expect(payload.codex_totals.total_tokens).toBe(321);
    expect(payload.codex_totals.input_tokens).toBe(0);
    expect(payload.codex_totals.output_tokens).toBe(0);
    expect(payload.codex_totals.token_split_status).toBe('aggregate_only');
    expect(payload.running[0]?.tokens.total_tokens).toBe(321);
    expect(payload.running[0]?.tokens.token_split_status).toBe('aggregate_only');
    expect(typeof payload.running[0]?.tokens.total_tokens).toBe('number');
    expect(typeof payload.running[0]?.tokens.input_tokens).toBe('number');
    expect(typeof payload.running[0]?.tokens.output_tokens).toBe('number');
    expect(payload.running[0]?.token_telemetry_status).toBe('available');
    expect(payload.running[0]?.token_telemetry_last_source).toBe('codex_home_state_sqlite');
    expect(payload.running[0]?.token_telemetry_confidence).toBe('backfilled');
    expect(payload.running[0]?.token_telemetry_source).toBe('codex_home_state_sqlite');
    expect(typeof payload.running[0]?.token_telemetry_last_at_ms).toBe('number');

    const issueResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/ABC-1`);
    const issuePayload = (await issueResponse.json()) as {
      operator_explainer: { version: string; classification: string; actionability: string; headline: string };
      running: {
        token_telemetry_status: string;
        token_telemetry_last_source: string | null;
        token_telemetry_last_at_ms: number | null;
        token_telemetry_confidence: string;
        tokens: { total_tokens: number; token_split_status?: string };
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
    expect(issuePayload.running.tokens.token_split_status).toBe('aggregate_only');
    expect(issuePayload.running.token_telemetry_status).toBe('available');
    expect(issuePayload.running.token_telemetry_last_source).toBe('codex_home_state_sqlite');
    expect(issuePayload.running.token_telemetry_confidence).toBe('backfilled');
    expect(typeof issuePayload.running.token_telemetry_last_at_ms).toBe('number');

    if (previousCodexHome === undefined) {
      delete process.env.SYMPHONY_CODEX_HOME;
    } else {
      process.env.SYMPHONY_CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(codexHomeDir, { recursive: true, force: true });
  });

  it('keeps split transcript token usage primary over CODEX_HOME state sqlite fallback', async () => {
    const codexHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-protocol-primary-'));
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
      INSERT INTO threads (id, tokens_used) VALUES ('thread-protocol-1', 999);
    `);
    db.close();

    const previousCodexHome = process.env.SYMPHONY_CODEX_HOME;
    process.env.SYMPHONY_CODEX_HOME = codexHomeDir;

    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            thread_id: 'thread-protocol-1',
            tokens: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            last_reported_tokens: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            token_telemetry_status: 'available',
            token_telemetry_last_source: 'transcript_token_count',
            token_telemetry_last_at_ms: Date.parse('2026-04-10T10:04:00.000Z')
          })
        ]
      ]),
      codex_totals: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
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
      codex_totals: { input_tokens: number; output_tokens: number; total_tokens: number; token_split_status?: string };
      running: Array<{
        token_telemetry_status: string;
        token_telemetry_last_source: string | null;
        tokens: { input_tokens: number; output_tokens: number; total_tokens: number; token_split_status?: string };
      }>;
    };

    expect(response.status).toBe(200);
    expect(payload.codex_totals).toMatchObject({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
    expect(payload.codex_totals.token_split_status).toBeUndefined();
    expect(payload.running[0]?.tokens).toMatchObject({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
    expect(payload.running[0]?.tokens.token_split_status).toBeUndefined();
    expect(payload.running[0]?.token_telemetry_status).toBe('available');
    expect(payload.running[0]?.token_telemetry_last_source).toBe('transcript_token_count');

    if (previousCodexHome === undefined) {
      delete process.env.SYMPHONY_CODEX_HOME;
    } else {
      process.env.SYMPHONY_CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(codexHomeDir, { recursive: true, force: true });
  });

  it('adds aggregate sqlite fallback totals to existing protocol state totals', async () => {
    const codexHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-mixed-totals-'));
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
      INSERT INTO threads (id, tokens_used) VALUES ('thread-fallback-mixed', 50);
    `);
    db.close();

    const previousCodexHome = process.env.SYMPHONY_CODEX_HOME;
    process.env.SYMPHONY_CODEX_HOME = codexHomeDir;

    const state = makeState({
      running: new Map([
        [
          'issue-protocol',
          makeRunningEntry({
            issue: makeIssue({ id: 'issue-protocol', identifier: 'ABC-PROTOCOL' }),
            identifier: 'ABC-PROTOCOL',
            thread_id: 'thread-protocol-mixed',
            tokens: { input_tokens: 60, output_tokens: 40, total_tokens: 100 },
            last_reported_tokens: { input_tokens: 60, output_tokens: 40, total_tokens: 100 },
            token_telemetry_status: 'available',
            token_telemetry_last_source: 'worker_event_usage',
            token_telemetry_last_at_ms: Date.parse('2026-04-10T10:04:00.000Z')
          })
        ],
        [
          'issue-fallback',
          makeRunningEntry({
            issue: makeIssue({ id: 'issue-fallback', identifier: 'ABC-FALLBACK' }),
            identifier: 'ABC-FALLBACK',
            thread_id: 'thread-fallback-mixed',
            tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            last_reported_tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            token_telemetry_status: 'pending',
            token_telemetry_last_source: null,
            token_telemetry_last_at_ms: null
          })
        ]
      ]),
      codex_totals: {
        input_tokens: 60,
        output_tokens: 40,
        total_tokens: 100,
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
      codex_totals: { input_tokens: number; output_tokens: number; total_tokens: number; token_split_status?: string };
      running: Array<{
        issue_identifier: string;
        token_telemetry_status: string;
        token_telemetry_last_source: string | null;
        tokens: { input_tokens: number; output_tokens: number; total_tokens: number; token_split_status?: string };
      }>;
    };

    const protocolRow = payload.running.find((row) => row.issue_identifier === 'ABC-PROTOCOL');
    const fallbackRow = payload.running.find((row) => row.issue_identifier === 'ABC-FALLBACK');
    expect(response.status).toBe(200);
    expect(payload.codex_totals.total_tokens).toBe(150);
    expect(payload.codex_totals.input_tokens).toBe(60);
    expect(payload.codex_totals.output_tokens).toBe(40);
    expect(payload.codex_totals.token_split_status).toBe('aggregate_only');
    expect(protocolRow?.tokens).toMatchObject({ input_tokens: 60, output_tokens: 40, total_tokens: 100 });
    expect(protocolRow?.tokens.token_split_status).toBeUndefined();
    expect(fallbackRow?.tokens.total_tokens).toBe(50);
    expect(fallbackRow?.tokens.token_split_status).toBe('aggregate_only');
    expect(fallbackRow?.token_telemetry_status).toBe('available');
    expect(fallbackRow?.token_telemetry_last_source).toBe('codex_home_state_sqlite');

    if (previousCodexHome === undefined) {
      delete process.env.SYMPHONY_CODEX_HOME;
    } else {
      process.env.SYMPHONY_CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(codexHomeDir, { recursive: true, force: true });
  });

  it('keeps GET /api/v1/state off the live token fallback hot path', async () => {
    const codexHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-hot-path-'));
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
      INSERT INTO threads (id, tokens_used) VALUES ('thread-live-stall', 999);
    `);
    db.close();

    const previousCodexHome = process.env.SYMPHONY_CODEX_HOME;
    process.env.SYMPHONY_CODEX_HOME = codexHomeDir;
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            thread_id: 'thread-live-stall',
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
    let now = Date.parse('2026-04-10T10:05:00.000Z');

    server = new LocalApiServer({
      host: '127.0.0.1',
      port: 0,
      snapshotSource: {
        getStateSnapshot: () => state
      },
      refreshSource: { tick: async () => {} },
      diagnosticsSource: makeDiagnosticsSource(),
      nowMs: () => {
        now += 2;
        return now;
      }
    });
    await server.listen();
    const address = server.address();

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const payload = (await response.json()) as {
      codex_totals: { total_tokens: number; token_split_status?: string };
      running: Array<{
        token_telemetry_status: string;
        token_telemetry_last_source: string | null;
        tokens: { total_tokens: number; token_split_status?: string };
      }>;
    };
    const updatedDb = new sqlite.DatabaseSync(dbPath);
    updatedDb.exec("UPDATE threads SET tokens_used = 1234 WHERE id = 'thread-live-stall';");
    updatedDb.close();
    const cachedResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const cachedPayload = (await cachedResponse.json()) as {
      codex_totals: { total_tokens: number };
      running: Array<{ tokens: { total_tokens: number } }>;
    };
    const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const diagnosticsPayload = (await diagnosticsResponse.json()) as {
      control_plane: {
        endpoints: Array<{
          endpoint: string;
          last_enrichment_status: string | null;
          last_enrichment_degraded: boolean | null;
        }>;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.codex_totals.total_tokens).toBe(999);
    expect(payload.codex_totals.token_split_status).toBe('aggregate_only');
    expect(payload.running[0]?.tokens.total_tokens).toBe(999);
    expect(payload.running[0]?.tokens.token_split_status).toBe('aggregate_only');
    expect(payload.running[0]?.token_telemetry_status).toBe('available');
    expect(payload.running[0]?.token_telemetry_last_source).toBe('codex_home_state_sqlite');
    expect(cachedResponse.status).toBe(200);
    expect(cachedPayload.codex_totals.total_tokens).toBe(999);
    expect(cachedPayload.running[0]?.tokens.total_tokens).toBe(999);
    expect(diagnosticsResponse.status).toBe(200);
    expect(diagnosticsPayload.control_plane.endpoints.find((entry) => entry.endpoint === '/api/v1/state')).toMatchObject({
      last_enrichment_status: 'available',
      last_enrichment_degraded: false
    });

    if (previousCodexHome === undefined) {
      delete process.env.SYMPHONY_CODEX_HOME;
    } else {
      process.env.SYMPHONY_CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(codexHomeDir, { recursive: true, force: true });
  });

  it('keeps diagnostics and SSE snapshots available with degraded live enrichment', async () => {
    const codexHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-sse-hot-path-'));
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
      INSERT INTO threads (id, tokens_used) VALUES ('thread-live-stall', 777);
    `);
    db.close();

    const previousCodexHome = process.env.SYMPHONY_CODEX_HOME;
    process.env.SYMPHONY_CODEX_HOME = codexHomeDir;
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            thread_id: 'thread-live-stall',
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
    let now = Date.parse('2026-04-10T10:05:00.000Z');

    server = new LocalApiServer({
      host: '127.0.0.1',
      port: 0,
      snapshotSource: {
        getStateSnapshot: () => state
      },
      refreshSource: { tick: async () => {} },
      diagnosticsSource: makeDiagnosticsSource(),
      nowMs: () => {
        now += 3;
        return now;
      }
    });
    await server.listen();
    const address = server.address();

    const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const diagnosticsPayload = (await diagnosticsResponse.json()) as {
      token_telemetry_status: string;
      token_telemetry_last_source: string | null;
      token_enrichment: { status: string; degraded: boolean; reason_code: string | null };
    };
    const streamResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/events`);
    const events = await readSseEvents(streamResponse, 1);
    const stateSnapshotEvent = events.find((entry) => entry.data.type === 'state_snapshot');
    const ssePayload = stateSnapshotEvent?.data.payload as {
      state?: {
        running: Array<{ tokens: { total_tokens: number; token_split_status?: string }; token_telemetry_status: string }>;
        codex_totals: { total_tokens: number; token_split_status?: string };
      };
    };
    const diagnosticsAfterSseResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const diagnosticsAfterSse = (await diagnosticsAfterSseResponse.json()) as {
      control_plane: {
        endpoints: Array<{
          endpoint: string;
          transport: string;
          last_enrichment_status: string | null;
          last_enrichment_degraded: boolean | null;
        }>;
      };
    };

    expect(diagnosticsResponse.status).toBe(200);
    expect(diagnosticsPayload.token_telemetry_status).toBe('available');
    expect(diagnosticsPayload.token_telemetry_last_source).toBe('codex_home_state_sqlite');
    expect(diagnosticsPayload.token_enrichment).toMatchObject({
      status: 'available',
      degraded: false,
      reason_code: null
    });
    expect(streamResponse.status).toBe(200);
    expect(ssePayload?.state?.codex_totals.total_tokens).toBe(777);
    expect(ssePayload?.state?.codex_totals.token_split_status).toBe('aggregate_only');
    expect(ssePayload?.state?.running[0]?.tokens.total_tokens).toBe(777);
    expect(ssePayload?.state?.running[0]?.tokens.token_split_status).toBe('aggregate_only');
    expect(ssePayload?.state?.running[0]?.token_telemetry_status).toBe('available');
    expect(
      diagnosticsAfterSse.control_plane.endpoints.find(
        (entry) => entry.endpoint === '/api/v1/events:state_snapshot' && entry.transport === 'sse'
      )
    ).toMatchObject({
      last_enrichment_status: 'available',
      last_enrichment_degraded: false
    });

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
      refreshSource: { tick: async () => {} },
      diagnosticsSource: makeDiagnosticsSource()
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
    const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const diagnosticsPayload = (await diagnosticsResponse.json()) as {
      control_plane: {
        endpoints: Array<{
          endpoint: string;
          health: string;
          last_enrichment_status: string | null;
          last_enrichment_degraded: boolean | null;
          last_enrichment_reason_code: string | null;
        }>;
      };
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
    expect(diagnosticsResponse.status).toBe(200);
    expect(issueResponse.status).toBe(200);
    expect(statePayload.running[0]?.tokens.total_tokens).toBe(0);
    expect(statePayload.running[0]?.token_telemetry_status).toBe('pending');
    expect(statePayload.running[0]?.token_telemetry_last_source).toBeNull();
    expect(statePayload.running[0]?.token_telemetry_last_at_ms).toBeNull();
    expect(diagnosticsPayload.control_plane.endpoints.find((entry) => entry.endpoint === '/api/v1/state')).toMatchObject({
      health: 'ok',
      last_enrichment_status: 'degraded',
      last_enrichment_degraded: true,
      last_enrichment_reason_code: REASON_CODES.liveTokenFallbackNotOnHotPath
    });
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
});
