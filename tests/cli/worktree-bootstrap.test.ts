import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/worktree_bootstrap.py');

function run(cmd: string, args: string[], cwd: string): void {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}

function runBootstrap(args: string[], cwd: string) {
  return spawnSync('python3', [SCRIPT_PATH, ...args], {
    cwd,
    encoding: 'utf8'
  });
}

describe('worktree_bootstrap.py', () => {
  it('auto-resolves source from sibling worktree when --source is omitted', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-worktree-bootstrap-'));
    const primary = path.join(root, 'primary');
    const target = path.join(root, 'target');
    fs.mkdirSync(primary, { recursive: true });

    run('git', ['init'], primary);
    run('git', ['config', 'user.email', 'test@example.com'], primary);
    run('git', ['config', 'user.name', 'Test User'], primary);
    run('git', ['checkout', '-b', 'main'], primary);
    fs.writeFileSync(path.join(primary, '.gitignore'), '.cache/\n');
    fs.writeFileSync(path.join(primary, '.worktreeinclude'), '.cache/**\n');
    fs.writeFileSync(path.join(primary, 'README.md'), 'root\n');
    run('git', ['add', '.gitignore', '.worktreeinclude', 'README.md'], primary);
    run('git', ['commit', '-m', 'init'], primary);

    fs.mkdirSync(path.join(primary, '.cache'), { recursive: true });
    fs.writeFileSync(path.join(primary, '.cache', 'artifact.txt'), 'hello\n');

    run('git', ['worktree', 'add', target, '-b', 'feature/NIE-BOOTSTRAP'], primary);

    const result = runBootstrap(['--allow-sensitive'], target);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(target, '.cache', 'artifact.txt'))).toBe(true);
  });

  it('uses current working directory as default target', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-worktree-bootstrap-'));
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(target, { recursive: true });

    run('git', ['init'], source);
    run('git', ['config', 'user.email', 'test@example.com'], source);
    run('git', ['config', 'user.name', 'Test User'], source);

    fs.writeFileSync(path.join(source, '.gitignore'), '.cache/\n');
    fs.mkdirSync(path.join(source, '.cache'), { recursive: true });
    fs.writeFileSync(path.join(source, '.cache', 'artifact.txt'), 'hello\n');
    fs.writeFileSync(path.join(source, '.worktreeinclude'), '.cache/**\n');

    run('git', ['init'], target);
    run('git', ['config', 'user.email', 'test@example.com'], target);
    run('git', ['config', 'user.name', 'Test User'], target);

    const result = runBootstrap(['--source', source], target);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(target, '.cache', 'artifact.txt'))).toBe(true);
  });

  it('does not overcount copied files when destination already exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-worktree-bootstrap-'));
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(target, { recursive: true });

    run('git', ['init'], source);
    run('git', ['config', 'user.email', 'test@example.com'], source);
    run('git', ['config', 'user.name', 'Test User'], source);

    fs.writeFileSync(path.join(source, '.gitignore'), '.cache/\n');
    fs.mkdirSync(path.join(source, '.cache'), { recursive: true });
    fs.writeFileSync(path.join(source, '.cache', 'artifact.txt'), 'hello\n');
    fs.writeFileSync(path.join(source, '.worktreeinclude'), '.cache/**\n');

    run('git', ['init'], target);
    run('git', ['config', 'user.email', 'test@example.com'], target);
    run('git', ['config', 'user.name', 'Test User'], target);

    fs.mkdirSync(path.join(target, '.cache'), { recursive: true });
    fs.writeFileSync(path.join(target, '.cache', 'artifact.txt'), 'existing\n');

    const result = runBootstrap(['--source', source, '--target', target], root);
    expect(result.status).toBe(0);

    const summaryLine = result.stdout
      .trim()
      .split('\n')
      .find((line) => {
        try {
          const parsed = JSON.parse(line) as { action?: string; selected?: number };
          return parsed.action === 'summary' && typeof parsed.selected === 'number';
        } catch {
          return false;
        }
      });

    expect(summaryLine).toBeTruthy();
    const summary = JSON.parse(summaryLine as string) as { copied: number; selected: number };
    expect(summary.selected).toBe(1);
    expect(summary.copied).toBe(0);
  });
});
