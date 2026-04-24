import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

function runNode(cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ['scripts/workspace-before-remove.js'], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function writeExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

describe('workspace-before-remove script', () => {
  it('closes open branch PRs via gh and exits successfully', () => {
    const root = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-workspace-before-remove-'));
    const binDir = path.join(tempDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });

    const traceFile = path.join(tempDir, 'gh-calls.log');

    writeExecutable(
      path.join(binDir, 'git'),
      '#!/bin/sh\nif [ "$1" = "rev-parse" ]; then\n  echo "feature/test"\n  exit 0\nfi\nexit 1\n'
    );

    writeExecutable(
      path.join(binDir, 'gh'),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "gh version"\n  exit 0\nfi\nif [ "$1" = "pr" ] && [ "$2" = "list" ]; then\n  printf "[{\\"number\\":12,\\"url\\":\\"https://example.test/pr/12\\"}]\\n"\n  exit 0\nfi\nif [ "$1" = "pr" ] && [ "$2" = "close" ]; then\n  echo "$@" >> "$TRACE_FILE"\n  exit 0\nfi\nexit 1\n'
    );

    const result = runNode(root, {
      ...process.env,
      PATH: binDir,
      TRACE_FILE: traceFile
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('workspace-before-remove: completed');
    const calls = fs.readFileSync(traceFile, 'utf8');
    expect(calls).toContain('pr close 12');
    expect(calls).toContain('Closing from workspace cleanup for branch feature/test.');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('no-ops when gh is unavailable', () => {
    const root = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-workspace-before-remove-'));
    const binDir = path.join(tempDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });

    writeExecutable(
      path.join(binDir, 'git'),
      '#!/bin/sh\nif [ "$1" = "rev-parse" ]; then\n  echo "feature/test"\n  exit 0\nfi\nexit 1\n'
    );

    const result = runNode(root, {
      ...process.env,
      PATH: binDir
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('workspace-before-remove: skipped (gh unavailable)');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
