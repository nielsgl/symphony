import fs from 'node:fs';
import dns from 'node:dns/promises';
import path from 'node:path';
import net from 'node:net';

import { LocalApiServer } from '../api';
import { CodexRunner, createDefaultDynamicToolExecutor, type CodexRunnerEvent } from '../codex';
import {
  DEFAULT_LOG_FILE_NAME,
  type LogEntry,
  type LogSink,
  MultiSinkLogger,
  RotatingFileSink,
  StderrSink,
  type StructuredLogger
} from '../observability';
import { CANONICAL_EVENT } from '../observability/events';
import { SqlitePersistenceStore } from '../persistence';
import { LocalRunnerBridge, OrchestratorCore, type DispatchPreflightResult } from '../orchestrator';
import type { WorkerObservabilityEvent } from '../orchestrator';
import { resolveSecurityProfile, securityProfileSummary } from '../security';
import { createTrackerAdapter, type TrackerAdapter } from '../tracker';
import { WorkflowConfigError } from '../workflow/errors';
import {
  WorkflowLoader,
  ConfigResolver,
  ConfigValidator,
  DEFAULT_PROMPT_TEMPLATE,
  type EffectiveConfig,
  type WorkflowDefinition
} from '../workflow';
import { WorkspaceManager, createWorkspaceProvisioner } from '../workspace';

interface RuntimeTimer {
  timeout: NodeJS.Timeout;
}

export interface RuntimeBootstrapOptions {
  workflowPath?: string;
  logsRoot?: string;
  host?: string;
  port?: number;
  nowMs?: () => number;
  logObserver?: StructuredLogger;
  trackerAdapter?: TrackerAdapter;
  fetchFn?: typeof fetch;
}

type LogsRootSource = 'cli' | 'workflow' | 'default';

function resolveRuntimeLogsRoot(params: {
  cliLogsRoot?: string;
  workflowLogsRoot: string;
  workflowLogsRootSource: 'workflow' | 'default';
  workflowDir: string;
}): { logsRoot: string; source: LogsRootSource } {
  if (params.cliLogsRoot && params.cliLogsRoot.trim().length > 0) {
    return {
      logsRoot: path.resolve(params.cliLogsRoot),
      source: 'cli'
    };
  }

  if (params.workflowLogsRootSource === 'workflow' && params.workflowLogsRoot.trim().length > 0) {
    const resolvedWorkflowLogsRoot = path.isAbsolute(params.workflowLogsRoot)
      ? params.workflowLogsRoot
      : path.resolve(params.workflowDir, params.workflowLogsRoot);
    return {
      logsRoot: resolvedWorkflowLogsRoot,
      source: 'workflow'
    };
  }

  return {
    logsRoot: path.join(params.workflowDir, '.symphony', 'log'),
    source: 'default'
  };
}

