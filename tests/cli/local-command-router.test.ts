import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  bindDashboardSupervisorSignalForwarding,
  runCommandRouter,
  type DashboardLaunchContext,
  type DashboardSupervisorSignal
} from '../../src/runtime/command-router';
import type { SetupConsentStore, SetupConsentStorePayload, WorkflowPosture } from '../../src/runtime/setup-consent';

function createMemoryConsentStore(storePath = path.join(os.tmpdir(), 'symphony-user-state', 'setup-consent.json')) {
  let payload: SetupConsentStorePayload = { version: 1, records: [] };
  const store: SetupConsentStore = {
    path: storePath,
    read: () => payload,
    write: (next) => {
      payload = next;
    }
  };
  return {
    store,
    records: () => payload.records
  };
}

const HIGH_TRUST_POSTURE: WorkflowPosture = {
  posture: 'high-trust',
  reason: 'workflow effective codex sandbox posture requires danger-full-access local execution',
  evidence: {
    thread_sandbox: 'danger-full-access',
    turn_sandbox_policy: 'danger-full-access'
  }
};

function createHarness(overrides: { packageVersion?: string; repoRoot?: string } = {}) {
  let stdout = '';
  let stderr = '';
  const dashboardCalls: string[][] = [];
  const dashboardContexts: Array<{ cwd: string; envFilePath: string; repoRoot: string }> = [];
  const linkLocalCalls: string[][] = [];
  const envFileLoads: string[] = [];
  const consent = createMemoryConsentStore();

  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    dashboardCalls,
    dashboardContexts,
    linkLocalCalls,
    envFileLoads,
    consent,
    deps: {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
      runDashboard: async (argv: readonly string[], context: DashboardLaunchContext) => {
        dashboardCalls.push([...argv]);
        dashboardContexts.push({
          cwd: context.cwd,
          envFilePath: context.envFilePath,
          repoRoot: context.repoRoot
        });
        return 27;
      },
      runLinkLocal: async (argv: readonly string[]) => {
        linkLocalCalls.push([...argv]);
        return 28;
      },
      loadEnvFile: (envFilePath: string) => {
        envFileLoads.push(envFilePath);
      },
      setupConsentStore: consent.store,
      resolveWorkflowPosture: () => HIGH_TRUST_POSTURE,
      promptSetupConsent: async () => false,
      clock: () => new Date('2026-05-24T20:00:00.000Z'),
      packageVersion: overrides.packageVersion ?? '9.8.7',
      repoRoot: overrides.repoRoot ?? '/repo/symphony',
      cwd: process.cwd(),
      env: {}
    }
  };
}

