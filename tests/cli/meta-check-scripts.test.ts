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

describe('meta check scripts', () => {
  it('[SPEC-18-1][SPEC-18.1-1][SPEC-18.2-1] passes api contract and governance checks in repository root', () => {
    const root = process.cwd();

    const api = runNode(['scripts/check-api-contract.js'], root);
    expect(api.status).toBe(0);
    expect(api.stdout).toContain('API contract check passed');

    const governance = runNode(['scripts/check-pr-governance.js'], root);
    expect(governance.status).toBe(0);
    expect(governance.stdout).toContain('PR governance check passed');

    const specCoverage = runNode(['scripts/check-spec-coverage.js'], root);
    expect(specCoverage.status).toBe(0);
    expect(specCoverage.stdout).toContain('SPEC coverage check passed');

    const logContext = runNode(['scripts/check-log-context.js'], root);
    expect(logContext.status).toBe(0);
    expect(logContext.stdout).toContain('Log context check passed');

    const meta = runNode(['scripts/check-meta.js'], root);
    expect(meta.status).toBe(0);
    expect(meta.stdout).toContain('Meta checks passed');
  });

  it('fails with actionable output when governance docs are missing from cwd', () => {
    const root = process.cwd();
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-meta-check-'));

    const governance = runNode([path.join(root, 'scripts/check-pr-governance.js')], tempCwd);
    expect(governance.status).toBe(1);
    expect(governance.stderr).toContain('Governance check failed');
    expect(governance.stderr).toContain('missing required document');

    fs.rmSync(tempCwd, { recursive: true, force: true });
  });

  it('fails with actionable output when SPEC test manifest is missing', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-spec-coverage-'));
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'docs'), path.join(tempRoot, 'docs'), { recursive: true });
    fs.rmSync(path.join(tempRoot, 'docs/prd/SPEC-TEST-MANIFEST.json'), { force: true });

    const result = runNode(['scripts/check-spec-coverage.js'], tempRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SPEC coverage check failed');
    expect(result.stderr).toContain('SPEC-TEST-MANIFEST.json');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});
