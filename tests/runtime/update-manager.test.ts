import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { REASON_CODES } from '../../src/observability';
import { detectRuntimeUpdateReadiness, LocalRuntimeUpdateManager } from '../../src/runtime/update-manager';

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function writeFile(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
}

async function makeRepoPair() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-runtime-update-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  git(root, ['init', '--bare', remote]);
  git(root, ['clone', remote, local]);
  git(local, ['config', 'user.email', 'symphony@example.test']);
  git(local, ['config', 'user.name', 'Symphony Test']);
  await writeFile(path.join(local, 'package.json'), '{"scripts":{"build":"node -e \\"process.exit(0)\\""}}\n');
  await writeFile(path.join(local, 'index.js'), 'console.log("one");\n');
  git(local, ['add', '.']);
  git(local, ['commit', '-m', 'initial']);
  git(local, ['branch', '-M', 'main']);
  git(local, ['push', '-u', 'origin', 'main']);
  return { root, remote, local };
}

describe('runtime update manager', () => {
  it('detects a fetched remote update without mutating the working tree', async () => {
    const { root, local } = await makeRepoPair();
    const beforeStatus = git(local, ['status', '--porcelain=v1']);
    const remoteWork = path.join(root, 'remote-work');
    git(root, ['clone', path.join(root, 'remote.git'), remoteWork]);
    git(remoteWork, ['config', 'user.email', 'symphony@example.test']);
    git(remoteWork, ['config', 'user.name', 'Symphony Test']);
    await writeFile(path.join(remoteWork, 'index.js'), 'console.log("two");\n');
    git(remoteWork, ['add', '.']);
    git(remoteWork, ['commit', '-m', 'remote update']);
    git(remoteWork, ['push', 'origin', 'main']);
    git(local, ['fetch', 'origin', 'main']);

    const readiness = detectRuntimeUpdateReadiness({
      repoRoot: local,
      baseRef: 'main',
      runtimeIdentity: null,
      nowMs: () => Date.parse('2026-05-21T10:00:00.000Z')
    });

    expect(readiness).toMatchObject({
      state: 'local_checkout_behind',
      attention_required: true,
      drain_required: true,
      recommended_action: 'prepare_update',
      ahead_behind: { ahead: 0, behind: 1 },
      last_fetch: { result: 'not_attempted' }
    });
    expect(git(local, ['rev-parse', 'HEAD'])).toBe(readiness.local_checkout.commit_sha);
    expect(git(local, ['status', '--porcelain=v1'])).toBe(beforeStatus);
  });

  it('distinguishes dirty worktree, branch mismatch, non-fast-forward, stale runtime, and current build states', async () => {
    const { root, local } = await makeRepoPair();
    await writeFile(path.join(local, 'dirty.txt'), 'dirty\n');
    expect(detectRuntimeUpdateReadiness({ repoRoot: local, baseRef: 'main', runtimeIdentity: null }).state).toBe('dirty_worktree');
    await fs.rm(path.join(local, 'dirty.txt'));

    git(local, ['checkout', '-b', 'feature']);
    expect(detectRuntimeUpdateReadiness({ repoRoot: local, baseRef: 'main', runtimeIdentity: null }).state).toBe('branch_mismatch');
    git(local, ['checkout', 'main']);

    const remoteWork = path.join(root, 'remote-work');
    git(root, ['clone', path.join(root, 'remote.git'), remoteWork]);
    git(remoteWork, ['config', 'user.email', 'symphony@example.test']);
    git(remoteWork, ['config', 'user.name', 'Symphony Test']);
    await writeFile(path.join(remoteWork, 'remote.txt'), 'remote\n');
    git(remoteWork, ['add', '.']);
    git(remoteWork, ['commit', '-m', 'remote update']);
    git(remoteWork, ['push', 'origin', 'main']);
    await writeFile(path.join(local, 'local.txt'), 'local\n');
    git(local, ['add', '.']);
    git(local, ['commit', '-m', 'local update']);
    git(local, ['fetch', 'origin', 'main']);
    expect(detectRuntimeUpdateReadiness({ repoRoot: local, baseRef: 'main', runtimeIdentity: null }).state).toBe('non_fast_forward_required');

    git(local, ['reset', '--hard', 'origin/main']);
    const currentSha = git(local, ['rev-parse', 'HEAD']);
    expect(detectRuntimeUpdateReadiness({
      repoRoot: local,
      baseRef: 'main',
      runtimeIdentity: {
        process_started_at: '2026-05-21T09:00:00.000Z',
        process_started_at_ms: Date.parse('2026-05-21T09:00:00.000Z'),
        running_build: { identity: 'old', commit_sha: 'old', source_timestamp: null, source_timestamp_ms: null },
        current_build: { identity: currentSha, commit_sha: currentSha, source_timestamp: null, source_timestamp_ms: null, status: 'available' },
        status: 'stale',
        health_warning: null
      }
    }).state).toBe('runtime_stale');
    expect(detectRuntimeUpdateReadiness({ repoRoot: local, baseRef: 'main', runtimeIdentity: null }).state).toBe('build_current');
  });

  it('applies a safe fast-forward update through fetch, pull, guarded install skip, build, and manual restart handoff', async () => {
    const { root, local } = await makeRepoPair();
    const remoteWork = path.join(root, 'remote-work');
    git(root, ['clone', path.join(root, 'remote.git'), remoteWork]);
    git(remoteWork, ['config', 'user.email', 'symphony@example.test']);
    git(remoteWork, ['config', 'user.name', 'Symphony Test']);
    await writeFile(path.join(remoteWork, 'index.js'), 'console.log("two");\n');
    git(remoteWork, ['add', '.']);
    git(remoteWork, ['commit', '-m', 'remote update']);
    git(remoteWork, ['push', 'origin', 'main']);

    const auditEvents: any[] = [];
    const manager = new LocalRuntimeUpdateManager({
      repoRoot: local,
      baseRef: 'main',
      nowMs: () => Date.parse('2026-05-21T10:00:00.000Z'),
      runtimeIdentity: () => null,
      auditSink: {
        appendDrainAuditHistory: async (event) => {
          auditEvents.push(event);
          return `audit-${auditEvents.length}`;
        }
      },
      restartCommand: ['npm', 'run', 'start:dashboard']
    });

    await manager.prepareUpdate();
    const applied = await manager.applyUpdate();

    expect(applied).toMatchObject({
      success: true,
      status: 'manual_restart_required',
      recommended_action: 'manual_restart',
      restart: {
        mode: 'manual',
        status: 'manual_restart_required',
        command: ['npm', 'run', 'start:dashboard'],
        reason_code: REASON_CODES.runtimeUpdateRestartWrapperUnavailable
      }
    });
    expect(applied.command_results?.map((result) => [result.step, result.status])).toEqual([
      ['pull', 'succeeded'],
      ['install', 'skipped'],
      ['build', 'succeeded']
    ]);
    expect(auditEvents.map((event) => event.event_type)).toEqual(expect.arrayContaining([
      'update-detected',
      'update-pull-started',
      'update-pull-succeeded',
      'update-install-skipped',
      'update-build-started',
      'update-build-succeeded',
      'update-manual-restart-required'
    ]));
  });

  it('returns the completed apply result on repeated apply without rerunning commands', async () => {
    const { root, local } = await makeRepoPair();
    const remoteWork = path.join(root, 'remote-work');
    git(root, ['clone', path.join(root, 'remote.git'), remoteWork]);
    git(remoteWork, ['config', 'user.email', 'symphony@example.test']);
    git(remoteWork, ['config', 'user.name', 'Symphony Test']);
    await writeFile(path.join(remoteWork, 'index.js'), 'console.log("two");\n');
    git(remoteWork, ['add', '.']);
    git(remoteWork, ['commit', '-m', 'remote update']);
    git(remoteWork, ['push', 'origin', 'main']);

    const auditEvents: any[] = [];
    const manager = new LocalRuntimeUpdateManager({
      repoRoot: local,
      baseRef: 'main',
      nowMs: () => Date.parse('2026-05-21T10:00:00.000Z'),
      runtimeIdentity: () => null,
      auditSink: {
        appendDrainAuditHistory: async (event) => {
          auditEvents.push(event);
          return `audit-${auditEvents.length}`;
        }
      },
      restartCommand: ['npm', 'run', 'start:dashboard']
    });

    await manager.prepareUpdate();
    const first = await manager.applyUpdate();
    const second = await manager.applyUpdate();

    expect(first.success).toBe(true);
    expect(second).toMatchObject({
      success: true,
      status: 'manual_restart_required',
      idempotent_replay: true,
      command_results: first.command_results
    });
    expect(auditEvents.filter((event) => event.event_type === 'update-pull-started')).toHaveLength(1);
    expect(auditEvents.filter((event) => event.event_type === 'update-install-skipped')).toHaveLength(1);
    expect(auditEvents.filter((event) => event.event_type === 'update-build-started')).toHaveLength(1);
  });
});
