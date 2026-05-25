import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const doctorScript = path.join(repoRoot, 'scripts', 'symphony.js');
const guardrailFlag = '--i-understand-that-this-will-be-running-without-the-usual-guardrails';

const MATRIX = [
  { scenario: 'missing-workflow', stories: [1], mode: 'blocker' },
  { scenario: 'invalid-workflow-syntax', stories: [2], mode: 'blocker' },
  { scenario: 'resolved-config-failure', stories: [3], mode: 'blocker' },
  { scenario: 'missing-env-tracker-credential', stories: [4, 5], mode: 'blocker' },
  { scenario: 'codex-command-unavailable', stories: [6], mode: 'blocker' },
  { scenario: 'workspace-clean-base-ready', stories: [7, 8, 9, 20], mode: 'pass' },
  { scenario: 'workspace-base-ref-and-dirty-policy', stories: [8, 9], mode: 'blocker' },
  { scenario: 'fixed-port-unavailable', stories: [10], mode: 'blocker' },
  { scenario: 'setup-consent-fix-json', stories: [11, 12, 17], mode: 'pass' },
  { scenario: 'layout-customization-ci-provenance', stories: [13, 14, 15, 16, 18, 19], mode: 'warning' },
  { scenario: 'project-local-consent-rejected', stories: [11], mode: 'blocker' }
] as const;

interface DoctorCliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  json: {
    status: string;
    reason: string;
    exitCode: number;
    resolution: Record<string, unknown>;
    checks: Array<{
      id: string;
      status: string;
      reason: string;
      details?: Record<string, unknown>;
    }>;
    fixes: Array<{ id: string; status: string; details?: Record<string, unknown> }>;
    layout: null | {
      legacyRuntimePaths: Array<Record<string, unknown>>;
      ignoreAnalysis: Record<string, unknown>;
      reservedCustomizationPaths: Array<Record<string, unknown>>;
    };
  };
}

beforeAll(() => {
  execFileSync('npm', ['run', 'build', '--silent'], { cwd: repoRoot, stdio: 'pipe' });
}, 120_000);

async function makeTempDir(prefix: string): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function createBin(options: { includeCodex?: boolean } = {}): Promise<string> {
  const binDir = await makeTempDir('symphony-doctor-matrix-bin-');
  await fs.writeFile(
    path.join(binDir, 'symphony'),
    [
      '#!/usr/bin/env bash',
      '# symphony-local-shim',
      '# symphony-shim-version: 1',
      `# symphony-repo-root: ${repoRoot}`,
      `# symphony-entrypoint: ${doctorScript}`,
      'exit 0',
      ''
    ].join('\n'),
    { encoding: 'utf8', mode: 0o755 }
  );
  if (options.includeCodex !== false) {
    await fs.writeFile(path.join(binDir, 'codex'), '#!/usr/bin/env bash\nexit 0\n', { encoding: 'utf8', mode: 0o755 });
  }
  return binDir;
}

async function createProject(workflow: string): Promise<string> {
  const projectRoot = await makeTempDir('symphony-doctor-matrix-project-');
  await fs.writeFile(path.join(projectRoot, 'WORKFLOW.md'), workflow, 'utf8');
  await fs.writeFile(path.join(projectRoot, '.gitignore'), '.symphony/system/\n', 'utf8');
  return projectRoot;
}

function memoryWorkflow(extra = ''): string {
  return ['---', 'tracker:', '  kind: memory', 'codex:', '  command: codex', extra, '---', 'workflow']
    .filter((line) => line.length > 0)
    .join('\n');
}

function worktreeWorkflow(gitRoot: string, options: { baseRef?: string; allowDirtyRepo?: boolean } = {}): string {
  return [
    '---',
    'tracker:',
    '  kind: memory',
    'codex:',
    '  command: codex',
    '  thread_sandbox: danger-full-access',
    '  turn_sandbox_policy: danger-full-access',
    'workspace:',
    '  provisioner:',
    '    type: worktree',
    `    repo_root: ${JSON.stringify(gitRoot)}`,
    `    base_ref: ${options.baseRef ?? 'origin/main'}`,
    '    branch_template: "feature/{{ issue.identifier }}"',
    '    teardown_mode: remove_worktree',
    `    allow_dirty_repo: ${options.allowDirtyRepo ?? false}`,
    '---',
    'workflow'
  ].join('\n');
}