function ensureWritableDirectory(directoryPath: string): void {
  try {
    fs.mkdirSync(directoryPath, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown filesystem error';
    throw new WorkflowConfigError('invalid_logging_root', `logging.root is not writable at ${directoryPath}: ${message}`);
  }

  try {
    fs.accessSync(directoryPath, fs.constants.W_OK);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown filesystem error';
    throw new WorkflowConfigError('invalid_logging_root', `logging.root is not writable at ${directoryPath}: ${message}`);
  }
}

async function assertResolvableServerHost(host: string): Promise<void> {
  const trimmed = host.trim();
  if (!trimmed || trimmed === 'localhost' || net.isIP(trimmed) !== 0) {
    return;
  }

  try {
    await dns.lookup(trimmed);
  } catch {
    throw new WorkflowConfigError('invalid_server_host', `server.host '${host}' is not resolvable`);
  }
}

class StructuredLoggerObserverSink implements LogSink {
  name = 'observer';
  private readonly observer: StructuredLogger;

  constructor(observer: StructuredLogger) {
    this.observer = observer;
  }

  write(entry: LogEntry, _rendered: string): void {
    this.observer.log({
      level: entry.level,
      event: entry.event,
      message: entry.message,
      context: entry.context
    });
  }
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
  const workflowLoader = new WorkflowLoader();
  const resolvedWorkflowPath = workflowLoader.resolvePath({ explicitPath: options.workflowPath });
  const workflowDefinition = workflowLoader.load({ explicitPath: resolvedWorkflowPath });

  const configResolver = new ConfigResolver();
  let currentWorkflowPath = path.resolve(resolvedWorkflowPath);
  let currentWorkflowDefinition: WorkflowDefinition = workflowDefinition;
  let promptFallbackActive = workflowDefinition.prompt_template === DEFAULT_PROMPT_TEMPLATE;
  let effectiveConfig = configResolver.resolve(workflowDefinition, { workflowPath: currentWorkflowPath });
  let workflowDir = path.dirname(currentWorkflowPath);
  const loggingResolution = resolveRuntimeLogsRoot({
    cliLogsRoot: options.logsRoot,
    workflowLogsRoot: effectiveConfig.logging.root,
    workflowLogsRootSource: effectiveConfig.logging.root_source,
    workflowDir
  });

  ensureWritableDirectory(loggingResolution.logsRoot);

  const activeLogFile = path.join(loggingResolution.logsRoot, DEFAULT_LOG_FILE_NAME);
  const observer = options.logObserver;
  const activeSinks: LogSink[] = [
    new StderrSink(),
    new RotatingFileSink({
      root: loggingResolution.logsRoot,
      baseFileName: DEFAULT_LOG_FILE_NAME,
      maxBytes: effectiveConfig.logging.max_bytes,
      maxFiles: effectiveConfig.logging.max_files
    })
  ];
  if (observer) {
    activeSinks.push(new StructuredLoggerObserverSink(observer));
  }
  const activeSinkNames = activeSinks.map((sink) => sink.name);
  const logger = new MultiSinkLogger({ sinks: activeSinks });

  logger.log({
    level: 'info',
    event: CANONICAL_EVENT.runtime.loggingConfigured,
    message: 'configured runtime log sinks',
    context: {
      logs_root: loggingResolution.logsRoot,
      logs_root_source: loggingResolution.source,
      active_log_file: activeLogFile,
      rotation_max_bytes: effectiveConfig.logging.max_bytes,
      rotation_max_files: effectiveConfig.logging.max_files
    }
  });

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
      event: CANONICAL_EVENT.runtime.startupValidationBypassed,
      message: startupValidation.message
    });
  }

  let tracker =
    options.trackerAdapter ??
    createTrackerAdapter(
      {
        ...effectiveConfig.tracker,
        timeout_ms: 30_000,
        page_size: 50
      },
      options.fetchFn
    );
  const trackerProxy: TrackerAdapter = {
    fetch_candidate_issues: async () => tracker.fetch_candidate_issues(),
    fetch_issues_by_states: async (state_names) => tracker.fetch_issues_by_states(state_names),
    fetch_issue_states_by_ids: async (issue_ids) => tracker.fetch_issue_states_by_ids(issue_ids),
    create_comment: async (issue_id, body) => tracker.create_comment(issue_id, body),
    update_issue_state: async (issue_id, state_name) => tracker.update_issue_state(issue_id, state_name)
  };

  const workspaceProvisionState: {
    last_provision_result: 'provisioned' | 'reused' | 'skipped' | 'failed' | null;
    last_teardown_result: 'removed' | 'kept' | 'skipped' | 'failed' | null;
    last_error_code: string | null;
    last_verification_result: 'verified' | 'reprovisioned' | 'failed' | null;
    last_cleanup_on_failure_result: 'cleaned' | 'cleanup_failed' | 'not_attempted' | null;
    verification_mode: 'strict' | 'none';
  } = {
    last_provision_result: null,
    last_teardown_result: null,
    last_error_code: null,
    last_verification_result: null,
    last_cleanup_on_failure_result: null,
    verification_mode: effectiveConfig.workspace.provisioner.type === 'none' ? 'none' : 'strict'
  };

  const workspaceManager = new WorkspaceManager({
    root: effectiveConfig.workspace.root,
    hooks: effectiveConfig.hooks,
    provisioner: createWorkspaceProvisioner(effectiveConfig.workspace.provisioner),
    onProvisionerResult: (result) => {
      const baseContext = {
        issue_identifier: result.identifier,
        workspace_path: result.workspace_path,
        provisioner_type: result.provisioner_type,
        repo_root: effectiveConfig.workspace.provisioner.repo_root ?? null,
        base_ref: effectiveConfig.workspace.provisioner.base_ref,
        branch_name_template: effectiveConfig.workspace.provisioner.branch_template
      };

      if (result.phase === 'provision') {
        if (result.status === 'start') {
          logger.log({
            level: 'info',
            event: CANONICAL_EVENT.workspace.provisionStart,
            message: 'workspace provision started',
            context: baseContext
          });
          return;
        }
        if (result.status === 'failed') {
          workspaceProvisionState.last_provision_result = 'failed';
          workspaceProvisionState.last_error_code = result.error_code ?? 'workspace_provision_failed';
          workspaceProvisionState.last_verification_result = 'failed';
          logger.log({
            level: 'error',
            event: CANONICAL_EVENT.workspace.provisionFailed,
            message: result.error_message ?? 'workspace provisioning failed',
            context: {
              ...baseContext,
              error_code: workspaceProvisionState.last_error_code
            }
          });
          if (result.cleanup_attempted) {
            workspaceProvisionState.last_cleanup_on_failure_result = result.cleanup_succeeded ? 'cleaned' : 'cleanup_failed';
            logger.log({
              level: result.cleanup_succeeded ? 'info' : 'error',
              event: result.cleanup_succeeded
                ? CANONICAL_EVENT.workspace.provisionFailureCleanupSucceeded
                : CANONICAL_EVENT.workspace.provisionFailureCleanupFailed,
              message: result.cleanup_succeeded
                ? 'workspace provision failure cleanup succeeded'
                : 'workspace provision failure cleanup failed',
              context: {
                ...baseContext,
                cleanup_error: result.cleanup_error ?? null
              }
            });
          }
          if (!result.cleanup_attempted) {
            workspaceProvisionState.last_cleanup_on_failure_result = 'not_attempted';
          }
          return;
        }
        workspaceProvisionState.last_provision_result = result.status as 'provisioned' | 'reused' | 'skipped';
        workspaceProvisionState.last_error_code = null;
        workspaceProvisionState.last_verification_result = result.status === 'reused' ? 'verified' : 'reprovisioned';
        workspaceProvisionState.last_cleanup_on_failure_result = null;
        logger.log({
          level: 'info',
          event:
            result.status === 'reused'
              ? CANONICAL_EVENT.workspace.provisionReused
              : CANONICAL_EVENT.workspace.provisionSuccess,
          message: `workspace provision ${result.status}`,
          context: baseContext
        });
        return;
      }

      if (result.status === 'start') {
        logger.log({
          level: 'info',
          event: CANONICAL_EVENT.workspace.teardownStart,
          message: 'workspace teardown started',
          context: baseContext
        });
        return;
      }

      if (result.status === 'failed') {
        workspaceProvisionState.last_teardown_result = 'failed';
        workspaceProvisionState.last_error_code = result.error_code ?? 'workspace_provision_failed';
        logger.log({
          level: 'error',
          event: CANONICAL_EVENT.workspace.teardownFailed,
          message: result.error_message ?? 'workspace teardown failed',
          context: {
            ...baseContext,
            error_code: workspaceProvisionState.last_error_code
          }
        });
        return;
      }

      workspaceProvisionState.last_teardown_result = result.status as 'removed' | 'kept' | 'skipped';
      workspaceProvisionState.last_error_code = null;
      logger.log({
        level: 'info',
        event: CANONICAL_EVENT.workspace.teardownSuccess,
        message: `workspace teardown ${result.status}`,
        context: baseContext
      });
    }
  });

  let activeProfile = resolveSecurityProfile(effectiveConfig.codex);
  effectiveConfig.codex.security_profile = activeProfile.name;
  effectiveConfig.codex.approval_policy = activeProfile.approval_policy;
  effectiveConfig.codex.thread_sandbox = activeProfile.thread_sandbox;
  effectiveConfig.codex.turn_sandbox_policy = activeProfile.turn_sandbox_policy.type;
  effectiveConfig.codex.user_input_policy = activeProfile.user_input_policy;

  logger.log({
    level: 'info',
    event: CANONICAL_EVENT.runtime.securityProfileActive,
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
  let runtimeStarted = false;

  const bridge = new LocalRunnerBridge({
    workspaceManager,
    codexRunner,
    config: effectiveConfig,
    logger,
    promptTemplate: workflowDefinition.prompt_template,
    issueStateFetcher: async (issue_ids) => tracker.fetch_issue_states_by_ids(issue_ids),
    onWorkerExit: async ({ issue_id, reason, error }) => {
      await orchestrator.onWorkerExit(issue_id, reason, error);
    },
    onWorkerEvent: ({ issue_id, event }) => {
      orchestrator.onWorkerEvent(issue_id, toWorkerEvent(event, nowMs()));
    }
  });

  const retryTimers = new Map<string, RuntimeTimer>();
  let pollIntervalHandle: NodeJS.Timeout | null = null;

  const applyRuntimeConfig = (nextConfig: EffectiveConfig, nextWorkflowPath: string, nextDefinition: WorkflowDefinition): void => {
    let nextTracker = tracker;
    if (!options.trackerAdapter) {
      nextTracker = createTrackerAdapter(
        {
          ...nextConfig.tracker,
          timeout_ms: 30_000,
          page_size: 50
        },
        options.fetchFn
      );
    }

    const nextProfile = resolveSecurityProfile(nextConfig.codex);
    nextConfig.codex.security_profile = nextProfile.name;
    nextConfig.codex.approval_policy = nextProfile.approval_policy;
    nextConfig.codex.thread_sandbox = nextProfile.thread_sandbox;
    nextConfig.codex.turn_sandbox_policy = nextProfile.turn_sandbox_policy.type;
    nextConfig.codex.user_input_policy = nextProfile.user_input_policy;

    tracker = nextTracker;
    activeProfile = nextProfile;
    currentWorkflowPath = nextWorkflowPath;
    currentWorkflowDefinition = nextDefinition;
    promptFallbackActive = nextDefinition.prompt_template === DEFAULT_PROMPT_TEMPLATE;
    effectiveConfig = nextConfig;
    workflowDir = path.dirname(nextWorkflowPath);

    orchestrator.applyRuntimeConfig({
      poll_interval_ms: nextConfig.polling.interval_ms,
      max_concurrent_agents: nextConfig.agent.max_concurrent_agents,
      max_concurrent_agents_by_state: nextConfig.agent.max_concurrent_agents_by_state,
      max_retry_backoff_ms: nextConfig.agent.max_retry_backoff_ms,
      active_states: nextConfig.tracker.active_states,
      terminal_states: nextConfig.tracker.terminal_states,
      stall_timeout_ms: nextConfig.codex.stall_timeout_ms,
      worker_hosts: nextConfig.worker?.ssh_hosts ?? [],
      max_concurrent_agents_per_host: nextConfig.worker?.max_concurrent_agents_per_host ?? null
    });

    bridge.setRuntimeConfig(nextConfig, nextDefinition.prompt_template);
    if (runtimeStarted) {
      if (pollIntervalHandle) {
        clearInterval(pollIntervalHandle);
      }
      pollIntervalHandle = setInterval(() => {
        void orchestrator.tick('interval');
      }, Math.max(1000, nextConfig.polling.interval_ms));
    }
  };

  const reloadWorkflow = async (workflowPath: string): Promise<{ workflow_path: string; applied: boolean; error?: string }> => {
    try {
      const nextPath = path.resolve(workflowPath);
      const nextDefinition = workflowLoader.load({ explicitPath: nextPath });
      const nextConfig = configResolver.resolve(nextDefinition, { workflowPath: nextPath });
      const validation = validator.validate(nextConfig);
      if (!validation.ok) {
        throw new WorkflowConfigError(validation.error_code, validation.message);
      }

      applyRuntimeConfig(nextConfig, nextPath, nextDefinition);
      return {
        workflow_path: nextPath,
        applied: true
      };
    } catch (error) {
      return {
        workflow_path: currentWorkflowPath,
        applied: false,
        error: error instanceof Error ? error.message : 'workflow reload failed'
      };
    }
  };

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
      tracker: trackerProxy,
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
  const resolvedHost = options.host ?? effectiveConfig.server?.host ?? '127.0.0.1';
  apiServer =
    resolvedPort === undefined
      ? null
      : new LocalApiServer({
          host: resolvedHost,
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
            getLoggingHealth: () => ({
              root: loggingResolution.logsRoot,
              active_file: activeLogFile,
              rotation: {
                max_bytes: effectiveConfig.logging.max_bytes,
                max_files: effectiveConfig.logging.max_files
              },
              sinks: activeSinkNames
            }),
            getUiState: () => (persistenceStore ? persistenceStore.loadUiState() : null),
            setUiState: (state) => {
              persistenceStore?.saveUiState(state);
            },
            getPromptFallbackActive: () => promptFallbackActive,
            getRuntimeResolution: () => ({
              workflow_path: currentWorkflowPath,
              workflow_dir: workflowDir,
              workspace_root: effectiveConfig.workspace.root,
              workspace_root_source: effectiveConfig.workspace.root_source,
              server: {
                host: apiServer?.address().host ?? resolvedHost,
                port: apiServer?.address().port ?? (resolvedPort ?? null)
              },
              provisioner_type: effectiveConfig.workspace.provisioner.type,
              repo_root: effectiveConfig.workspace.provisioner.repo_root ?? null,
              base_ref: effectiveConfig.workspace.provisioner.base_ref ?? null,
              branch_name_template: effectiveConfig.workspace.provisioner.branch_template ?? null
            }),
            getWorkspaceProvisioner: () => ({
              provisioner_type: effectiveConfig.workspace.provisioner.type,
              repo_root: effectiveConfig.workspace.provisioner.repo_root ?? null,
              base_ref: effectiveConfig.workspace.provisioner.base_ref ?? null,
              branch_name_template: effectiveConfig.workspace.provisioner.branch_template ?? null,
              last_provision_result: workspaceProvisionState.last_provision_result,
              last_teardown_result: workspaceProvisionState.last_teardown_result,
              last_error_code: workspaceProvisionState.last_error_code,
              last_verification_result: workspaceProvisionState.last_verification_result,
              last_cleanup_on_failure_result: workspaceProvisionState.last_cleanup_on_failure_result,
              verification_mode: workspaceProvisionState.verification_mode
            })
          },
          workflowControlSource: {
            switchWorkflowPath: async (workflowPath) => {
              const result = await reloadWorkflow(workflowPath);
              if (!result.applied) {
                logger.log({
                  level: 'warn',
                  event: CANONICAL_EVENT.workflow.reloadFailed,
                  message: result.error ?? 'workflow path switch failed',
                  context: {
                    source: 'api_path_switch',
                    workflow_path: workflowPath
                  }
                });
                return result;
              }

              logger.log({
                level: 'info',
                event: CANONICAL_EVENT.workflow.pathSwitched,
                message: 'workflow path switched',
                context: {
                  workflow_path: result.workflow_path
                }
              });
              apiServer?.notifyStateChanged('workflow_path_switch');
              return result;
            },
            forceReload: async () => {
              const result = await reloadWorkflow(currentWorkflowPath);
              if (!result.applied) {
                logger.log({
                  level: 'warn',
                  event: CANONICAL_EVENT.workflow.reloadFailed,
                  message: result.error ?? 'workflow force reload failed',
                  context: {
                    source: 'api_force_reload',
                    workflow_path: currentWorkflowPath
                  }
                });
                return result;
              }

              logger.log({
                level: 'info',
                event: CANONICAL_EVENT.workflow.reloadForced,
                message: 'workflow force reload applied',
                context: {
                  workflow_path: result.workflow_path
                }
              });
              apiServer?.notifyStateChanged('workflow_force_reload');
              return result;
            }
          },
          issueControlSource: {
            resumeBlockedIssue: async (issueIdentifier) => orchestrator.resumeBlockedIssue(issueIdentifier)
          },
          dashboardConfig: {
            dashboard_enabled: effectiveConfig.observability?.dashboard_enabled ?? true,
            refresh_ms: effectiveConfig.observability?.refresh_ms ?? 4000,
            render_interval_ms: effectiveConfig.observability?.render_interval_ms ?? 1000
          },
          logger,
          nowMs
        });

  const start = async (): Promise<void> => {
    const startupSnapshot = orchestrator.getStateSnapshot();
    logger.log({
      level: 'info',
      event: CANONICAL_EVENT.runtime.startupStateInitialized,
      message: 'startup initialized orchestrator state from cold process memory',
      context: {
        state_source: 'cold_start',
        running_cleared: startupSnapshot.running.size,
        retry_cleared: startupSnapshot.retry_attempts.size
      }
    });

    if (apiServer) {
      await assertResolvableServerHost(resolvedHost);
      await apiServer.listen();
      const address = apiServer.address();
      logger.log({
        level: 'info',
        event: CANONICAL_EVENT.runtime.httpEnabled,
        message: 'local HTTP extension enabled',
        context: {
          host: address.host,
          port: address.port,
          configured_port: resolvedPort,
          configured_host: resolvedHost
        }
      });
    } else {
      logger.log({
        level: 'info',
        event: CANONICAL_EVENT.runtime.httpDisabled,
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
        event: CANONICAL_EVENT.persistence.pruned,
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
        event: CANONICAL_EVENT.runtime.startupCleanupCompleted,
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
        event: CANONICAL_EVENT.runtime.startupCleanupFailed,
        message: error instanceof Error ? error.message : 'terminal cleanup failed'
      });
    }

    await orchestrator.tick('startup');
    pollIntervalHandle = setInterval(() => {
      void orchestrator.tick('interval');
    }, Math.max(1000, effectiveConfig.polling.interval_ms));
    runtimeStarted = true;

    logger.log({
      level: 'info',
      event: CANONICAL_EVENT.runtime.started,
      message: 'runtime environment started',
      context: {
        poll_interval_ms: effectiveConfig.polling.interval_ms,
        http_server_enabled: apiServer !== null,
        workflow_path: currentWorkflowPath,
        workspace_root: effectiveConfig.workspace.root,
        workspace_root_source: effectiveConfig.workspace.root_source
      }
    });
  };

  const stop = async (): Promise<void> => {
    if (pollIntervalHandle) {
      clearInterval(pollIntervalHandle);
      pollIntervalHandle = null;
    }
    runtimeStarted = false;

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
      event: CANONICAL_EVENT.runtime.stopped,
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
