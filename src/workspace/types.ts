export type WorkspaceHookName = 'after_create' | 'before_run' | 'after_run' | 'before_remove';

export interface WorkspaceInfo {
  path: string;
  workspace_key: string;
  created_now: boolean;
}

export interface HookExecutionResult {
  hook: WorkspaceHookName;
  status: 'succeeded' | 'failed';
  duration_ms: number;
  timed_out: boolean;
  error?: string;
}

export interface WorkspaceHooksConfig {
  after_create?: string;
  before_run?: string;
  after_run?: string;
  before_remove?: string;
  timeout_ms: number;
}

export interface WorkspaceManagerOptions {
  root: string;
  hooks: WorkspaceHooksConfig;
  nowMs?: () => number;
  runShell?: (params: {
    cwd: string;
    script: string;
    timeoutMs: number;
  }) => Promise<{ timedOut: boolean; error?: string }>;
  onHookResult?: (result: HookExecutionResult) => void;
}

export interface CleanupWorkspacesResult {
  identifier: string;
  cleaned: boolean;
}
