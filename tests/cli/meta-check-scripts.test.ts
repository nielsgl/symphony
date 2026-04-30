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

function runGit(args: string[], cwd: string) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8'
  });
}

function expectScriptPasses(root: string, script: string, output: string) {
  const result = runNode([script], root);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(output);
}

describe('meta check scripts', () => {
  it(
    '[SPEC-18-1][SPEC-18.1-1][SPEC-18.2-1] passes api contract and governance checks in repository root',
    () => {
      const root = process.cwd();

      expectScriptPasses(root, 'scripts/check-api-contract.js', 'API contract check passed');
      expectScriptPasses(root, 'scripts/check-public-api-contract.js', 'Public API contract check passed');
      expectScriptPasses(root, 'scripts/check-pr-governance.js', 'PR governance check passed');
      expectScriptPasses(root, 'scripts/check-spec-coverage.js', 'SPEC coverage check passed');
      expectScriptPasses(root, 'scripts/check-log-context.js', 'Log context check passed');
    },
    30_000
  );

  it('passes aggregate meta check in repository root', () => {
    const root = process.cwd();
    const meta = runNode(['scripts/check-meta.js'], root);
    expect(meta.status).toBe(0);
    expect(meta.stdout).toContain('Meta checks passed');
  }, 30_000);

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

  it('fails with actionable output when public API contract is violated', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-meta-check-'));
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'docs'), path.join(tempRoot, 'docs'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    fs.cpSync(path.join(root, 'tests'), path.join(tempRoot, 'tests'), { recursive: true });

    const indexPath = path.join(tempRoot, 'src/index.ts');
    const updated = fs
      .readFileSync(indexPath, 'utf8')
      .replace("export * as runtime from './runtime';\n", '');
    fs.writeFileSync(indexPath, updated, 'utf8');

    const result = runNode(['scripts/check-meta.js'], tempRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Public API contract check failed');
    expect(result.stderr).toContain("module 'runtime'");

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('fails ui evidence gate when dashboard UI changes exist without evidence markers', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    fs.cpSync(path.join(root, '.git'), path.join(tempRoot, '.git'), { recursive: true });
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'docs'), path.join(tempRoot, 'docs'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    fs.cpSync(path.join(root, 'tests'), path.join(tempRoot, 'tests'), { recursive: true });

    const dashboardPath = path.join(tempRoot, 'src/api/dashboard-assets.ts');
    fs.appendFileSync(dashboardPath, '\n// ui evidence gate test marker\n', 'utf8');

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('UI-affecting changes detected without e2e evidence');
    expect(result.stderr).toContain('src/api/dashboard-assets.ts');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('passes ui evidence gate when marker file is present for UI changes', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    fs.cpSync(path.join(root, '.git'), path.join(tempRoot, '.git'), { recursive: true });
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'docs'), path.join(tempRoot, 'docs'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });

    const dashboardPath = path.join(tempRoot, 'src/api/dashboard-assets.ts');
    fs.appendFileSync(dashboardPath, '\n// ui evidence gate test marker\n', 'utf8');

    fs.mkdirSync(path.join(tempRoot, 'output/playwright'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, 'output/playwright/ui-e2e-evidence.txt'),
      'UI_E2E_EVIDENCE=PASS\n',
      'utf8'
    );

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1'
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('UI evidence gate passed');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('fails ui evidence gate for committed UI changes in branch history when origin/main is unavailable', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });

    expect(runGit(['init'], tempRoot).status).toBe(0);
    expect(runGit(['config', 'user.email', 'test@example.com'], tempRoot).status).toBe(0);
    expect(runGit(['config', 'user.name', 'Meta Test'], tempRoot).status).toBe(0);
    expect(runGit(['add', '.'], tempRoot).status).toBe(0);
    expect(runGit(['commit', '-m', 'initial'], tempRoot).status).toBe(0);

    const dashboardPath = path.join(tempRoot, 'src/api/dashboard-assets.ts');
    fs.appendFileSync(dashboardPath, '\n// committed ui evidence gate test marker\n', 'utf8');
    expect(runGit(['add', 'src/api/dashboard-assets.ts'], tempRoot).status).toBe(0);
    expect(runGit(['commit', '-m', 'ui change'], tempRoot).status).toBe(0);

    const nonUiPath = path.join(tempRoot, 'scripts/check-meta.js');
    fs.appendFileSync(nonUiPath, '\n// non-ui change after ui commit\n', 'utf8');
    expect(runGit(['add', 'scripts/check-meta.js'], tempRoot).status).toBe(0);
    expect(runGit(['commit', '-m', 'non-ui follow-up'], tempRoot).status).toBe(0);

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('UI-affecting changes detected without e2e evidence');
    expect(result.stderr).toContain('src/api/dashboard-assets.ts');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});