describe('local symphony command router', () => {
  it('prints top-level help with supported commands', async () => {
    const harness = createHarness();

    const exitCode = await runCommandRouter({ argv: ['--help'], deps: harness.deps });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('symphony <command> [options]');
    expect(harness.stdout).toContain('dashboard');
    expect(harness.stdout).toContain('doctor');
    expect(harness.stdout).toContain('setup');
    expect(harness.stdout).toContain('profile');
    expect(harness.stdout).toContain('init');
    expect(harness.stdout).toContain('link-local');
    expect(harness.stderr).toBe('');
  });

  it('prints the package version', async () => {
    const harness = createHarness({ packageVersion: '1.2.3' });

    const exitCode = await runCommandRouter({ argv: ['--version'], deps: harness.deps });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toBe('1.2.3\n');
    expect(harness.stderr).toBe('');
  });

  it('lists bounded profiles including symphony-internal', async () => {
    const harness = createHarness();

    const exitCode = await runCommandRouter({ argv: ['profile', 'list'], deps: harness.deps });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('symphony-internal');
    expect(harness.stdout).toContain('checked-in WORKFLOW.md');
    expect(harness.stderr).toBe('');
  });

  it('shows symphony-internal as the protected checked-in workflow binding', async () => {
    const repoRoot = '/repo/symphony';
    const harness = createHarness({ repoRoot });

    const exitCode = await runCommandRouter({
      argv: ['profile', 'show', 'symphony-internal'],
      deps: harness.deps
    });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('Profile: symphony-internal');
    expect(harness.stdout).toContain('Type: protected');
    expect(harness.stdout).toContain(path.join(repoRoot, 'WORKFLOW.md'));
    expect(harness.stdout).toContain('checked-in Symphony WORKFLOW.md');
    expect(harness.stdout).toContain('not a generated workflow template');
    expect(harness.stderr).toBe('');
  });

  it('prints bounded init help without materialization behavior', async () => {
    const harness = createHarness();

    const exitCode = await runCommandRouter({ argv: ['init', '--help'], deps: harness.deps });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('symphony init --help');
    expect(harness.stdout).toContain('reserved for later workflow materialization work');
    expect(harness.stdout).toContain('does not generate, copy, or overwrite workflows');
    expect(harness.stderr).toBe('');
  });

  it('fails unknown commands with actionable help', async () => {
    const harness = createHarness();

    const exitCode = await runCommandRouter({ argv: ['frobnicate'], deps: harness.deps });

    expect(exitCode).toBe(1);
    expect(harness.stderr).toContain("Unknown command 'frobnicate'");
    expect(harness.stderr).toContain('Supported commands: dashboard, doctor, setup, profile, init, link-local');
    expect(harness.stderr).toContain('symphony <command> [options]');
    expect(harness.stdout).toBe('');
  });

  it('fails unsupported profile modes instead of silently succeeding', async () => {
    const harness = createHarness();

    const exitCode = await runCommandRouter({
      argv: ['profile', 'show', 'custom-profile'],
      deps: harness.deps
    });

    expect(exitCode).toBe(1);
    expect(harness.stderr).toContain('Unsupported profile command: show custom-profile');
    expect(harness.stderr).toContain('symphony profile show symphony-internal');
    expect(harness.stdout).toBe('');
  });

  it('fails recognized but not-yet-implemented commands', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-reserved-')));
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'workflow\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({ argv: ['doctor'], deps: harness.deps });

    expect(exitCode).toBe(1);
    expect(harness.stderr).toContain("Command 'doctor' is recognized but not implemented in this PRD.");
    expect(harness.stderr).toContain('symphony <command> [options]');
    expect(harness.stdout).toBe('');
  });

  it('runs local context resolution for reserved setup and doctor flows', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-doctor-')));
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'workflow\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({
      argv: ['doctor', '--profile', 'unknown'],
      deps: harness.deps
    });

    expect(exitCode).toBe(1);
    expect(harness.stderr).toContain("Unknown Symphony profile 'unknown'");
    expect(harness.stderr).not.toContain("Command 'doctor' is recognized but not implemented");
    expect(harness.stdout).toBe('');
  });

  it('records explicit setup consent in user-local state for the resolved workflow identity', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-setup-')));
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'workflow\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({ argv: ['setup', '--yes'], deps: harness.deps });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('Symphony setup high-trust consent:');
    expect(harness.stdout).toContain(`project root: ${projectRoot} (project)`);
    expect(harness.stdout).toContain('required posture: high-trust');
    expect(harness.stdout).toContain('Setup consent recorded for identity');
    expect(harness.stderr).toBe('');
    expect(harness.consent.records()).toHaveLength(1);
    const [record] = harness.consent.records();
    expect(record.evidence.project_root).toBe(projectRoot);
    expect(record.evidence.workflow_path).toBe(path.join(projectRoot, 'WORKFLOW.md'));
    expect(record.evidence.project_root_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.evidence.workflow_path_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(record)).not.toContain('workflow\\n');
  });

  it('fails setup safely when explicit consent is not available', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-setup-refuse-')));
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'workflow\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({ argv: ['setup'], deps: harness.deps });

    expect(exitCode).toBe(1);
    expect(harness.stderr).toContain('Setup consent was not recorded');
    expect(harness.consent.records()).toEqual([]);
  });

  it('refuses to persist setup consent inside the project checkout', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-project-state-')));
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'workflow\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;
    const projectStore = createMemoryConsentStore(path.join(projectRoot, '.symphony', 'setup-consent.json'));
    harness.deps.setupConsentStore = projectStore.store;

    const exitCode = await runCommandRouter({ argv: ['setup', '--yes'], deps: harness.deps });

    expect(exitCode).toBe(1);
    expect(harness.stderr).toContain('Refusing to store setup consent under the project checkout');
    expect(projectStore.records()).toEqual([]);
  });

  it('uses valid setup consent as the dashboard guardrail acknowledgement source', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-setup-dashboard-')));
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'workflow\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    expect(await runCommandRouter({ argv: ['setup', '--yes'], deps: harness.deps })).toBe(0);
    const exitCode = await runCommandRouter({ argv: ['dashboard', '--port=0'], deps: harness.deps });

    expect(exitCode).toBe(27);
    expect(harness.dashboardCalls.at(-1)).toContain('--i-understand-that-this-will-be-running-without-the-usual-guardrails');
    expect(harness.stdout).toContain('consent: setup');
  });

  it('does not treat workflow declarations as setup consent authority', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-project-file-')));
    await fs.writeFile(
      path.join(projectRoot, 'WORKFLOW.md'),
      ['---', 'local_high_trust_consent: true', '---', 'workflow'].join('\n'),
      'utf8'
    );
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({ argv: ['dashboard', '--port=0'], deps: harness.deps });

    expect(exitCode).toBe(27);
    expect(harness.dashboardCalls.at(-1)).not.toContain('--i-understand-that-this-will-be-running-without-the-usual-guardrails');
    expect(harness.stdout).toContain('consent: missing');
  });

  it('bypasses old setup consent when the workflow identity changes', async () => {
    const projectA = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-identity-a-')));
    const projectB = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-identity-b-')));
    await fs.writeFile(path.join(projectA, 'WORKFLOW.md'), 'workflow a\n', 'utf8');
    await fs.writeFile(path.join(projectB, 'WORKFLOW.md'), 'workflow b\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectA;
    expect(await runCommandRouter({ argv: ['setup', '--yes'], deps: harness.deps })).toBe(0);

    harness.deps.cwd = projectB;
    const exitCode = await runCommandRouter({ argv: ['dashboard', '--port=0'], deps: harness.deps });

    expect(exitCode).toBe(27);
    expect(harness.dashboardCalls.at(-1)).not.toContain('--i-understand-that-this-will-be-running-without-the-usual-guardrails');
    expect(harness.stdout).toContain('consent: missing');
  });

  it('resolves dashboard local context before delegating to the existing dashboard runner', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-project-')));
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'workflow\n', 'utf8');
    await fs.writeFile(path.join(projectRoot, '.env'), 'SYMPHONY_TEST_VALUE=1\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({
      argv: ['dashboard', '--port=0', '--offline'],
      deps: harness.deps
    });

    expect(exitCode).toBe(27);
    expect(harness.dashboardCalls).toEqual([
      [
        '--offline',
        path.join('--workflow=' + projectRoot, 'WORKFLOW.md'),
        '--host=127.0.0.1',
        '--port=0'
      ]
    ]);
    expect(harness.dashboardContexts).toEqual([
      {
        cwd: projectRoot,
        envFilePath: path.join(projectRoot, '.env'),
        repoRoot: '/repo/symphony'
      }
    ]);
    expect(harness.envFileLoads).toEqual([path.join(projectRoot, '.env')]);
    expect(harness.stdout).toContain('Symphony dashboard startup context:');
    expect(harness.stdout).toContain(`project root: ${projectRoot} (project)`);
    expect(harness.stdout).toContain(`workflow: ${path.join(projectRoot, 'WORKFLOW.md')} (project)`);
    expect(harness.stdout).toContain(`env file: ${path.join(projectRoot, '.env')} (project)`);
    expect(harness.stdout).toContain('profile: project (default)');
    expect(harness.stdout).toContain('host: 127.0.0.1 (default)');
    expect(harness.stdout).toContain('port: 0 (cli)');
    expect(harness.stdout).toContain('consent: missing');
    expect(harness.stderr).toBe('');
  });

  it('delegates link-local arguments to the local linker', async () => {
    const harness = createHarness();

    const exitCode = await runCommandRouter({
      argv: ['link-local', '--target', '/tmp/symphony'],
      deps: harness.deps
    });

    expect(exitCode).toBe(28);
    expect(harness.linkLocalCalls).toEqual([['--target', '/tmp/symphony']]);
    expect(harness.stdout).toBe('');
    expect(harness.stderr).toBe('');
  });

  it('loads the explicit workflow project env file before delegating dashboard startup', async () => {
    const cwdProject = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-cwd-')));
    const explicitProject = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-explicit-')));
    await fs.writeFile(path.join(cwdProject, 'WORKFLOW.md'), 'cwd workflow\n', 'utf8');
    await fs.writeFile(path.join(cwdProject, '.env'), 'SYMPHONY_HOST=198.51.100.1\n', 'utf8');
    await fs.writeFile(path.join(explicitProject, 'WORKFLOW.md'), 'explicit workflow\n', 'utf8');
    await fs.writeFile(path.join(explicitProject, '.env'), 'SYMPHONY_HOST=203.0.113.7\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = cwdProject;

    const exitCode = await runCommandRouter({
      argv: ['dashboard', '--workflow', path.join(explicitProject, 'WORKFLOW.md'), '--port', '0'],
      deps: harness.deps
    });

    expect(exitCode).toBe(27);
    expect(harness.envFileLoads).toEqual([path.join(explicitProject, '.env')]);
    expect(harness.dashboardContexts).toEqual([
      {
        cwd: cwdProject,
        envFilePath: path.join(explicitProject, '.env'),
        repoRoot: '/repo/symphony'
      }
    ]);
    expect(harness.dashboardCalls).toEqual([
      [
        `--workflow=${path.join(explicitProject, 'WORKFLOW.md')}`,
        '--host=203.0.113.7',
        '--port=0'
      ]
    ]);
    expect(harness.stdout).toContain(`project root: ${explicitProject} (cli)`);
    expect(harness.stdout).toContain(`workflow: ${path.join(explicitProject, 'WORKFLOW.md')} (cli)`);
    expect(harness.stdout).toContain(`env file: ${path.join(explicitProject, '.env')} (project)`);
    expect(harness.stdout).toContain('host: 203.0.113.7 (env)');
    expect(harness.stderr).toBe('');
  });

  it('routes the symphony-internal profile through the checkout workflow and preserves consent flag', async () => {
    const externalProject = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-external-')));
    await fs.writeFile(path.join(externalProject, 'WORKFLOW.md'), 'external workflow\n', 'utf8');
    const repoRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-repo-')));
    await fs.writeFile(path.join(repoRoot, 'WORKFLOW.md'), 'repo workflow\n', 'utf8');
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = externalProject;

    const exitCode = await runCommandRouter({
      argv: [
        'dashboard',
        '--profile',
        'symphony-internal',
        '--host',
        '0.0.0.0',
        '--port',
        '0',
        '--i-understand-that-this-will-be-running-without-the-usual-guardrails'
      ],
      deps: harness.deps
    });

    expect(exitCode).toBe(27);
    expect(harness.envFileLoads).toEqual([path.join(repoRoot, '.env')]);
    expect(harness.dashboardContexts).toEqual([
      {
        cwd: externalProject,
        envFilePath: path.join(repoRoot, '.env'),
        repoRoot
      }
    ]);
    expect(harness.dashboardCalls).toEqual([
      [
        '--i-understand-that-this-will-be-running-without-the-usual-guardrails',
        `--workflow=${path.join(repoRoot, 'WORKFLOW.md')}`,
        '--host=0.0.0.0',
        '--port=0'
      ]
    ]);
    expect(harness.stdout).toContain(`project root: ${repoRoot} (profile)`);
    expect(harness.stdout).toContain(`workflow: ${path.join(repoRoot, 'WORKFLOW.md')} (profile)`);
    expect(harness.stdout).toContain('profile: symphony-internal (cli)');
    expect(harness.stdout).toContain('host: 0.0.0.0 (cli)');
    expect(harness.stdout).toContain('consent: flag');
    expect(harness.stderr).toBe('');
  });

  it('fails missing resolver-managed values before dashboard startup', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-missing-')));
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'workflow\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({
      argv: ['dashboard', '--workflow', '--port', '0'],
      deps: harness.deps
    });

    expect(exitCode).toBe(1);
    expect(harness.dashboardCalls).toEqual([]);
    expect(harness.envFileLoads).toEqual([]);
    expect(harness.stderr).toContain('cli workflow requires a value');
  });

  it('forwards wrapper termination signals to the active dashboard supervisor child', () => {
    const signalSource = new EventEmitter() as EventEmitter & {
      once(signal: DashboardSupervisorSignal, listener: () => void): EventEmitter;
      removeListener(signal: DashboardSupervisorSignal, listener: () => void): EventEmitter;
    };
    const forwardedSignals: DashboardSupervisorSignal[] = [];
    const child = {
      killed: false,
      kill: (signal: DashboardSupervisorSignal) => {
        forwardedSignals.push(signal);
        child.killed = true;
        return true;
      }
    };

    const binding = bindDashboardSupervisorSignalForwarding(child, signalSource);

    signalSource.emit('SIGTERM');
    signalSource.emit('SIGINT');
    binding.cleanup();

    expect(forwardedSignals).toEqual(['SIGTERM']);
    expect(binding.forwardedSignal()).toBe('SIGTERM');
    expect(signalSource.listenerCount('SIGINT')).toBe(0);
    expect(signalSource.listenerCount('SIGTERM')).toBe(0);
  });

  it('cleans dashboard supervisor signal listeners when no signal was forwarded', () => {
    const signalSource = new EventEmitter() as EventEmitter & {
      once(signal: DashboardSupervisorSignal, listener: () => void): EventEmitter;
      removeListener(signal: DashboardSupervisorSignal, listener: () => void): EventEmitter;
    };
    const child = {
      killed: false,
      kill: () => {
        throw new Error('signal should not be forwarded');
      }
    };

    const binding = bindDashboardSupervisorSignalForwarding(child, signalSource);
    binding.cleanup();

    expect(binding.forwardedSignal()).toBeNull();
    expect(signalSource.listenerCount('SIGINT')).toBe(0);
    expect(signalSource.listenerCount('SIGTERM')).toBe(0);
  });
});
