import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

function runNode(args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env
    }
  });
}

function resolveGitPath(cwd: string, gitRelativePath: string): string {
  const result = spawnSync('git', ['rev-parse', '--git-path', gitRelativePath], {
    cwd,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(`failed to resolve git path: ${gitRelativePath}`);
  }
  return path.resolve(cwd, result.stdout.trim());
}

describe('PR submission governance scripts', () => {
  it('normalizes escaped newline sequences to output file', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-pr-body-normalize-'));
    const outputPath = path.join(tempRoot, '.git', 'normalized.md');

    const result = runNode([path.join(process.cwd(), 'scripts/normalize-pr-body.js')], tempRoot, {
      SYMPHONY_PR_BODY: '## Summary\\n- one\\n- two',
      SYMPHONY_PR_BODY_FILE: '',
      SYMPHONY_PR_BODY_NORMALIZED_FILE: '.git/normalized.md'
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('## Summary\n- one\n- two');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('fails normalization when malformed escaped payload remains', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-pr-body-normalize-'));
    const result = runNode([path.join(process.cwd(), 'scripts/normalize-pr-body.js')], tempRoot, {
      SYMPHONY_PR_BODY: '## Summary\\\\n- one',
      SYMPHONY_PR_BODY_FILE: ''
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pr_body_escaped_newlines: body contains escaped newline sequences; normalize before submit');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('uses normalized body-file in governed submit wrapper dry-run', () => {
    const root = process.cwd();
    const gitRelativeOutput = '.symphony-pr-body.normalized.test.md';
    const normalizedPath = resolveGitPath(root, gitRelativeOutput);
    const expectedBodyFileArg = path.relative(root, normalizedPath) || normalizedPath;
    const result = runNode([path.join(root, 'scripts/submit-pr-with-governance.js'), '--mode', 'create', '--title', 'Test PR'], root, {
      SYMPHONY_PR_BODY: '## Summary\\n- one\\n- two',
      SYMPHONY_PR_BODY_FILE: '',
      SYMPHONY_SUBMIT_PR_SKIP_CHECKS: '1',
      SYMPHONY_SUBMIT_PR_DRY_RUN: '1',
      SYMPHONY_PR_BODY_NORMALIZED_FILE: '.git/.symphony-pr-body.normalized.test.md'
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`[dry-run] gh pr create --title "Test PR" --body-file ${expectedBodyFileArg}`);

    expect(fs.existsSync(normalizedPath)).toBe(true);
    expect(fs.readFileSync(normalizedPath, 'utf8')).toBe('## Summary\n- one\n- two');
    fs.rmSync(normalizedPath, { force: true });
  });
});
