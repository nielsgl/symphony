import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const runtimeGuardrail = require('../../scripts/check-test-runtime-budget.js') as {
  ERROR_CODE: string;
  parseArgs: (argv: string[]) => {
    profile: string | null;
    input: string | null;
    command: string | null;
    baseline: string;
    json: boolean;
    limit: number;
    help: boolean;
  };
  compareRuntime: (profile: unknown, baseline: unknown, commandName: string) => {
    ok: boolean;
    diagnostics: Array<{ kind: string; message: string; file?: string }>;
  };
  formatResult: (result: unknown, limit?: number) => string;
};

function makeProfile(root: string, overrides: { wallClockMs?: number; localTrialMs?: number } = {}) {
  return {
    measured_at: '2026-05-29T00:00:00.000Z',
    environment: {
      cwd: root,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      sha: 'fixture'
    },
    command: 'npm run test:integration',
    vitest_command: 'input report',
    wall_clock_ms: overrides.wallClockMs ?? 120000,
    result: {
      success: true,
      total_files: 2,
      total_tests: 10,
      passed_tests: 10,
      failed_tests: 0
    },
    groups: [],
    slowest_files: [
      {
        file: 'tests/cli/local-multi-project-trial.test.ts',
        duration_ms: overrides.localTrialMs ?? 90000,
        status: 'passed',
        tests: 4,
        category: 'git/worktree/process-heavy',
        reasons: ['process']
      },
      {
        file: 'tests/runtime/bootstrap.test.ts',
        duration_ms: 40000,
        status: 'passed',
        tests: 6,
        category: 'git/worktree/process-heavy',
        reasons: ['git']
      }
    ],
    expensive_patterns: []
  };
}

function runScript(args: string[], cwd: string) {
  return spawnSync(process.execPath, [path.join(process.cwd(), 'scripts/check-test-runtime-budget.js'), ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env
    }
  });
}

describe('test runtime budget guardrail', () => {
  it('parses input and live-profile modes without pnpm-specific assumptions', () => {
    expect(runtimeGuardrail.parseArgs(['--input=profile.json', '--command', 'full', '--limit=3'])).toMatchObject({
      input: 'profile.json',
      command: 'full',
      profile: null,
      limit: 3
    });

    expect(runtimeGuardrail.parseArgs(['--profile', 'fast'])).toMatchObject({
      profile: 'fast',
      input: null,
      command: null
    });
  });

  it('passes when the current profile is within rough runtime budgets', () => {
    const baseline = JSON.parse(fs.readFileSync('docs/test-runtime-baseline.json', 'utf8'));
    const result = runtimeGuardrail.compareRuntime(makeProfile(process.cwd()), baseline, 'integration');

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(runtimeGuardrail.formatResult(result)).toContain('Test runtime guardrail passed.');
  });

  it('reports simulated slow-file regressions as actionable diagnostics', () => {
    const baseline = JSON.parse(fs.readFileSync('docs/test-runtime-baseline.json', 'utf8'));
    const result = runtimeGuardrail.compareRuntime(
      makeProfile(process.cwd(), { wallClockMs: 360000, localTrialMs: 160000 }),
      baseline,
      'integration'
    );
    const report = runtimeGuardrail.formatResult(result);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual([
      'command_wall_clock',
      'slow_file'
    ]);
    expect(report).toContain(runtimeGuardrail.ERROR_CODE);
    expect(report).toContain('tests/cli/local-multi-project-trial.test.ts');
    expect(report).toContain('fix avoidable setup or update the baseline with rationale');
  });

  it('reports failed test profiles as explicit diagnostics', () => {
    const baseline = JSON.parse(fs.readFileSync('docs/test-runtime-baseline.json', 'utf8'));
    const failedProfile = makeProfile(process.cwd());
    failedProfile.result.success = false;
    failedProfile.result.failed_tests = 1;

    const result = runtimeGuardrail.compareRuntime(failedProfile, baseline, 'integration');

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({
      kind: 'test_failure',
      message: 'integration test command did not pass (1 failed tests)'
    });
  });

  it('compares an existing profile JSON through the CLI path', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-runtime-guardrail-'));
    const inputPath = path.join(tempRoot, 'profile.json');
    fs.writeFileSync(inputPath, JSON.stringify(makeProfile(process.cwd())), 'utf8');

    const result = runScript(['--input', inputPath, '--command', 'integration'], process.cwd());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Test runtime guardrail passed.');
    expect(result.stdout).toContain('Command: integration');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('exits non-zero for fixture-based regressions through the CLI path', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-runtime-guardrail-regression-'));
    const inputPath = path.join(tempRoot, 'profile.json');
    fs.writeFileSync(inputPath, JSON.stringify(makeProfile(process.cwd(), { localTrialMs: 160000 })), 'utf8');

    const result = runScript(['--input', inputPath, '--command', 'integration'], process.cwd());

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(runtimeGuardrail.ERROR_CODE);
    expect(result.stdout).toContain('npm run test:profile:slow');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});
