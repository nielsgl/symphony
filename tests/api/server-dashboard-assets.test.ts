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

describe('LocalApiServer dashboard assets', () => {
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
});
