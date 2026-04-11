import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRuntimeEnvironment } from '../../src/runtime';
import type { TrackerAdapter } from '../../src/tracker';

async function makeWorkflowFile(options?: { includeTrackerCredentials?: boolean }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-runtime-'));
  const workflowPath = path.join(dir, 'WORKFLOW.md');
  const includeTrackerCredentials = options?.includeTrackerCredentials ?? true;
  const trackerCredentialBlock = includeTrackerCredentials
    ? `  api_key: test-token
  project_slug: TEST
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
server:
  port: 0
---
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
    const address = runtime.apiServer.address();

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
    const address = runtime.apiServer.address();

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/refresh`, { method: 'POST' });
    expect(response.status).toBe(202);
    expect(tracker.fetch_candidate_issues).toHaveBeenCalled();
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
    const address = runtime.apiServer.address();

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const payload = (await response.json()) as {
      health: { dispatch_validation: 'ok' | 'failed'; last_error: string | null };
    };

    expect(response.status).toBe(200);
    expect(payload.health.dispatch_validation).toBe('failed');
    expect(payload.health.last_error).toContain('tracker.api_key is required');
  });
});
