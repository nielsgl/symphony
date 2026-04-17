import { LocalApiServer } from '../api';
import { CodexRunner, createDefaultDynamicToolExecutor, type CodexRunnerEvent } from '../codex';
import { MultiSinkLogger, type StructuredLogger } from '../observability';
import { SqlitePersistenceStore } from '../persistence';
import { LocalRunnerBridge, OrchestratorCore, type DispatchPreflightResult } from '../orchestrator';
import type { WorkerObservabilityEvent } from '../orchestrator';
import { resolveSecurityProfile, securityProfileSummary } from '../security';
import { createTrackerAdapter, type TrackerAdapter } from '../tracker';
import { WorkflowLoader, ConfigResolver, ConfigValidator, type EffectiveConfig } from '../workflow';
import { WorkspaceManager } from '../workspace';

interface RuntimeTimer {
  timeout: NodeJS.Timeout;
}

export interface RuntimeBootstrapOptions {
  workflowPath?: string;
  host?: string;
  port?: number;
  nowMs?: () => number;
  logger?: StructuredLogger;
  trackerAdapter?: TrackerAdapter;
  fetchFn?: typeof fetch;
}

export interface RuntimeBootstrapResult {
  apiServer: LocalApiServer | null;
  orchestrator: OrchestratorCore;
  effectiveConfig: EffectiveConfig;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

function toWorkerEvent(event: CodexRunnerEvent, nowMs: number): WorkerObservabilityEvent {
  const parsed = Date.parse(event.timestamp);
  return {
    timestamp_ms: Number.isFinite(parsed) ? parsed : nowMs,
    event: event.event,
    thread_id: event.thread_id,
    turn_id: event.turn_id,
    session_id: event.session_id,
    codex_app_server_pid: event.codex_app_server_pid,
    detail: event.detail,
    usage: event.usage,
    rate_limits: event.rate_limits
  };
}

export function createRuntimeEnvironment(options: RuntimeBootstrapOptions = {}): RuntimeBootstrapResult {
  const nowMs = options.nowMs ?? (() => Date.now());
  const logger = options.logger ?? new MultiSinkLogger();

  const workflowLoader = new WorkflowLoader();
  const workflowDefinition = workflowLoader.load({ explicitPath: options.workflowPath });

  const configResolver = new ConfigResolver();
  const effectiveConfig = configResolver.resolve(workflowDefinition);

  const validator = new ConfigValidator();
  const startupValidation = validator.validate(effectiveConfig);
  if (!startupValidation.ok) {
    const canBypassTrackerCredentialValidation =
      Boolean(options.trackerAdapter) &&
      (startupValidation.error_code === 'missing_tracker_api_key' ||
        startupValidation.error_code === 'missing_tracker_project_slug' ||
        startupValidation.error_code === 'missing_tracker_owner' ||
        startupValidation.error_code === 'missing_tracker_repo');

    if (!canBypassTrackerCredentialValidation) {
      throw new Error(startupValidation.message);
    }

    logger.log({
      level: 'warn',
      event: 'runtime_startup_validation_bypassed',
      message: startupValidation.message
    });
  }

  const tracker =
    options.trackerAdapter ??
    createTrackerAdapter(
      {
        ...effectiveConfig.tracker,
        timeout_ms: 30_000,
        page_size: 50
      },
      options.fetchFn
    );

  const workspaceManager = new WorkspaceManager({
    root: effectiveConfig.workspace.root,
    hooks: effectiveConfig.hooks
  });

  const activeProfile = resolveSecurityProfile(effectiveConfig.codex);
  effectiveConfig.codex.security_profile = activeProfile.name;
  effectiveConfig.codex.approval_policy = activeProfile.approval_policy;
  effectiveConfig.codex.thread_sandbox = activeProfile.thread_sandbox;
  effectiveConfig.codex.turn_sandbox_policy = activeProfile.turn_sandbox_policy.type;
  effectiveConfig.codex.user_input_policy = activeProfile.user_input_policy;

  logger.log({
    level: 'info',
    event: 'security_profile_active',
    message: securityProfileSummary(activeProfile),
    context: {
      profile_name: activeProfile.name,
      approval_policy:
        typeof activeProfile.approval_policy === 'string'
          ? activeProfile.approval_policy
          : JSON.stringify(activeProfile.approval_policy),
      thread_sandbox: activeProfile.thread_sandbox,
      turn_sandbox_policy: activeProfile.turn_sandbox_policy.type
    }
  });

  const persistenceStore = effectiveConfig.persistence.enabled
    ? new SqlitePersistenceStore({
        dbPath: effectiveConfig.persistence.db_path,
        retentionDays: effectiveConfig.persistence.retention_days,
        nowMs
      })
    : null;

  const codexRunner = new CodexRunner({
    dynamicToolExecutor: createDefaultDynamicToolExecutor({
      trackerEndpoint: effectiveConfig.tracker.endpoint,
      trackerApiKey: effectiveConfig.tracker.api_key,
      fetchFn: options.fetchFn
    })
  });
  let orchestrator: OrchestratorCore;
  let apiServer: LocalApiServer | null = null;

  const bridge = new LocalRunnerBridge({
    workspaceManager,
    codexRunner,
    config: effectiveConfig,
    promptTemplate: workflowDefinition.prompt_template,
    onWorkerExit: async ({ issue_id, reason, error }) => {
      await orchestrator.onWorkerExit(issue_id, reason, error);
    },
    onWorkerEvent: ({ issue_id, event }) => {
      orchestrator.onWorkerEvent(issue_id, toWorkerEvent(event, nowMs()));
    }
  });

  const retryTimers = new Map<string, RuntimeTimer>();
  let pollIntervalHandle: NodeJS.Timeout | null = null;

  const dispatchPreflight = (): DispatchPreflightResult => {
    const result = validator.evaluateDispatchPreflight(effectiveConfig);
    return {
      dispatch_allowed: result.dispatch_allowed,
      reason: result.validation.ok ? undefined : result.validation.message
    };
  };

  orchestrator = new OrchestratorCore({
    config: {
      poll_interval_ms: effectiveConfig.polling.interval_ms,
      max_concurrent_agents: effectiveConfig.agent.max_concurrent_agents,
      max_concurrent_agents_by_state: effectiveConfig.agent.max_concurrent_agents_by_state,
      max_retry_backoff_ms: effectiveConfig.agent.max_retry_backoff_ms,
      active_states: effectiveConfig.tracker.active_states,
      terminal_states: effectiveConfig.tracker.terminal_states,
      stall_timeout_ms: effectiveConfig.codex.stall_timeout_ms,
      worker_hosts: effectiveConfig.worker?.ssh_hosts ?? [],
      max_concurrent_agents_per_host: effectiveConfig.worker?.max_concurrent_agents_per_host ?? null
    },
    ports: {
      tracker,
      dispatchPreflight,
      spawnWorker: ({ issue, attempt, worker_host }) => bridge.spawnWorker({ issue, attempt, worker_host }),
      terminateWorker: ({ issue_id, worker_handle, cleanup_workspace }) =>
        bridge.terminateWorker({ issue_id, worker_handle, cleanup_workspace }),
      scheduleRetryTimer: ({ issue_id, due_at_ms, callback }) => {
        const delayMs = Math.max(0, due_at_ms - nowMs());
        const timeout = setTimeout(() => {
          void callback();
        }, delayMs);
        retryTimers.set(issue_id, { timeout });
        return timeout;
      },
      cancelRetryTimer: (timer_handle) => {
        const timeout = timer_handle as NodeJS.Timeout;
        clearTimeout(timeout);
        for (const [issueId, timer] of retryTimers.entries()) {
          if (timer.timeout === timeout) {
            retryTimers.delete(issueId);
          }
        }
      },
      notifyObservers: () => {
        apiServer?.notifyStateChanged('orchestrator_observer');
      }
    },
    nowMs,
    persistence: persistenceStore
      ? {
          startRun: async (params) => persistenceStore.startRun(params),
          recordSession: async (params) => {
            persistenceStore.recordSession(params.run_id, params.session_id);
          },
          recordEvent: async (params) => {
            persistenceStore.recordEvent(params);
          },
          completeRun: async (params) => {
            persistenceStore.completeRun(params);
          }
        }
      : undefined,
    logger
  });

  const resolvedPort = options.port ?? effectiveConfig.server?.port;
  apiServer =
    resolvedPort === undefined
      ? null
      : new LocalApiServer({
          host: options.host ?? '127.0.0.1',
          port: resolvedPort,
          snapshotSource: {
            getStateSnapshot: () => orchestrator.getStateSnapshot()
          },
          refreshSource: {
            tick: (reason) => orchestrator.tick(reason)
          },
          diagnosticsSource: {
            getActiveProfile: () => activeProfile,
            getPersistenceHealth: () =>
              persistenceStore
                ? persistenceStore.health()
                : {
                    enabled: false,
                    db_path: null,
                    retention_days: effectiveConfig.persistence.retention_days,
                    run_count: 0,
                    last_pruned_at: null,
                    integrity_ok: true
                  },
            listRunHistory: (limit) => (persistenceStore ? persistenceStore.listRunHistory(limit) : []),
            getUiState: () => (persistenceStore ? persistenceStore.loadUiState() : null),
            setUiState: (state) => {
              persistenceStore?.saveUiState(state);
            }
          },
          logger,
          nowMs
        });

  const start = async (): Promise<void> => {
    const startupSnapshot = orchestrator.getStateSnapshot();
    logger.log({
      level: 'info',
      event: 'startup_orchestrator_state_initialized',
      message: 'startup initialized orchestrator state from cold process memory',
      context: {
        state_source: 'cold_start',
        running_cleared: startupSnapshot.running.size,
        retry_cleared: startupSnapshot.retry_attempts.size
      }
    });

    if (apiServer) {
      await apiServer.listen();
      const address = apiServer.address();
      logger.log({
        level: 'info',
        event: 'runtime_http_enabled',
        message: 'local HTTP extension enabled',
        context: {
          host: address.host,
          port: address.port,
          configured_port: resolvedPort
        }
      });
    } else {
      logger.log({
        level: 'info',
        event: 'runtime_http_disabled',
        message: 'local HTTP extension disabled (no CLI or workflow port configured)',
        context: {
          configured_port: null
        }
      });
    }

    if (persistenceStore) {
      const pruned = persistenceStore.pruneExpiredRuns();
      logger.log({
        level: 'info',
        event: 'persistence_pruned',
        message: `pruned ${pruned} expired run records`,
        context: {
          pruned,
          retention_days: effectiveConfig.persistence.retention_days
        }
      });
    }

    try {
      const terminalIssues = await tracker.fetch_issues_by_states(effectiveConfig.tracker.terminal_states);
      const cleanupResults = await workspaceManager.cleanupWorkspaces(terminalIssues.map((issue) => issue.identifier));
      const cleanedCount = cleanupResults.filter((result) => result.cleaned).length;
      logger.log({
        level: 'info',
        event: 'startup_terminal_cleanup_completed',
        message: 'completed startup terminal workspace cleanup sweep',
        context: {
          terminal_issue_count: terminalIssues.length,
          cleaned_count: cleanedCount,
          failed_count: cleanupResults.length - cleanedCount
        }
      });
    } catch (error) {
      logger.log({
        level: 'warn',
        event: 'startup_terminal_cleanup_failed',
        message: error instanceof Error ? error.message : 'terminal cleanup failed'
      });
    }

    await orchestrator.tick('startup');
    pollIntervalHandle = setInterval(() => {
      void orchestrator.tick('interval');
    }, Math.max(1000, effectiveConfig.polling.interval_ms));

    logger.log({
      level: 'info',
      event: 'runtime_started',
      message: 'runtime environment started',
      context: {
        poll_interval_ms: effectiveConfig.polling.interval_ms,
        http_server_enabled: apiServer !== null
      }
    });
  };

  const stop = async (): Promise<void> => {
    if (pollIntervalHandle) {
      clearInterval(pollIntervalHandle);
      pollIntervalHandle = null;
    }

    for (const timer of retryTimers.values()) {
      clearTimeout(timer.timeout);
    }
    retryTimers.clear();

    if (apiServer) {
      await apiServer.close();
    }

    persistenceStore?.close();

    logger.log({
      level: 'info',
      event: 'runtime_stopped',
      message: 'runtime environment stopped'
    });
  };

  return {
    apiServer,
    orchestrator,
    effectiveConfig,
    start,
    stop
  };
}
