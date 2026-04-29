import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { copyIgnoredArtifacts } from '../../src/workspace/copy-ignored';

function makeRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'symphony-copy-ignored-'));
  execSync('git init', { cwd: root, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: root, stdio: 'ignore' });
  execSync('git config user.name "Test User"', { cwd: root, stdio: 'ignore' });
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

describe('copyIgnoredArtifacts', () => {
  it('copies included gitignored files from repo_root source', async () => {
    const repo = makeRepo();
    try {
      writeFileSync(path.join(repo.root, '.gitignore'), 'node_modules/\n.cache/\n', 'utf8');
      mkdirSync(path.join(repo.root, '.cache'), { recursive: true });
      writeFileSync(path.join(repo.root, '.cache', 'index.json'), '{"ok":true}\n', 'utf8');
      writeFileSync(path.join(repo.root, '.worktreeinclude'), '.cache/**\n', 'utf8');

      const workspace = path.join(repo.root, 'workspace');
      mkdirSync(workspace, { recursive: true });

      const result = await copyIgnoredArtifacts({
        identifier: 'ABC-1',
        workspacePath: workspace,
        provisionRepoRoot: repo.root,
        config: {
          enabled: true,
          include_file: path.join(repo.root, '.worktreeinclude'),
          from: 'repo_root',
          conflict_policy: 'skip',
          require_gitignored: true,
          max_files: 100,
          max_total_bytes: 10_000,
          allow_patterns: [],
          deny_patterns: []
        }
      });

      expect(result.status).toBe('success');
      expect(result.copied_files).toBe(1);
      const copiedPath = path.join(workspace, '.cache', 'index.json');
      expect(existsSync(copiedPath)).toBe(true);
      expect(readFileSync(copiedPath, 'utf8')).toContain('"ok":true');
    } finally {
      repo.cleanup();
    }
  });

  it('denies .env copies even when include and allow patterns match', async () => {
    const repo = makeRepo();
    try {
      writeFileSync(path.join(repo.root, '.gitignore'), '.env\n', 'utf8');
      writeFileSync(path.join(repo.root, '.env'), 'SECRET=1\n', 'utf8');
      writeFileSync(path.join(repo.root, '.worktreeinclude'), '.env\n', 'utf8');

      const workspace = path.join(repo.root, 'workspace');
      mkdirSync(workspace, { recursive: true });

      const result = await copyIgnoredArtifacts({
        identifier: 'ABC-2',
        workspacePath: workspace,
        provisionRepoRoot: repo.root,
        config: {
          enabled: true,
          include_file: path.join(repo.root, '.worktreeinclude'),
          from: 'repo_root',
          conflict_policy: 'skip',
          require_gitignored: true,
          max_files: 100,
          max_total_bytes: 10_000,
          allow_patterns: ['.env'],
          deny_patterns: []
        }
      });

      expect(result.blocked_files).toBeGreaterThan(0);
      expect(existsSync(path.join(workspace, '.env'))).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  it('fails on non-skip conflict when destination file already exists', async () => {
    const repo = makeRepo();
    try {
      writeFileSync(path.join(repo.root, '.gitignore'), '.cache/\n', 'utf8');
      mkdirSync(path.join(repo.root, '.cache'), { recursive: true });
      writeFileSync(path.join(repo.root, '.cache', 'value.txt'), 'new\n', 'utf8');
      writeFileSync(path.join(repo.root, '.worktreeinclude'), '.cache/**\n', 'utf8');

      const workspace = path.join(repo.root, 'workspace');
      mkdirSync(path.join(workspace, '.cache'), { recursive: true });
      writeFileSync(path.join(workspace, '.cache', 'value.txt'), 'old\n', 'utf8');

      await expect(
        copyIgnoredArtifacts({
          identifier: 'ABC-3',
          workspacePath: workspace,
          provisionRepoRoot: repo.root,
          config: {
            enabled: true,
            include_file: path.join(repo.root, '.worktreeinclude'),
            from: 'repo_root',
            conflict_policy: 'fail',
            require_gitignored: true,
            max_files: 100,
            max_total_bytes: 10_000,
            allow_patterns: [],
            deny_patterns: []
          }
        })
      ).rejects.toMatchObject({
        code: 'workspace_copy_ignored_invalid_config'
      });
      expect(readFileSync(path.join(workspace, '.cache', 'value.txt'), 'utf8')).toBe('old\n');
    } finally {
      repo.cleanup();
    }
  });
});
