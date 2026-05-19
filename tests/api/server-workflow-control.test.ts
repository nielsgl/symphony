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

describe('LocalApiServer workflow controls', () => {
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
});
