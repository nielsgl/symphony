import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { WorkspaceError } from './errors';
import type {
  CleanupWorkspacesResult,
  HookExecutionResult,
  WorkspaceHookName,
  WorkspaceInfo,
  WorkspaceManagerOptions
} from './types';

const SANITIZE_PATTERN = /[^A-Za-z0-9._-]/g;
const TEMP_ARTIFACTS = ['tmp', '.elixir_ls'];

async function defaultRunShell(params: {
  cwd: string;
  script: string;
  timeoutMs: number;
}): Promise<{ timedOut: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', params.script], {
      cwd: params.cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let settled = false;
    let output = '';

    const finish = (result: { timedOut: boolean; error?: string }) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ timedOut: true, error: 'hook timeout' });
    }, params.timeoutMs);

    child.on('error', (error) => {
      finish({ timedOut: false, error: error.message });
    });

    child.on('close', (code) => {
      if (code === 0) {
        finish({ timedOut: false });
        return;
      }

      const message = output.trim().slice(0, 500) || `hook exited with code ${code ?? 'unknown'}`;
      finish({ timedOut: false, error: message });
    });
  });
}

export class WorkspaceManager {
  private readonly root: string;
  private readonly hooks: WorkspaceManagerOptions['hooks'];
  private readonly nowMs: () => number;
  private readonly runShell: NonNullable<WorkspaceManagerOptions['runShell']>;
  private readonly onHookResult?: WorkspaceManagerOptions['onHookResult'];

  constructor(options: WorkspaceManagerOptions) {
    this.root = path.resolve(options.root);
    this.hooks = options.hooks;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.runShell = options.runShell ?? defaultRunShell;
    this.onHookResult = options.onHookResult;
  }

  deriveWorkspaceKey(identifier: string): string {
    return identifier.replace(SANITIZE_PATTERN, '_');
  }

  async ensureWorkspace(identifier: string): Promise<WorkspaceInfo> {
    const workspace_key = this.deriveWorkspaceKey(identifier);
    const workspacePath = path.resolve(this.root, workspace_key);
    this.assertContained(workspacePath);

    let created_now = false;
    let stat = await this.statIfExists(workspacePath);

    if (stat && !stat.isDirectory()) {
      throw new WorkspaceError(
        'workspace_non_directory_collision',
        `Workspace path collides with non-directory entry: ${workspacePath}`
      );
    }

    if (!stat) {
      await fs.mkdir(workspacePath, { recursive: true });
      created_now = true;
      stat = await this.statIfExists(workspacePath);
      if (!stat || !stat.isDirectory()) {
        throw new WorkspaceError('workspace_non_directory_collision', `Failed to create workspace directory: ${workspacePath}`);
      }
    }

    if (created_now) {
      await this.runHookOrThrow('after_create', workspacePath);
    }

    return {
      path: workspacePath,
      workspace_key,
      created_now
    };
  }

  async prepareAttempt(workspacePath: string): Promise<void> {
    const resolved = path.resolve(workspacePath);
    this.assertLaunchSafety({ workspacePath: resolved, cwd: resolved });

    for (const artifact of TEMP_ARTIFACTS) {
      await fs.rm(path.join(resolved, artifact), { recursive: true, force: true });
    }

    await this.runHookOrThrow('before_run', resolved);
  }

  async finalizeAttempt(workspacePath: string): Promise<void> {
    const resolved = path.resolve(workspacePath);
    this.assertContained(resolved);
    await this.runHookBestEffort('after_run', resolved);
  }

  async cleanupWorkspace(identifier: string): Promise<boolean> {
    const workspacePath = path.resolve(this.root, this.deriveWorkspaceKey(identifier));
    this.assertContained(workspacePath);

    await this.runHookBestEffort('before_remove', workspacePath);

    try {
      await fs.rm(workspacePath, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  async cleanupWorkspaces(identifiers: string[]): Promise<CleanupWorkspacesResult[]> {
    const results: CleanupWorkspacesResult[] = [];
    for (const identifier of identifiers) {
      const cleaned = await this.cleanupWorkspace(identifier);
      results.push({ identifier, cleaned });
    }
    return results;
  }

  assertLaunchSafety(params: { workspacePath: string; cwd: string }): void {
    const workspacePath = path.resolve(params.workspacePath);
    const cwd = path.resolve(params.cwd);

    this.assertContained(workspacePath);

    if (cwd !== workspacePath) {
      throw new WorkspaceError('workspace_cwd_mismatch', `Launch cwd must equal workspace path. cwd=${cwd} workspace=${workspacePath}`);
    }
  }

  private async runHookOrThrow(hook: WorkspaceHookName, cwd: string): Promise<void> {
    const result = await this.runHook(hook, cwd);
    if (result.status === 'succeeded') {
      return;
    }

    if (result.timed_out) {
      throw new WorkspaceError('workspace_hook_timeout', `${hook} hook timed out`);
    }

    throw new WorkspaceError('workspace_hook_failed', `${hook} hook failed: ${result.error ?? 'unknown error'}`);
  }

  private async runHookBestEffort(hook: WorkspaceHookName, cwd: string): Promise<void> {
    await this.runHook(hook, cwd);
  }

  private async runHook(hook: WorkspaceHookName, cwd: string): Promise<HookExecutionResult> {
    const script = this.hooks[hook];
    if (!script) {
      return {
        hook,
        status: 'succeeded',
        duration_ms: 0,
        timed_out: false
      };
    }

    const started = this.nowMs();
    const shellResult = await this.runShell({
      cwd,
      script,
      timeoutMs: this.hooks.timeout_ms
    });
    const duration_ms = Math.max(0, this.nowMs() - started);

    const result: HookExecutionResult = shellResult.error
      ? {
          hook,
          status: 'failed',
          duration_ms,
          timed_out: shellResult.timedOut,
          error: shellResult.error
        }
      : {
          hook,
          status: 'succeeded',
          duration_ms,
          timed_out: false
        };

    this.onHookResult?.(result);
    return result;
  }

  private assertContained(workspacePath: string): void {
    const relative = path.relative(this.root, workspacePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new WorkspaceError(
        'workspace_not_contained',
        `Workspace path is outside configured root: path=${workspacePath} root=${this.root}`
      );
    }
  }

  private async statIfExists(targetPath: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
    try {
      return await fs.stat(targetPath);
    } catch {
      return null;
    }
  }
}
