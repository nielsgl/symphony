import type { CodexRunner } from '../codex';
import type { Issue } from '../tracker';
import type { EffectiveConfig } from '../workflow';
import type { WorkspaceManager } from '../workspace';
import type { SpawnWorkerResult } from './types';
import { runLocalWorkerAttempt } from './local-worker-runner';

interface WorkerHandle {
  issue_id: string;
  promise: Promise<void>;
}

export interface LocalRunnerBridgeOptions {
  workspaceManager: WorkspaceManager;
  codexRunner: CodexRunner;
  config: EffectiveConfig;
  onWorkerExit?: (params: { issue_id: string; reason: 'normal' | 'abnormal'; error?: string }) => Promise<void> | void;
}

export class LocalRunnerBridge {
  private readonly workspaceManager: WorkspaceManager;
  private readonly codexRunner: CodexRunner;
  private readonly config: EffectiveConfig;
  private readonly onWorkerExit?: LocalRunnerBridgeOptions['onWorkerExit'];

  constructor(options: LocalRunnerBridgeOptions) {
    this.workspaceManager = options.workspaceManager;
    this.codexRunner = options.codexRunner;
    this.config = options.config;
    this.onWorkerExit = options.onWorkerExit;
  }

  async spawnWorker(params: { issue: Issue; attempt: number | null }): Promise<SpawnWorkerResult> {
    const workerPromise = this.startWorker(params.issue, params.attempt ?? 0);
    const worker_handle: WorkerHandle = {
      issue_id: params.issue.id,
      promise: workerPromise
    };

    return {
      ok: true,
      worker_handle,
      monitor_handle: worker_handle
    };
  }

  async terminateWorker(params: { issue_identifier: string; cleanup_workspace: boolean }): Promise<void> {
    if (!params.cleanup_workspace) {
      return;
    }

    await this.workspaceManager.cleanupWorkspace(params.issue_identifier);
  }

  private async startWorker(issue: Issue, attempt: number): Promise<void> {
    const result = await runLocalWorkerAttempt({
      issue,
      attempt,
      workspaceManager: this.workspaceManager,
      codexRunner: this.codexRunner,
      config: this.config
    });

    await this.onWorkerExit?.({
      issue_id: issue.id,
      reason: result.reason,
      error: result.error
    });
  }
}
