import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

function runNode(args: string[], cwd: string) {
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8'
  });
}

describe('check-public-api-contract script', () => {
  it('passes in repository root', () => {
    const root = process.cwd();
    const result = runNode(['scripts/check-public-api-contract.js'], root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Public API contract check passed');
  });

  it('fails with actionable output when required root export is missing', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-public-api-check-'));
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });

    const indexPath = path.join(tempRoot, 'src/index.ts');
    const updated = fs
      .readFileSync(indexPath, 'utf8')
      .replace("export * as runtime from './runtime';\n", '');
    fs.writeFileSync(indexPath, updated, 'utf8');

    const result = runNode(['scripts/check-public-api-contract.js'], tempRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Public API contract check failed');
    expect(result.stderr).toContain("module 'runtime'");

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});
