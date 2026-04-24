export type WorkspaceHookName = 'after_create' | 'before_run' | 'after_run' | 'before_remove';

export interface WorkspaceInfo {
  path: string;
  workspace_key: string;
  created_now: boolean;
  provisioner_type?: string;
  branch_name?: string | null;
  repo_root?: string | null;
  workspace_exists?: boolean;
  workspace_git_status?: 'clean' | 'dirty' | 'unknown';
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
  provisioner?: WorkspaceProvisioner;
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

export interface WorkspaceProvisionContext {
  identifier: string;
  workspacePath: string;
}

export interface WorkspaceProvisionResult {
  status: 'provisioned' | 'reused' | 'skipped';
  provisioner_type: string;
  branch_name?: string | null;
  repo_root?: string | null;
  workspace_exists?: boolean;
  workspace_git_status?: 'clean' | 'dirty' | 'unknown';
}

export interface WorkspaceTeardownContext {
  identifier: string;
  workspacePath: string;
}

export interface WorkspaceTeardownResult {
  status: 'removed' | 'kept' | 'skipped';
  provisioner_type: string;
}

export interface WorkspaceProvisioner {
  provision(params: WorkspaceProvisionContext): Promise<WorkspaceProvisionResult>;
  teardown(params: WorkspaceTeardownContext): Promise<WorkspaceTeardownResult>;
}
