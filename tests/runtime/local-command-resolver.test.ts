import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveLocalCommand, LocalCommandResolutionError } from '../../src/runtime/local-command-resolver';

async function makeProject(name: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `symphony-${name}-`));
  await fs.writeFile(path.join(root, 'WORKFLOW.md'), `# ${name}\n`, 'utf8');
  return fs.realpath(root);
}

describe('local command resolver', () => {
  it('defaults nested project cwd to the nearest project WORKFLOW.md and project .env', async () => {
    const projectRoot = await makeProject('resolver-default');
    const nestedCwd = path.join(projectRoot, 'src', 'feature');
    await fs.mkdir(nestedCwd, { recursive: true });

    const resolved = resolveLocalCommand({
      command: 'dashboard',
      argv: [],
      cwd: nestedCwd,
      env: {},
      symphonyCheckoutRoot: projectRoot
    });

    expect(resolved.currentProjectRoot).toBe(projectRoot);
    expect(resolved.workflowPath).toBe(path.join(projectRoot, 'WORKFLOW.md'));
    expect(resolved.envFilePath).toBe(path.join(projectRoot, '.env'));
    expect(resolved.host).toEqual({ host: '127.0.0.1', source: 'default' });
    expect(resolved.port).toEqual({ port: 0, source: 'default' });
    expect(resolved.sources).toMatchObject({
      projectRoot: 'project',
      workflowPath: 'project',
      envFilePath: 'project'
    });
    expect(resolved.projectIdentity.project_root).toBe(projectRoot);
    expect(resolved.projectIdentity.workflow_path).toBe(path.join(projectRoot, 'WORKFLOW.md'));
  });

  it('uses explicit workflow over cwd default and normalizes relative paths', async () => {
    const projectRoot = await makeProject('resolver-explicit');
    const nestedCwd = path.join(projectRoot, 'nested');
    await fs.mkdir(nestedCwd, { recursive: true });
    const explicitDir = path.join(projectRoot, 'alternate');
    await fs.mkdir(explicitDir);
    const explicitWorkflow = path.join(explicitDir, 'WORKFLOW.md');
    await fs.writeFile(explicitWorkflow, 'alternate\n', 'utf8');

    const resolved = resolveLocalCommand({
      command: 'dashboard',
      argv: ['--workflow', '../alternate/WORKFLOW.md'],
      cwd: nestedCwd,
      env: {},
      symphonyCheckoutRoot: projectRoot
    });

    expect(resolved.workflowPath).toBe(explicitWorkflow);
    expect(resolved.sources.workflowPath).toBe('cli');
    expect(resolved.dashboardArgv).toContain(`--workflow=${explicitWorkflow}`);
  });

  it('keeps absolute workflow paths stable in identity collisions', async () => {
    const projectA = await makeProject('resolver-collision-a');
    const projectB = await makeProject('resolver-collision-b');

    const first = resolveLocalCommand({
      command: 'dashboard',
      argv: ['--workflow', path.join(projectA, 'WORKFLOW.md')],
      cwd: projectA,
      env: {},
      symphonyCheckoutRoot: projectA
    });
    const second = resolveLocalCommand({
      command: 'dashboard',
      argv: ['--workflow', path.join(projectB, 'WORKFLOW.md')],
      cwd: projectB,
      env: {},
      symphonyCheckoutRoot: projectA
    });

    expect(first.projectIdentity.key).not.toBe(second.projectIdentity.key);
  });

  it('resolves env file, host, and port with deterministic override precedence', async () => {
    const projectRoot = await makeProject('resolver-env-port');
    const envFile = path.join(projectRoot, 'custom.env');
    await fs.writeFile(envFile, 'SYMPHONY_HOST=192.0.2.10\nSYMPHONY_PORT=5111\n', 'utf8');

    const fromEnvFile = resolveLocalCommand({
      command: 'dashboard',
      argv: ['--env-file', envFile],
      cwd: projectRoot,
      env: {},
      symphonyCheckoutRoot: projectRoot
    });
    expect(fromEnvFile.host).toEqual({ host: '192.0.2.10', source: 'env' });
    expect(fromEnvFile.port).toEqual({ port: 5111, source: 'env' });

    const resolved = resolveLocalCommand({
      command: 'dashboard',
      argv: ['--env-file', envFile, '--host=0.0.0.0', '--port', '0'],
      cwd: projectRoot,
      env: {
        SYMPHONY_ENV_FILE: path.join(projectRoot, 'env.env'),
        SYMPHONY_HOST: 'localhost',
        SYMPHONY_PORT: '4123'
      },
      symphonyCheckoutRoot: projectRoot
    });

    expect(resolved.envFilePath).toBe(envFile);
    expect(resolved.sources.envFilePath).toBe('cli');
    expect(resolved.host).toEqual({ host: '0.0.0.0', source: 'cli' });
    expect(resolved.port).toEqual({ port: 0, source: 'cli' });
  });

  it('normalizes symlinked project roots to a stable real path', async () => {
    const projectRoot = await makeProject('resolver-symlink-target');
    const linkParent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-link-parent-')));
    const linkRoot = path.join(linkParent, 'project-link');
    await fs.symlink(projectRoot, linkRoot, 'dir');

    const resolved = resolveLocalCommand({
      command: 'dashboard',
      argv: [],
      cwd: linkRoot,
      env: {},
      symphonyCheckoutRoot: projectRoot
    });

    expect(resolved.currentProjectRoot).toBe(projectRoot);
    expect(resolved.workflowPath).toBe(path.join(projectRoot, 'WORKFLOW.md'));
    expect(resolved.projectIdentity.project_root).toBe(projectRoot);
  });

  it('resolves symphony-internal to the checked-in checkout workflow', async () => {
    const projectRoot = await makeProject('resolver-project');
    const checkoutRoot = await makeProject('resolver-checkout');

    const resolved = resolveLocalCommand({
      command: 'dashboard',
      argv: ['--profile', 'symphony-internal'],
      cwd: projectRoot,
      env: {},
      symphonyCheckoutRoot: checkoutRoot
    });

    expect(resolved.profile).toEqual({ name: 'symphony-internal', source: 'cli' });
    expect(resolved.currentProjectRoot).toBe(checkoutRoot);
    expect(resolved.workflowPath).toBe(path.join(checkoutRoot, 'WORKFLOW.md'));
    expect(resolved.sources.workflowPath).toBe('profile');
  });

  it('reports missing workflow, unreadable workflow, invalid profile, and invalid port with actionable errors', async () => {
    const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-missing-'));

    expect(() =>
      resolveLocalCommand({
        command: 'dashboard',
        argv: [],
        cwd: emptyRoot,
        env: {},
        symphonyCheckoutRoot: emptyRoot
      })
    ).toThrow(/No WORKFLOW.md was found/);

    expect(() =>
      resolveLocalCommand({
        command: 'dashboard',
        argv: ['--profile', 'unknown'],
        cwd: emptyRoot,
        env: {},
        symphonyCheckoutRoot: emptyRoot
      })
    ).toThrow(/Supported profiles: project, symphony-internal/);

    const portRoot = await makeProject('resolver-invalid-port');
    for (const argv of [
      ['--port', 'NaN'],
      ['--port', '-1']
    ]) {
      expect(() =>
        resolveLocalCommand({
          command: 'dashboard',
          argv,
          cwd: portRoot,
          env: {},
          symphonyCheckoutRoot: portRoot
        })
      ).toThrow(/must be a non-negative integer/);
    }

    expect(() =>
      resolveLocalCommand({
        command: 'dashboard',
        argv: ['--port'],
        cwd: portRoot,
        env: {},
        symphonyCheckoutRoot: portRoot
      })
    ).toThrow(/requires a value/);

    expect(() =>
      resolveLocalCommand({
        command: 'dashboard',
        argv: ['--port', '--host', '127.0.0.1'],
        cwd: portRoot,
        env: {},
        symphonyCheckoutRoot: portRoot
      })
    ).toThrow(/requires a value/);

    const unreadableRoot = await makeProject('resolver-unreadable');
    const unreadableWorkflow = path.join(unreadableRoot, 'WORKFLOW.md');
    try {
      await fs.chmod(unreadableWorkflow, 0o000);
      expect(() =>
        resolveLocalCommand({
          command: 'dashboard',
          argv: ['--workflow', unreadableWorkflow],
          cwd: unreadableRoot,
          env: {},
          symphonyCheckoutRoot: unreadableRoot
        })
      ).toThrow(/Workflow file is not readable/);
    } finally {
      await fs.chmod(unreadableWorkflow, 0o600);
    }
  });

  it('rejects ambiguous ancestor project roots unless workflow is explicit', async () => {
    const outerRoot = await makeProject('resolver-outer');
    const innerRoot = path.join(outerRoot, 'nested');
    await fs.mkdir(innerRoot);
    await fs.writeFile(path.join(innerRoot, 'WORKFLOW.md'), 'inner\n', 'utf8');
    const cwd = path.join(innerRoot, 'src');
    await fs.mkdir(cwd);

    expect(() =>
      resolveLocalCommand({
        command: 'dashboard',
        argv: [],
        cwd,
        env: {},
        symphonyCheckoutRoot: outerRoot
      })
    ).toThrow(LocalCommandResolutionError);

    const resolved = resolveLocalCommand({
      command: 'dashboard',
      argv: ['--workflow', path.join(innerRoot, 'WORKFLOW.md')],
      cwd,
      env: {},
      symphonyCheckoutRoot: outerRoot
    });
    expect(resolved.currentProjectRoot).toBe(innerRoot);
  });
});
