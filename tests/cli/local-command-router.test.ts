import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  bindDashboardSupervisorSignalForwarding,
  runCommandRouter,
  type DashboardLaunchContext,
  type LinkLocalRunOptions,
  type DashboardSupervisorSignal
} from '../../src/runtime/command-router';
import { resolveLocalCommand } from '../../src/runtime/local-command-resolver';
import {
  buildSetupConsentRecord,
  createFileSetupConsentStore,
  persistSetupConsent,
  type SetupConsentStore,
  type SetupConsentStorePayload,
  type WorkflowPosture
} from '../../src/runtime/setup-consent';

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

const VALID_WORKFLOW = ['---', 'tracker:', '  kind: memory', 'codex:', '  command: codex', '---', 'workflow'].join('\n');
const ENV_BACKED_LINEAR_WORKFLOW = [
  '---',
  'tracker:',
  '  kind: linear',
  '  api_key: $DOCTOR_ONLY_LINEAR_TOKEN',
  '  project_slug: DEMO',
  'codex:',
  '  command: codex',
  '---',
  'workflow'
].join('\n');

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

async function createDoctorRepo(): Promise<{ repoRoot: string; binDir: string; shimPath: string }> {
  const repoRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-doctor-repo-')));
  await fs.mkdir(path.join(repoRoot, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'dist', 'src', 'runtime'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, 'scripts', 'symphony.js'), '#!/usr/bin/env node\n', 'utf8');
  await fs.writeFile(path.join(repoRoot, 'scripts', 'start-dashboard-supervisor.js'), '#!/usr/bin/env node\n', 'utf8');
  await fs.writeFile(path.join(repoRoot, 'dist', 'src', 'runtime', 'command-router.js'), 'module.exports = {};\n', 'utf8');
  const binDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-doctor-bin-')));
  const shimPath = path.join(binDir, 'symphony');
  await fs.writeFile(path.join(binDir, 'codex'), '#!/usr/bin/env bash\nexit 0\n', { encoding: 'utf8', mode: 0o755 });
  await fs.writeFile(
    shimPath,
    [
      '#!/usr/bin/env bash',
      '# symphony-local-shim',
      '# symphony-shim-version: 1',
      `# symphony-repo-root: ${repoRoot}`,
      `# symphony-entrypoint: ${path.join(repoRoot, 'scripts', 'symphony.js')}`,
      'exit 0',
      ''
    ].join('\n'),
    { encoding: 'utf8', mode: 0o755 }
  );
  return { repoRoot, binDir, shimPath };
}

async function createDoctorProject(workflowContent = VALID_WORKFLOW): Promise<string> {
  const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-doctor-project-')));
  await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), workflowContent, 'utf8');
  await fs.writeFile(path.join(projectRoot, '.gitignore'), '.symphony/system/\n', 'utf8');
  return projectRoot;
}

