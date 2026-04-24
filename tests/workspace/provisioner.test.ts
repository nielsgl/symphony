import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { CloneProvisioner, NoopProvisioner, WorktreeProvisioner } from '../../src/workspace/provisioner';

describe('WorkspaceProvisioner', () => {
  it('noop provisioner returns skipped lifecycle results', async () => {
    const provisioner = new NoopProvisioner();
    await expect(
      provisioner.provision({
        identifier: 'ABC-1',
        workspacePath: '/tmp/symphony/ABC-1'
      })
    ).resolves.toMatchObject({
      status: 'skipped',
      provisioner_type: 'none'
    });

    await expect(
      provisioner.teardown({
        identifier: 'ABC-1',
        workspacePath: '/tmp/symphony/ABC-1'
      })
    ).resolves.toMatchObject({
      status: 'skipped',
      provisioner_type: 'none'
    });
  });

  it('worktree provisioner renders deterministic branch and provisions via git worktree add', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-provisioner-repo-'));
    await fs.mkdir(path.join(repoRoot, '.git'));
    const runGit = vi.fn(async () => ({ ok: true, stdout: '', stderr: '' }));
    const rm = vi.fn(async () => undefined);

    const provisioner = new WorktreeProvisioner({
      repoRoot,
      baseRef: 'origin/main',
      branchTemplate: 'feature/{{ issue.identifier }}',
      teardownMode: 'remove_worktree',
      allowDirtyRepo: false,
      runGit,
      fsOps: {
        stat: fs.stat,
        rm
      }
    });

    const result = await provisioner.provision({
      identifier: 'ABC/12',
      workspacePath: '/tmp/workspaces/ABC_12'
    });

    expect(runGit).toHaveBeenNthCalledWith(1, {
      cwd: repoRoot,
      args: ['status', '--porcelain']
    });
    expect(runGit).toHaveBeenNthCalledWith(2, {
      cwd: repoRoot,
      args: ['worktree', 'add', '-b', 'feature/ABC/12', '/tmp/workspaces/ABC_12', 'origin/main']
    });
    expect(rm).toHaveBeenCalledWith('/tmp/workspaces/ABC_12', { recursive: true, force: true });
    expect(result).toMatchObject({
      status: 'provisioned',
      provisioner_type: 'worktree',
      branch_name: 'feature/ABC/12'
    });

    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('worktree provisioner blocks dirty repo when allow_dirty_repo is false', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-provisioner-repo-'));
    await fs.mkdir(path.join(repoRoot, '.git'));
    const runGit = vi.fn(async () => ({ ok: true, stdout: ' M README.md\n', stderr: '' }));

    const provisioner = new WorktreeProvisioner({
      repoRoot,
      baseRef: 'origin/main',
      branchTemplate: 'feature/{{ issue.identifier }}',
      teardownMode: 'remove_worktree',
      allowDirtyRepo: false,
      runGit,
      fsOps: {
        stat: fs.stat,
        rm: fs.rm
      }
    });

    await expect(
      provisioner.provision({
        identifier: 'ABC-1',
        workspacePath: '/tmp/workspaces/ABC-1'
      })
    ).rejects.toMatchObject({ code: 'workspace_provision_failed' });
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('clone provisioner clones repo and supports keep teardown mode', async () => {
    const runGit = vi.fn(async () => ({ ok: true, stdout: '', stderr: '' }));
    const rm = vi.fn(async () => undefined);
    const provisioner = new CloneProvisioner({
      repoRoot: '/tmp/source',
      baseRef: 'origin/main',
      teardownMode: 'keep',
      runGit,
      fsOps: {
        rm
      }
    });

    const result = await provisioner.provision({
      identifier: 'ABC-1',
      workspacePath: '/tmp/workspaces/ABC-1'
    });
    expect(result.status).toBe('provisioned');
    expect(runGit).toHaveBeenCalledWith({
      cwd: process.cwd(),
      args: ['clone', '--branch', 'origin/main', '--single-branch', '/tmp/source', '/tmp/workspaces/ABC-1']
    });

    await expect(
      provisioner.teardown({
        identifier: 'ABC-1',
        workspacePath: '/tmp/workspaces/ABC-1'
      })
    ).resolves.toMatchObject({
      status: 'kept',
      provisioner_type: 'clone'
    });
  });
});
