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
  workspace_provisioned?: boolean;
  workspace_is_git_worktree?: boolean;
  workspace_integrity_status?: 'ok' | 'reconciled' | 'failed';
  workspace_integrity_reason?: string | null;
  workspace_integrity_checked_at?: string | null;
  workspace_integrity_reconciled_at?: string | null;
  copy_ignored_applied?: boolean;
  copy_ignored_status?: 'skipped' | 'success' | 'failed';
  copy_ignored_summary?: {
    copied_files: number;
    skipped_existing: number;
    blocked_files: number;
    bytes_copied: number;
    duration_ms: number;
  };
}

export interface HookExecutionResult {
  hook: WorkspaceHookName;
  status: 'succeeded' | 'failed';
  duration_ms: number;
  timed_out: boolean;
  error?: string;
  hook_reason_code?: string;
  fallback_reason_code?: 'shell_unavailable' | 'tool_missing_git' | 'tool_missing_gh';
  fallback_mode?: 'mcp_github';
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
  copyIgnored?: WorkspaceCopyIgnoredConfig;
  onProvisionerResult?: (result: {
    phase: 'provision' | 'teardown';
    identifier: string;
    workspace_path: string;
    status: WorkspaceProvisionResult['status'] | WorkspaceTeardownResult['status'] | 'failed' | 'start';
    provisioner_type: string;
    error_code?: string;
    error_message?: string;
    cleanup_attempted?: boolean;
    cleanup_succeeded?: boolean;
    cleanup_error?: string;
    workspace_integrity_status?: 'ok' | 'reconciled' | 'failed';
    workspace_integrity_reason?: string | null;
    workspace_integrity_checked_at?: string | null;
    workspace_integrity_reconciled_at?: string | null;
  }) => void;
  onCopyIgnoredResult?: (result: {
    identifier: string;
    workspace_path: string;
    status: 'start' | 'success' | 'skipped' | 'failed';
    source_path?: string;
    include_file?: string;
    conflict_policy?: 'skip' | 'overwrite' | 'fail';
    copied_files?: number;
    skipped_existing?: number;
    blocked_files?: number;
    bytes_copied?: number;
    duration_ms?: number;
    error_code?: string;
    error_message?: string;
    warning?: string;
  }) => void;
  nowMs?: () => number;
  runShell?: (params: {
    cwd: string;
    script: string;
    timeoutMs: number;
  }) => Promise<{ timedOut: boolean; error?: string }>;
  probeTool?: (params: { command: string; args: string[]; cwd: string }) => Promise<boolean>;
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
  workspace_provisioned?: boolean;
  workspace_is_git_worktree?: boolean;
  workspace_integrity_status?: 'ok' | 'reconciled' | 'failed';
  workspace_integrity_reason?: string | null;
  workspace_integrity_checked_at?: string | null;
  workspace_integrity_reconciled_at?: string | null;
}

export interface WorkspaceTeardownContext {
  identifier: string;
  workspacePath: string;
}

export interface WorkspaceTeardownResult {
  status: 'removed' | 'kept' | 'skipped';
  provisioner_type: string;
  workspace_integrity_status?: 'ok' | 'reconciled' | 'failed';
  workspace_integrity_reason?: string | null;
  workspace_integrity_checked_at?: string | null;
  workspace_integrity_reconciled_at?: string | null;
}

export interface WorkspaceProvisioner {
  provision(params: WorkspaceProvisionContext): Promise<WorkspaceProvisionResult>;
  teardown(params: WorkspaceTeardownContext): Promise<WorkspaceTeardownResult>;
}

export interface WorkspaceCopyIgnoredConfig {
  enabled: boolean;
  include_file: string;
  from: 'primary_worktree' | 'repo_root' | string;
  conflict_policy: 'skip' | 'overwrite' | 'fail' | string;
  require_gitignored: boolean;
  max_files: number;
  max_total_bytes: number;
  allow_patterns: string[];
  deny_patterns: string[];
}