function listenOnLocalhost(port = 0): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('expected TCP address'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function doctorFinding(payload: { findings: Array<{ id: string }> }, id: string) {
  const found = payload.findings.find((finding) => finding.id === id);
  expect(found, `missing doctor finding ${id}`).toBeTruthy();
  return found!;
}

describe('local symphony command router', () => {
  it('prints top-level help with supported commands', async () => {
    const harness = createHarness();

    const exitCode = await runCommandRouter({ argv: ['--help'], deps: harness.deps });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('symphony <command> [options]');
    expect(harness.stdout).toContain('dashboard');
    expect(harness.stdout).toContain('doctor');
    expect(harness.stdout).toContain('setup           Record user-local setup consent for this workflow');
    expect(harness.stdout).not.toContain('Reserved for future local setup consent and configuration');
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

  it('reports healthy local doctor readiness with a linked shim and setup consent', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    expect(await runCommandRouter({ argv: ['setup', '--yes'], deps: harness.deps })).toBe(0);
    const exitCode = await runCommandRouter({ argv: ['doctor'], deps: harness.deps });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('Symphony doctor: ok');
    expect(harness.stdout).toContain(`project root: ${projectRoot}`);
    expect(harness.stdout).toContain(`workflow: ${path.join(projectRoot, 'WORKFLOW.md')}`);
    expect(harness.stdout).toContain(`env file: ${path.join(projectRoot, '.env')}`);
    expect(harness.stdout).toContain('port: 0 (ephemeral)');
    expect(harness.stdout).toContain('consent: setup');
    expect(harness.stdout).not.toContain('SYMPHONY_TEST_VALUE');
    expect(harness.stderr).toBe('');
  });

  it('emits stable JSON doctor output and CI blocker exit behavior', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({ argv: ['doctor', '--json', '--ci'], deps: harness.deps });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(2);
    expect(payload).toMatchObject({
      version: 1,
      command: 'doctor',
      status: 'failure',
      reason: 'blockers_present',
      exitCode: 2,
      exitSemantics: {
        code: 2,
        meaning: 'blockers_present',
        ci: {
          requested: true,
          promptsAllowed: false,
          nonZeroOnBlocker: true
        }
      },
      ci: true,
      resolution: {
        projectRoot,
        workflowPath: path.join(projectRoot, 'WORKFLOW.md'),
        envFilePath: path.join(projectRoot, '.env'),
        host: '127.0.0.1',
        port: 0,
        ephemeralPort: true,
        consent: 'missing'
      }
    });
    expect(payload.projectContext).toMatchObject({
      cwd: projectRoot,
      symphonyCheckoutRoot: repoRoot,
      projectRoot,
      workflowPath: path.join(projectRoot, 'WORKFLOW.md'),
      envFilePath: path.join(projectRoot, '.env'),
      envFileExists: false,
      profile: 'project'
    });
    expect(payload.findings).toEqual(payload.checks);
    expect(payload.findings.every((finding: Record<string, unknown>) =>
      ['id', 'code', 'severity', 'message', 'source', 'remediationInfo', 'safeFix', 'details', 'checkStatus'].every((key) =>
        Object.prototype.hasOwnProperty.call(finding, key)
      )
    )).toBe(true);
    expect(doctorFinding(payload, 'setup.consent')).toMatchObject({
      code: 'setup_consent_missing',
      severity: 'blocker',
      checkStatus: 'failure',
      message: expect.stringContaining('No user-local setup consent exists'),
      source: { category: 'user_local_trust_state', present: false },
      remediationInfo: { guidance: expect.stringContaining('symphony setup --yes') },
      safeFix: {
        available: true,
        fixId: 'setup-consent',
        command: 'symphony doctor --fix --yes',
        requiresYes: true,
        mutates: [
          {
            scope: 'user_local_state',
            path: harness.deps.setupConsentStore.path,
            operation: 'record_setup_consent'
          }
        ]
      },
      details: {
        posture: 'high-trust'
      }
    });
    expect(doctorFinding(payload, 'server.port')).toMatchObject({
      severity: 'pass',
      checkStatus: 'ok',
      source: { category: 'inferred_runtime_default', value: 'default', present: true },
      safeFix: { available: false }
    });
    expect(doctorFinding(payload, 'env.path')).toMatchObject({
      source: { category: 'project_default', value: 'project', present: true },
      details: { exists: false }
    });
    expect(doctorFinding(payload, 'layout.gitignore_system')).toMatchObject({
      source: { category: 'layout_inspection' },
      safeFix: {
        available: false,
        mutates: [
          {
            scope: 'project_file',
            path: path.join(projectRoot, '.gitignore'),
            operation: 'append_gitignore_entry'
          }
        ]
      }
    });
    expect(doctorFinding(payload, 'workflow.effective_config')).toMatchObject({
      details: {
        trackerApiKey: { redacted: true, present: false }
      }
    });
    expect(payload.checks.some((check: { id: string; reason: string }) => check.id === 'setup.consent' && check.reason === 'setup_consent_missing')).toBe(true);
    expect(payload.layout).toMatchObject({
      workflow: { path: 'WORKFLOW.md', exists: true, canonical: true },
      runtimeStateRoot: { path: '.symphony/system', owner: 'runtime-state' },
      ignoreAnalysis: { status: 'narrow-system', hasNarrowSystemIgnore: true }
    });
    expect(harness.stderr).toBe('');
  });

  it('normalizes doctor provenance categories and redacts sensitive details', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject(ENV_BACKED_LINEAR_WORKFLOW);
    await fs.writeFile(path.join(projectRoot, '.env'), 'DOCTOR_ONLY_LINEAR_TOKEN=secret-from-env-file\n', 'utf8');
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({
      argv: ['doctor', '--json', '--port', '0', '--i-understand-that-this-will-be-running-without-the-usual-guardrails'],
      deps: harness.deps
    });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(0);
    expect(doctorFinding(payload, 'resolver.workflow')).toMatchObject({
      source: { category: 'workflow_value', value: 'project', present: true }
    });
    expect(doctorFinding(payload, 'env.path')).toMatchObject({
      source: { category: 'environment_file', value: 'project', present: true },
      details: { exists: true }
    });
    expect(doctorFinding(payload, 'workflow.effective_config')).toMatchObject({
      severity: 'pass',
      source: { category: 'workflow_value', present: true },
      details: {
        trackerKind: 'linear',
        trackerApiKey: { redacted: true, present: true }
      }
    });
    expect(doctorFinding(payload, 'server.port')).toMatchObject({
      source: { category: 'cli_flag', value: 'cli', present: true }
    });
    expect(doctorFinding(payload, 'setup.consent')).toMatchObject({
      source: { category: 'cli_flag', value: 'guardrail_ack', present: true }
    });
    expect(JSON.stringify(payload)).not.toContain('secret-from-env-file');
    expect(harness.stderr).toBe('');
  });

  it('reports environment-variable provenance for doctor env overrides', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir, SYMPHONY_PORT: '0' };

    const exitCode = await runCommandRouter({ argv: ['doctor', '--json', '--ci'], deps: harness.deps });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(2);
    expect(doctorFinding(payload, 'server.port')).toMatchObject({
      severity: 'pass',
      checkStatus: 'ok',
      source: { category: 'environment_variable', value: 'env', present: true },
      details: { port: 0, source: 'env' }
    });
    expect(harness.stderr).toBe('');
  });

  it('reports generated profile provenance for symphony-internal doctor checks', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    await fs.writeFile(path.join(repoRoot, 'WORKFLOW.md'), VALID_WORKFLOW, 'utf8');
    await fs.writeFile(path.join(repoRoot, '.gitignore'), '.symphony/system/\n', 'utf8');
    const projectRoot = await createDoctorProject();
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({
      argv: ['doctor', '--json', '--profile', 'symphony-internal', '--i-understand-that-this-will-be-running-without-the-usual-guardrails'],
      deps: harness.deps
    });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(0);
    expect(payload.projectContext).toMatchObject({
      projectRoot: repoRoot,
      workflowPath: path.join(repoRoot, 'WORKFLOW.md'),
      profile: 'symphony-internal'
    });
    expect(doctorFinding(payload, 'resolver.workflow')).toMatchObject({
      source: { category: 'generated_profile', value: 'profile', present: true }
    });
    expect(harness.stderr).toBe('');
  });

  it('reports layout checks in doctor human output', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    await fs.writeFile(path.join(projectRoot, '.gitignore'), '.symphony/\n', 'utf8');
    await fs.mkdir(path.join(projectRoot, '.symphony', 'workspaces'), { recursive: true });
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({ argv: ['doctor'], deps: harness.deps });

    expect(exitCode).toBe(2);
    expect(harness.stdout).toContain('Root WORKFLOW.md is canonical');
    expect(harness.stdout).toContain('.symphony/system runtime root is reserved');
    expect(harness.stdout).toContain('.gitignore covers runtime state root');
    expect(harness.stdout).toContain('Broad .symphony/ ignores are not hiding project customization');
    expect(harness.stdout).toContain('Reserved customization paths remain project-owned');
    expect(harness.stdout).toContain('Legacy runtime paths are absent');
    expect(harness.stdout).toContain('broad .symphony/ ignore may hide future project-owned customization');
    expect(harness.stdout).toContain('Found 1 legacy runtime state path');
    expect(harness.stdout).toContain('doctor will not remove broad ignores');
    expect(harness.stdout).toContain('Migrate runtime state to .symphony/system/ manually');
    expect(harness.stderr).toBe('');
  });

  it('emits stable JSON layout findings and warning-only CI exit behavior', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    const setupHarness = createHarness({ repoRoot });
    setupHarness.deps.cwd = projectRoot;
    setupHarness.deps.env = { PATH: binDir };
    expect(await runCommandRouter({ argv: ['setup', '--yes'], deps: setupHarness.deps })).toBe(0);
    await fs.rm(path.join(projectRoot, '.gitignore'));

    const doctorHarness = createHarness({ repoRoot });
    doctorHarness.deps.cwd = projectRoot;
    doctorHarness.deps.env = { PATH: binDir };
    doctorHarness.deps.setupConsentStore = setupHarness.deps.setupConsentStore;

    const exitCode = await runCommandRouter({ argv: ['doctor', '--json', '--ci'], deps: doctorHarness.deps });
    const payload = JSON.parse(doctorHarness.stdout);

    expect(exitCode).toBe(1);
    expect(payload.status).toBe('warning');
    expect(payload.reason).toBe('warnings_present');
    expect(payload.layout.ignoreAnalysis).toMatchObject({
      exists: false,
      status: 'missing',
      hasNarrowSystemIgnore: false
    });
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'layout.gitignore_system',
          status: 'warning',
          reason: 'system_ignore_missing'
        })
      ])
    );
    expect(doctorHarness.stderr).toBe('');
  });

  it('treats invalid layout paths as CI blockers', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    const setupHarness = createHarness({ repoRoot });
    setupHarness.deps.cwd = projectRoot;
    setupHarness.deps.env = { PATH: binDir };
    expect(await runCommandRouter({ argv: ['setup', '--yes'], deps: setupHarness.deps })).toBe(0);
    await fs.writeFile(path.join(projectRoot, '.symphony'), 'not-a-directory\n', 'utf8');

    const doctorHarness = createHarness({ repoRoot });
    doctorHarness.deps.cwd = projectRoot;
    doctorHarness.deps.env = { PATH: binDir };
    doctorHarness.deps.setupConsentStore = setupHarness.deps.setupConsentStore;

    const exitCode = await runCommandRouter({ argv: ['doctor', '--json', '--ci'], deps: doctorHarness.deps });
    const payload = JSON.parse(doctorHarness.stdout);

    expect(exitCode).toBe(2);
    expect(payload.status).toBe('failure');
    expect(payload.reason).toBe('blockers_present');
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'layout.warning.invalid_layout_path',
          status: 'failure',
          reason: 'invalid_layout_path'
        })
      ])
    );
    expect(doctorHarness.stderr).toBe('');
  });

  it('validates doctor workflow config with values loaded from the resolved project env file', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject(ENV_BACKED_LINEAR_WORKFLOW);
    await fs.writeFile(path.join(projectRoot, '.env'), 'DOCTOR_ONLY_LINEAR_TOKEN=secret-from-env-file\n', 'utf8');
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({ argv: ['doctor', '--json'], deps: harness.deps });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(2);
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'workflow.effective_config',
          status: 'ok',
          reason: 'workflow_config_valid'
        }),
        expect.objectContaining({
          id: 'setup.consent',
          status: 'failure',
          reason: 'setup_consent_missing'
        })
      ])
    );
    expect(JSON.stringify(payload)).not.toContain('secret-from-env-file');
    expect(harness.stderr).toBe('');
  });

  it('reports missing link and PATH issues with actionable remediation', async () => {
    const projectRoot = await createDoctorProject();
    const repoRoot = (await createDoctorRepo()).repoRoot;
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-empty-path-'))) };

    const exitCode = await runCommandRouter({ argv: ['doctor'], deps: harness.deps });

    expect(exitCode).toBe(2);
    expect(harness.stdout).toContain('`symphony` was not found on PATH');
    expect(harness.stdout).toContain('npm run link:local');
    expect(harness.stderr).toBe('');
  });

  it('reports stale shim checkout targets and built CLI refresh guidance', async () => {
    const { repoRoot, binDir, shimPath } = await createDoctorRepo();
    const missingRoot = path.join(os.tmpdir(), `symphony-missing-${Date.now()}`);
    await fs.writeFile(
      shimPath,
      [
        '#!/usr/bin/env bash',
        '# symphony-local-shim',
        '# symphony-shim-version: 1',
        `# symphony-repo-root: ${missingRoot}`,
        `# symphony-entrypoint: ${path.join(missingRoot, 'scripts', 'symphony.js')}`,
        'exit 0',
        ''
      ].join('\n'),
      { encoding: 'utf8', mode: 0o755 }
    );
    const projectRoot = await createDoctorProject();
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({ argv: ['doctor'], deps: harness.deps });

    expect(exitCode).toBe(2);
    expect(harness.stdout).toContain('PATH shim points at');
    expect(harness.stdout).toContain('expected');
    expect(harness.stdout).toContain('Checkout does not exist');
    expect(harness.stdout).toContain('Refresh the local link');
  });

  it('keeps doctor --fix --json output parseable when link-local remediation emits text', async () => {
    const { repoRoot, binDir, shimPath } = await createDoctorRepo();
    const missingRoot = path.join(os.tmpdir(), `symphony-missing-${Date.now()}`);
    await fs.writeFile(
      shimPath,
      [
        '#!/usr/bin/env bash',
        '# symphony-local-shim',
        '# symphony-shim-version: 1',
        `# symphony-repo-root: ${missingRoot}`,
        `# symphony-entrypoint: ${path.join(missingRoot, 'scripts', 'symphony.js')}`,
        'exit 0',
        ''
      ].join('\n'),
      { encoding: 'utf8', mode: 0o755 }
    );
    const projectRoot = await createDoctorProject();
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };
    harness.deps.runLinkLocal = async (argv: readonly string[], options?: LinkLocalRunOptions) => {
      harness.linkLocalCalls.push([...argv]);
      (options?.stdout ?? harness.deps.stdout)('Updated Symphony local shim\n');
      return 0;
    };

    const exitCode = await runCommandRouter({
      argv: ['doctor', '--fix', '--yes', '--json'],
      deps: harness.deps
    });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(2);
    expect(harness.stdout).not.toContain('Updated Symphony local shim');
    expect(payload.fixes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'link-local',
          status: 'applied'
        })
      ])
    );
    expect(harness.linkLocalCalls).toEqual([[]]);
    expect(harness.stderr).toBe('');
  });

  it('does not perform doctor fix mutations in CI mode', async () => {
    const { repoRoot } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    await fs.writeFile(path.join(projectRoot, '.gitignore'), '.symphony/\n', 'utf8');
    const emptyBin = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-empty-path-')));
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: emptyBin };

    const exitCode = await runCommandRouter({
      argv: ['doctor', '--fix', '--yes', '--ci', '--json'],
      deps: harness.deps
    });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(2);
    expect(await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8')).toBe('.symphony/\n');
    expect(harness.consent.records()).toEqual([]);
    expect(harness.linkLocalCalls).toEqual([]);
    expect(payload.fixes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'link-local',
          status: 'skipped',
          summary: expect.stringContaining('`--ci` forbids doctor fix mutations')
        }),
        expect.objectContaining({
          id: 'layout.gitignore-system',
          status: 'skipped',
          summary: expect.stringContaining('`--ci` forbids doctor fix mutations')
        }),
        expect.objectContaining({
          id: 'setup-consent',
          status: 'skipped',
          summary: expect.stringContaining('`--ci` forbids doctor fix mutations')
        })
      ])
    );
    expect(payload.exitSemantics.ci).toMatchObject({
      requested: true,
      promptsAllowed: false,
      nonZeroOnBlocker: true
    });
    expect(harness.stderr).toBe('');
  });

  it('reports missing and invalid workflows through the local resolver and config validator', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-no-workflow-')));
    const missingHarness = createHarness({ repoRoot });
    missingHarness.deps.cwd = cwd;
    missingHarness.deps.env = { PATH: binDir };

    expect(await runCommandRouter({ argv: ['doctor'], deps: missingHarness.deps })).toBe(2);
    expect(missingHarness.stdout).toContain('No WORKFLOW.md was found');

    const invalidProject = await createDoctorProject(['---', 'tracker:', '  kind: linear', '---', 'workflow'].join('\n'));
    const invalidHarness = createHarness({ repoRoot });
    invalidHarness.deps.cwd = invalidProject;
    invalidHarness.deps.env = { PATH: binDir };

    expect(await runCommandRouter({ argv: ['doctor'], deps: invalidHarness.deps })).toBe(2);
    expect(invalidHarness.stdout).toContain('tracker.api_key is required after env resolution');
  });

  it('reports fixed port unavailability before dashboard startup', async () => {
    const { server, port } = await listenOnLocalhost();
    try {
      const { repoRoot, binDir } = await createDoctorRepo();
      const projectRoot = await createDoctorProject();
      const harness = createHarness({ repoRoot });
      harness.deps.cwd = projectRoot;
      harness.deps.env = { PATH: binDir };
      expect(await runCommandRouter({ argv: ['setup', '--yes'], deps: harness.deps })).toBe(0);

      const exitCode = await runCommandRouter({ argv: ['doctor', '--port', String(port)], deps: harness.deps });

      expect(exitCode).toBe(2);
      expect(harness.stdout).toContain(`Dashboard cannot bind 127.0.0.1:${port}`);
      expect(harness.stdout).toContain('Choose a different port');
      expect(harness.dashboardCalls).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps doctor --fix bounded to link/setup remediation', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({ argv: ['doctor', '--fix', '--yes'], deps: harness.deps });

    expect(exitCode).toBe(0);
    expect(harness.consent.records()).toHaveLength(1);
    expect(harness.linkLocalCalls).toEqual([]);
    expect(harness.stdout).toContain('[applied] setup-consent');
    expect(harness.dashboardCalls).toEqual([]);
  });

  it('doctor --fix --yes can append the runtime-state gitignore entry without removing broad ignores', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    await fs.writeFile(path.join(projectRoot, '.gitignore'), 'node_modules/\n.symphony/\n.env\n', 'utf8');
    await fs.mkdir(path.join(projectRoot, '.symphony', 'workspaces'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.symphony', 'runtime.sqlite'), 'legacy', 'utf8');
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({ argv: ['doctor', '--fix', '--yes', '--json'], deps: harness.deps });
    const payload = JSON.parse(harness.stdout);
    const gitignore = await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8');

    expect(exitCode).toBe(1);
    expect(gitignore).toBe('node_modules/\n.symphony/\n.env\n.symphony/system/\n');
    expect(payload.fixes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'layout.gitignore-system',
          status: 'applied',
          details: {
            path: '.gitignore',
            pattern: '.symphony/system/'
          }
        }),
        expect.objectContaining({
          id: 'setup-consent',
          status: 'applied'
        })
      ])
    );
    expect(payload.layout.ignoreAnalysis).toMatchObject({
      hasBroadSymphonyIgnore: true,
      hasNarrowSystemIgnore: true
    });
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'layout.broad_symphony_ignore',
          status: 'warning'
        })
      ])
    );
    expect(doctorFinding(payload, 'layout.gitignore_system')).toMatchObject({
      safeFix: {
        available: false,
        mutates: [
          {
            scope: 'project_file',
            path: path.join(projectRoot, '.gitignore'),
            operation: 'append_gitignore_entry'
          }
        ]
      }
    });
    expect(doctorFinding(payload, 'layout.legacy_runtime_paths')).toMatchObject({
      status: 'warning'
    });
    expect(await fs.readFile(path.join(projectRoot, '.symphony', 'runtime.sqlite'), 'utf8')).toBe('legacy');
    await expect(fs.stat(path.join(projectRoot, '.symphony', 'workspaces'))).resolves.toBeTruthy();
    expect(harness.stderr).toBe('');
  });

  it('doctor --fix --yes is idempotent for the runtime-state gitignore entry', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    await fs.writeFile(path.join(projectRoot, '.gitignore'), '.symphony/\n', 'utf8');
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    expect(await runCommandRouter({ argv: ['doctor', '--fix', '--yes', '--json'], deps: harness.deps })).toBe(1);
    const firstGitignore = await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8');
    const secondHarness = createHarness({ repoRoot });
    secondHarness.deps.cwd = projectRoot;
    secondHarness.deps.env = { PATH: binDir };

    expect(await runCommandRouter({ argv: ['doctor', '--fix', '--yes', '--json'], deps: secondHarness.deps })).toBe(1);
    const secondPayload = JSON.parse(secondHarness.stdout);
    const secondGitignore = await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8');

    expect(firstGitignore).toBe('.symphony/\n.symphony/system/\n');
    expect(secondGitignore).toBe(firstGitignore);
    expect(secondPayload.fixes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'layout.gitignore-system',
          status: 'applied'
        })
      ])
    );
    expect(secondPayload.checks.filter((check: { id: string }) => check.id === 'layout.gitignore_system')).toHaveLength(1);
  });

  it('refuses doctor --fix setup consent when local state is inside the project checkout', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    const projectConsentPath = path.join(projectRoot, '.symphony', 'setup-consent.json');
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };
    harness.deps.setupConsentStore = createFileSetupConsentStore(projectConsentPath);

    const exitCode = await runCommandRouter({ argv: ['doctor', '--fix', '--yes', '--json'], deps: harness.deps });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(2);
    expect(payload.status).toBe('failure');
    expect(payload.reason).toBe('blockers_present');
    expect(payload.resolution.consent).toBe('missing');
    expect(payload.fixes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'setup-consent',
          status: 'failed',
          details: { storeLocation: 'project_checkout' }
        })
      ])
    );
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'setup.consent',
          status: 'failure',
          reason: 'setup_consent_missing',
          remediation: expect.stringContaining('outside the project checkout')
        })
      ])
    );
    await expect(fs.access(projectConsentPath)).rejects.toThrow();
    expect(harness.stderr).toBe('');
    expect(harness.dashboardCalls).toEqual([]);
  });

  it('ignores existing setup consent when local state is inside the project checkout', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject();
    const projectConsentPath = path.join(projectRoot, '.symphony', 'setup-consent.json');
    const userConsentPath = path.join(await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-user-state-'))), 'setup-consent.json');
    const setupHarness = createHarness({ repoRoot });
    setupHarness.deps.cwd = projectRoot;
    setupHarness.deps.env = { PATH: binDir };
    setupHarness.deps.setupConsentStore = createFileSetupConsentStore(userConsentPath);

    const setupExitCode = await runCommandRouter({ argv: ['setup', '--yes'], deps: setupHarness.deps });
    await fs.mkdir(path.dirname(projectConsentPath), { recursive: true });
    await fs.copyFile(userConsentPath, projectConsentPath);

    const doctorHarness = createHarness({ repoRoot });
    doctorHarness.deps.cwd = projectRoot;
    doctorHarness.deps.env = { PATH: binDir };
    doctorHarness.deps.setupConsentStore = createFileSetupConsentStore(projectConsentPath);

    const exitCode = await runCommandRouter({ argv: ['doctor', '--json'], deps: doctorHarness.deps });
    const payload = JSON.parse(doctorHarness.stdout);

    expect(setupExitCode).toBe(0);
    expect(exitCode).toBe(2);
    expect(payload.status).toBe('failure');
    expect(payload.reason).toBe('blockers_present');
    expect(payload.resolution.consent).toBe('missing');
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'setup.consent',
          status: 'failure',
          reason: 'setup_consent_missing',
          remediation: expect.stringContaining('outside the project checkout')
        })
      ])
    );
    expect(doctorHarness.stderr).toBe('');
    expect(doctorHarness.dashboardCalls).toEqual([]);
  });

  it('does not treat workflow declarations as doctor setup consent authority', async () => {
    const { repoRoot, binDir } = await createDoctorRepo();
    const projectRoot = await createDoctorProject(
      ['---', 'local_high_trust_consent: true', 'codex:', '  command: codex', '---', 'workflow'].join('\n')
    );
    const harness = createHarness({ repoRoot });
    harness.deps.cwd = projectRoot;
    harness.deps.env = { PATH: binDir };

    const exitCode = await runCommandRouter({ argv: ['doctor', '--json'], deps: harness.deps });
    const payload = JSON.parse(harness.stdout);

    expect(exitCode).toBe(2);
    expect(payload.resolution.consent).toBe('missing');
    expect(doctorFinding(payload, 'setup.consent')).toMatchObject({
      status: 'failure',
      reason: 'setup_consent_missing',
      source: { category: 'user_local_trust_state', present: false }
    });
    expect(harness.consent.records()).toEqual([]);
    expect(harness.stderr).toBe('');
  });

  it('records explicit setup consent in user-local state for the resolved workflow identity', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-setup-')));
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'workflow\n', 'utf8');
    await fs.writeFile(path.join(projectRoot, '.gitignore'), '.symphony/system/\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({ argv: ['setup', '--yes'], deps: harness.deps });

    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain('Symphony setup high-trust consent:');
    expect(harness.stdout).toContain(`project root: ${projectRoot} (project)`);
    expect(harness.stdout).toContain('required posture: high-trust');
    expect(harness.stdout).toContain('Project layout:');
    expect(harness.stdout).toContain('runtime state root: .symphony/system/');
    expect(harness.stdout).toContain('gitignore: narrow-system');
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

  it('setup --yes safely appends a missing runtime-state gitignore entry', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-setup-layout-')));
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'workflow\n', 'utf8');
    await fs.writeFile(path.join(projectRoot, '.gitignore'), 'node_modules/\n.symphony/\n', 'utf8');
    await fs.mkdir(path.join(projectRoot, '.symphony', 'workspaces'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.symphony', 'runtime.sqlite'), 'legacy', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({ argv: ['setup', '--yes'], deps: harness.deps });
    const gitignore = await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8');

    expect(exitCode).toBe(0);
    expect(gitignore).toBe('node_modules/\n.symphony/\n.symphony/system/\n');
    expect(harness.stdout).toContain('[applied] layout.gitignore-system');
    expect(harness.stdout).toContain('warning: A broad .symphony/ ignore hides future project-owned customization paths.');
    expect(await fs.readFile(path.join(projectRoot, '.symphony', 'runtime.sqlite'), 'utf8')).toBe('legacy');
    await expect(fs.stat(path.join(projectRoot, '.symphony', 'workspaces'))).resolves.toBeTruthy();
  });

  it('setup --yes avoids duplicate runtime-state gitignore entries', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-setup-layout-dupe-')));
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'workflow\n', 'utf8');
    await fs.writeFile(path.join(projectRoot, '.gitignore'), '.symphony/system/\n', 'utf8');
    const harness = createHarness();
    harness.deps.cwd = projectRoot;

    const exitCode = await runCommandRouter({ argv: ['setup', '--yes'], deps: harness.deps });
    const gitignore = await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8');

    expect(exitCode).toBe(0);
    expect(gitignore).toBe('.symphony/system/\n');
    expect(harness.stdout).not.toContain('layout.gitignore-system');
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
    expect(harness.stdout).toContain('required posture: high-trust');
    expect(harness.stdout).toContain(
      'reason: workflow effective codex sandbox posture requires danger-full-access local execution'
    );
    expect(harness.stdout).toContain('consent: setup');
  });

  it('does not trust project-contained setup consent for dashboard startup', async () => {
    const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-router-dashboard-project-state-')));
    await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), 'workflow\n', 'utf8');
    const projectStore = createMemoryConsentStore(path.join(projectRoot, '.symphony', 'setup-consent.json'));
    const harness = createHarness();
    harness.deps.cwd = projectRoot;
    harness.deps.setupConsentStore = projectStore.store;

    const setupExit = await runCommandRouter({ argv: ['setup', '--yes'], deps: harness.deps });
    expect(setupExit).toBe(1);
    const resolved = resolveLocalCommand({
      command: 'dashboard',
      argv: ['--port=0'],
      cwd: projectRoot,
      env: harness.deps.env,
      symphonyCheckoutRoot: harness.deps.repoRoot
    });
    persistSetupConsent(
      projectStore.store,
      buildSetupConsentRecord({
        resolved,
        posture: HIGH_TRUST_POSTURE,
        approvedAt: '2026-05-24T20:00:00.000Z'
      })
    );

    const exitCode = await runCommandRouter({ argv: ['dashboard', '--port=0'], deps: harness.deps });

    expect(exitCode).toBe(27);
    expect(projectStore.records()).toHaveLength(1);
    expect(harness.dashboardCalls.at(-1)).not.toContain('--i-understand-that-this-will-be-running-without-the-usual-guardrails');
    expect(harness.stdout).toContain('consent: missing');
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
    expect(harness.stdout).toContain('required posture: high-trust');
    expect(harness.stdout).toContain(
      'reason: workflow effective codex sandbox posture requires danger-full-access local execution'
    );
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
