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
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-provisioner-ws-'));
    const workspacePath = path.join(workspaceRoot, 'ABC_12');
    await fs.mkdir(path.join(repoRoot, '.git'));
    const runGit = vi.fn(async ({ args }: { args: string[] }) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { ok: true, stdout: '', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        const workspacePath = args[4];
        await fs.mkdir(workspacePath, { recursive: true });
        await fs.writeFile(path.join(workspacePath, '.git'), `gitdir: ${path.join(repoRoot, '.git', 'worktrees', 'abc')}\n`);
      }
      return { ok: true, stdout: '', stderr: '' };
    });
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
      workspacePath
    });

    expect(runGit).toHaveBeenNthCalledWith(1, {
      cwd: repoRoot,
      args: ['worktree', 'list', '--porcelain']
    });
    expect(runGit).toHaveBeenNthCalledWith(2, {
      cwd: repoRoot,
      args: ['status', '--porcelain']
    });
    expect(runGit).toHaveBeenNthCalledWith(3, {
      cwd: repoRoot,
      args: ['worktree', 'add', '-b', 'feature/ABC/12', workspacePath, 'origin/main']
    });
    expect(rm).toHaveBeenCalledWith(workspacePath, { recursive: true, force: true });
    expect(result).toMatchObject({
      status: 'provisioned',
      provisioner_type: 'worktree',
      branch_name: 'feature/ABC/12'
    });

    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
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

  it('worktree provisioner prunes stale metadata before provisioning', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-provisioner-repo-'));
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-provisioner-ws-'));
    const workspacePath = path.join(workspaceRoot, 'ABC-STALE');
    await fs.mkdir(path.join(repoRoot, '.git'));

    let listCalls = 0;
    const runGit = vi.fn(async ({ args }: { args: string[] }) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        listCalls += 1;
        if (listCalls === 1) {
          return { ok: true, stdout: `worktree ${workspacePath}\nprunable gitdir file points to non-existent location\n`, stderr: '' };
        }
        return { ok: true, stdout: '', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        await fs.mkdir(workspacePath, { recursive: true });
        await fs.writeFile(path.join(workspacePath, '.git'), `gitdir: ${path.join(repoRoot, '.git', 'worktrees', 'abc')}\n`);
      }
      return { ok: true, stdout: '', stderr: '' };
    });

    const provisioner = new WorktreeProvisioner({
      repoRoot,
      baseRef: 'origin/main',
      branchTemplate: 'feature/{{ issue.identifier }}',
      teardownMode: 'remove_worktree',
      allowDirtyRepo: true,
      runGit,
      fsOps: { stat: fs.stat, rm: fs.rm }
    });

    const result = await provisioner.provision({ identifier: 'ABC-STALE', workspacePath });
    expect(result.workspace_integrity_status).toBe('reconciled');
    expect(result.workspace_integrity_reason).toBe('stale_worktree_metadata');
    expect(runGit).toHaveBeenCalledWith({ cwd: repoRoot, args: ['worktree', 'prune'] });

    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('clone provisioner clones repo and supports keep teardown mode', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-provisioner-clone-repo-'));
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-provisioner-clone-ws-'));
    const workspacePath = path.join(workspaceRoot, 'ABC-1');
    await fs.mkdir(path.join(repoRoot, '.git'));
    const runGit = vi.fn(async ({ args }: { args: string[] }) => {
      if (args[0] === 'clone') {
        const cloneWorkspacePath = args[5];
        await fs.mkdir(path.join(cloneWorkspacePath, '.git'), { recursive: true });
      }
      return { ok: true, stdout: '', stderr: '' };
    });
    const rm = vi.fn(async () => undefined);
    const provisioner = new CloneProvisioner({
      repoRoot,
      baseRef: 'origin/main',
      teardownMode: 'keep',
      runGit,
      fsOps: {
        rm
      }
    });

    const result = await provisioner.provision({
      identifier: 'ABC-1',
      workspacePath
    });
    expect(result.status).toBe('provisioned');
    expect(runGit).toHaveBeenCalledWith({
      cwd: process.cwd(),
      args: ['clone', '--branch', 'origin/main', '--single-branch', repoRoot, workspacePath]
    });

    await expect(
      provisioner.teardown({
        identifier: 'ABC-1',
        workspacePath
      })
    ).resolves.toMatchObject({
      status: 'kept',
      provisioner_type: 'clone'
    });

    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('worktree provisioner fails hard for non-empty non-managed directories', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-provisioner-repo-'));
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-provisioner-ws-'));
    const workspacePath = path.join(workspaceRoot, 'ABC-1');
    await fs.mkdir(path.join(repoRoot, '.git'));
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, 'README.md'), 'content');
    const runGit = vi.fn(async () => ({ ok: true, stdout: '', stderr: '' }));

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
        workspacePath
      })
    ).rejects.toMatchObject({ code: 'workspace_unprovisioned_conflict' });

    expect(runGit).toHaveBeenCalledTimes(2);
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('worktree provisioner reprovisions empty existing directories', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-provisioner-repo-'));
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-provisioner-ws-'));
    const workspacePath = path.join(workspaceRoot, 'ABC-2');
    await fs.mkdir(path.join(repoRoot, '.git'));
    await fs.mkdir(workspacePath, { recursive: true });

    const runGit = vi.fn(async ({ args }: { args: string[] }) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        await fs.mkdir(workspacePath, { recursive: true });
        await fs.writeFile(path.join(workspacePath, '.git'), `gitdir: ${path.join(repoRoot, '.git', 'worktrees', 'abc2')}\n`);
      }
      return { ok: true, stdout: '', stderr: '' };
    });

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
        identifier: 'ABC-2',
        workspacePath
      })
    ).resolves.toMatchObject({ status: 'provisioned', provisioner_type: 'worktree' });

    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });
});
