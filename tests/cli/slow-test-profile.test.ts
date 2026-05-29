import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const slowTestProfile = require('../../scripts/profile-slow-tests.js') as {
  ERROR_CODE: string;
  parseArgs: (argv: string[]) => {
    limit: number;
    json: boolean;
    input: string | null;
    keepJson: boolean;
    help: boolean;
    vitestArgs: string[];
  };
  classifyHeavy: (
    filePath: string,
    assertions?: Array<{ fullName?: string; title?: string }>
  ) => { category: string; reasons: string[] };
  buildProfile: (
    payload: unknown,
    options: { cwd: string; wallClockMs: number; command: string; vitestCommand: string }
  ) => {
    result: { success: boolean; total_files: number; total_tests: number };
    groups: Array<{ category: string; files: number; duration_ms: number; slowest_file: string }>;
    slowest_files: Array<{ file: string; category: string; duration_ms: number; reasons: string[] }>;
    expensive_patterns: Array<{ file: string; name: string; duration_ms: number; category: string }>;
  };
  formatReport: (profile: unknown, limit?: number) => string;
};

function vitestFixture(root: string) {
  return {
    success: true,
    numTotalTests: 4,
    numPassedTests: 4,
    numFailedTests: 0,
    testResults: [
      {
        name: path.join(root, 'tests/workspace/provisioner.test.ts'),
        status: 'passed',
        startTime: 1000,
        endTime: 5500,
        assertionResults: [
          {
            fullName: 'workspace provisioner initializes a git worktree fixture',
            title: 'initializes a git worktree fixture',
            status: 'passed',
            duration: 3000
          },
          {
            fullName: 'workspace provisioner removes old workspace directories',
            title: 'removes old workspace directories',
            status: 'passed',
            duration: 800
          }
        ]
      },
      {
        name: path.join(root, 'tests/observability/logger.test.ts'),
        status: 'passed',
        startTime: 2000,
        endTime: 2600,
        assertionResults: [
          {
            fullName: 'logger renders stable key value logs',
            title: 'renders stable key value logs',
            status: 'passed',
            duration: 400
          },
          {
            fullName: 'logger redacts secrets',
            title: 'redacts secrets',
            status: 'passed',
            duration: 100
          }
        ]
      }
    ]
  };
}

function runScript(args: string[], cwd: string) {
  return spawnSync(process.execPath, [path.join(process.cwd(), 'scripts/profile-slow-tests.js'), ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env
    }
  });
}

describe('slow test profile report', () => {
  it('parses report options while preserving Vitest filters', () => {
    const parsed = slowTestProfile.parseArgs([
      '--limit=5',
      '--json',
      '--keep-json',
      '--input',
      'report.json',
      'tests/workspace'
    ]);

    expect(parsed.limit).toBe(5);
    expect(parsed.json).toBe(true);
    expect(parsed.keepJson).toBe(true);
    expect(parsed.input).toBe('report.json');
    expect(parsed.vitestArgs).toEqual(['tests/workspace']);
  });

  it('classifies git worktree and process-heavy tests separately from routine unit tests', () => {
    expect(
      slowTestProfile.classifyHeavy('tests/workspace/provisioner.test.ts', [
        { fullName: 'initializes a git worktree fixture' }
      ])
    ).toEqual({ category: 'git/worktree/process-heavy', reasons: ['git', 'worktree'] });

    expect(slowTestProfile.classifyHeavy('tests/observability/logger.test.ts')).toEqual({
      category: 'routine unit',
      reasons: []
    });
  });

  it('builds a concise profile with wall clock, slow files, groups, and patterns', () => {
    const root = process.cwd();
    const profile = slowTestProfile.buildProfile(vitestFixture(root), {
      cwd: root,
      wallClockMs: 6200,
      command: 'npm run test:profile:slow',
      vitestCommand: 'npx vitest run --reporter=json'
    });
    const report = slowTestProfile.formatReport(profile, 2);

    expect(profile.result).toMatchObject({ success: true, total_files: 2, total_tests: 4 });
    expect(profile.groups.map((group) => group.category)).toEqual(['git/worktree/process-heavy', 'routine unit']);
    expect(profile.slowest_files[0]).toMatchObject({
      file: 'tests/workspace/provisioner.test.ts',
      category: 'git/worktree/process-heavy',
      duration_ms: 4500
    });
    expect(profile.expensive_patterns[0].name).toContain('git worktree fixture');
    expect(report).toContain('Wall clock: 6.20s');
    expect(report).toContain('Groups:');
    expect(report).toContain('Slowest files (top 2):');
    expect(report).toContain('Expensive test patterns (top 2):');
  });

  it('emits table and JSON reports from an existing Vitest JSON input', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-slow-profile-'));
    const input = path.join(tempRoot, 'vitest.json');
    fs.writeFileSync(input, JSON.stringify(vitestFixture(tempRoot)), 'utf8');

    const table = runScript(['--input', input, '--limit=1'], tempRoot);
    expect(table.status).toBe(0);
    expect(table.stdout).toContain('Slow test profile');
    expect(table.stdout).toContain('git/worktree/process-heavy');
    expect(table.stdout).toContain('tests/workspace/provisioner.test.ts');

    const json = runScript(['--input', input, '--json'], tempRoot);
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.result.success).toBe(true);
    expect(parsed.groups).toHaveLength(2);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('reports typed failures for invalid options', () => {
    const result = runScript(['--limit=0'], process.cwd());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(slowTestProfile.ERROR_CODE);
  });
});
