import type { Issue } from '../tracker';
import type { WorkspaceManager } from '../workspace';
import type { CodexRunner } from '../codex';
import type { CodexRunnerEvent } from '../codex';
import type { EffectiveConfig } from '../workflow';
import { CANONICAL_EVENT } from '../observability/events';
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
  issueStateFetcher: (issue_ids: string[]) => Promise<Issue[]>;
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
        event: CANONICAL_EVENT.codex.startupFailed,
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
    let currentIssue = input.issue;
    let lastSessionId: string | null = null;
    const maxTurns = Math.max(1, input.config.agent.max_turns);

    for (let turnNumber = 1; turnNumber <= maxTurns; turnNumber += 1) {
      const prompt =
        turnNumber === 1
          ? await input.renderPrompt({
              issue: currentIssue,
              attempt: input.attempt
            })
          : DEFAULT_CONTINUATION_PROMPT;

      const turnResult = await input.codexRunner.startSessionAndRunTurn({
        command: input.config.codex.command,
        workspaceCwd: workspace.path,
        workerHost: input.worker_host,
        prompt,
        continuationPrompt: DEFAULT_CONTINUATION_PROMPT,
        title: `${currentIssue.identifier}: ${currentIssue.title}`,
        maxTurns: 1,
        approvalPolicy: input.config.codex.approval_policy,
        threadSandbox: input.config.codex.thread_sandbox,
        turnSandboxPolicy: input.config.codex.turn_sandbox_policy
          ? { type: input.config.codex.turn_sandbox_policy }
          : undefined,
        onEvent: input.onCodexEvent,
        readTimeoutMs: input.config.codex.read_timeout_ms,
        turnTimeoutMs: input.config.codex.turn_timeout_ms
      });

      if (turnResult.status !== 'completed') {
        return {
          reason: 'abnormal',
          session_id: turnResult.session_id,
          error: turnResult.error_code ?? turnResult.last_event
        };
      }
      lastSessionId = turnResult.session_id;

      if (turnNumber >= maxTurns) {
        return {
          reason: 'normal',
          session_id: lastSessionId
        };
      }

      let refreshedIssues: Issue[];
      try {
        refreshedIssues = await input.issueStateFetcher([currentIssue.id]);
      } catch (error) {
        return {
          reason: 'abnormal',
          session_id: lastSessionId,
          error: `issue_state_refresh_failed: ${error instanceof Error ? error.message : 'unknown'}`
        };
      }

      if (refreshedIssues.length === 0) {
        return {
          reason: 'normal',
          session_id: lastSessionId
        };
      }

      const refreshedIssue = refreshedIssues.find((issue) => issue.id === currentIssue.id) ?? refreshedIssues[0];
      if (!refreshedIssue || !isActiveState(refreshedIssue.state, input.config.tracker.active_states)) {
        return {
          reason: 'normal',
          session_id: lastSessionId
        };
      }

      currentIssue = refreshedIssue;
    }

    return {
      reason: 'normal',
      session_id: lastSessionId
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

function isActiveState(state: string | null | undefined, activeStates: string[]): boolean {
  if (!state) {
    return false;
  }
  const normalized = state.trim().toLowerCase();
  return activeStates.some((activeState) => activeState.trim().toLowerCase() === normalized);
}
