import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CANONICAL_EVENT } from '../../src/observability/events';
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
  loggingRoot?: string;
  pollingIntervalMs?: number;
  hooksTimeoutMs?: number;
}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-runtime-'));
  const workflowPath = path.join(dir, 'WORKFLOW.md');
  const includeTrackerCredentials = options?.includeTrackerCredentials ?? true;
  const includeServerPort = options?.includeServerPort ?? true;
  const serverPort = options?.serverPort ?? 0;
  const loggingRoot = options?.loggingRoot;
  const pollingIntervalMs = options?.pollingIntervalMs ?? 1000;
  const hooksTimeoutMs = options?.hooksTimeoutMs ?? 1000;
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
  const loggingBlock =
    typeof loggingRoot === 'string' && loggingRoot.trim().length > 0
      ? `logging:
  root: ${JSON.stringify(loggingRoot)}
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
  interval_ms: ${pollingIntervalMs}
workspace:
  root: ${JSON.stringify(path.join(dir, 'workspaces'))}
hooks:
  timeout_ms: ${hooksTimeoutMs}
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
${serverBlock}${loggingBlock}---
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
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
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
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
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
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
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
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
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

  it('fails startup on strict numeric validation errors', async () => {
    const workflowPath = await makeWorkflowFile({ hooksTimeoutMs: 0 });
    dirs.push(path.dirname(workflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    expect(() =>
      createRuntimeEnvironment({
        workflowPath,
        trackerAdapter: tracker,
        port: 0
      })
    ).toThrow('hooks.timeout_ms must be a positive integer');
  });

  it('exposes diagnostics profile and persistence status endpoints', async () => {
    const workflowPath = await makeWorkflowFile();
    dirs.push(path.dirname(workflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
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
      logging: {
        root: string;
        active_file: string;
        sinks: string[];
        rotation: { max_bytes: number; max_files: number };
      };
    };

    expect(response.status).toBe(200);
    expect(payload.active_profile.name).toBe('strict');
    expect(payload.active_profile.approval_policy).toBe('never');
    expect(payload.persistence.enabled).toBe(true);
    expect(payload.persistence.integrity_ok).toBe(true);
    expect(payload.logging.root).toBe(path.join(path.dirname(workflowPath), '.symphony', 'log'));
    expect(payload.logging.active_file).toBe(path.join(path.dirname(workflowPath), '.symphony', 'log', 'symphony.log'));
    expect(payload.logging.sinks).toEqual(['stderr', 'file']);
    expect(payload.logging.rotation.max_files).toBe(5);
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
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
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
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
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
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
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
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
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
      logObserver: logger
    });
    runtimes.push(runtime);

    await runtime.start();

    const enabledEvent = entries.find((entry) => entry.event === CANONICAL_EVENT.runtime.httpEnabled);
    expect(enabledEvent).toBeDefined();
    expect(enabledEvent?.context.configured_port).toBe(0);
    const loggingConfiguredEvent = entries.find((entry) => entry.event === CANONICAL_EVENT.runtime.loggingConfigured);
    expect(loggingConfiguredEvent).toBeDefined();
    expect(loggingConfiguredEvent?.context.logs_root_source).toBe('default');

    const address = requireApiAddress(runtime);
    const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const diagnosticsPayload = (await diagnosticsResponse.json()) as {
      logging: { sinks: string[] };
    };
    expect(diagnosticsResponse.status).toBe(200);
    expect(diagnosticsPayload.logging.sinks).toEqual(['stderr', 'file', 'observer']);
  });

  it('uses explicit logsRoot option precedence over workflow logging.root', async () => {
    const workflowPath = await makeWorkflowFile();
    const workflowDir = path.dirname(workflowPath);
    dirs.push(workflowDir);
    const cliLogsRoot = path.join(workflowDir, 'custom-logs');

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };
    const entries: Array<{ event: string; context: Record<string, unknown> }> = [];

    const runtime = createRuntimeEnvironment({
      workflowPath,
      logsRoot: cliLogsRoot,
      trackerAdapter: tracker,
      port: 0,
      logObserver: {
        log: (params) => {
          entries.push({ event: params.event, context: params.context ?? {} });
        }
      }
    });
    runtimes.push(runtime);

    await runtime.start();
    const address = requireApiAddress(runtime);

    const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const diagnosticsPayload = (await diagnosticsResponse.json()) as {
      logging: { root: string; active_file: string };
    };

    expect(diagnosticsResponse.status).toBe(200);
    expect(diagnosticsPayload.logging.root).toBe(cliLogsRoot);
    expect(diagnosticsPayload.logging.active_file).toBe(path.join(cliLogsRoot, 'symphony.log'));
    const loggingConfiguredEvent = entries.find((entry) => entry.event === CANONICAL_EVENT.runtime.loggingConfigured);
    expect(loggingConfiguredEvent?.context.logs_root_source).toBe('cli');
  });

  it('uses workflow logging.root when CLI logsRoot is unset', async () => {
    const workflowPath = await makeWorkflowFile({
      loggingRoot: '$SYMPHONY_TEST_LOG_ROOT'
    });
    const workflowDir = path.dirname(workflowPath);
    dirs.push(workflowDir);

    const workflowLogsRoot = path.join(workflowDir, 'workflow-logs');
    process.env.SYMPHONY_TEST_LOG_ROOT = workflowLogsRoot;

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };
    const entries: Array<{ event: string; context: Record<string, unknown> }> = [];

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0,
      logObserver: {
        log: (params) => {
          entries.push({ event: params.event, context: params.context ?? {} });
        }
      }
    });
    runtimes.push(runtime);

    try {
      await runtime.start();
      const address = requireApiAddress(runtime);

      const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
      const diagnosticsPayload = (await diagnosticsResponse.json()) as {
        logging: { root: string; active_file: string; sinks: string[] };
      };

      expect(diagnosticsResponse.status).toBe(200);
      expect(diagnosticsPayload.logging.root).toBe(workflowLogsRoot);
      expect(diagnosticsPayload.logging.active_file).toBe(path.join(workflowLogsRoot, 'symphony.log'));
      expect(diagnosticsPayload.logging.sinks).toEqual(['stderr', 'file', 'observer']);
      const loggingConfiguredEvent = entries.find((entry) => entry.event === CANONICAL_EVENT.runtime.loggingConfigured);
      expect(loggingConfiguredEvent?.context.logs_root_source).toBe('workflow');
    } finally {
      delete process.env.SYMPHONY_TEST_LOG_ROOT;
    }
  });

  it('fails startup with typed workflow config error when logs root is not writable', async () => {
    const workflowPath = await makeWorkflowFile();
    const workflowDir = path.dirname(workflowPath);
    dirs.push(workflowDir);

    const blockedPath = path.join(workflowDir, 'blocked-log-root');
    await fs.writeFile(blockedPath, 'not-a-directory', 'utf8');

    expect(() =>
      createRuntimeEnvironment({
        workflowPath,
        logsRoot: blockedPath,
        trackerAdapter: {
          fetch_candidate_issues: async () => [],
          fetch_issues_by_states: async () => [],
          fetch_issue_states_by_ids: async () => [],
          create_comment: vi.fn(async () => undefined),
          update_issue_state: vi.fn(async () => undefined)
        },
        port: 0
      })
    ).toThrow(/invalid_logging_root|logging\.root is not writable/i);
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
          fetch_issue_states_by_ids: async () => [],
          create_comment: vi.fn(async () => undefined),
          update_issue_state: vi.fn(async () => undefined)
        }
      })
    ).toThrow(/workflow file/i);
  });

  it('fails startup with invalid_server_host when host is not resolvable', async () => {
    const workflowPath = await makeWorkflowFile();
    dirs.push(path.dirname(workflowPath));

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: {
        fetch_candidate_issues: async () => [],
        fetch_issues_by_states: async () => [],
        fetch_issue_states_by_ids: async () => [],
        create_comment: vi.fn(async () => undefined),
        update_issue_state: vi.fn(async () => undefined)
      },
      host: 'nonexistent.invalid.symphony.local',
      port: 0
    });

    await expect(runtime.start()).rejects.toThrow(/invalid_server_host|not resolvable/);
  });

  it('supports runtime workflow path switch and preserves last-known-good config', async () => {
    const workflowPath = await makeWorkflowFile({ pollingIntervalMs: 1000 });
    const nextWorkflowPath = await makeWorkflowFile({ pollingIntervalMs: 4000 });
    dirs.push(path.dirname(workflowPath));
    dirs.push(path.dirname(nextWorkflowPath));

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => []),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0
    });
    runtimes.push(runtime);
    await runtime.start();

    const address = requireApiAddress(runtime);
    const switchResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/workflow/path`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow_path: nextWorkflowPath })
    });
    expect(switchResponse.status).toBe(202);
    expect(runtime.orchestrator.getStateSnapshot().poll_interval_ms).toBe(4000);

    const invalidResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/workflow/path`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow_path: path.join(path.dirname(nextWorkflowPath), 'missing.md') })
    });
    expect(invalidResponse.status).toBe(422);
    expect(runtime.orchestrator.getStateSnapshot().poll_interval_ms).toBe(4000);
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
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const runtime = createRuntimeEnvironment({
      workflowPath,
      trackerAdapter: tracker,
      port: 0,
      logObserver: {
        log: (params) => {
          logs.push({ event: params.event, context: params.context ?? {} });
        }
      }
    });
    runtimes.push(runtime);

    await runtime.start();

    const stateInitialized = logs.find((entry) => entry.event === CANONICAL_EVENT.runtime.startupStateInitialized);
    expect(stateInitialized).toBeDefined();
    expect(stateInitialized?.context.state_source).toBe('cold_start');
    expect(stateInitialized?.context.running_cleared).toBe(0);
    expect(stateInitialized?.context.retry_cleared).toBe(0);

    const cleanupCompleted = logs.find((entry) => entry.event === CANONICAL_EVENT.runtime.startupCleanupCompleted);
    expect(cleanupCompleted).toBeDefined();
    expect(cleanupCompleted?.context.terminal_issue_count).toBe(1);
    expect(cleanupCompleted?.context.cleaned_count).toBe(1);
    expect(cleanupCompleted?.context.failed_count).toBe(0);
  });
});
