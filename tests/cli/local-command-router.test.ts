import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

import { describe, expect, it } from 'vitest';

import { runCommandRouter } from '../../src/runtime/command-router';

function createHarness(overrides: { packageVersion?: string; repoRoot?: string } = {}) {
  let stdout = '';
  let stderr = '';
  const dashboardCalls: string[][] = [];
  const envFileLoads: string[] = [];

  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    dashboardCalls,
    envFileLoads,
    deps: {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
      runDashboard: async (argv: readonly string[]) => {
        dashboardCalls.push([...argv]);
        return 27;
      },
      loadEnvFile: (envFilePath: string) => {
        envFileLoads.push(envFilePath);
      },
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
    expect(harness.envFileLoads).toEqual([path.join(projectRoot, '.env')]);
    expect(harness.stdout).toBe('');
    expect(harness.stderr).toBe('');
  });
});
