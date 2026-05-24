import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LOCAL_SHIM_MARKER, runLocalLinkCommand, type LocalLinkDependencies } from '../../src/runtime/local-link';

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-local-link-'));
  tempRoots.push(root);
  return root;
}

function createRepo(root = createTempRoot()): string {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'symphony.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
  return root;
}

function createHarness(
  overrides: {
    repoRoot?: string;
    home?: string;
    env?: NodeJS.ProcessEnv;
    run?: LocalLinkDependencies['run'];
    writeFileAtomic?: LocalLinkDependencies['writeFileAtomic'];
  } = {}
) {
  const repoRoot = overrides.repoRoot ?? createRepo();
  const home = overrides.home ?? createTempRoot();
  let stdout = '';
  let stderr = '';
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const run: LocalLinkDependencies['run'] =
    overrides.run ??
    ((command, args) => {
      calls.push({ command, args });
      if (command === 'npm' && args.join(' ') === 'run build') {
        return { status: 0, stdout: 'built\n', stderr: '' };
      }
      if (command === process.execPath && args[0] === path.join(repoRoot, 'scripts', 'symphony.js')) {
        return { status: 0, stdout: '0.1.0\n', stderr: '' };
      }
      if (command.endsWith('symphony') && args[0] === '--version') {
        return { status: 0, stdout: '0.1.0\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected command ${command} ${args.join(' ')}` };
    });

  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    calls,
    home,
    repoRoot,
    deps: {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
      repoRoot,
      env: {
        PATH: path.join(home, '.local', 'bin'),
        SHELL: '/bin/zsh',
        ...overrides.env
      },
      platform: 'darwin' as const,
      homedir: () => home,
      run,
      writeFileAtomic: overrides.writeFileAtomic
    }
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('local checkout linking', () => {
  it('creates ~/.local/bin, writes an executable Symphony-owned shim, and verifies version', async () => {
    const harness = createHarness();

    const exitCode = await runLocalLinkCommand({ argv: [], deps: harness.deps });

    const shimPath = path.join(harness.home, '.local', 'bin', 'symphony');
    expect(exitCode).toBe(0);
    expect(fs.existsSync(path.dirname(shimPath))).toBe(true);
    expect(fs.statSync(shimPath).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(shimPath, 'utf8')).toContain(`# ${LOCAL_SHIM_MARKER}`);
    expect(fs.readFileSync(shimPath, 'utf8')).toContain(`# symphony-repo-root: ${harness.repoRoot}`);
    expect(harness.calls.map((call) => [call.command, call.args])).toEqual([
      ['npm', ['run', 'build']],
      [process.execPath, [path.join(harness.repoRoot, 'scripts', 'symphony.js'), '--version']],
      [shimPath, ['--version']]
    ]);
    expect(harness.stdout).toContain(`Linked Symphony local shim: ${shimPath}`);
    expect(harness.stdout).toContain('Update: rerun `npm run link:local` from this checkout.');
    expect(harness.stdout).toContain(`Unlink: rm '${shimPath}'`);
    expect(harness.stderr).toBe('');
  });

  it('re-running updates a stale Symphony-owned shim safely', async () => {
    const harness = createHarness();
    const shimPath = path.join(harness.home, '.local', 'bin', 'symphony');
    fs.mkdirSync(path.dirname(shimPath), { recursive: true });
    fs.writeFileSync(
      shimPath,
      ['#!/usr/bin/env bash', `# ${LOCAL_SHIM_MARKER}`, '# symphony-repo-root: /old/checkout', 'exit 0', ''].join('\n'),
      { mode: 0o755 }
    );

    const exitCode = await runLocalLinkCommand({ argv: [], deps: harness.deps });

    expect(exitCode).toBe(0);
    expect(fs.readFileSync(shimPath, 'utf8')).toContain(`# symphony-repo-root: ${harness.repoRoot}`);
    expect(fs.readFileSync(shimPath, 'utf8')).not.toContain('/old/checkout');
    expect(harness.stdout).toContain(`Updated Symphony local shim: ${shimPath}`);
  });

  it('refuses to overwrite a non-Symphony executable target', async () => {
    const harness = createHarness();
    const shimPath = path.join(harness.home, '.local', 'bin', 'symphony');
    fs.mkdirSync(path.dirname(shimPath), { recursive: true });
    fs.writeFileSync(shimPath, '#!/usr/bin/env bash\necho other\n', { mode: 0o755 });

    const exitCode = await runLocalLinkCommand({ argv: [], deps: harness.deps });

    expect(exitCode).toBe(1);
    expect(harness.calls).toEqual([]);
    expect(harness.stderr).toContain('Refusing to overwrite existing non-Symphony executable');
    expect(harness.stderr).toContain('choose a different target with `--target <path>`');
  });

  it('reports shell-specific PATH guidance without failing the link', async () => {
    const harness = createHarness({
      env: {
        PATH: '/usr/bin:/bin',
        SHELL: '/bin/zsh'
      }
    });

    const exitCode = await runLocalLinkCommand({ argv: [], deps: harness.deps });

    const binDir = path.join(harness.home, '.local', 'bin');
    expect(exitCode).toBe(0);
    expect(harness.stdout).toContain(`${binDir} is not on PATH`);
    expect(harness.stdout).toContain(`echo 'export PATH="${binDir}:$PATH"' >> ~/.zshrc && source ~/.zshrc`);
  });

  it('removes temporary files when atomic shim writing fails', async () => {
    const harness = createHarness({
      writeFileAtomic: (targetPath, content) => {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(`${targetPath}.tmp`, content);
        fs.rmSync(`${targetPath}.tmp`, { force: true });
        throw new Error('disk full');
      }
    });

    const exitCode = await runLocalLinkCommand({ argv: [], deps: harness.deps });

    const shimPath = path.join(harness.home, '.local', 'bin', 'symphony');
    expect(exitCode).toBe(1);
    expect(fs.existsSync(shimPath)).toBe(false);
    expect(fs.existsSync(`${shimPath}.tmp`)).toBe(false);
    expect(harness.stderr).toContain('Failed to write Symphony shim atomically: disk full');
  });

  it('does not claim success when linked shim version verification fails', async () => {
    const harness = createHarness({
      run: (command, args) => {
        if (command === 'npm') {
          return { status: 0, stdout: '', stderr: '' };
        }
        if (command === process.execPath) {
          return { status: 0, stdout: '0.1.0\n', stderr: '' };
        }
        if (command.endsWith('symphony') && args[0] === '--version') {
          return { status: 42, stdout: '', stderr: 'bad shim' };
        }
        return { status: 1, stdout: '', stderr: 'unexpected' };
      }
    });

    const exitCode = await runLocalLinkCommand({ argv: [], deps: harness.deps });

    expect(exitCode).toBe(1);
    expect(harness.stderr).toContain('Failed to verify linked Symphony shim: bad shim');
    expect(harness.stdout).toBe('');
  });

  it('supports custom targets for temporary-directory validation', async () => {
    const harness = createHarness();
    const targetPath = path.join(createTempRoot(), 'bin', 'custom-symphony');

    const exitCode = await runLocalLinkCommand({
      argv: ['--target', targetPath],
      deps: harness.deps
    });

    expect(exitCode).toBe(0);
    expect(fs.readFileSync(targetPath, 'utf8')).toContain(`# symphony-repo-root: ${harness.repoRoot}`);
    expect(harness.stdout).toContain(`Linked Symphony local shim: ${targetPath}`);
  });
});
