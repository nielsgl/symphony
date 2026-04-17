import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRuntimeEnvironment } from '../../src/runtime';
import { SqlitePersistenceStore } from '../../src/persistence';
import type { TrackerAdapter } from '../../src/tracker';

function requireApiAddress(runtime: { apiServer: { address: () => { host: string; port: number } } | null }) {
  if (!runtime.apiServer) {
    throw new Error('expected API server to be enabled for this test');
  }

  return runtime.apiServer.address();
}

async function makeWorkflowFile(options?: {
  includeTrackerCredentials?: boolean;
  includeServerPort?: boolean;
  serverPort?: number;
}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-runtime-'));
  const workflowPath = path.join(dir, 'WORKFLOW.md');
  const includeTrackerCredentials = options?.includeTrackerCredentials ?? true;
  const includeServerPort = options?.includeServerPort ?? true;
  const serverPort = options?.serverPort ?? 0;
  const trackerCredentialBlock = includeTrackerCredentials
    ? `  api_key: test-token
  project_slug: TEST
`
    : '';
  const serverBlock = includeServerPort
    ? `server:
  port: ${serverPort}
`
    : '';
  const content = `---
tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
${trackerCredentialBlock}  active_states:
    - Todo
  terminal_states:
    - Done
polling:
  interval_ms: 1000
workspace:
  root: ${JSON.stringify(path.join(dir, 'workspaces'))}
hooks:
  timeout_ms: 1000
agent:
  max_concurrent_agents: 1
  max_retry_backoff_ms: 10000
  max_turns: 1
codex:
  command: codex app-server
  turn_timeout_ms: 1000
  read_timeout_ms: 1000
  stall_timeout_ms: 1000
persistence:
  enabled: true
  db_path: ${JSON.stringify(path.join(dir, 'runtime.sqlite'))}
  retention_days: 14
${serverBlock}---
Issue {{ issue.identifier }} attempt {{ attempt }}
`;
  await fs.writeFile(workflowPath, content, 'utf8');
  return workflowPath;
}

