import type { Issue } from '../tracker';
import type { WorkspaceManager } from '../workspace';
import type { CodexRunner } from '../codex';
import type { CodexRunnerEvent } from '../codex';
import type { EffectiveConfig } from '../workflow';
import path from 'node:path';

const DEFAULT_CONTINUATION_PROMPT =
  'Continue on the same thread for this issue. Focus on incremental progress and report outcomes clearly.';

export interface LocalWorkerRunInput {
  issue: Issue;
  attempt: number | null;
  worker_host?: string;
  workspaceManager: WorkspaceManager;
  codexRunner: CodexRunner;
  config: EffectiveConfig;
  renderPrompt: (params: { issue: Issue; attempt: number | null }) => Promise<string>;
  onCodexEvent?: (event: CodexRunnerEvent) => void;
}

export interface LocalWorkerRunResult {
  reason: 'normal' | 'abnormal';
  session_id: string | null;
  error?: string;
}

export async function runLocalWorkerAttempt(input: LocalWorkerRunInput): Promise<LocalWorkerRunResult> {
  let workspacePath: string | null = null;

  try {
    const workspace = await input.workspaceManager.ensureWorkspace(input.issue.identifier);
    workspacePath = workspace.path;
    const normalizedWorkspace = path.resolve(workspace.path);
    const normalizedRoot = path.resolve(input.config.workspace.root);
    if (normalizedWorkspace === normalizedRoot) {
      input.onCodexEvent?.({
        event: 'startup_failed',
        timestamp: new Date().toISOString(),
        codex_app_server_pid: null,
        detail: 'unsafe_workspace_root'
      });
      return {
        reason: 'abnormal',
        session_id: null,
        error: 'unsafe_workspace_root'
      };
    }
    await input.workspaceManager.prepareAttempt(workspace.path);
    const prompt = await input.renderPrompt({
      issue: input.issue,
      attempt: input.attempt
    });

    const turnResult = await input.codexRunner.startSessionAndRunTurn({
      command: input.config.codex.command,
      workspaceCwd: workspace.path,
      workerHost: input.worker_host,
      prompt,
      continuationPrompt: DEFAULT_CONTINUATION_PROMPT,
      title: `${input.issue.identifier}: ${input.issue.title}`,
      maxTurns: input.config.agent.max_turns,
      approvalPolicy: input.config.codex.approval_policy,
      threadSandbox: input.config.codex.thread_sandbox,
      turnSandboxPolicy: input.config.codex.turn_sandbox_policy
        ? { type: input.config.codex.turn_sandbox_policy }
        : undefined,
      onEvent: input.onCodexEvent,
      readTimeoutMs: input.config.codex.read_timeout_ms,
      turnTimeoutMs: input.config.codex.turn_timeout_ms
    });

    if (turnResult.status === 'completed') {
      return {
        reason: 'normal',
        session_id: turnResult.session_id
      };
    }

    return {
      reason: 'abnormal',
      session_id: turnResult.session_id,
      error: turnResult.error_code ?? turnResult.last_event
    };
  } catch (error) {
    return {
      reason: 'abnormal',
      session_id: null,
      error: error instanceof Error ? error.message : 'unknown worker error'
    };
  } finally {
    if (workspacePath) {
      await input.workspaceManager.finalizeAttempt(workspacePath);
    }
  }
}
