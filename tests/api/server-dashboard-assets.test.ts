import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { LOCAL_DASHBOARD_ASSET_CACHE_CONTROL } from '../../src/api/server/responses';
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
      },
      dashboardConfig: {
        dashboard_enabled: true,
        refresh_ms: 4000,
        render_interval_ms: 1000,
        asset_revision: 'asset-rev-test'
      }
    });

    await server.listen();
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    const payload = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe(LOCAL_DASHBOARD_ASSET_CACHE_CONTROL);
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('expires')).toBe('0');
    expect(payload).toContain('Symphony Operator Control');
    expect(payload).toContain('symphony-dashboard-asset-revision');
    expect(payload).toContain('/dashboard/client.js?v=asset-rev-test');
    expect(payload).toContain('/dashboard/styles.css?v=asset-rev-test');
  });

  it('serves shared dashboard script and styles assets', async () => {
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      dashboardConfig: {
        dashboard_enabled: true,
        refresh_ms: 4000,
        render_interval_ms: 1000,
        asset_revision: 'asset-rev-test'
      }
    });

    await server.listen();
    const address = server.address();

    const scriptResponse = await fetch(`http://127.0.0.1:${address.port}/dashboard/client.js?v=asset-rev-test`);
    const scriptPayload = await scriptResponse.text();
    expect(scriptResponse.status).toBe(200);
    expect(scriptResponse.headers.get('content-type')).toContain('application/javascript');
    expect(scriptResponse.headers.get('cache-control')).toBe(LOCAL_DASHBOARD_ASSET_CACHE_CONTROL);
    expect(scriptResponse.headers.get('pragma')).toBe('no-cache');
    expect(scriptResponse.headers.get('expires')).toBe('0');
    expect(scriptPayload).toContain('symphony-dashboard-asset-revision asset-rev-test');
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
    expect(scriptPayload).toMatch(/Blocked reason: ["'] \+ getActionRequiredLabel\(payload\.blocked\.stop_reason_code\)/);
    expect(scriptPayload).toMatch(/formatApiError\(payload, ["']Request failed["']\)/);
    expect(scriptPayload).toContain('setInterval(updateRuntimeClock, DASHBOARD_CONFIG.render_interval_ms)');

    const cssResponse = await fetch(`http://127.0.0.1:${address.port}/dashboard/styles.css?v=asset-rev-test`);
    const cssPayload = await cssResponse.text();
    expect(cssResponse.status).toBe(200);
    expect(cssResponse.headers.get('content-type')).toContain('text/css');
    expect(cssResponse.headers.get('cache-control')).toBe(LOCAL_DASHBOARD_ASSET_CACHE_CONTROL);
    expect(cssResponse.headers.get('pragma')).toBe('no-cache');
    expect(cssResponse.headers.get('expires')).toBe('0');
    expect(cssPayload).toContain('symphony-dashboard-asset-revision asset-rev-test');
    expect(cssPayload).toContain('.layout');
    expect(cssPayload).toContain('.panel');
  });

  it('verifies dashboard asset revision and cache contract through local HTTP routes', async () => {
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      dashboardConfig: {
        dashboard_enabled: true,
        refresh_ms: 4000,
        render_interval_ms: 1000,
        asset_revision: 'asset-rev-test'
      }
    });

    await server.listen();

    await expect(server.verifyDashboardAssets()).resolves.toMatchObject({
      ok: true,
      revision: 'asset-rev-test',
      reason_code: null,
      checks: [
        expect.objectContaining({ path: '/', status_code: 200, body_contains_revision: true }),
        expect.objectContaining({ path: '/dashboard/client.js?v=asset-rev-test', status_code: 200, body_contains_revision: true }),
        expect.objectContaining({ path: '/dashboard/styles.css?v=asset-rev-test', status_code: 200, body_contains_revision: true })
      ]
    });
  });

  it('does not apply the dashboard asset cache policy to unrelated API responses', async () => {
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

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    await response.arrayBuffer();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).not.toBe(LOCAL_DASHBOARD_ASSET_CACHE_CONTROL);
    expect(response.headers.get('pragma')).toBeNull();
    expect(response.headers.get('expires')).toBeNull();
  });
});
