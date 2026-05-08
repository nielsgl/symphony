import type { CodexRunner } from '../codex';
import type { CodexRunnerEvent } from '../codex';
import type { StructuredLogger } from '../observability';
import { CANONICAL_EVENT } from '../observability/events';
import { REASON_CODES } from '../observability/reason-codes';
import type { Issue } from '../tracker';
import { TemplateEngine, type Template } from '../workflow';
import type { EffectiveConfig } from '../workflow';
import type { WorkspaceManager } from '../workspace';
import type { SpawnWorkerResult, WorkerExitDetails } from './types';
import { runLocalWorkerAttempt, runLocalWorkerRecoveryAttempt } from './local-worker-runner';

interface WorkerHandle {
  issue_id: string;
  issue_identifier: string;
  worker_instance_id: string;
  worker_host: string | null;
  promise: Promise<void>;
  cancel: (reason: string) => Promise<void>;
  cleanup_workspace_promise?: Promise<boolean>;
}

export interface LocalRunnerBridgeOptions {
  workspaceManager: WorkspaceManager;
  codexRunner: CodexRunner;
  config: EffectiveConfig;
  promptTemplate: string;
  renderPrompt?: (params: { issue: Issue; attempt: number | null }) => Promise<string>;
  issueStateFetcher?: (issue_ids: string[]) => Promise<Issue[]>;
  logger?: StructuredLogger;
  onWorkerExit?: (
    params: { issue_id: string; reason: 'normal' | 'abnormal'; error?: string; worker_handle?: unknown } & WorkerExitDetails
  ) => Promise<void> | void;
  onWorkerEvent?: (params: { issue_id: string; event: CodexRunnerEvent }) => void;
}

export class LocalRunnerBridge {
  private readonly workspaceManager: WorkspaceManager;
  private readonly codexRunner: CodexRunner;
  private config: EffectiveConfig;
  private renderPrompt: (params: { issue: Issue; attempt: number | null }) => Promise<string>;
  private readonly logger?: StructuredLogger;
  private readonly issueStateFetcher: (issue_ids: string[]) => Promise<Issue[]>;
  private readonly onWorkerExit?: LocalRunnerBridgeOptions['onWorkerExit'];
  private readonly onWorkerEvent?: LocalRunnerBridgeOptions['onWorkerEvent'];
  private nextWorkerSequence = 0;

  constructor(options: LocalRunnerBridgeOptions) {
    this.workspaceManager = options.workspaceManager;
    this.codexRunner = options.codexRunner;
    this.config = options.config;
    if (options.renderPrompt) {
      this.renderPrompt = options.renderPrompt;
    } else {
      const compiledTemplate: Template = new TemplateEngine().compile(options.promptTemplate);
      this.renderPrompt = async ({ issue, attempt }) => {
        return compiledTemplate.render({ issue: issue as unknown as Record<string, unknown>, attempt });
      };
    }
    this.logger = options.logger;
    this.issueStateFetcher = options.issueStateFetcher ?? (async () => []);
    this.onWorkerExit = options.onWorkerExit;
    this.onWorkerEvent = options.onWorkerEvent;
  }

  setRuntimeConfig(config: EffectiveConfig, promptTemplate: string): void {
    this.config = config;
    const compiledTemplate: Template = new TemplateEngine().compile(promptTemplate);
    this.renderPrompt = async ({ issue, attempt }) => {
      return compiledTemplate.render({ issue: issue as unknown as Record<string, unknown>, attempt });
    };
  }

  async spawnWorker(params: {
    issue: Issue;
    attempt: number | null;
    worker_host?: string | null;
    resume_context?: string | null;
  }): Promise<SpawnWorkerResult> {
    const workerHost = params.worker_host ?? null;
    let workspace;
    try {
      workspace = await this.workspaceManager.ensureWorkspace(params.issue.identifier);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'workspace provisioning failed'
      };
    }
    const cancellationController = new AbortController();
    const workerInstanceId = this.createWorkerInstanceId(params.issue.id);
    let runnerSettled = false;
    const workerPromise = this.startWorker(
      params.issue,
      params.attempt,
      workerHost,
      params.resume_context ?? null,
      workerInstanceId,
      cancellationController.signal,
      () => {
        runnerSettled = true;
      }
    );
    const worker_handle: WorkerHandle = {
      issue_id: params.issue.id,
      issue_identifier: params.issue.identifier,
      worker_instance_id: workerInstanceId,
      promise: workerPromise,
      worker_host: workerHost,
      cancel: createWorkerCancel({
        issue_id: params.issue.id,
        issue_identifier: params.issue.identifier,
        worker_host: workerHost,
        controller: cancellationController,
        workerPromise,
        isRunnerSettled: () => runnerSettled
      })
    };

