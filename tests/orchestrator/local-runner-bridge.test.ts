import { describe, expect, it, vi } from 'vitest';

import { OrchestratorCore } from '../../src/orchestrator/core';
import { LocalRunnerBridge } from '../../src/orchestrator/local-runner-bridge';
import type { OrchestratorConfig, OrchestratorPorts } from '../../src/orchestrator/types';
import type { Issue, TrackerAdapter } from '../../src/tracker/types';
import type { EffectiveConfig } from '../../src/workflow/types';
import type { CodexRunner } from '../../src/codex';
import type { WorkspaceManager } from '../../src/workspace';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'i-1',
    identifier: 'ABC-1',
    title: 'Issue ABC-1',
    description: null,
    priority: 2,
    state: 'Todo',
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides
  };
}

function makeConfig(): EffectiveConfig {
  return {
    tracker: {
      kind: 'linear',
      endpoint: 'https://api.linear.app/graphql',
      api_key: 'token',
      project_slug: 'PROJ',
      active_states: ['Todo', 'In Progress'],
      terminal_states: ['Done']
    },
    polling: { interval_ms: 30000 },
    workspace: { root: '/tmp/symphony' },
    hooks: { timeout_ms: 1000 },
    agent: {
      max_concurrent_agents: 2,
      max_retry_backoff_ms: 300000,
      max_turns: 1,
      max_concurrent_agents_by_state: {}
    },
    codex: {
      command: 'codex app-server',
      turn_timeout_ms: 1000,
      read_timeout_ms: 1000,
      stall_timeout_ms: 300000
    }
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('LocalRunnerBridge integration', () => {
  it('runs workspace ensure/prepare/codex/finalize via orchestrator spawn path', async () => {
    const ensureWorkspace = vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true }));
    const prepareAttempt = vi.fn(async () => {});
    const finalizeAttempt = vi.fn(async () => {});
    const cleanupWorkspace = vi.fn(async () => true);

    const startSessionAndRunTurn = vi.fn(async () => ({
      status: 'completed' as const,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1',
      last_event: 'turn_completed'
    }));

    const workspaceManager = {
      ensureWorkspace,
      prepareAttempt,
      finalizeAttempt,
      cleanupWorkspace
    } as unknown as WorkspaceManager;

    const codexRunner = {
      startSessionAndRunTurn
    } as unknown as CodexRunner;

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => [makeIssue()]),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => [])
    };

    let orchestrator!: OrchestratorCore;
    const bridge = new LocalRunnerBridge({
      workspaceManager,
      codexRunner,
      config: makeConfig(),
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      onWorkerExit: async ({ issue_id, reason }) => {
        await orchestrator.onWorkerExit(issue_id, reason);
      }
    });

    const ports: OrchestratorPorts = {
      tracker,
      dispatchPreflight: () => ({ dispatch_allowed: true }),
      spawnWorker: (params) => bridge.spawnWorker(params),
      terminateWorker: async () => {},
      scheduleRetryTimer: ({ issue_id }) => ({ issue_id }),
      cancelRetryTimer: () => {}
    };

    const config: OrchestratorConfig = {
      poll_interval_ms: 30000,
      max_concurrent_agents: 2,
      max_concurrent_agents_by_state: {},
      max_retry_backoff_ms: 300000,
      active_states: ['Todo', 'In Progress'],
      terminal_states: ['Done'],
      stall_timeout_ms: 300000
    };

    orchestrator = new OrchestratorCore({ config, ports });
    await orchestrator.tick('interval');
    await flush();

    expect(ensureWorkspace).toHaveBeenCalledWith('ABC-1');
    expect(prepareAttempt).toHaveBeenCalledWith('/tmp/symphony/ABC-1');
    expect(startSessionAndRunTurn).toHaveBeenCalledTimes(1);
    expect(startSessionAndRunTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Issue ABC-1 attempt'),
        maxTurns: 1
      })
    );
    expect(finalizeAttempt).toHaveBeenCalledWith('/tmp/symphony/ABC-1');

    const retry = orchestrator.getStateSnapshot().retry_attempts.get('i-1');
    expect(retry?.attempt).toBe(1);
  });

  it('invokes workspace cleanup helper when terminateWorker requests cleanup', async () => {
    const issue = makeIssue();
    const pending = new Promise<never>(() => {
      return;
    });

    const cleanupWorkspace = vi.fn(async () => true);
    const workspaceManager = {
      ensureWorkspace: vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true })),
      prepareAttempt: vi.fn(async () => {}),
      finalizeAttempt: vi.fn(async () => {}),
      cleanupWorkspace
    } as unknown as WorkspaceManager;
    const codexRunner = {
      startSessionAndRunTurn: vi.fn(() => pending)
    } as unknown as CodexRunner;

    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => [issue]),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => [makeIssue({ id: issue.id, state: 'Done' })])
    };

    const bridge = new LocalRunnerBridge({
      workspaceManager,
      codexRunner,
      config: makeConfig(),
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}'
    });

    const ports: OrchestratorPorts = {
      tracker,
      dispatchPreflight: () => ({ dispatch_allowed: true }),
      spawnWorker: (params) => bridge.spawnWorker(params),
      terminateWorker: async ({ issue_id, worker_handle, cleanup_workspace }) => {
        await bridge.terminateWorker({ issue_id, worker_handle, cleanup_workspace });
      },
      scheduleRetryTimer: ({ issue_id }) => ({ issue_id }),
      cancelRetryTimer: () => {}
    };

    const config: OrchestratorConfig = {
      poll_interval_ms: 30000,
      max_concurrent_agents: 1,
      max_concurrent_agents_by_state: {},
      max_retry_backoff_ms: 300000,
      active_states: ['Todo', 'In Progress'],
      terminal_states: ['Done'],
      stall_timeout_ms: 300000
    };

    const orchestrator = new OrchestratorCore({ config, ports });
    await orchestrator.tick('interval');
    await orchestrator.reconcileRunningIssues();

    expect(cleanupWorkspace).toHaveBeenCalledWith('ABC-1');
  });

  it('maps codex startup failure to abnormal worker exit and retry scheduling', async () => {
    const workspaceManager = {
      ensureWorkspace: vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true })),
      prepareAttempt: vi.fn(async () => {}),
      finalizeAttempt: vi.fn(async () => {}),
      cleanupWorkspace: vi.fn(async () => true)
    } as unknown as WorkspaceManager;
    const codexRunner = {
      startSessionAndRunTurn: vi.fn(async () => {
        throw new Error('response timeout');
      })
    } as unknown as CodexRunner;
    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => [makeIssue()]),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => [])
    };

    let orchestrator!: OrchestratorCore;
    const bridge = new LocalRunnerBridge({
      workspaceManager,
      codexRunner,
      config: makeConfig(),
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      onWorkerExit: async ({ issue_id, reason }) => {
        await orchestrator.onWorkerExit(issue_id, reason);
      }
    });

    const ports: OrchestratorPorts = {
      tracker,
      dispatchPreflight: () => ({ dispatch_allowed: true }),
      spawnWorker: (params) => bridge.spawnWorker(params),
      terminateWorker: async () => {},
      scheduleRetryTimer: ({ issue_id, callback, due_at_ms }) => {
        void callback;
        return { issue_id, due_at_ms };
      },
      cancelRetryTimer: () => {}
    };

    const config: OrchestratorConfig = {
      poll_interval_ms: 30000,
      max_concurrent_agents: 2,
      max_concurrent_agents_by_state: {},
      max_retry_backoff_ms: 300000,
      active_states: ['Todo', 'In Progress'],
      terminal_states: ['Done'],
      stall_timeout_ms: 300000
    };

    orchestrator = new OrchestratorCore({ config, ports });
    await orchestrator.tick('interval');
    await flush();

    const retry = orchestrator.getStateSnapshot().retry_attempts.get('i-1');
    expect(retry?.attempt).toBe(1);
    expect(retry?.error).toBe('worker exited: abnormal');
  });
});