async function createGitRepo(options: { dirty?: boolean } = {}): Promise<string> {
  const gitRoot = await makeTempDir('symphony-doctor-matrix-git-');
  execFileSync('git', ['init', '-b', 'main'], { cwd: gitRoot, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'doctor@example.test'], { cwd: gitRoot, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Doctor Matrix'], { cwd: gitRoot, stdio: 'pipe' });
  await fs.writeFile(path.join(gitRoot, 'README.md'), 'doctor matrix\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: gitRoot, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: gitRoot, stdio: 'pipe' });
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: gitRoot, stdio: 'pipe' });
  if (options.dirty) {
    await fs.writeFile(path.join(gitRoot, 'dirty.txt'), 'dirty\n', 'utf8');
  }
  return gitRoot;
}

function runDoctor(projectRoot: string, argv: string[] = [], env: Record<string, string> = {}): DoctorCliResult {
  const binDir = env.PATH?.split(path.delimiter)[0] ?? fsSync.mkdtempSync(path.join(os.tmpdir(), 'unused-bin-'));
  const stateHome = fsSync.mkdtempSync(path.join(os.tmpdir(), 'symphony-doctor-matrix-state-'));
  const { PATH: _pathOverride, ...extraEnv } = env;
  const baseEnv = { ...process.env };
  for (const key of [
    'SYMPHONY_WORKFLOW_PATH',
    'SYMPHONY_ENV_FILE',
    'SYMPHONY_PROFILE',
    'SYMPHONY_HOST',
    'SYMPHONY_PORT'
  ]) {
    delete baseEnv[key];
  }
  const child = spawnSync(process.execPath, [doctorScript, 'doctor', '--json', ...argv], {
    cwd: projectRoot,
    env: {
      ...baseEnv,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      SYMPHONY_LOCAL_STATE_HOME: stateHome,
      ...extraEnv
    },
    encoding: 'utf8'
  });
  return {
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    json: JSON.parse(child.stdout)
  };
}

function check(payload: DoctorCliResult['json'], id: string) {
  const found = payload.checks.find((item) => item.id === id);
  expect(found, `missing doctor check ${id}`).toBeTruthy();
  return found!;
}

describe('Doctor MVP real CLI scenario matrix', () => {
  it('maps every Doctor MVP story to an executable scenario', () => {
    expect(new Set(MATRIX.flatMap((entry) => entry.stories))).toEqual(new Set(Array.from({ length: 20 }, (_, index) => index + 1)));
    expect(MATRIX.map((entry) => entry.scenario)).toEqual([
      'missing-workflow',
      'invalid-workflow-syntax',
      'resolved-config-failure',
      'missing-env-tracker-credential',
      'codex-command-unavailable',
      'workspace-clean-base-ready',
      'workspace-base-ref-and-dirty-policy',
      'fixed-port-unavailable',
      'setup-consent-fix-json',
      'layout-customization-ci-provenance',
      'project-local-consent-rejected'
    ]);
  });

  it('executes blocker/pass/warning scenarios through scripts/symphony.js doctor', async () => {
    const binDir = await createBin();
    const noWorkflow = await makeTempDir('symphony-doctor-matrix-empty-');
    const missingWorkflow = runDoctor(noWorkflow, [], { PATH: binDir });
    expect(missingWorkflow.status).toBe(2);
    expect(check(missingWorkflow.json, 'resolver.workflow')).toMatchObject({ status: 'failure', reason: 'missing_workflow' });

    const invalidProject = await createProject(['---', 'tracker: [', '---', 'workflow'].join('\n'));
    const invalidWorkflow = runDoctor(invalidProject, [], { PATH: binDir });
    expect(invalidWorkflow.status).toBe(2);
    expect(check(invalidWorkflow.json, 'workflow.effective_config')).toMatchObject({
      status: 'failure',
      reason: 'workflow_parse_error'
    });

    const invalidConfig = await createProject(['---', 'tracker:', '  kind: memory', 'codex:', '  command: ""', '---', 'workflow'].join('\n'));
    const resolvedConfig = runDoctor(invalidConfig, [], { PATH: binDir });
    expect(resolvedConfig.status).toBe(2);
    expect(check(resolvedConfig.json, 'workflow.effective_config')).toMatchObject({
      status: 'failure',
      reason: 'missing_codex_command'
    });

    const missingEnv = await createProject(
      ['---', 'tracker:', '  kind: linear', '  api_key: $DOCTOR_MATRIX_LINEAR_TOKEN', '  project_slug: DEMO', 'codex:', '  command: codex', '---', 'workflow'].join('\n')
    );
    const missingCredential = runDoctor(missingEnv, [], { PATH: binDir });
    expect(missingCredential.status).toBe(2);
    expect(check(missingCredential.json, 'workflow.effective_config')).toMatchObject({
      status: 'failure',
      reason: 'missing_tracker_api_key'
    });

    const noCodexBin = await createBin({ includeCodex: false });
    const codexProject = await createProject(
      ['---', 'tracker:', '  kind: memory', 'codex:', '  command: missing-doctor-matrix-codex', '---', 'workflow'].join('\n')
    );
    const codexMissing = runDoctor(codexProject, [], { PATH: noCodexBin });
    expect(codexMissing.status).toBe(2);
    expect(check(codexMissing.json, 'codex.command')).toMatchObject({ status: 'failure', reason: 'codex_command_missing' });

    const gitRoot = await createGitRepo();
    const workspaceProject = await createProject(worktreeWorkflow(gitRoot));
    const workspaceReady = runDoctor(workspaceProject, [guardrailFlag], { PATH: binDir });
    expect(workspaceReady.status).toBe(0);
    expect(check(workspaceReady.json, 'workspace.git_repository')).toMatchObject({ status: 'ok', reason: 'repo_root_git_repository' });
    expect(check(workspaceReady.json, 'workspace.worktree')).toMatchObject({ status: 'ok', reason: 'worktree_list_ready' });
    expect(check(workspaceReady.json, 'workspace.base_ref')).toMatchObject({ status: 'ok', reason: 'base_ref_exists' });
    expect(check(workspaceReady.json, 'workspace.dirty_policy')).toMatchObject({ status: 'ok', reason: 'repo_clean' });

    const dirtyGitRoot = await createGitRepo({ dirty: true });
    const dirtyProject = await createProject(worktreeWorkflow(dirtyGitRoot, { baseRef: 'origin/not-present' }));
    const dirtyBlocked = runDoctor(dirtyProject, [guardrailFlag], { PATH: binDir });
    expect(dirtyBlocked.status).toBe(2);
    expect(check(dirtyBlocked.json, 'workspace.base_ref')).toMatchObject({ status: 'failure', reason: 'base_ref_unavailable' });
    expect(check(dirtyBlocked.json, 'workspace.dirty_policy')).toMatchObject({ status: 'failure', reason: 'dirty_repo_blocked' });
  });

  it('covers ports, fixes, layout warnings, provenance, severity, and local consent rejection', async () => {
    const binDir = await createBin();
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected TCP address');
    }
    try {
      const portProject = await createProject(memoryWorkflow());
      const portBlocked = runDoctor(portProject, ['--port', String(address.port), guardrailFlag], { PATH: binDir });
      expect(portBlocked.status).toBe(2);
      expect(check(portBlocked.json, 'server.port')).toMatchObject({ status: 'failure', reason: 'port_unavailable' });
      expect(check(portBlocked.json, 'server.port').details).toMatchObject({ source: 'cli' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const fixProject = await createProject(memoryWorkflow());
    const fixed = runDoctor(fixProject, ['--fix', '--yes'], { PATH: binDir });
    expect(fixed.status).toBe(0);
    expect(fixed.stdout).not.toContain('Updated Symphony local shim');
    expect(fixed.json.fixes).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'setup-consent', status: 'applied' })]));
    expect(check(fixed.json, 'setup.consent')).toMatchObject({ status: 'ok', reason: 'setup_consent_setup' });

    const layoutProject = await createProject(memoryWorkflow());
    await fs.writeFile(path.join(layoutProject, '.gitignore'), '.symphony/\n', 'utf8');
    await fs.mkdir(path.join(layoutProject, '.symphony', 'workspaces'), { recursive: true });
    await fs.mkdir(path.join(layoutProject, '.symphony', 'skills'), { recursive: true });
    const layoutWarning = runDoctor(layoutProject, ['--ci', guardrailFlag], { PATH: binDir });
    expect(layoutWarning.status).toBe(1);
    expect(layoutWarning.json.status).toBe('warning');
    expect(layoutWarning.json.reason).toBe('warnings_present');
    expect(check(layoutWarning.json, 'layout.broad_symphony_ignore')).toMatchObject({
      status: 'warning',
      reason: 'broad_symphony_ignore_present'
    });
    expect(check(layoutWarning.json, 'layout.legacy_runtime_paths')).toMatchObject({
      status: 'warning',
      reason: 'legacy_runtime_paths_present'
    });
    expect(layoutWarning.json.layout?.reservedCustomizationPaths).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: '.symphony/skills', owner: 'project-customization', exists: true })])
    );
    expect(check(layoutWarning.json, 'resolver.workflow').details).toMatchObject({ workflowSource: 'project' });
    expect(check(layoutWarning.json, 'env.path').details).toMatchObject({ source: 'project' });

    const projectConsent = await createProject(memoryWorkflow());
    const projectStateHome = path.join(projectConsent, '.symphony');
    const rejected = runDoctor(projectConsent, ['--fix', '--yes'], {
      PATH: binDir,
      SYMPHONY_LOCAL_STATE_HOME: projectStateHome
    });
    expect(rejected.status).toBe(2);
    expect(rejected.json.resolution.consent).toBe('missing');
    expect(rejected.json.fixes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'setup-consent', status: 'failed', details: { storeLocation: 'project_checkout' } })
      ])
    );
    await expect(fs.access(path.join(projectStateHome, 'setup-consent.json'))).rejects.toThrow();
  });
});
