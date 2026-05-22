import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { REASON_CODES } from '../../src/observability';
import { detectRuntimeUpdateReadiness, LocalRuntimeUpdateManager } from '../../src/runtime/update-manager';

const GIT_INTEGRATION_TEST_TIMEOUT_MS = 30_000;

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

async function pushRemoteUpdate(root: string, fileName = 'index.js') {
  const remoteWork = path.join(root, `remote-work-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  git(root, ['clone', path.join(root, 'remote.git'), remoteWork]);
  git(remoteWork, ['config', 'user.email', 'symphony@example.test']);
  git(remoteWork, ['config', 'user.name', 'Symphony Test']);
  await writeFile(path.join(remoteWork, fileName), `console.log("${fileName}-${Date.now()}");\n`);
  git(remoteWork, ['add', '.']);
  git(remoteWork, ['commit', '-m', 'remote update']);
  git(remoteWork, ['push', 'origin', 'main']);
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
  }, GIT_INTEGRATION_TEST_TIMEOUT_MS);

  it('discovers a newly pushed remote update from readiness reads without mutating checkout files', async () => {
    const { root, local } = await makeRepoPair();
    const beforeHead = git(local, ['rev-parse', 'HEAD']);
    const beforeStatus = git(local, ['status', '--porcelain=v1']);
    await pushRemoteUpdate(root);

    const manager = new LocalRuntimeUpdateManager({
      repoRoot: local,
      baseRef: 'main',
      githubEligibilityMode: 'trust_raw_git',
      nowMs: () => Date.parse('2026-05-21T10:00:00.000Z'),
      runtimeIdentity: () => null
    });

    const readiness = manager.readUpdateReadiness();

    expect(readiness).toMatchObject({
      state: 'local_checkout_behind',
      attention_required: true,
      recommended_action: 'prepare_update',
      prepared: false,
      apply_ready: false,
      ahead_behind: { ahead: 0, behind: 1 },
      last_fetch: { result: 'succeeded' }
    });
    expect(git(local, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(git(local, ['status', '--porcelain=v1'])).toBe(beforeStatus);
  });

  it('blocks actionable update prepare when GitHub eligibility is not configured by default', async () => {
    const { root, local } = await makeRepoPair();
    await pushRemoteUpdate(root);

    const manager = new LocalRuntimeUpdateManager({
      repoRoot: local,
      baseRef: 'main',
      nowMs: () => Date.parse('2026-05-21T10:00:00.000Z'),
      runtimeIdentity: () => null
    });

    const prepared = await manager.prepareUpdate();

    expect(prepared).toMatchObject({
      success: false,
      status: 'refused',
      step: 'prepare',
      reason_code: REASON_CODES.runtimeUpdateGithubEligibilityRequired,
      readiness: {
        state: 'local_checkout_behind',
        prepared: false,
        apply_ready: false,
        github_eligibility: {
          mode: 'required',
          state: 'github_not_configured',
          reason_code: REASON_CODES.runtimeUpdateGithubEligibilityRequired
        }
      }
    });
    expect(prepared.readiness?.refusal_reasons).toContain(REASON_CODES.runtimeUpdateGithubEligibilityRequired);
  });

  it('allows prepare for an actionable update only when GitHub eligibility is verified or explicitly allowed', async () => {
    const { root, local } = await makeRepoPair();
    await pushRemoteUpdate(root);

    const manager = new LocalRuntimeUpdateManager({
      repoRoot: local,
      baseRef: 'main',
      nowMs: () => Date.parse('2026-05-21T10:00:00.000Z'),
      runtimeIdentity: () => null,
      githubEligibilityResolver: (params) => ({
        mode: params.mode,
        state: 'github_verified',
        provider: 'github',
        owner: 'nielsgl',
        repo: 'symphony',
        base_ref: params.baseRef,
        candidate_sha: params.candidateSha,
        checked_at: '2026-05-21T10:00:00.000Z',
        reason_code: null,
        check_summary: { total: 2, succeeded: 2, pending: 0, failed: 0, skipped: 0 }
      })
    });

    const prepared = await manager.prepareUpdate();

    expect(prepared).toMatchObject({
      success: true,
      status: 'draining',
      readiness: {
        state: 'local_checkout_behind',
        github_eligibility: {
          state: 'github_verified',
          check_summary: { total: 2, succeeded: 2 }
        },
        prepared: true,
        apply_ready: true
      }
    });
  });

  it('caches GitHub eligibility for repeated readiness reads of the same candidate', async () => {
    const { root, local } = await makeRepoPair();
    await pushRemoteUpdate(root);
    let eligibilityCalls = 0;

    const manager = new LocalRuntimeUpdateManager({
      repoRoot: local,
      baseRef: 'main',
      discoveryFetchIntervalMs: 60_000,
      nowMs: () => Date.parse('2026-05-21T10:00:00.000Z'),
      runtimeIdentity: () => null,
      githubEligibilityResolver: (params) => {
        eligibilityCalls += 1;
        return {
          mode: params.mode,
          state: 'github_verified',
          provider: 'github',
          owner: 'nielsgl',
          repo: 'symphony',
          base_ref: params.baseRef,
          candidate_sha: params.candidateSha,
          checked_at: '2026-05-21T10:00:00.000Z',
          reason_code: null,
          check_summary: { total: 1, succeeded: 1, pending: 0, failed: 0, skipped: 0 }
        };
      }
    });

    const first = manager.readUpdateReadiness();
    const second = manager.readUpdateReadiness();

    expect(first?.github_eligibility.state).toBe('github_verified');
    expect(second?.github_eligibility.state).toBe('github_verified');
    expect(eligibilityCalls).toBe(1);
  });

  it.each([
    'github_checks_pending',
    'github_checks_failed',
    'github_unavailable'
  ] as const)('blocks prepare when GitHub eligibility is %s', async (state) => {
    const { root, local } = await makeRepoPair();
    await pushRemoteUpdate(root);

    const manager = new LocalRuntimeUpdateManager({
      repoRoot: local,
      baseRef: 'main',
      nowMs: () => Date.parse('2026-05-21T10:00:00.000Z'),
      runtimeIdentity: () => null,
      githubEligibilityResolver: (params) => ({
        mode: params.mode,
        state,
        provider: 'github',
        owner: 'nielsgl',
        repo: 'symphony',
        base_ref: params.baseRef,
        candidate_sha: params.candidateSha,
        checked_at: '2026-05-21T10:00:00.000Z',
        reason_code: REASON_CODES.runtimeUpdateGithubEligibilityRequired,
        check_summary: {
          total: 1,
          succeeded: state === 'github_checks_pending' ? 0 : null,
          pending: state === 'github_checks_pending' ? 1 : null,
          failed: state === 'github_checks_failed' ? 1 : null,
          skipped: 0
        }
      })
    });

    const prepared = await manager.prepareUpdate();

    expect(prepared).toMatchObject({
      success: false,
      status: 'refused',
      reason_code: REASON_CODES.runtimeUpdateGithubEligibilityRequired,
      readiness: {
        state: 'local_checkout_behind',
        github_eligibility: { state, reason_code: REASON_CODES.runtimeUpdateGithubEligibilityRequired },
        prepared: false,
        apply_ready: false
      }
    });
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
      githubEligibilityMode: 'trust_raw_git',
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

    const prepared = await manager.prepareUpdate();
    expect(prepared.readiness).toMatchObject({
      state: 'local_checkout_behind',
      prepared: true,
      apply_ready: true
    });
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
  }, GIT_INTEGRATION_TEST_TIMEOUT_MS);

  it('requests a supervisor-backed restart after successful guided update apply', async () => {
    const { root, local } = await makeRepoPair();
    await pushRemoteUpdate(root);
    const auditEvents: any[] = [];
    const restartRequests: any[] = [];
    const manager = new LocalRuntimeUpdateManager({
      repoRoot: local,
      baseRef: 'main',
      githubEligibilityMode: 'trust_raw_git',
      nowMs: () => Date.parse('2026-05-21T10:00:00.000Z'),
      runtimeIdentity: () => null,
      auditSink: {
        appendDrainAuditHistory: async (event) => {
          auditEvents.push(event);
          return `audit-${auditEvents.length}`;
        }
      },
      restartCommand: ['npm', 'run', 'start:dashboard'],
      restartController: {
        capability: () => ({
          mode: 'supervisor_available',
          available: true,
          reason_code: REASON_CODES.runtimeUpdateRestartSupervisorAvailable,
          detail: 'test supervisor available'
        }),
        requestRestart: async (request) => {
          restartRequests.push(request);
          return {
            accepted: true,
            reason_code: REASON_CODES.runtimeUpdateRestartRequested,
            old_child_pid: 12345
          };
        }
      }
    });

    await manager.prepareUpdate();
    const applied = await manager.applyUpdate();

    expect(applied).toMatchObject({
      success: true,
      status: 'ready_to_restart',
      step: 'restart',
      recommended_action: 'reconnect_dashboard',
      restart: {
        mode: 'wrapper',
        status: 'restarting',
        reason_code: REASON_CODES.runtimeUpdateRestartStarted
      }
    });
    expect(restartRequests).toHaveLength(1);
    const replay = await manager.applyUpdate();
    expect(replay).toMatchObject({
      success: true,
      status: 'ready_to_restart',
      idempotent_replay: true,
      restart: { attempt_id: applied.restart?.attempt_id }
    });
    expect(restartRequests).toHaveLength(1);
    expect(restartRequests[0]).toMatchObject({
      old_commit_sha: expect.any(String),
      target_commit_sha: expect.any(String)
    });
    expect(manager.readRestartStatus()).toMatchObject({
      capability: { mode: 'supervisor_available', available: true },
      phase: 'restarting',
      old_child_pid: 12345,
      target_commit_sha: restartRequests[0].target_commit_sha
    });
    expect(auditEvents.map((event) => event.event_type)).toEqual(expect.arrayContaining([
      'update-restart-ready',
      'update-restart-requested',
      'update-restart-started',
      'update-old-child-shutdown-requested'
    ]));
  }, GIT_INTEGRATION_TEST_TIMEOUT_MS);

  it('records replacement child readiness from supervisor metadata once', async () => {
    const { local } = await makeRepoPair();
    const auditEvents: any[] = [];
    const manager = new LocalRuntimeUpdateManager({
      repoRoot: local,
      baseRef: 'main',
      githubEligibilityMode: 'trust_raw_git',
      nowMs: () => Date.parse('2026-05-21T10:00:00.000Z'),
      runtimeIdentity: () => ({
        process_started_at: '2026-05-21T10:00:00.000Z',
        process_started_at_ms: Date.parse('2026-05-21T10:00:00.000Z'),
        running_build: { identity: 'new-sha', commit_sha: 'new-sha', source_timestamp: null, source_timestamp_ms: null },
        current_build: { identity: 'new-sha', commit_sha: 'new-sha', source_timestamp: null, source_timestamp_ms: null, status: 'available' },
        status: 'current',
        health_warning: null
      }),
      auditSink: {
        appendDrainAuditHistory: async (event) => {
          auditEvents.push(event);
          return `audit-${auditEvents.length}`;
        }
      },
      supervisedRestartMetadata: {
        attempt_id: 'restart-1',
        target_commit_sha: 'new-sha',
        old_child_pid: 111,
        new_child_pid: 222,
        started_at: '2026-05-21T09:59:59.000Z'
      }
    });

    await manager.recordSupervisedRestartReady();
    await manager.recordSupervisedRestartReady();
    await manager.recordReconnectObserved();

    expect(manager.readRestartStatus()).toMatchObject({
      phase: 'completed',
      attempt_id: 'restart-1',
      old_child_pid: 111,
      new_child_pid: 222,
      target_commit_sha: 'new-sha',
      observed_running_commit_sha: 'new-sha'
    });
    expect(auditEvents.map((event) => event.event_type)).toEqual([
      'update-old-child-exited',
      'update-new-child-spawned',
      'update-new-child-ready',
      'update-restart-completed',
      'update-reconnect-observed'
    ]);
  }, GIT_INTEGRATION_TEST_TIMEOUT_MS);

  it('refuses apply when the remote candidate changed after prepare', async () => {
    const { root, local } = await makeRepoPair();
    await pushRemoteUpdate(root);
    const auditEvents: any[] = [];
    const manager = new LocalRuntimeUpdateManager({
      repoRoot: local,
      baseRef: 'main',
      githubEligibilityMode: 'trust_raw_git',
      nowMs: () => Date.parse('2026-05-21T10:00:00.000Z'),
      runtimeIdentity: () => null,
      auditSink: {
        appendDrainAuditHistory: async (event) => {
          auditEvents.push(event);
          return `audit-${auditEvents.length}`;
        }
      }
    });

    const prepared = await manager.prepareUpdate();
    const preparedCandidate = prepared.readiness?.prepared_update?.candidate_sha;
    await pushRemoteUpdate(root, 'index.js');
    const beforeApplyHead = git(local, ['rev-parse', 'HEAD']);
    const applied = await manager.applyUpdate();

    expect(prepared).toMatchObject({
      success: true,
      status: 'draining',
      readiness: {
        prepared_update: {
          remote: 'origin',
          base_ref: 'main',
          candidate_sha: preparedCandidate
        }
      }
    });
    expect(applied).toMatchObject({
      success: false,
      status: 'refused',
      step: 'apply',
      reason_code: REASON_CODES.runtimeUpdateCandidateChanged,
      recommended_action: 'prepare_update',
      command_results: [],
      readiness: {
        prepared: false,
        apply_ready: false,
        prepared_update: null
      }
    });
    expect(git(local, ['rev-parse', 'HEAD'])).toBe(beforeApplyHead);
    expect(auditEvents.map((event) => event.event_type)).not.toContain('update-pull-started');
    const refusal = auditEvents.find((event) => event.result_code === REASON_CODES.runtimeUpdateCandidateChanged);
    expect(refusal?.state_context).toMatchObject({
      prepared_update: { candidate_sha: preparedCandidate },
      fetched_candidate: { remote: 'origin', base_ref: 'main' }
    });
    expect(refusal?.state_context.fetched_candidate.candidate_sha).not.toBe(preparedCandidate);
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
      githubEligibilityMode: 'trust_raw_git',
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
  }, GIT_INTEGRATION_TEST_TIMEOUT_MS);

  it('does not report local-ahead-only history as a remote update candidate', async () => {
    const { local } = await makeRepoPair();
    await writeFile(path.join(local, 'local-only.txt'), 'local only\n');
    git(local, ['add', '.']);
    git(local, ['commit', '-m', 'local only update']);
    git(local, ['fetch', 'origin', 'main']);

    const auditEvents: any[] = [];
    const manager = new LocalRuntimeUpdateManager({
      repoRoot: local,
      baseRef: 'main',
      githubEligibilityMode: 'trust_raw_git',
      nowMs: () => Date.parse('2026-05-21T10:00:00.000Z'),
      runtimeIdentity: () => null,
      auditSink: {
        appendDrainAuditHistory: async (event) => {
          auditEvents.push(event);
          return `audit-${auditEvents.length}`;
        }
      }
    });

    const readiness = manager.readUpdateReadiness();
    const prepared = await manager.prepareUpdate();

    expect(readiness).toMatchObject({
      state: 'build_current',
      attention_required: false,
      drain_required: false,
      recommended_action: 'none',
      ahead_behind: { ahead: 1, behind: 0 },
      prepared: false,
      apply_ready: false
    });
    expect(prepared).toMatchObject({
      success: false,
      status: 'refused',
      step: 'prepare',
      reason_code: REASON_CODES.runtimeUpdateNotActionable,
      recommended_action: 'none',
      readiness: {
        state: 'build_current',
        attention_required: false,
        drain_required: false,
        prepared: false,
        apply_ready: false
      }
    });
    expect(auditEvents.map((event) => event.event_type)).not.toContain('update-prepare-requested');
    expect(auditEvents.map((event) => event.event_type)).not.toContain('update-pull-started');
    expect(git(local, ['status', '--porcelain=v1'])).toBe('');
  }, GIT_INTEGRATION_TEST_TIMEOUT_MS);

  it('refuses prepare and apply for a current build without entering the command sequence', async () => {
    const { local } = await makeRepoPair();
    const auditEvents: any[] = [];
    const manager = new LocalRuntimeUpdateManager({
      repoRoot: local,
      baseRef: 'main',
      githubEligibilityMode: 'trust_raw_git',
      nowMs: () => Date.parse('2026-05-21T10:00:00.000Z'),
      runtimeIdentity: () => null,
      auditSink: {
        appendDrainAuditHistory: async (event) => {
          auditEvents.push(event);
          return `audit-${auditEvents.length}`;
        }
      }
    });

    const prepare = await manager.prepareUpdate();
    const apply = await manager.applyUpdate();

    expect(prepare).toMatchObject({
      success: false,
      status: 'refused',
      step: 'prepare',
      reason_code: REASON_CODES.runtimeUpdateNotActionable,
      recommended_action: 'none',
      readiness: { state: 'build_current', prepared: false, apply_ready: false }
    });
    expect(apply).toMatchObject({
      success: false,
      status: 'refused',
      step: 'apply',
      reason_code: REASON_CODES.runtimeUpdateNotPrepared,
      recommended_action: 'none',
      readiness: { state: 'build_current' }
    });
    expect(apply.command_results ?? []).toEqual([]);
    expect(auditEvents.map((event) => event.event_type)).not.toContain('update-pull-started');
    expect(auditEvents.map((event) => event.event_type)).not.toContain('update-build-started');
    expect(git(local, ['status', '--porcelain=v1'])).toBe('');
  });
});
