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

function expectStrictFailureOrParserUnavailable(stderr: string) {
  const strictFailure = stderr.includes('strict UI evidence profile requires manifest-backed artifacts');
  const parserFailure = stderr.includes('unable to load workflow validation profile');
  expect(strictFailure || parserFailure).toBe(true);
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

  it('fails aggregate meta check when upstream parity blocking is enabled with untriaged high-impact deltas', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-meta-parity-check-'));
    fs.cpSync(path.join(root, '.git'), path.join(tempRoot, '.git'), { recursive: true });
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

    fs.rmSync(tempRoot, { recursive: true, force: true });
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
    fs.cpSync(path.join(root, 'dist/src/workflow'), path.join(tempRoot, 'dist/src/workflow'), { recursive: true });

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

  it('passes baseline profile when UI evidence env marker is set without artifact file', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    fs.cpSync(path.join(root, '.git'), path.join(tempRoot, '.git'), { recursive: true });
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    fs.cpSync(path.join(root, 'dist/src/workflow'), path.join(tempRoot, 'dist/src/workflow'), { recursive: true });

    const dashboardPath = path.join(tempRoot, 'src/api/dashboard-assets.ts');
    fs.appendFileSync(dashboardPath, '\n// ui evidence gate baseline env marker\n', 'utf8');

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_E2E_PLAYWRIGHT_PASS: '1',
      SYMPHONY_UI_EVIDENCE_PROFILE: 'baseline'
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('UI evidence profile active: baseline');
    expect(result.stdout).toContain('UI evidence gate passed via env:SYMPHONY_UI_E2E_PLAYWRIGHT_PASS');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('fails strict profile when only env marker exists without manifest artifacts', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    fs.cpSync(path.join(root, '.git'), path.join(tempRoot, '.git'), { recursive: true });
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    fs.cpSync(path.join(root, 'dist/src/workflow'), path.join(tempRoot, 'dist/src/workflow'), { recursive: true });

    const dashboardPath = path.join(tempRoot, 'src/api/dashboard-assets.ts');
    fs.appendFileSync(dashboardPath, '\n// ui evidence gate strict missing artifact marker\n', 'utf8');

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_E2E_PLAYWRIGHT_PASS: '1',
      SYMPHONY_UI_EVIDENCE_PROFILE: 'strict'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('strict UI evidence profile requires manifest-backed artifacts');
    expect(result.stderr).toContain('missing manifest file: output/playwright/ui-evidence.json');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('fails strict profile when manifest exists but artifact file is missing', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    fs.cpSync(path.join(root, '.git'), path.join(tempRoot, '.git'), { recursive: true });
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    fs.cpSync(path.join(root, 'dist/src/workflow'), path.join(tempRoot, 'dist/src/workflow'), { recursive: true });

    const dashboardPath = path.join(tempRoot, 'src/api/dashboard-assets.ts');
    fs.appendFileSync(dashboardPath, '\n// ui evidence gate strict pass marker\n', 'utf8');

    fs.mkdirSync(path.join(tempRoot, 'output/playwright'), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, 'output/playwright/ui-evidence.json'),
      JSON.stringify(
        {
          artifacts: [{ path: 'output/playwright/demo.webm', type: 'video' }],
          ui_paths: ['src/api/dashboard-assets.ts'],
          captured_at: '2026-05-01T00:00:00.000Z',
          summary: 'Demo capture',
          publish_reference: 'https://github.com/nielsgl/symphony/pull/25#issuecomment-demo'
        },
        null,
        2
      ),
      'utf8'
    );

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_EVIDENCE_PROFILE: 'strict'
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('UI evidence profile active: strict');
    expect(result.stderr).toContain('manifest artifact file is missing: output/playwright/demo.webm');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('fails strict profile when manifest publish reference is missing', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    fs.cpSync(path.join(root, '.git'), path.join(tempRoot, '.git'), { recursive: true });
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    fs.cpSync(path.join(root, 'dist/src/workflow'), path.join(tempRoot, 'dist/src/workflow'), { recursive: true });

    const dashboardPath = path.join(tempRoot, 'src/api/dashboard-assets.ts');
    fs.appendFileSync(dashboardPath, '\n// ui evidence gate strict missing publish reference\n', 'utf8');

    fs.mkdirSync(path.join(tempRoot, 'output/playwright'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'output/playwright/demo.webm'), 'stub-video', 'utf8');
    fs.writeFileSync(
      path.join(tempRoot, 'output/playwright/ui-evidence.json'),
      JSON.stringify(
        {
          artifacts: [{ path: 'output/playwright/demo.webm', type: 'video' }],
          ui_paths: ['src/api/dashboard-assets.ts'],
          captured_at: '2026-05-01T00:00:00.000Z',
          summary: 'Demo capture'
        },
        null,
        2
      ),
      'utf8'
    );

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_EVIDENCE_PROFILE: 'strict'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('manifest.publish_reference must be a non-empty string');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('fails strict profile when artifact path escapes output/playwright directory', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    fs.cpSync(path.join(root, '.git'), path.join(tempRoot, '.git'), { recursive: true });
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    fs.cpSync(path.join(root, 'dist/src/workflow'), path.join(tempRoot, 'dist/src/workflow'), { recursive: true });

    const dashboardPath = path.join(tempRoot, 'src/api/dashboard-assets.ts');
    fs.appendFileSync(dashboardPath, '\n// ui evidence gate strict traversal check\n', 'utf8');

    fs.mkdirSync(path.join(tempRoot, 'output/playwright'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'output/escape.png'), 'stub-image', 'utf8');
    fs.writeFileSync(
      path.join(tempRoot, 'output/playwright/ui-evidence.json'),
      JSON.stringify(
        {
          artifacts: [{ path: 'output/playwright/../escape.png', type: 'image' }],
          ui_paths: ['src/api/dashboard-assets.ts'],
          captured_at: '2026-05-01T00:00:00.000Z',
          summary: 'Demo capture',
          publish_reference: 'https://github.com/nielsgl/symphony/pull/25#issuecomment-demo'
        },
        null,
        2
      ),
      'utf8'
    );

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_EVIDENCE_PROFILE: 'strict'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('path escapes output/playwright/');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('passes strict profile when manifest and artifact files are present', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    fs.cpSync(path.join(root, '.git'), path.join(tempRoot, '.git'), { recursive: true });
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    fs.cpSync(path.join(root, 'dist/src/workflow'), path.join(tempRoot, 'dist/src/workflow'), { recursive: true });

    const dashboardPath = path.join(tempRoot, 'src/api/dashboard-assets.ts');
    fs.appendFileSync(dashboardPath, '\n// ui evidence gate strict pass manifest\n', 'utf8');

    fs.mkdirSync(path.join(tempRoot, 'output/playwright'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'output/playwright/demo.webm'), 'stub-video', 'utf8');
    fs.writeFileSync(
      path.join(tempRoot, 'output/playwright/ui-evidence.json'),
      JSON.stringify(
        {
          artifacts: [{ path: 'output/playwright/demo.webm', type: 'video' }],
          ui_paths: ['src/api/dashboard-assets.ts'],
          captured_at: '2026-05-01T00:00:00.000Z',
          summary: 'Demo capture',
          publish_reference: 'https://github.com/nielsgl/symphony/pull/25#issuecomment-demo'
        },
        null,
        2
      ),
      'utf8'
    );

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_EVIDENCE_PROFILE: 'strict'
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('UI evidence profile active: strict');
    expect(result.stdout).toContain('UI evidence gate passed via file:output/playwright/ui-evidence.json');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('resolves strict profile from WORKFLOW.md validation config', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    fs.cpSync(path.join(root, '.git'), path.join(tempRoot, '.git'), { recursive: true });
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    fs.cpSync(path.join(root, 'dist/src/workflow'), path.join(tempRoot, 'dist/src/workflow'), { recursive: true });

    const dashboardPath = path.join(tempRoot, 'src/api/dashboard-assets.ts');
    fs.appendFileSync(dashboardPath, '\n// ui evidence gate strict workflow profile\n', 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'WORKFLOW.md'), '---\nvalidation:\n  ui_evidence_profile: strict\n---\n', 'utf8');

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_E2E_PLAYWRIGHT_PASS: '1'
    });
    expect(result.status).toBe(1);
    expectStrictFailureOrParserUnavailable(result.stderr);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('fails when workflow profile exists but shared parser is unavailable', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    fs.cpSync(path.join(root, '.git'), path.join(tempRoot, '.git'), { recursive: true });
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });

    const dashboardPath = path.join(tempRoot, 'src/api/dashboard-assets.ts');
    fs.appendFileSync(dashboardPath, '\n// ui evidence gate parser unavailable\n', 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'WORKFLOW.md'), '---\nvalidation:\n  ui_evidence_profile: strict\n---\n', 'utf8');

    const result = runNode(['scripts/check-meta.js'], tempRoot, {
      SYMPHONY_META_SKIP_BASE_CHECKS: '1',
      SYMPHONY_UI_E2E_PLAYWRIGHT_PASS: '1'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unable to load workflow validation profile');
    expect(result.stderr).toContain('shared_frontmatter_parser_unavailable');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('resolves strict profile from quoted WORKFLOW.md value with comments and extra keys', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    fs.cpSync(path.join(root, '.git'), path.join(tempRoot, '.git'), { recursive: true });
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    fs.cpSync(path.join(root, 'dist/src/workflow'), path.join(tempRoot, 'dist/src/workflow'), { recursive: true });

    const dashboardPath = path.join(tempRoot, 'src/api/dashboard-assets.ts');
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
    expect(result.status).toBe(1);
    expectStrictFailureOrParserUnavailable(result.stderr);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('resolves strict profile from indented WORKFLOW.md frontmatter formatting', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-meta-check-'));
    fs.cpSync(path.join(root, '.git'), path.join(tempRoot, '.git'), { recursive: true });
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(tempRoot, 'src'), { recursive: true });
    fs.cpSync(path.join(root, 'dist/src/workflow'), path.join(tempRoot, 'dist/src/workflow'), { recursive: true });

    const dashboardPath = path.join(tempRoot, 'src/api/dashboard-assets.ts');
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
    expect(result.status).toBe(1);
    expectStrictFailureOrParserUnavailable(result.stderr);

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
