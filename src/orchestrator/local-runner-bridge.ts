import type { CodexRunner } from '../codex';
import type { CodexRunnerEvent } from '../codex';
import type { StructuredLogger } from '../observability';
import { CANONICAL_EVENT } from '../observability/events';
import type { Issue } from '../tracker';
import { TemplateEngine, type Template } from '../workflow';
import type { EffectiveConfig } from '../workflow';
import type { WorkspaceManager } from '../workspace';
import type { SpawnWorkerResult } from './types';
import { runLocalWorkerAttempt } from './local-worker-runner';

interface WorkerHandle {
  issue_id: string;
  issue_identifier: string;
  worker_host: string | null;
  promise: Promise<void>;
}

export interface LocalRunnerBridgeOptions {
  workspaceManager: WorkspaceManager;
  codexRunner: CodexRunner;
  config: EffectiveConfig;
  promptTemplate: string;
  renderPrompt?: (params: { issue: Issue; attempt: number | null }) => Promise<string>;
  issueStateFetcher?: (issue_ids: string[]) => Promise<Issue[]>;
  logger?: StructuredLogger;
  onWorkerExit?: (params: { issue_id: string; reason: 'normal' | 'abnormal'; error?: string }) => Promise<void> | void;
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

  async spawnWorker(params: { issue: Issue; attempt: number | null; worker_host?: string | null }): Promise<SpawnWorkerResult> {
    const workerHost = params.worker_host ?? null;
    const workerPromise = this.startWorker(params.issue, params.attempt, workerHost);
    const worker_handle: WorkerHandle = {
      issue_id: params.issue.id,
      issue_identifier: params.issue.identifier,
      promise: workerPromise,
      worker_host: workerHost
    };

    return {
      ok: true,
      worker_handle,
      monitor_handle: worker_handle,
      worker_host: workerHost
    };
  }

  async terminateWorker(params: { issue_id: string; worker_handle: unknown; cleanup_workspace: boolean }): Promise<void> {
    if (!params.cleanup_workspace) {
      return;
    }

    const workerHandle = params.worker_handle as WorkerHandle | null;
    if (!workerHandle?.issue_identifier) {
      return;
    }

    await this.workspaceManager.cleanupWorkspace(workerHandle.issue_identifier);
  }

  private async startWorker(issue: Issue, attempt: number | null, worker_host: string | null): Promise<void> {
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
      issueStateFetcher: this.issueStateFetcher,
      onCodexEvent: (event) => {
        this.onWorkerEvent?.({ issue_id: issue.id, event });
      }
    });
    if (result.reason === 'normal') {
      this.logger?.log({
        level: 'info',
        event: CANONICAL_EVENT.agentRunner.attemptCompleted,
        message: 'agent runner attempt completed',
        context: {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          session_id: result.session_id
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
      error: result.error
    });
  }
}