    return {
      ok: true,
      worker_handle,
      worker_instance_id: workerInstanceId,
      monitor_handle: worker_handle,
      worker_host: workerHost,
      workspace_path: workspace.path,
      provisioner_type: workspace.provisioner_type ?? null,
      branch_name: workspace.branch_name ?? null,
      repo_root: workspace.repo_root ?? null,
      workspace_exists: workspace.workspace_exists ?? true,
      workspace_git_status: workspace.workspace_git_status ?? 'unknown',
      workspace_provisioned: workspace.workspace_provisioned ?? false,
      workspace_is_git_worktree: workspace.workspace_is_git_worktree ?? false,
      copy_ignored_applied: workspace.copy_ignored_applied ?? false,
      copy_ignored_status: workspace.copy_ignored_status ?? null,
      copy_ignored_summary: workspace.copy_ignored_summary ?? null
    };
  }

  async recoverMissingToolOutput(params: {
    issue: Issue;
    attempt: number | null;
    worker_host?: string | null;
    previous_thread_id: string;
    previous_turn_id: string;
    previous_session_id: string | null;
    recovery_prompt: string;
  }): Promise<SpawnWorkerResult> {
    const workerHost = params.worker_host ?? null;
    let workspace;
    try {
      workspace = await this.workspaceManager.ensureWorkspace(params.issue.identifier);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'workspace provisioning failed'
      };
    }
    const cancellationController = new AbortController();
    const workerInstanceId = this.createWorkerInstanceId(params.issue.id);
    let runnerSettled = false;
    const workerPromise = this.startRecoveryWorker(params, workerHost, workerInstanceId, cancellationController.signal, () => {
      runnerSettled = true;
    });
    const worker_handle: WorkerHandle = {
      issue_id: params.issue.id,
      issue_identifier: params.issue.identifier,
      worker_instance_id: workerInstanceId,
      promise: workerPromise,
      worker_host: workerHost,
      cancel: createWorkerCancel({
        issue_id: params.issue.id,
        issue_identifier: params.issue.identifier,
        worker_host: workerHost,
        controller: cancellationController,
        workerPromise,
        isRunnerSettled: () => runnerSettled
      })
    };

    return {
      ok: true,
      worker_handle,
      worker_instance_id: workerInstanceId,
      monitor_handle: worker_handle,
      worker_host: workerHost,
      workspace_path: workspace.path,
      provisioner_type: workspace.provisioner_type ?? null,
      branch_name: workspace.branch_name ?? null,
      repo_root: workspace.repo_root ?? null,
      workspace_exists: workspace.workspace_exists ?? true,
      workspace_git_status: workspace.workspace_git_status ?? 'unknown',
      workspace_provisioned: workspace.workspace_provisioned ?? false,
      workspace_is_git_worktree: workspace.workspace_is_git_worktree ?? false,
      copy_ignored_applied: workspace.copy_ignored_applied ?? false,
      copy_ignored_status: workspace.copy_ignored_status ?? null,
      copy_ignored_summary: workspace.copy_ignored_summary ?? null
    };
  }

  async terminateWorker(params: {
    issue_id: string;
    worker_handle: unknown;
    cleanup_workspace: boolean;
    reason?: string;
  }): Promise<void> {
    const workerHandle = params.worker_handle as WorkerHandle | null;
    if (!workerHandle?.issue_identifier) {
      return;
    }

    if (typeof workerHandle.cancel === 'function') {
      await workerHandle.cancel(params.reason ?? 'worker_terminated');
      this.logger?.log({
        level: 'info',
        event: CANONICAL_EVENT.orchestration.workerTerminated,
        message: 'worker process cancellation requested',
        context: {
          issue_id: params.issue_id,
          issue_identifier: workerHandle.issue_identifier,
          worker_instance_id: workerHandle.worker_instance_id,
          cleanup_workspace: params.cleanup_workspace,
          reason: params.reason ?? 'worker_terminated',
          worker_host: workerHandle.worker_host,
          cancellation_contract: 'supported',
          cancel_requested: true,
          graceful_exit_observed: true
        }
      });
    } else {
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.orchestration.workerTerminated,
        message: 'worker process cancellation unsupported',
        context: {
          issue_id: params.issue_id,
          issue_identifier: workerHandle.issue_identifier,
          worker_instance_id: workerHandle.worker_instance_id,
          cleanup_workspace: params.cleanup_workspace,
          reason: params.reason ?? 'worker_terminated',
          worker_host: workerHandle.worker_host,
          cancellation_contract: 'unsupported'
        }
      });
    }

    if (params.cleanup_workspace) {
      this.logger?.log({
        level: 'info',
        event: CANONICAL_EVENT.workspace.teardownStart,
        message: 'worker workspace cleanup attempted',
        context: {
          issue_id: params.issue_id,
          issue_identifier: workerHandle.issue_identifier,
          worker_instance_id: workerHandle.worker_instance_id,
          reason: params.reason ?? 'worker_terminated'
        }
      });
      workerHandle.cleanup_workspace_promise ??= this.workspaceManager.cleanupWorkspace(workerHandle.issue_identifier);
      const cleanupSucceeded = await workerHandle.cleanup_workspace_promise;
      this.logger?.log({
        level: cleanupSucceeded ? 'info' : 'warn',
        event: cleanupSucceeded ? CANONICAL_EVENT.workspace.teardownSuccess : CANONICAL_EVENT.workspace.teardownFailed,
        message: cleanupSucceeded ? 'worker workspace cleanup succeeded' : 'worker workspace cleanup failed',
        context: {
          issue_id: params.issue_id,
          issue_identifier: workerHandle.issue_identifier,
          worker_instance_id: workerHandle.worker_instance_id,
          reason: params.reason ?? 'worker_terminated',
          cleanup_succeeded: cleanupSucceeded
        }
      });
    }
  }

  private async startWorker(
    issue: Issue,
    attempt: number | null,
    worker_host: string | null,
    resume_context: string | null,
    workerInstanceId: string,
    cancellationSignal: AbortSignal,
    onRunnerSettled: () => void
  ): Promise<void> {
    this.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.agentRunner.attemptStarted,
      message: 'agent runner attempt started',
      context: {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        worker_host,
        attempt: attempt ?? 0
      }
    });
    const result = await runLocalWorkerAttempt({
      issue,
      attempt,
      worker_host: worker_host ?? undefined,
      workspaceManager: this.workspaceManager,
      codexRunner: this.codexRunner,
      config: this.config,
      renderPrompt: this.renderPrompt,
      resumeContext: resume_context,
      issueStateFetcher: this.issueStateFetcher,
      cancellationSignal,
      onCodexEvent: (event) => {
        this.onWorkerEvent?.({ issue_id: issue.id, event: { ...event, worker_instance_id: workerInstanceId } });
      }
    });
    onRunnerSettled();
    if (result.reason === 'normal') {
      this.logger?.log({
        level: 'info',
        event: CANONICAL_EVENT.agentRunner.attemptCompleted,
        message: 'agent runner attempt completed',
        context: {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          session_id: result.session_id,
          completion_reason: result.completion_reason ?? REASON_CODES.normalCompletion,
          refreshed_state: result.refreshed_state ?? null
        }
      });
    } else {
      this.logger?.log({
        level: 'warn',
        event: CANONICAL_EVENT.agentRunner.attemptFailed,
        message: 'agent runner attempt failed',
        context: {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          session_id: result.session_id,
          error: result.error ?? 'unknown'
        }
      });
    }

    await this.onWorkerExit?.({
      issue_id: issue.id,
      reason: result.reason,
      error: result.error,
      worker_instance_id: workerInstanceId,
      completion_reason: result.completion_reason,
      refreshed_state: result.refreshed_state,
      session_id: result.session_id
    });
  }

  private async startRecoveryWorker(
    params: {
      issue: Issue;
      attempt: number | null;
      previous_thread_id: string;
      previous_turn_id: string;
      previous_session_id: string | null;
      recovery_prompt: string;
    },
    worker_host: string | null,
    workerInstanceId: string,
    cancellationSignal: AbortSignal,
    onRunnerSettled: () => void
  ): Promise<void> {
    this.logger?.log({
      level: 'info',
      event: CANONICAL_EVENT.agentRunner.attemptStarted,
      message: 'agent runner guarded recovery attempt started',
      context: {
        issue_id: params.issue.id,
        issue_identifier: params.issue.identifier,
        worker_host,
        attempt: params.attempt ?? 0,
        previous_thread_id: params.previous_thread_id,
        previous_turn_id: params.previous_turn_id
      }
    });
    const result = await runLocalWorkerRecoveryAttempt({
      issue: params.issue,
      attempt: params.attempt,
      worker_host: worker_host ?? undefined,
      workspaceManager: this.workspaceManager,
      codexRunner: this.codexRunner,
      config: this.config,
      renderPrompt: this.renderPrompt,
      resumeContext: null,
      issueStateFetcher: this.issueStateFetcher,
      previousThreadId: params.previous_thread_id,
      previousTurnId: params.previous_turn_id,
      previousSessionId: params.previous_session_id,
      recoveryPrompt: params.recovery_prompt,
      cancellationSignal,
      onCodexEvent: (event) => {
        this.onWorkerEvent?.({ issue_id: params.issue.id, event: { ...event, worker_instance_id: workerInstanceId } });
      }
    });
    onRunnerSettled();
    await this.onWorkerExit?.({
      issue_id: params.issue.id,
      reason: result.reason,
      error: result.error,
      worker_instance_id: workerInstanceId,
      completion_reason: result.completion_reason,
      refreshed_state: result.refreshed_state,
      session_id: result.session_id
    });
  }

  private createWorkerInstanceId(issueId: string): string {
    this.nextWorkerSequence += 1;
    return `${issueId}:${Date.now().toString(36)}:${this.nextWorkerSequence}`;
  }
}

function createWorkerCancel(params: {
  issue_id: string;
  issue_identifier: string;
  worker_host: string | null;
  controller: AbortController;
  workerPromise: Promise<void>;
  isRunnerSettled: () => boolean;
}): (reason: string) => Promise<void> {
  let cancellationPromise: Promise<void> | null = null;
  return async (reason: string): Promise<void> => {
    if (!params.controller.signal.aborted) {
      params.controller.abort(reason);
    }

    cancellationPromise ??= params.workerPromise.catch(() => undefined);
    if (!params.isRunnerSettled()) {
      await cancellationPromise;
    }
  };
}
