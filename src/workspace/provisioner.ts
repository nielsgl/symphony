import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { WorkspaceError } from './errors';
import type {
  WorkspaceProvisionContext,
  WorkspaceProvisionResult,
  WorkspaceProvisioner,
  WorkspaceTeardownContext,
  WorkspaceTeardownResult
} from './types';

type RunGit = (params: { cwd: string; args: string[] }) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

async function defaultRunGit(params: { cwd: string; args: string[] }): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', params.args, {
      cwd: params.cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      resolve({ ok: false, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

function sanitizeBranchIdentifier(identifier: string): string {
  const normalized = identifier.trim().replace(/[^A-Za-z0-9._/-]/g, '-');
  return normalized.replace(/\/+/g, '/').replace(/^-+|-+$/g, '') || 'issue';
}

function renderBranchName(template: string, identifier: string): string {
  return template.replace(/\{\{\s*issue\.identifier\s*\}\}/g, sanitizeBranchIdentifier(identifier));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function assertGitRepoRoot(repoRoot: string): Promise<void> {
  const resolved = path.resolve(repoRoot);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new WorkspaceError('workspace_provision_failed', `repo_root does not exist or is not a directory: ${resolved}`);
  }

  const dotGitPath = path.join(resolved, '.git');
  const dotGitStat = await fs.stat(dotGitPath).catch(() => null);
  if (!dotGitStat) {
    throw new WorkspaceError('workspace_provision_failed', `repo_root is not a git repository: ${resolved}`);
  }
}

export class NoopProvisioner implements WorkspaceProvisioner {
  async provision(_params: WorkspaceProvisionContext): Promise<WorkspaceProvisionResult> {
    return {
      status: 'skipped',
      provisioner_type: 'none',
      workspace_exists: true,
      workspace_git_status: 'unknown'
    };
  }

  async teardown(_params: WorkspaceTeardownContext): Promise<WorkspaceTeardownResult> {
    return {
      status: 'skipped',
      provisioner_type: 'none'
    };
  }
}

interface WorktreeProvisionerOptions {
  repoRoot: string;
  baseRef: string;
  branchTemplate: string;
  teardownMode: 'remove_worktree' | 'keep';
  allowDirtyRepo: boolean;
  runGit?: RunGit;
  fsOps?: {
    stat: typeof fs.stat;
    rm: typeof fs.rm;
  };
}

export class WorktreeProvisioner implements WorkspaceProvisioner {
  private readonly repoRoot: string;
  private readonly baseRef: string;
  private readonly branchTemplate: string;
  private readonly teardownMode: 'remove_worktree' | 'keep';
  private readonly allowDirtyRepo: boolean;
  private readonly runGit: RunGit;
  private readonly statPath: typeof fs.stat;
  private readonly rmPath: typeof fs.rm;

  constructor(options: WorktreeProvisionerOptions) {
    this.repoRoot = path.resolve(options.repoRoot);
    this.baseRef = options.baseRef;
    this.branchTemplate = options.branchTemplate;
    this.teardownMode = options.teardownMode;
    this.allowDirtyRepo = options.allowDirtyRepo;
    this.runGit = options.runGit ?? defaultRunGit;
    this.statPath = options.fsOps?.stat ?? fs.stat;
    this.rmPath = options.fsOps?.rm ?? fs.rm;
  }

  async provision(params: WorkspaceProvisionContext): Promise<WorkspaceProvisionResult> {
    await assertGitRepoRoot(this.repoRoot);
    const branchName = renderBranchName(this.branchTemplate, params.identifier);

    if (!this.allowDirtyRepo) {
      const status = await this.runGit({ cwd: this.repoRoot, args: ['status', '--porcelain'] });
      if (!status.ok) {
        throw new WorkspaceError('workspace_provision_failed', `failed to inspect repo status: ${status.stderr.trim() || 'unknown'}`);
      }
      if (status.stdout.trim().length > 0) {
        throw new WorkspaceError('workspace_provision_failed', 'worktree_dirty_repo');
      }
    }

    const gitMarker = path.join(params.workspacePath, '.git');
    if (
      await pathExists(gitMarker)
    ) {
      const branch = await this.runGit({
        cwd: params.workspacePath,
        args: ['rev-parse', '--abbrev-ref', 'HEAD']
      });
      if (!branch.ok) {
        throw new WorkspaceError(
          'workspace_provision_failed',
          `workspace path exists but branch cannot be inspected: ${branch.stderr.trim() || 'unknown'}`
        );
      }
      const currentBranch = branch.stdout.trim();
      if (currentBranch !== branchName) {
        throw new WorkspaceError('workspace_provision_failed', 'worktree_branch_conflict');
      }
      return {
        status: 'reused',
        provisioner_type: 'worktree',
        branch_name: branchName,
        repo_root: this.repoRoot,
        workspace_exists: true,
        workspace_git_status: 'unknown'
      };
    }

    await this.rmPath(params.workspacePath, { recursive: true, force: true });
    const add = await this.runGit({
      cwd: this.repoRoot,
      args: ['worktree', 'add', '-b', branchName, params.workspacePath, this.baseRef]
    });
    if (!add.ok) {
      throw new WorkspaceError('workspace_provision_failed', add.stderr.trim() || 'worktree_add_failed');
    }

    return {
      status: 'provisioned',
      provisioner_type: 'worktree',
      branch_name: branchName,
      repo_root: this.repoRoot,
      workspace_exists: true,
      workspace_git_status: this.allowDirtyRepo ? 'unknown' : 'clean'
    };
  }

  async teardown(params: WorkspaceTeardownContext): Promise<WorkspaceTeardownResult> {
    if (this.teardownMode === 'keep') {
      return {
        status: 'kept',
        provisioner_type: 'worktree'
      };
    }

    const remove = await this.runGit({
      cwd: this.repoRoot,
      args: ['worktree', 'remove', '--force', params.workspacePath]
    });
    if (!remove.ok) {
      throw new WorkspaceError('workspace_provision_failed', remove.stderr.trim() || 'worktree_remove_failed');
    }

    return {
      status: 'removed',
      provisioner_type: 'worktree'
    };
  }
}

interface CloneProvisionerOptions {
  repoRoot: string;
  baseRef: string;
  teardownMode: 'remove_worktree' | 'keep';
  runGit?: RunGit;
  fsOps?: {
    rm: typeof fs.rm;
  };
}

export class CloneProvisioner implements WorkspaceProvisioner {
  private readonly repoRoot: string;
  private readonly baseRef: string;
  private readonly teardownMode: 'remove_worktree' | 'keep';
  private readonly runGit: RunGit;
  private readonly rmPath: typeof fs.rm;

  constructor(options: CloneProvisionerOptions) {
    this.repoRoot = options.repoRoot;
    this.baseRef = options.baseRef;
    this.teardownMode = options.teardownMode;
    this.runGit = options.runGit ?? defaultRunGit;
    this.rmPath = options.fsOps?.rm ?? fs.rm;
  }

  async provision(params: WorkspaceProvisionContext): Promise<WorkspaceProvisionResult> {
    await this.rmPath(params.workspacePath, { recursive: true, force: true });
    const clone = await this.runGit({
      cwd: process.cwd(),
      args: ['clone', '--branch', this.baseRef, '--single-branch', this.repoRoot, params.workspacePath]
    });
    if (!clone.ok) {
      throw new WorkspaceError('workspace_provision_failed', clone.stderr.trim() || 'clone_failed');
    }

    return {
      status: 'provisioned',
      provisioner_type: 'clone',
      repo_root: this.repoRoot,
      workspace_exists: true,
      workspace_git_status: 'unknown'
    };
  }

  async teardown(params: WorkspaceTeardownContext): Promise<WorkspaceTeardownResult> {
    if (this.teardownMode === 'keep') {
      return {
        status: 'kept',
        provisioner_type: 'clone'
      };
    }

    await this.rmPath(params.workspacePath, { recursive: true, force: true });
    return {
      status: 'removed',
      provisioner_type: 'clone'
    };
  }
}

export function createWorkspaceProvisioner(config: {
  type: string;
  repo_root?: string;
  base_ref: string;
  branch_template: string;
  teardown_mode: string;
  allow_dirty_repo: boolean;
}): WorkspaceProvisioner {
  if (config.type === 'worktree') {
    return new WorktreeProvisioner({
      repoRoot: config.repo_root ?? '',
      baseRef: config.base_ref,
      branchTemplate: config.branch_template,
      teardownMode: config.teardown_mode === 'keep' ? 'keep' : 'remove_worktree',
      allowDirtyRepo: config.allow_dirty_repo
    });
  }

  if (config.type === 'clone') {
    return new CloneProvisioner({
      repoRoot: config.repo_root ?? '',
      baseRef: config.base_ref,
      teardownMode: config.teardown_mode === 'keep' ? 'keep' : 'remove_worktree'
    });
  }

  return new NoopProvisioner();
}
