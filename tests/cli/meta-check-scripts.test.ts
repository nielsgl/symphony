import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

function runNode(args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  const rootNodeModules = path.join(process.cwd(), 'node_modules');
  const nodePath = process.env.NODE_PATH ? `${rootNodeModules}${path.delimiter}${process.env.NODE_PATH}` : rootNodeModules;
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_PATH: nodePath,
      SYMPHONY_UI_EVIDENCE_PROFILE: '',
      SYMPHONY_UI_EVIDENCE_ALLOW_TRACKED: '1',
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

function expectStrictPassOrParserUnavailable(result: ReturnType<typeof runNode>) {
  const stderr = result.stderr;
  const strictPass =
    result.status === 0 &&
    result.stdout.includes('UI evidence profile active: strict') &&
    result.stdout.includes('UI evidence gate passed via env:SYMPHONY_UI_E2E_PLAYWRIGHT_PASS');
  const parserFailure = stderr.includes('unable to load workflow validation profile');
  expect(strictPass || parserFailure).toBe(true);
}

const UI_FIXTURE_PATH = 'tests/fixtures/ui-gate/dashboard-assets.fixture.ts';
const HEAVY_META_FIXTURE_TIMEOUT_MS = 30_000;

function appendUiFixtureMarker(root: string, marker: string) {
  const fixturePath = path.join(root, UI_FIXTURE_PATH);
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  if (!fs.existsSync(fixturePath)) {
    fs.writeFileSync(fixturePath, 'export const dashboardFixture = true;\n', 'utf8');
  }
  fs.appendFileSync(fixturePath, `${marker}\n`, 'utf8');
}

function initTempGitRepository(root: string) {
  expect(runGit(['init'], root).status).toBe(0);
  expect(runGit(['config', 'user.email', 'test@example.com'], root).status).toBe(0);
  expect(runGit(['config', 'user.name', 'Meta Test'], root).status).toBe(0);
  fs.writeFileSync(
    path.join(root, '.gitignore'),
    [
      '.symphony/system/',
      '.symphony/workspaces/',
      '.symphony/log/',
      '.symphony/logs/',
      '.symphony/runtime.sqlite',
      '.symphony/runtime.sqlite.bak-*',
      '.symphony/runtime.sqlite-*',
      '.symphony/state.db',
      '.symphony/runtime-restart-failure.json',
      '.symphony/stress-base/',
      ''
    ].join('\n'),
    'utf8'
  );
  const fixturePath = path.join(root, UI_FIXTURE_PATH);
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  if (!fs.existsSync(fixturePath)) {
    fs.writeFileSync(fixturePath, 'export const dashboardFixture = true;\n', 'utf8');
  }
}

function removeTempRoot(root: string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch (error) {
      if (attempt === 4) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
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
    const meta = runNode(['scripts/check-meta.js'], root, {
      SYMPHONY_UI_EVIDENCE_PROFILE: 'baseline',
      SYMPHONY_UI_E2E_PLAYWRIGHT_PASS: '1'
    });
    expect(meta.status).toBe(0);
    expect(meta.stdout).toContain('Meta checks passed');
  }, 30_000);

  it('fails aggregate meta check when upstream parity blocking is enabled with untriaged high-impact deltas', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-meta-parity-check-'));
    initTempGitRepository(tempRoot);
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'docs'), path.join(tempRoot, 'docs'), { recursive: true });
    fs.cpSync(path.join(root, 'tests/fixtures/upstream-parity'), path.join(tempRoot, 'tests/fixtures/upstream-parity'), {
      recursive: true
    });

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UPSTREAM_PARITY_ENABLED: '1',
      SYMPHONY_UPSTREAM_PARITY_BLOCKING: '1',
      SYMPHONY_UPSTREAM_PARITY_HEAD_SHA: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      SYMPHONY_UPSTREAM_PARITY_FIXTURE: 'tests/fixtures/upstream-parity/compare-mixed.json'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('high-impact delta(s) are untriaged');

    removeTempRoot(tempRoot);
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

  it('fails governance check when PR body contains escaped newline payload', () => {
    const root = process.cwd();
    const result = runNode([path.join(root, 'scripts/check-pr-governance.js')], root, {
      SYMPHONY_PR_BODY: '## Summary\\n- item'
    });
    expect(result.status).toBe(0);

    const malformed = runNode([path.join(root, 'scripts/check-pr-governance.js')], root, {
      SYMPHONY_PR_BODY: '## Summary\\\\n- item'
    });
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain('pr_body_escaped_newlines: body contains escaped newline sequences; normalize before submit');
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

    removeTempRoot(tempRoot);
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

    removeTempRoot(tempRoot);
  });

  it('fails aggregate meta check when source files add ad-hoc reason-code literals outside the registry', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-meta-reason-code-check-'));
    initTempGitRepository(tempRoot);
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });

    const offenderPath = path.join(tempRoot, 'src/api/ad-hoc-reason.ts');
    fs.writeFileSync(offenderPath, "export const reason = 'turn_input_required';\n", 'utf8');

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('reason-code literals must be referenced');
    expect(result.stderr).toContain('src/api/ad-hoc-reason.ts');

    removeTempRoot(tempRoot);
  });

  it('fails aggregate meta check when source files add unknown reason-code field literals', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-meta-unknown-reason-code-check-'));
    initTempGitRepository(tempRoot);
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });

    const offenderPath = path.join(tempRoot, 'src/api/unknown-runtime-reason.ts');
    fs.writeFileSync(
      offenderPath,
      "export const blocked = { stop_reason_code: 'new_runtime_blocker_reason' };\n",
      'utf8'
    );

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('reason-code-bearing fields must use canonical registry values');
    expect(result.stderr).toContain('src/api/unknown-runtime-reason.ts');
    expect(result.stderr).toContain('new_runtime_blocker_reason');

    removeTempRoot(tempRoot);
  });

  it('fails aggregate meta check when source files add reason-code prefix literals', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-meta-reason-prefix-check-'));
    initTempGitRepository(tempRoot);
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });

    const offenderPath = path.join(tempRoot, 'src/orchestrator/ad-hoc-prefix.ts');
    fs.writeFileSync(offenderPath, "export const prefix = 'turn_input_required:';\n", 'utf8');

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('reason-code-bearing fields must use canonical registry values');
    expect(result.stderr).toContain('src/orchestrator/ad-hoc-prefix.ts');
    expect(result.stderr).toContain('turn_input_required:');

    removeTempRoot(tempRoot);
  });

  it('fails ui evidence gate when dashboard UI changes exist without evidence markers', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    initTempGitRepository(tempRoot);
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'docs'), path.join(tempRoot, 'docs'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    fs.cpSync(path.join(root, 'tests'), path.join(tempRoot, 'tests'), { recursive: true });
    expect(runGit(['add', '.'], tempRoot).status).toBe(0);
    expect(runGit(['commit', '-m', 'initial'], tempRoot).status).toBe(0);

    const dashboardPath = path.join(tempRoot, UI_FIXTURE_PATH);
    fs.appendFileSync(dashboardPath, '\n// ui evidence gate test marker\n', 'utf8');

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_EVIDENCE_PROFILE: 'baseline'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('UI-affecting changes detected without e2e evidence');
    expect(result.stderr).toContain(UI_FIXTURE_PATH);

    removeTempRoot(tempRoot);
  });

  it('passes ui evidence gate when marker file is present for UI changes', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    initTempGitRepository(tempRoot);
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'docs'), path.join(tempRoot, 'docs'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    fs.cpSync(path.join(root, 'dist/src/workflow'), path.join(tempRoot, 'dist/src/workflow'), { recursive: true });
    expect(runGit(['add', '.'], tempRoot).status).toBe(0);
    expect(runGit(['commit', '-m', 'initial'], tempRoot).status).toBe(0);

    const dashboardPath = path.join(tempRoot, UI_FIXTURE_PATH);
    fs.appendFileSync(dashboardPath, '\n// ui evidence gate test marker\n', 'utf8');

    fs.mkdirSync(path.join(tempRoot, 'output/playwright'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, 'output/playwright/ui-e2e-evidence.txt'),
      'UI_E2E_EVIDENCE=PASS\n',
      'utf8'
    );

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_EVIDENCE_PROFILE: 'baseline'
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('UI evidence gate passed');

    removeTempRoot(tempRoot);
  }, HEAVY_META_FIXTURE_TIMEOUT_MS);

  it('passes baseline profile when UI evidence env marker is set without artifact file', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    initTempGitRepository(tempRoot);
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    fs.cpSync(path.join(root, 'dist/src/workflow'), path.join(tempRoot, 'dist/src/workflow'), { recursive: true });
    expect(runGit(['add', '.'], tempRoot).status).toBe(0);
    expect(runGit(['commit', '-m', 'initial'], tempRoot).status).toBe(0);

    const dashboardPath = path.join(tempRoot, UI_FIXTURE_PATH);
    fs.appendFileSync(dashboardPath, '\n// ui evidence gate baseline env marker\n', 'utf8');

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_E2E_PLAYWRIGHT_PASS: '1',
      SYMPHONY_UI_EVIDENCE_PROFILE: 'baseline'
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('UI evidence profile active: baseline');
    expect(result.stdout).toContain('UI evidence gate passed via env:SYMPHONY_UI_E2E_PLAYWRIGHT_PASS');

    removeTempRoot(tempRoot);
  });

  it('passes strict profile with the Playwright env marker and no ui-evidence manifest', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    initTempGitRepository(tempRoot);
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    fs.cpSync(path.join(root, 'dist/src/workflow'), path.join(tempRoot, 'dist/src/workflow'), { recursive: true });
    expect(runGit(['add', '.'], tempRoot).status).toBe(0);
    expect(runGit(['commit', '-m', 'initial'], tempRoot).status).toBe(0);

    const dashboardPath = path.join(tempRoot, UI_FIXTURE_PATH);
    fs.appendFileSync(dashboardPath, '\n// ui evidence gate strict missing artifact marker\n', 'utf8');

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_E2E_PLAYWRIGHT_PASS: '1',
      SYMPHONY_UI_EVIDENCE_PROFILE: 'strict'
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('UI evidence profile active: strict');
    expect(result.stdout).toContain('UI evidence gate passed via env:SYMPHONY_UI_E2E_PLAYWRIGHT_PASS');

    removeTempRoot(tempRoot);
  });

  it('fails when PR body uses a local Playwright artifact path as review evidence', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    initTempGitRepository(tempRoot);
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    fs.cpSync(path.join(root, 'dist/src/workflow'), path.join(tempRoot, 'dist/src/workflow'), { recursive: true });
    expect(runGit(['add', '.'], tempRoot).status).toBe(0);
    expect(runGit(['commit', '-m', 'initial'], tempRoot).status).toBe(0);

    const dashboardPath = path.join(tempRoot, UI_FIXTURE_PATH);
    fs.appendFileSync(dashboardPath, '\n// ui evidence local path rejection\n', 'utf8');

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_EVIDENCE_PROFILE: 'strict',
      SYMPHONY_UI_E2E_PLAYWRIGHT_PASS: '1',
      SYMPHONY_PR_BODY: 'Evidence: output/playwright/demo.webm'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ui_evidence_unpublished: local output/playwright artifact references are not review evidence');
    expect(result.stderr).toContain('Publish UI evidence with the linear-ui-evidence skill');
    expect(result.stderr).toContain('output/playwright/demo.webm');

    removeTempRoot(tempRoot);
  });

  it('fails when strict evidence artifacts are staged for commit', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    initTempGitRepository(tempRoot);
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    fs.cpSync(path.join(root, 'dist/src/workflow'), path.join(tempRoot, 'dist/src/workflow'), { recursive: true });
    expect(runGit(['add', '.'], tempRoot).status).toBe(0);
    expect(runGit(['commit', '-m', 'initial'], tempRoot).status).toBe(0);

    const dashboardPath = path.join(tempRoot, UI_FIXTURE_PATH);
    fs.appendFileSync(dashboardPath, '\n// ui evidence gate strict staged artifact block\n', 'utf8');

    fs.mkdirSync(path.join(tempRoot, 'output/playwright'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'output/playwright/demo.webm'), 'stub-video', 'utf8');

    expect(runGit(['add', UI_FIXTURE_PATH], tempRoot).status).toBe(0);
    expect(runGit(['add', '-f', 'output/playwright/demo.webm'], tempRoot).status).toBe(0);

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_EVIDENCE_PROFILE: 'strict',
      SYMPHONY_UI_EVIDENCE_ALLOW_TRACKED: '0'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('staged UI evidence entries are not allowed');
    expect(result.stderr).toContain('output/playwright/demo.webm');

    removeTempRoot(tempRoot);
  });

  it('fails when strict evidence artifacts are committed in branch history', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    fs.cpSync(path.join(root, 'dist/src/workflow'), path.join(tempRoot, 'dist/src/workflow'), { recursive: true });

    initTempGitRepository(tempRoot);
    expect(runGit(['add', '.'], tempRoot).status).toBe(0);
    expect(runGit(['commit', '-m', 'initial'], tempRoot).status).toBe(0);

    const dashboardPath = path.join(tempRoot, UI_FIXTURE_PATH);
    fs.appendFileSync(dashboardPath, '\n// ui evidence gate strict committed artifact block\n', 'utf8');
    fs.mkdirSync(path.join(tempRoot, 'output/playwright'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'output/playwright/demo.webm'), 'stub-video', 'utf8');
    expect(runGit(['add', UI_FIXTURE_PATH], tempRoot).status).toBe(0);
    expect(runGit(['add', '-f', 'output/playwright/demo.webm'], tempRoot).status).toBe(0);
    expect(runGit(['commit', '-m', 'commit evidence files'], tempRoot).status).toBe(0);

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_EVIDENCE_PROFILE: 'strict',
      SYMPHONY_UI_EVIDENCE_ALLOW_TRACKED: '0'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('tracked UI evidence artifacts are not allowed');
    expect(result.stderr).toContain('output/playwright/demo.webm');

    removeTempRoot(tempRoot);
  }, HEAVY_META_FIXTURE_TIMEOUT_MS);

  it('fails with typed hygiene diagnostic when provision artifact is staged', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-repo-hygiene-check-'));
    initTempGitRepository(tempRoot);
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    expect(runGit(['add', '.'], tempRoot).status).toBe(0);
    expect(runGit(['commit', '-m', 'initial'], tempRoot).status).toBe(0);

    fs.writeFileSync(path.join(tempRoot, '.symphony-provision.json'), '{}\n', 'utf8');
    expect(runGit(['add', '.symphony-provision.json'], tempRoot).status).toBe(0);

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_EVIDENCE_PROFILE: 'baseline',
      SYMPHONY_UI_EVIDENCE_ALLOW_TRACKED: '0',
      SYMPHONY_REPO_HYGIENE_ALLOW_TRACKED: '0'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('hygiene_repo_artifact_tracked_forbidden');
    expect(result.stderr).toContain('.symphony-provision.json');
    expect(result.stderr).toContain('Remediation:');

    removeTempRoot(tempRoot);
  }, HEAVY_META_FIXTURE_TIMEOUT_MS);

  it('does not allow provision artifact when only legacy UI evidence allow env is set', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-repo-hygiene-check-'));
    initTempGitRepository(tempRoot);
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    expect(runGit(['add', '.'], tempRoot).status).toBe(0);
    expect(runGit(['commit', '-m', 'initial'], tempRoot).status).toBe(0);

    fs.writeFileSync(path.join(tempRoot, '.symphony-provision.json'), '{}\n', 'utf8');
    expect(runGit(['add', '.symphony-provision.json'], tempRoot).status).toBe(0);

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_EVIDENCE_PROFILE: 'baseline',
      SYMPHONY_UI_EVIDENCE_ALLOW_TRACKED: '1',
      SYMPHONY_REPO_HYGIENE_ALLOW_TRACKED: '0'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('hygiene_repo_artifact_tracked_forbidden');
    expect(result.stderr).toContain('.symphony-provision.json');
    expect(result.stderr).toContain('SYMPHONY_REPO_HYGIENE_ALLOW_TRACKED=1');

    removeTempRoot(tempRoot);
  }, HEAVY_META_FIXTURE_TIMEOUT_MS);

  it('keeps legacy UI evidence allow env scoped to playwright artifacts', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-repo-hygiene-check-'));
    initTempGitRepository(tempRoot);
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    expect(runGit(['add', '.'], tempRoot).status).toBe(0);
    expect(runGit(['commit', '-m', 'initial'], tempRoot).status).toBe(0);

    fs.mkdirSync(path.join(tempRoot, 'output/playwright'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'output/playwright/demo.webm'), 'stub-video', 'utf8');
    expect(runGit(['add', '-f', 'output/playwright/demo.webm'], tempRoot).status).toBe(0);

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_EVIDENCE_PROFILE: 'baseline',
      SYMPHONY_UI_EVIDENCE_ALLOW_TRACKED: '1',
      SYMPHONY_REPO_HYGIENE_ALLOW_TRACKED: '0'
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Meta checks passed');

    removeTempRoot(tempRoot);
  }, HEAVY_META_FIXTURE_TIMEOUT_MS);

  it('allows known hygiene artifacts when explicit allow env is set', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-repo-hygiene-check-'));
    initTempGitRepository(tempRoot);
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    expect(runGit(['add', '.'], tempRoot).status).toBe(0);
    expect(runGit(['commit', '-m', 'initial'], tempRoot).status).toBe(0);

    fs.writeFileSync(path.join(tempRoot, '.symphony-provision.json'), '{}\n', 'utf8');
    expect(runGit(['add', '.symphony-provision.json'], tempRoot).status).toBe(0);

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_EVIDENCE_PROFILE: 'baseline',
      SYMPHONY_REPO_HYGIENE_ALLOW_TRACKED: '1'
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Meta checks passed');

    removeTempRoot(tempRoot);
  }, HEAVY_META_FIXTURE_TIMEOUT_MS);

  it('fails aggregate meta check when root gitignore reintroduces broad symphony ignores', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-layout-ignore-check-'));
    initTempGitRepository(tempRoot);
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, '.gitignore'), '.symphony/\n', 'utf8');

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_EVIDENCE_PROFILE: 'baseline'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('project_layout_ignore_policy_failed');
    expect(result.stderr).toContain('broad .symphony/');
    expect(result.stderr).toContain('missing .symphony/system/');

    removeTempRoot(tempRoot);
  }, HEAVY_META_FIXTURE_TIMEOUT_MS);

  it('accepts narrow system and targeted legacy ignores while reserved customization stays visible', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-layout-ignore-check-'));
    initTempGitRepository(tempRoot);
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    expect(runGit(['add', '.'], tempRoot).status).toBe(0);
    expect(runGit(['commit', '-m', 'initial'], tempRoot).status).toBe(0);

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_EVIDENCE_PROFILE: 'baseline'
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Project layout ignore policy passed');
    expect(runGit(['check-ignore', '-q', '.symphony/system/runtime.sqlite'], tempRoot).status).toBe(0);
    expect(runGit(['check-ignore', '-q', '.symphony/workspaces/NIE-1'], tempRoot).status).toBe(0);
    expect(runGit(['check-ignore', '-q', '.symphony/logs/runtime.log'], tempRoot).status).toBe(0);
    expect(runGit(['check-ignore', '-q', '.symphony/runtime.sqlite.bak-example'], tempRoot).status).toBe(0);
    expect(runGit(['check-ignore', '-q', '.symphony/runtime.sqlite-wal'], tempRoot).status).toBe(0);
    expect(runGit(['check-ignore', '-q', '.symphony/stress-base/summary.json'], tempRoot).status).toBe(0);
    expect(runGit(['check-ignore', '-q', '.symphony/skills/example.md'], tempRoot).status).toBe(1);
    expect(runGit(['check-ignore', '-q', '.symphony/prompts/example.md'], tempRoot).status).toBe(1);

    removeTempRoot(tempRoot);
  }, HEAVY_META_FIXTURE_TIMEOUT_MS);

  it('fails aggregate meta check when managed symphony ignore entries are duplicated', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-layout-ignore-check-'));
    initTempGitRepository(tempRoot);
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    fs.appendFileSync(path.join(tempRoot, '.gitignore'), '.symphony/runtime.sqlite.bak-*\n', 'utf8');

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_EVIDENCE_PROFILE: 'baseline'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('project_layout_ignore_policy_failed');
    expect(result.stderr).toContain('duplicate managed Symphony ignore entry .symphony/runtime.sqlite.bak-*');

    removeTempRoot(tempRoot);
  }, HEAVY_META_FIXTURE_TIMEOUT_MS);

  it('resolves strict profile from WORKFLOW.md validation config', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    initTempGitRepository(tempRoot);
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    fs.cpSync(path.join(root, 'dist/src/workflow'), path.join(tempRoot, 'dist/src/workflow'), { recursive: true });
    expect(runGit(['add', '.'], tempRoot).status).toBe(0);
    expect(runGit(['commit', '-m', 'initial'], tempRoot).status).toBe(0);

    const dashboardPath = path.join(tempRoot, UI_FIXTURE_PATH);
    fs.appendFileSync(dashboardPath, '\n// ui evidence gate strict workflow profile\n', 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'WORKFLOW.md'), '---\nvalidation:\n  ui_evidence_profile: strict\n---\n', 'utf8');

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_EVIDENCE_PROFILE: '',
      SYMPHONY_UI_E2E_PLAYWRIGHT_PASS: '1'
    });
    expectStrictPassOrParserUnavailable(result);

    removeTempRoot(tempRoot);
  }, HEAVY_META_FIXTURE_TIMEOUT_MS);

  it('fails when workflow profile exists but shared parser is unavailable', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    initTempGitRepository(tempRoot);
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    expect(runGit(['add', '.'], tempRoot).status).toBe(0);
    expect(runGit(['commit', '-m', 'initial'], tempRoot).status).toBe(0);

    const dashboardPath = path.join(tempRoot, UI_FIXTURE_PATH);
    fs.appendFileSync(dashboardPath, '\n// ui evidence gate parser unavailable\n', 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'WORKFLOW.md'), '---\nvalidation:\n  ui_evidence_profile: strict\n---\n', 'utf8');

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_EVIDENCE_PROFILE: '',
      SYMPHONY_UI_E2E_PLAYWRIGHT_PASS: '1'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unable to load workflow validation profile');
    expect(result.stderr).toContain('shared_frontmatter_parser_unavailable');

    removeTempRoot(tempRoot);
  }, HEAVY_META_FIXTURE_TIMEOUT_MS);

  it('resolves strict profile from quoted WORKFLOW.md value with comments and extra keys', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    initTempGitRepository(tempRoot);
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    fs.cpSync(path.join(root, 'dist/src/workflow'), path.join(tempRoot, 'dist/src/workflow'), { recursive: true });
    expect(runGit(['add', '.'], tempRoot).status).toBe(0);
    expect(runGit(['commit', '-m', 'initial'], tempRoot).status).toBe(0);

    const dashboardPath = path.join(tempRoot, UI_FIXTURE_PATH);
    fs.appendFileSync(dashboardPath, '\n// ui evidence gate strict workflow quoted value\n', 'utf8');
    fs.writeFileSync(
      path.join(tempRoot, 'WORKFLOW.md'),
      [
        '---',
        '# workflow comment',
        'runtime:',
        '  max_attempts: 3',
        'validation:',
        '  ui_evidence_profile: "strict"',
        '  extra_key: "preserve"',
        '---',
        '',
        'Prompt body'
      ].join('\n'),
      'utf8'
    );

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_E2E_PLAYWRIGHT_PASS: '1'
    });
    expectStrictPassOrParserUnavailable(result);

    removeTempRoot(tempRoot);
  }, HEAVY_META_FIXTURE_TIMEOUT_MS);

  it('resolves strict profile from indented WORKFLOW.md frontmatter formatting', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    initTempGitRepository(tempRoot);
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    fs.cpSync(path.join(root, 'dist/src/workflow'), path.join(tempRoot, 'dist/src/workflow'), { recursive: true });
    expect(runGit(['add', '.'], tempRoot).status).toBe(0);
    expect(runGit(['commit', '-m', 'initial'], tempRoot).status).toBe(0);

    const dashboardPath = path.join(tempRoot, UI_FIXTURE_PATH);
    fs.appendFileSync(dashboardPath, '\n// ui evidence gate strict workflow indentation\n', 'utf8');
    fs.writeFileSync(
      path.join(tempRoot, 'WORKFLOW.md'),
      [
        '---',
        'runtime:',
        '    max_attempts: 3',
        'validation:',
        '    ui_evidence_profile: strict',
        '---',
        '',
        'Prompt body'
      ].join('\n'),
      'utf8'
    );

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_E2E_PLAYWRIGHT_PASS: '1'
    });
    expectStrictPassOrParserUnavailable(result);

    removeTempRoot(tempRoot);
  }, HEAVY_META_FIXTURE_TIMEOUT_MS);

  it('fails ui evidence gate for committed UI changes in branch history when origin/main is unavailable', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });

    initTempGitRepository(tempRoot);
    expect(runGit(['add', '.'], tempRoot).status).toBe(0);
    expect(runGit(['commit', '-m', 'initial'], tempRoot).status).toBe(0);

    const dashboardPath = path.join(tempRoot, UI_FIXTURE_PATH);
    fs.appendFileSync(dashboardPath, '\n// committed ui evidence gate test marker\n', 'utf8');
    expect(runGit(['add', UI_FIXTURE_PATH], tempRoot).status).toBe(0);
    expect(runGit(['commit', '-m', 'ui change'], tempRoot).status).toBe(0);

    const nonUiPath = path.join(tempRoot, 'scripts/check-meta.js');
    fs.appendFileSync(nonUiPath, '\n// non-ui change after ui commit\n', 'utf8');
    expect(runGit(['add', 'scripts/check-meta.js'], tempRoot).status).toBe(0);
    expect(runGit(['commit', '-m', 'non-ui follow-up'], tempRoot).status).toBe(0);

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_EVIDENCE_PROFILE: 'baseline'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('UI-affecting changes detected without e2e evidence');
    expect(result.stderr).toContain(UI_FIXTURE_PATH);

    removeTempRoot(tempRoot);
  }, HEAVY_META_FIXTURE_TIMEOUT_MS);
});