describe('createRuntimeEnvironment', () => {
  const runtimes: Array<{ stop: () => Promise<void> }> = [];
  const dirs: string[] = [];

  afterEach(async () => {
    while (runtimes.length > 0) {
      const runtime = runtimes.pop();
      if (runtime) {
        await runtime.stop();
      }
    }

    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('starts live runtime and serves orchestrator-backed state endpoint', async () => {
    const workflowPath = await makeWorkflowFile();
    dirs.push(path.dirname(workflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => [])
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0
    });
    runtimes.push(runtime);

    await runtime.start();
    const address = requireApiAddress(runtime);

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const payload = (await response.json()) as {
      counts: { running: number; retrying: number };
      health: { dispatch_validation: 'ok' | 'failed'; last_error: string | null };
    };

    expect(response.status).toBe(200);
    expect(payload.counts.running).toBe(0);
    expect(payload.health.dispatch_validation).toBe('ok');
    expect(tracker.fetch_candidate_issues).toHaveBeenCalled();
  });

  it('maps refresh endpoint to orchestrator manual refresh tick', async () => {
    const workflowPath = await makeWorkflowFile();
    dirs.push(path.dirname(workflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => [])
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0
    });
    runtimes.push(runtime);

    await runtime.start();
    const address = requireApiAddress(runtime);

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/refresh`, { method: 'POST' });
    expect(response.status).toBe(202);
    expect(tracker.fetch_candidate_issues).toHaveBeenCalled();
  });

  it('exposes SSE event stream endpoint for runtime state push updates', async () => {
    const workflowPath = await makeWorkflowFile();
    dirs.push(path.dirname(workflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => [])
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0
    });
    runtimes.push(runtime);

    await runtime.start();
    const address = requireApiAddress(runtime);

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    await runtime.orchestrator.tick('manual_refresh');
    await response.body?.cancel();
  });

  it('starts in offline mode when tracker credentials are missing and adapter is provided', async () => {
    const workflowPath = await makeWorkflowFile({ includeTrackerCredentials: false });
    dirs.push(path.dirname(workflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => [])
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0
    });
    runtimes.push(runtime);

    await runtime.start();
    const address = requireApiAddress(runtime);

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const payload = (await response.json()) as {
      health: { dispatch_validation: 'ok' | 'failed'; last_error: string | null };
    };

    expect(response.status).toBe(200);
    expect(payload.health.dispatch_validation).toBe('failed');
    expect(payload.health.last_error).toContain('tracker.api_key is required');
  });

  it('exposes diagnostics profile and persistence status endpoints', async () => {
    const workflowPath = await makeWorkflowFile();
    dirs.push(path.dirname(workflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => [])
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0
    });
    runtimes.push(runtime);

    await runtime.start();
    const address = requireApiAddress(runtime);

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const payload = (await response.json()) as {
      active_profile: { name: string; approval_policy: string };
      persistence: { enabled: boolean; integrity_ok: boolean };
    };

    expect(response.status).toBe(200);
    expect(payload.active_profile.name).toBe('balanced');
    expect(payload.active_profile.approval_policy).toBe('on-request');
    expect(payload.persistence.enabled).toBe(true);
    expect(payload.persistence.integrity_ok).toBe(true);
  });

  it('restores durable history on restart without restoring running or retry state', async () => {
    const workflowPath = await makeWorkflowFile();
    const workflowDir = path.dirname(workflowPath);
    dirs.push(workflowDir);
    const dbPath = path.join(workflowDir, 'runtime.sqlite');

    const seedStore = new SqlitePersistenceStore({
      dbPath,
      retentionDays: 14,
      nowMs: () => Date.parse('2026-04-11T10:00:00.000Z')
    });
    const runId = seedStore.startRun({ issue_id: 'issue-1', issue_identifier: 'ABC-1' });
    seedStore.recordSession(runId, 'thread-1-turn-1');
    seedStore.completeRun({ run_id: runId, terminal_status: 'succeeded' });
    seedStore.close();

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => [])
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0
    });
    runtimes.push(runtime);

    await runtime.start();
    const address = requireApiAddress(runtime);

    const historyResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/history`);
    const historyPayload = (await historyResponse.json()) as {
      runs: Array<{ run_id: string; issue_identifier: string; terminal_status: string | null }>;
    };
    expect(historyResponse.status).toBe(200);
    expect(historyPayload.runs.some((entry) => entry.run_id === runId)).toBe(true);

    const stateResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const statePayload = (await stateResponse.json()) as {
      counts: { running: number; retrying: number };
    };
    expect(stateResponse.status).toBe(200);
    expect(statePayload.counts.running).toBe(0);
    expect(statePayload.counts.retrying).toBe(0);
  });

  it('keeps HTTP extension disabled when neither CLI port nor workflow server.port is configured', async () => {
    const workflowPath = await makeWorkflowFile({ includeServerPort: false });
    dirs.push(path.dirname(workflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => [])
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker
    });
    runtimes.push(runtime);

    expect(runtime.apiServer).toBeNull();
    await runtime.start();

    expect(tracker.fetch_candidate_issues).toHaveBeenCalled();
  });

  it('still enables HTTP extension when CLI port is explicitly provided', async () => {
    const workflowPath = await makeWorkflowFile({ includeServerPort: false });
    dirs.push(path.dirname(workflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => [])
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0
    });
    runtimes.push(runtime);

    expect(runtime.apiServer).not.toBeNull();
    await runtime.start();
    const address = requireApiAddress(runtime);
    expect(address.port).toBeGreaterThan(0);
  });

  it('uses CLI port precedence over workflow server.port when both are configured', async () => {
    const workflowPath = await makeWorkflowFile({ includeServerPort: true, serverPort: 41001 });
    dirs.push(path.dirname(workflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => [])
    };

    const entries: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger = {
      log: (params: {
        level: 'info' | 'warn' | 'error';
        event: string;
        message: string;
        context?: Record<string, unknown>;
      }) => {
        entries.push({ event: params.event, context: params.context ?? {} });
      }
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0,
      logger
    });
    runtimes.push(runtime);

    await runtime.start();

    const enabledEvent = entries.find((entry) => entry.event === 'runtime_http_enabled');
    expect(enabledEvent).toBeDefined();
    expect(enabledEvent?.context.configured_port).toBe(0);
  });

  it('throws startup failure for nonexistent explicit workflow path', () => {
    const missingPath = path.join(os.tmpdir(), `missing-${Date.now()}.md`);

    expect(() =>
      createRuntimeEnvironment({
        workflowPath: missingPath,
        port: 0,
        trackerAdapter: {
          fetch_candidate_issues: async () => [],
          fetch_issues_by_states: async () => [],
          fetch_issue_states_by_ids: async () => []
        }
      })
    ).toThrow(/workflow file/i);
  });

  it('emits startup cold-start and terminal cleanup diagnostics markers', async () => {
    const workflowPath = await makeWorkflowFile();
    const workflowDir = path.dirname(workflowPath);
    dirs.push(workflowDir);
    const workspaceRoot = path.join(workflowDir, 'workspaces');
    await fs.mkdir(path.join(workspaceRoot, 'ABC-1'), { recursive: true });

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => [
        {
          id: 'issue-1',
          identifier: 'ABC-1',
          title: 'Issue ABC-1',
          description: null,
          priority: 1,
          state: 'Done',
          branch_name: null,
          url: null,
          labels: [],
          blocked_by: [],
          created_at: new Date('2026-04-10T10:00:00.000Z'),
          updated_at: new Date('2026-04-10T10:00:00.000Z')
        }
      ]),
      fetch_issue_states_by_ids: vi.fn(async () => [])
    };

    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0,
      logger: {
        log: (params) => {
          logs.push({ event: params.event, context: params.context ?? {} });
        }
      }
    });
    runtimes.push(runtime);

    await runtime.start();

    const stateInitialized = logs.find((entry) => entry.event === 'startup_orchestrator_state_initialized');
    expect(stateInitialized).toBeDefined();
    expect(stateInitialized?.context.state_source).toBe('cold_start');
    expect(stateInitialized?.context.running_cleared).toBe(0);
    expect(stateInitialized?.context.retry_cleared).toBe(0);

    const cleanupCompleted = logs.find((entry) => entry.event === 'startup_terminal_cleanup_completed');
    expect(cleanupCompleted).toBeDefined();
    expect(cleanupCompleted?.context.terminal_issue_count).toBe(1);
    expect(cleanupCompleted?.context.cleaned_count).toBe(1);
    expect(cleanupCompleted?.context.failed_count).toBe(0);
  });
});
