import { describe, expect, it, vi } from 'vitest';

import { OrchestratorCore } from '../../src/orchestrator/core';
import { LocalRunnerBridge } from '../../src/orchestrator/local-runner-bridge';
import type { OrchestratorConfig, OrchestratorPorts } from '../../src/orchestrator/types';
import type { StructuredLogger } from '../../src/observability';
import { CANONICAL_EVENT } from '../../src/observability/events';
import type { Issue, TrackerAdapter } from '../../src/tracker/types';
import type { EffectiveConfig } from '../../src/workflow/types';
import type { CodexRunner, CodexRunnerEvent } from '../../src/codex';
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
    workspace: {
      root: '/tmp/symphony',
      root_source: 'workflow',
      provisioner: {
        type: 'none',
        base_ref: 'origin/main',
        branch_template: 'feature/{{ issue.identifier }}',
        teardown_mode: 'remove_worktree',
        allow_dirty_repo: false,
        fallback_to_clone_on_worktree_failure: false
      },
      copy_ignored: {
        enabled: false,
        include_file: '/tmp/symphony/.worktreeinclude',
        from: 'primary_worktree',
        conflict_policy: 'skip',
        require_gitignored: true,
        max_files: 10_000,
        max_total_bytes: 5 * 1024 * 1024 * 1024,
        allow_patterns: [],
        deny_patterns: []
      }
    },
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
    },
    persistence: {
      enabled: true,
      db_path: '/tmp/symphony/runtime.sqlite',
      retention_days: 14
    },
    logging: {
      root: '/tmp/symphony/log',
      root_source: 'workflow',
      max_bytes: 10 * 1024 * 1024,
      max_files: 5
    }
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('LocalRunnerBridge integration', () => {
  it('stops continuation turns when tracker refresh leaves active states', async () => {
    const ensureWorkspace = vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true }));
    const prepareAttempt = vi.fn(async () => {});
    const finalizeAttempt = vi.fn(async () => {});
    const cleanupWorkspace = vi.fn(async () => true);

    const startSessionAndRunTurn = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'completed' as const,
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        session_id: 'thread-1-turn-1',
        last_event: CANONICAL_EVENT.codex.turnCompleted
      })
      .mockResolvedValueOnce({
        status: 'completed' as const,
        thread_id: 'thread-2',
        turn_id: 'turn-2',
        session_id: 'thread-2-turn-2',
        last_event: CANONICAL_EVENT.codex.turnCompleted
      });

    const issueStateFetcher = vi
      .fn()
      .mockResolvedValueOnce([makeIssue({ id: 'i-1', identifier: 'ABC-1', state: 'In Progress' })])
      .mockResolvedValueOnce([makeIssue({ id: 'i-1', identifier: 'ABC-1', state: 'Done' })]);

    const workspaceManager = {
      ensureWorkspace,
      prepareAttempt,
      finalizeAttempt,
      cleanupWorkspace
    } as unknown as WorkspaceManager;

    const codexRunner = {
      startSessionAndRunTurn
    } as unknown as CodexRunner;

    const bridge = new LocalRunnerBridge({
      workspaceManager,
      codexRunner,
      config: {
        ...makeConfig(),
        agent: {
          ...makeConfig().agent,
          max_turns: 5
        }
      },
      issueStateFetcher,
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}'
    });

    const spawned = await bridge.spawnWorker({ issue: makeIssue(), attempt: null });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) {
      throw new Error('expected spawn success');
    }
    const workerHandle = spawned.worker_handle as { promise: Promise<void> };
    await workerHandle.promise;

    expect(startSessionAndRunTurn).toHaveBeenCalledTimes(2);
    expect(startSessionAndRunTurn.mock.calls[0][0]).toMatchObject({
      prompt: expect.stringContaining('Issue ABC-1 attempt'),
      maxTurns: 1
    });
    expect(startSessionAndRunTurn.mock.calls[1][0]).toMatchObject({
      prompt: expect.stringContaining('Continue on the same thread'),
      maxTurns: 1
    });
    expect(issueStateFetcher).toHaveBeenCalledTimes(2);
    expect(finalizeAttempt).toHaveBeenCalledWith('/tmp/symphony/ABC-1');
  });

  it('prepends resume context to first prompt when provided', async () => {
    const ensureWorkspace = vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true }));
    const prepareAttempt = vi.fn(async () => {});
    const finalizeAttempt = vi.fn(async () => {});
    const cleanupWorkspace = vi.fn(async () => true);
    const startSessionAndRunTurn = vi.fn(async () => ({
      status: 'completed' as const,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1',
      last_event: CANONICAL_EVENT.codex.turnCompleted
    }));

    const bridge = new LocalRunnerBridge({
      workspaceManager: { ensureWorkspace, prepareAttempt, finalizeAttempt, cleanupWorkspace } as unknown as WorkspaceManager,
      codexRunner: { startSessionAndRunTurn } as unknown as CodexRunner,
      config: makeConfig(),
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}'
    });

    const spawned = await bridge.spawnWorker({
      issue: makeIssue(),
      attempt: null,
      resume_context: 'Operator provided input.\nAnswer: Yes'
    });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) {
      throw new Error('expected spawn success');
    }
    await (spawned.worker_handle as { promise: Promise<void> }).promise;

    expect(startSessionAndRunTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Operator provided input.\nAnswer: Yes\n\nIssue ABC-1 attempt')
      })
    );
  });

  it('preserves a legacy wrapper base in mixed mode and emits a mixed-mode reason code', async () => {
    const ensureWorkspace = vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true }));
    const prepareAttempt = vi.fn(async () => {});
    const finalizeAttempt = vi.fn(async () => {});
    const cleanupWorkspace = vi.fn(async () => true);
    const startSessionAndRunTurn = vi.fn(async () => ({
      status: 'completed' as const,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1',
      last_event: CANONICAL_EVENT.codex.turnCompleted
    }));
    const events: CodexRunnerEvent[] = [];
    const config = makeConfig();
    config.codex = {
      ...config.codex,
      command: 'FOO=bar BAZ=qux CODEX_HOME="$HOME/.codex" /opt/codex-wrapper --config model="legacy" app-server',
      effective_codex_home: '/tmp/codex-home',
      effective_codex_model: 'typed-model',
      effective_reasoning_effort: 'high',
      effective_extra_flags: ['--config', 'shell_environment_policy.inherit=all'],
      effective_extra_flags_count: 2,
      codex_resolution_mode: 'mixed'
    };

    const bridge = new LocalRunnerBridge({
      workspaceManager: { ensureWorkspace, prepareAttempt, finalizeAttempt, cleanupWorkspace } as unknown as WorkspaceManager,
      codexRunner: { startSessionAndRunTurn } as unknown as CodexRunner,
      config,
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      onWorkerEvent: ({ event }) => events.push(event)
    });

    const spawned = await bridge.spawnWorker({ issue: makeIssue(), attempt: null });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) {
      throw new Error('expected spawn success');
    }
    await (spawned.worker_handle as { promise: Promise<void> }).promise;

    expect(startSessionAndRunTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/opt/codex-wrapper',
        commandArgs: [
          '--config',
          'model=legacy',
          '--config',
          'shell_environment_policy.inherit=all',
          '--config',
          'model="typed-model"',
          '--config',
          'model_reasoning_effort=high',
          'app-server'
        ],
        commandEnv: { BAZ: 'qux', CODEX_HOME: '/tmp/codex-home', FOO: 'bar' }
      })
    );
    expect(events.some((event) => event.detail === 'codex_command_legacy_path_used')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.commandMixedTypedOverridesApplied,
        detail: 'codex_command_mixed_typed_overrides_applied'
      })
    );
  });

  it('emits warning code when legacy-only codex command path is used', async () => {
    const ensureWorkspace = vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true }));
    const prepareAttempt = vi.fn(async () => {});
    const finalizeAttempt = vi.fn(async () => {});
    const cleanupWorkspace = vi.fn(async () => true);
    const startSessionAndRunTurn = vi.fn(async () => ({
      status: 'completed' as const,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1',
      last_event: CANONICAL_EVENT.codex.turnCompleted
    }));
    const events: CodexRunnerEvent[] = [];
    const config = makeConfig();
    config.codex.codex_resolution_mode = 'legacy';

    const bridge = new LocalRunnerBridge({
      workspaceManager: { ensureWorkspace, prepareAttempt, finalizeAttempt, cleanupWorkspace } as unknown as WorkspaceManager,
      codexRunner: { startSessionAndRunTurn } as unknown as CodexRunner,
      config,
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      onWorkerEvent: ({ event }) => events.push(event)
    });

    const spawned = await bridge.spawnWorker({ issue: makeIssue(), attempt: null });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) {
      throw new Error('expected spawn success');
    }
    await (spawned.worker_handle as { promise: Promise<void> }).promise;

    expect(startSessionAndRunTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'codex app-server',
        commandArgs: undefined,
        commandEnv: undefined
      })
    );
    expect(events).toEqual([
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.commandLegacyPathUsed,
        detail: 'codex_command_legacy_path_used'
      })
    ]);
  });

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
      last_event: CANONICAL_EVENT.codex.turnCompleted
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
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    let orchestrator!: OrchestratorCore;
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    const bridge = new LocalRunnerBridge({
      workspaceManager,
      codexRunner,
      config: makeConfig(),
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      logger,
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
    const started = logs.find((entry) => entry.event === CANONICAL_EVENT.agentRunner.attemptStarted);
    expect(started?.context.issue_id).toBe('i-1');
    expect(started?.context.issue_identifier).toBe('ABC-1');
    const completed = logs.find((entry) => entry.event === CANONICAL_EVENT.agentRunner.attemptCompleted);
    expect(completed?.context.session_id).toBe('thread-1-turn-1');
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
      fetch_issue_states_by_ids: vi.fn(async () => [makeIssue({ id: issue.id, state: 'Done' })]),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
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
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    let orchestrator!: OrchestratorCore;
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    const bridge = new LocalRunnerBridge({
      workspaceManager,
      codexRunner,
      config: makeConfig(),
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      logger,
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
    const failed = logs.find((entry) => entry.event === CANONICAL_EVENT.agentRunner.attemptFailed);
    expect(failed?.context.issue_id).toBe('i-1');
    expect(failed?.context.issue_identifier).toBe('ABC-1');
    expect(failed?.context.error).toBe('response timeout');
  });

  it('emits typed workspace conflict envelope when workspace preflight reports unresolved tracked artifacts', async () => {
    const workspaceManager = {
      ensureWorkspace: vi.fn(async () => ({ path: '/tmp/symphony/ABC-1', workspace_key: 'ABC-1', created_now: true })),
      prepareAttempt: vi.fn(async () => {
        const err = new Error(
          'workspace_preflight_conflict:{"detail":"tracked output/playwright artifacts remain after preflight cleanup","conflict_files":[{"path":"output/playwright/ui-evidence.json","status":"staged"}],"resolution_hints":["Remove tracked entries under output/playwright/ from git index/history."]}'
        ) as Error & { code?: string };
        err.code = 'workspace_unprovisioned_conflict';
        throw err;
      }),
      finalizeAttempt: vi.fn(async () => {}),
      cleanupWorkspace: vi.fn(async () => true)
    } as unknown as WorkspaceManager;
    const codexRunner = {
      startSessionAndRunTurn: vi.fn(async () => {
        throw new Error('should not be reached');
      })
    } as unknown as CodexRunner;
    const tracker: TrackerAdapter = {
      fetch_candidate_issues: vi.fn(async () => [makeIssue()]),
      fetch_issues_by_states: vi.fn(async () => []),
      fetch_issue_states_by_ids: vi.fn(async () => []),
      create_comment: vi.fn(async () => undefined),
      update_issue_state: vi.fn(async () => undefined)
    };

    let orchestrator!: OrchestratorCore;
    const bridge = new LocalRunnerBridge({
      workspaceManager,
      codexRunner,
      config: makeConfig(),
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      onWorkerExit: async ({ issue_id, reason, error }) => {
        await orchestrator.onWorkerExit(issue_id, reason, error);
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

    const snapshot = orchestrator.getStateSnapshot();
    const blocked = snapshot.blocked_inputs.get('i-1');
    expect(blocked?.stop_reason_code).toBe('operator_action_required_workspace_conflict');
    expect(blocked?.conflict_files).toEqual([{ path: 'output/playwright/ui-evidence.json', status: 'staged' }]);
    expect(blocked?.resolution_hints).toContain('Remove tracked entries under output/playwright/ from git index/history.');
    expect(snapshot.retry_attempts.has('i-1')).toBe(false);
  });

  it('fails fast with codex.startup.failed event when workspace resolves to unsafe root', async () => {
    const workspaceManager = {
      ensureWorkspace: vi.fn(async () => ({
        path: '/tmp/symphony',
        workspace_key: 'ABC-1',
        created_now: true
      })),
      prepareAttempt: vi.fn(async () => {}),
      finalizeAttempt: vi.fn(async () => {}),
      cleanupWorkspace: vi.fn(async () => true)
    } as unknown as WorkspaceManager;

    const startSessionAndRunTurn = vi.fn(async () => ({
      status: 'completed' as const,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1',
      last_event: CANONICAL_EVENT.codex.turnCompleted
    }));
    const codexRunner = {
      startSessionAndRunTurn
    } as unknown as CodexRunner;

    const events: string[] = [];
    const bridge = new LocalRunnerBridge({
      workspaceManager,
      codexRunner,
      config: {
        ...makeConfig(),
        workspace: {
          root: '/tmp/symphony',
          root_source: 'workflow',
          provisioner: {
            type: 'none',
            base_ref: 'origin/main',
            branch_template: 'feature/{{ issue.identifier }}',
            teardown_mode: 'remove_worktree',
            allow_dirty_repo: false,
            fallback_to_clone_on_worktree_failure: false
          },
          copy_ignored: {
            enabled: false,
            include_file: '/tmp/symphony/.worktreeinclude',
            from: 'primary_worktree',
            conflict_policy: 'skip',
            require_gitignored: true,
            max_files: 10_000,
            max_total_bytes: 5 * 1024 * 1024 * 1024,
            allow_patterns: [],
            deny_patterns: []
          }
        }
      },
      promptTemplate: 'Issue {{ issue.identifier }} attempt {{ attempt }}',
      onWorkerEvent: ({ event }) => {
        events.push(event.event);
      }
    });

    const spawned = await bridge.spawnWorker({ issue: makeIssue(), attempt: null });
    expect(spawned.ok).toBe(true);
    await flush();

    expect(startSessionAndRunTurn).not.toHaveBeenCalled();
    expect(events).toContain(CANONICAL_EVENT.codex.startupFailed);
  });
});
