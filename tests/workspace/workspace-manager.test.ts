import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceError, WorkspaceManager } from '../../src/workspace';

async function makeTempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'symphony-workspace-test-'));
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

describe('WorkspaceManager', () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupPaths.splice(0).map(async (targetPath) => {
        await fs.rm(targetPath, { recursive: true, force: true });
      })
    );
  });

  it('[SPEC-9.1-1][SPEC-17.2-1] derives deterministic workspace key and path from issue identifier', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const manager = new WorkspaceManager({
      root,
      hooks: { timeout_ms: 1000 }
    });

    expect(manager.deriveWorkspaceKey('ABC-123')).toBe('ABC-123');
    expect(manager.deriveWorkspaceKey('a/b:c?d')).toBe('a_b_c_d');

    const workspace = await manager.ensureWorkspace('a/b:c?d');
    expect(workspace.workspace_key).toBe('a_b_c_d');
    expect(workspace.path).toBe(path.resolve(root, 'a_b_c_d'));
  });

  it('creates missing workspace and reuses existing directory with created_now flag', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const manager = new WorkspaceManager({
      root,
      hooks: { timeout_ms: 1000 }
    });

    const first = await manager.ensureWorkspace('ABC-1');
    const second = await manager.ensureWorkspace('ABC-1');

    expect(first.created_now).toBe(true);
    expect(second.created_now).toBe(false);
    expect(first.path).toBe(second.path);
  });

  it('replaces non-allowed identifier characters with underscore', () => {
    const manager = new WorkspaceManager({
      root: '/tmp/symphony',
      hooks: { timeout_ms: 1000 }
    });

    expect(manager.deriveWorkspaceKey('../ABC/é$*')).toBe('.._ABC____');
  });

  it('fails fast when workspace path collides with non-directory entry', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    await fs.writeFile(path.join(root, 'ABC-1'), 'collision');

    const manager = new WorkspaceManager({
      root,
      hooks: { timeout_ms: 1000 }
    });

    await expect(manager.ensureWorkspace('ABC-1')).rejects.toMatchObject({
      code: 'workspace_non_directory_collision'
    });
  });

  it('enforces root containment and cwd equality launch invariants', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const manager = new WorkspaceManager({
      root,
      hooks: { timeout_ms: 1000 }
    });

    expect(() =>
      manager.assertLaunchSafety({
        workspacePath: path.resolve(root, '..', 'escape'),
        cwd: path.resolve(root, '..', 'escape')
      })
    ).toThrowError(WorkspaceError);

    expect(() =>
      manager.assertLaunchSafety({
        workspacePath: path.resolve(root, 'ABC-1'),
        cwd: path.resolve(root, 'ABC-2')
      })
    ).toThrowError(WorkspaceError);
  });

  it('removes temporary artifacts during prepareAttempt', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const manager = new WorkspaceManager({
      root,
      hooks: { timeout_ms: 1000 }
    });

    const workspace = await manager.ensureWorkspace('ABC-1');
    await fs.mkdir(path.join(workspace.path, 'tmp'), { recursive: true });
    await fs.mkdir(path.join(workspace.path, '.elixir_ls'), { recursive: true });

    await manager.prepareAttempt(workspace.path);

    expect(await exists(path.join(workspace.path, 'tmp'))).toBe(false);
    expect(await exists(path.join(workspace.path, '.elixir_ls'))).toBe(false);
  });

  it('enforces per-hook failure and timeout semantics', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const calls: string[] = [];
    const manager = new WorkspaceManager({
      root,
      hooks: {
        after_create: 'create',
        before_run: 'before',
        after_run: 'after',
        before_remove: 'remove',
        timeout_ms: 1000
      },
      runShell: async ({ script }) => {
        calls.push(script);
        if (script === 'create') {
          return { timedOut: true, error: 'timeout' };
        }
        if (script === 'before') {
          return { timedOut: false, error: 'failed' };
        }
        return { timedOut: false };
      },
      probeTool: async () => true
    });

    await expect(manager.ensureWorkspace('ABC-1')).rejects.toMatchObject({ code: 'workspace_hook_timeout' });

    const manager2 = new WorkspaceManager({
      root,
      hooks: {
        before_run: 'before',
        after_run: 'after',
        before_remove: 'remove',
        timeout_ms: 1000
      },
      runShell: async ({ script }) => {
        if (script === 'before') {
          return { timedOut: false, error: 'failed' };
        }
        if (script === 'after') {
          return { timedOut: true, error: 'timeout' };
        }
        if (script === 'remove') {
          return { timedOut: true, error: 'timeout' };
        }
        return { timedOut: false };
      },
      probeTool: async () => true
    });

    const workspace = await manager2.ensureWorkspace('ABC-2');
    await expect(manager2.prepareAttempt(workspace.path)).rejects.toMatchObject({ code: 'workspace_hook_failed' });
    await expect(manager2.finalizeAttempt(workspace.path)).resolves.toBeUndefined();
    await expect(manager2.cleanupWorkspace('ABC-2')).resolves.toBe(true);

    expect(calls).toContain('create');
  });

  it('surfaces structured hook reason codes instead of raw stderr blobs', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const manager = new WorkspaceManager({
      root,
      hooks: {
        after_create: 'echo create',
        timeout_ms: 1000
      },
      runShell: async () => ({
        timedOut: false,
        error: '{"action":"error","reason":"source and target resolve to the same repository"}'
      })
    });

    await expect(manager.ensureWorkspace('ABC-1')).rejects.toMatchObject({
      code: 'workspace_hook_failed',
      message: expect.stringContaining('source_and_target_resolve_to_the_same_repository')
    });
  });

  it('preflights finalization shell/tool availability and emits typed fallback reason codes', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const hookResults: Array<{
      fallback_reason_code?: string;
      fallback_mode?: string;
      status: string;
    }> = [];
    const runShell = vi.fn(async () => ({ timedOut: false }));

    const manager = new WorkspaceManager({
      root,
      hooks: {
        after_run: 'echo finalize',
        timeout_ms: 1000
      },
      runShell,
      probeTool: async ({ command }) => command !== 'gh',
      onHookResult: (result) => {
        hookResults.push({
          fallback_reason_code: result.fallback_reason_code,
          fallback_mode: result.fallback_mode,
          status: result.status
        });
      }
    });

    const workspace = await manager.ensureWorkspace('ABC-1');
    await expect(manager.finalizeAttempt(workspace.path)).resolves.toBeUndefined();

    expect(runShell).not.toHaveBeenCalled();
    expect(hookResults).toContainEqual({
      fallback_reason_code: 'tool_missing_gh',
      fallback_mode: 'mcp_github',
      status: 'failed'
    });
  });

  it('runs after_create hook only on new workspace creation', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const runShell = vi.fn(async () => ({ timedOut: false }));
    const manager = new WorkspaceManager({
      root,
      hooks: {
        after_create: 'echo create',
        timeout_ms: 1000
      },
      runShell
    });

    await manager.ensureWorkspace('ABC-1');
    await manager.ensureWorkspace('ABC-1');

    expect(runShell).toHaveBeenCalledTimes(1);
  });

  it('runs before_remove only for existing workspace directories', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);

    const runShell = vi.fn(async () => ({ timedOut: false }));
    const manager = new WorkspaceManager({
      root,
      hooks: {
        before_remove: 'echo remove',
        timeout_ms: 1000
      },
      runShell
    });

    await expect(manager.cleanupWorkspace('MISSING-1')).resolves.toBe(true);
    expect(runShell).not.toHaveBeenCalled();

    const dirWorkspace = await manager.ensureWorkspace('ABC-1');
    await expect(manager.cleanupWorkspace('ABC-1')).resolves.toBe(true);
    expect(runShell).toHaveBeenCalledTimes(1);
    expect(runShell).toHaveBeenLastCalledWith({
      cwd: dirWorkspace.path,
      script: 'echo remove',
      timeoutMs: 1000
    });
  });

  it('provisions before after_create and tears down after before_remove', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);

    const callOrder: string[] = [];
    const manager = new WorkspaceManager({
      root,
      hooks: {
        after_create: 'echo create',
        before_remove: 'echo remove',
        timeout_ms: 1000
      },
      provisioner: {
        provision: async () => {
          callOrder.push('provision');
          return {
            status: 'provisioned',
            provisioner_type: 'worktree',
            branch_name: 'feature/ABC-1',
            repo_root: '/tmp/source',
            workspace_exists: true,
            workspace_git_status: 'clean'
          };
        },
        teardown: async () => {
          callOrder.push('teardown');
          return {
            status: 'removed',
            provisioner_type: 'worktree'
          };
        }
      },
      runShell: async ({ script }) => {
        if (script === 'echo create') {
          callOrder.push('after_create');
        }
        if (script === 'echo remove') {
          callOrder.push('before_remove');
        }
        return { timedOut: false };
      }
    });

    const workspace = await manager.ensureWorkspace('ABC-1');
    expect(workspace.provisioner_type).toBe('worktree');
    expect(workspace.branch_name).toBe('feature/ABC-1');
    await expect(manager.cleanupWorkspace('ABC-1')).resolves.toBe(true);

    expect(callOrder).toEqual(['provision', 'after_create', 'before_remove', 'teardown']);
  });

  it('does not remove workspace directory when teardown result is kept', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const manager = new WorkspaceManager({
      root,
      hooks: { timeout_ms: 1000 },
      provisioner: {
        provision: async () => ({ status: 'provisioned', provisioner_type: 'worktree' }),
        teardown: async () => ({ status: 'kept', provisioner_type: 'worktree' })
      }
    });

    const workspace = await manager.ensureWorkspace('ABC-KEEP');
    await expect(manager.cleanupWorkspace('ABC-KEEP')).resolves.toBe(true);
    await expect(exists(workspace.path)).resolves.toBe(true);
  });

  it('removes freshly created workspace dir when provisioning fails', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);
    const onProvisionerResult = vi.fn();
    const manager = new WorkspaceManager({
      root,
      hooks: { timeout_ms: 1000 },
      provisioner: {
        provision: async () => {
          throw new WorkspaceError('workspace_provision_failed', 'forced failure');
        },
        teardown: async () => ({ status: 'skipped', provisioner_type: 'worktree' })
      },
      onProvisionerResult
    });

    await expect(manager.ensureWorkspace('ABC-FAIL')).rejects.toMatchObject({
      code: 'workspace_provision_failed'
    });

    const workspacePath = path.join(root, 'ABC-FAIL');
    await expect(exists(workspacePath)).resolves.toBe(false);
    expect(onProvisionerResult).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'provision',
        identifier: 'ABC-FAIL',
        status: 'failed',
        cleanup_attempted: true,
        cleanup_succeeded: true
      })
    );
  });

  it('returns false for non-directory entry at cleanup path and skips before_remove', async () => {
    const root = await makeTempRoot();
    cleanupPaths.push(root);

    const runShell = vi.fn(async () => ({ timedOut: false }));
    const manager = new WorkspaceManager({
      root,
      hooks: {
        before_remove: 'echo remove',
        timeout_ms: 1000
      },
      runShell
    });

    await fs.writeFile(path.join(root, 'ABC-1'), 'collision');
    await expect(manager.cleanupWorkspace('ABC-1')).resolves.toBe(false);
    expect(runShell).not.toHaveBeenCalled();
  });
});
