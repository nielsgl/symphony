import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vitestGroup = require('../../scripts/run-vitest-group.js') as {
  INTEGRATION_TEST_FILES: Array<{ file: string; reason: string }>;
  buildVitestArgs: (mode: string, extraArgs?: string[]) => string[];
  formatMovedFiles: () => string;
  parseArgs: (argv: string[]) => { mode: string; list: boolean; help: boolean; vitestArgs: string[] };
};

describe('Vitest test group runner', () => {
  it('keeps the moved simulation-heavy files explicit and documented', () => {
    expect(vitestGroup.INTEGRATION_TEST_FILES.map(({ file }) => file)).toEqual([
      'tests/cli/local-multi-project-trial.test.ts',
      'tests/runtime/bootstrap.test.ts',
      'tests/cli/meta-check-scripts.test.ts',
      'tests/runtime/update-manager.test.ts',
      'tests/cli/local-command-router.test.ts',
      'tests/api/server-state.test.ts',
      'tests/cli/doctor-mvp-scenario-matrix.test.ts',
      'tests/cli/workspace-before-remove.test.ts',
      'tests/cli/worktree-bootstrap.test.ts'
    ]);
    expect(vitestGroup.INTEGRATION_TEST_FILES.every(({ reason }) => reason.length > 20)).toBe(true);
  });

  it('builds a fast command that excludes the integration simulations', () => {
    const args = vitestGroup.buildVitestArgs('fast', ['--reporter=dot']);

    expect(args[0]).toBe('run');
    expect(args).toContain('--reporter=dot');
    expect(args).toContain('--exclude=tests/cli/local-multi-project-trial.test.ts');
    expect(args).toContain('--exclude=tests/runtime/bootstrap.test.ts');
    expect(args).not.toContain('tests/cli/local-multi-project-trial.test.ts');
  });

  it('builds integration and full commands without hiding coverage', () => {
    expect(vitestGroup.buildVitestArgs('integration').slice(0, 3)).toEqual([
      'run',
      'tests/cli/local-multi-project-trial.test.ts',
      'tests/runtime/bootstrap.test.ts'
    ]);
    expect(vitestGroup.buildVitestArgs('full', ['tests/workflow'])).toEqual(['run', 'tests/workflow']);
  });

  it('prints the moved file list for handoff evidence', () => {
    const report = vitestGroup.formatMovedFiles();

    expect(report).toContain('Simulation-heavy files excluded from the fast unit path:');
    expect(report).toContain('tests/runtime/update-manager.test.ts');
    expect(report).toContain('profiled at');
  });

  it('parses list mode separately from forwarded Vitest arguments', () => {
    expect(vitestGroup.parseArgs(['integration', '--list', '--reporter=dot'])).toEqual({
      mode: 'integration',
      list: true,
      help: false,
      vitestArgs: ['--reporter=dot']
    });
  });

  it('keeps README validation guidance on local npm test commands', () => {
    const readme = readFileSync('README.md', 'utf8');

    expect(readme).toMatch(/npm\s+run\s+test:full\s+--\s+<file-or-filter>/);
    expect(readme).not.toContain('npx vitest run');
  });
});
