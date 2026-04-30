import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const parityScriptPath = path.join(process.cwd(), 'scripts/check-upstream-parity.js');
const parityModule = require(parityScriptPath) as {
  classifyDelta: (filePath: string, patch: string) => string;
  matchesWatchlist: (filePath: string, watchlist: Array<{ path_glob: string; patch?: string; hunk_regex?: string[] }>) => boolean;
  parseBaselineSha: (config: { last_reviewed_sha?: string }) => string;
};

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

describe('check-upstream-parity script', () => {
  it('classifies spec and behavioral deltas deterministically', () => {
    expect(parityModule.classifyDelta('SPEC.md', 'The system MUST validate retries.')).toBe('spec_required');
    expect(parityModule.classifyDelta('elixir/test/example_test.exs', 'assert state == :running')).toBe('behavioral_risk');
    expect(parityModule.classifyDelta('elixir/lib/symphony/orchestrator/core.ex', 'retry state updated')).toBe(
      'behavioral_risk'
    );
    expect(parityModule.classifyDelta('README.md', 'text')).toBe('no_impact');
  });

  it('matches watchlist path globs', () => {
    const watchlist = [{ path_glob: 'SPEC.md' }, { path_glob: 'elixir/lib/**' }, { path_glob: 'elixir/test/**' }];
    expect(parityModule.matchesWatchlist('SPEC.md', watchlist)).toBe(true);
    expect(parityModule.matchesWatchlist('elixir/lib/symphony/orchestrator/core.ex', watchlist)).toBe(true);
    expect(parityModule.matchesWatchlist('README.md', watchlist)).toBe(false);
  });

  it('validates baseline SHA format', () => {
    expect(parityModule.parseBaselineSha({ last_reviewed_sha: '58cf97da06d556c019ccea20c67f4f77da124bf3' })).toBe(
      '58cf97da06d556c019ccea20c67f4f77da124bf3'
    );
    expect(() => parityModule.parseBaselineSha({ last_reviewed_sha: 'invalid' })).toThrow(
      'Config last_reviewed_sha must be a 40-character lowercase hex SHA.'
    );
  });

  it('produces deterministic json+markdown report and blocks in blocking mode with untriaged high-impact deltas', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-upstream-parity-'));
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'docs'), path.join(tempRoot, 'docs'), { recursive: true });
    fs.cpSync(path.join(root, 'tests/fixtures/upstream-parity'), path.join(tempRoot, 'tests/fixtures/upstream-parity'), {
      recursive: true
    });

    const advisory = runNode(
      [
        'scripts/check-upstream-parity.js',
        '--fixture',
        'tests/fixtures/upstream-parity/compare-mixed.json',
        '--mode',
        'advisory'
      ],
      tempRoot,
      { SYMPHONY_UPSTREAM_PARITY_HEAD_SHA: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
    );
    expect(advisory.status).toBe(0);
    expect(advisory.stdout).toContain('Upstream Delta Report');
    expect(fs.existsSync(path.join(tempRoot, 'docs/analysis/crossref/appendix/upstream-delta-report.json'))).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, 'docs/analysis/crossref/appendix/upstream-delta-report.md'))).toBe(true);

    const report = JSON.parse(
      fs.readFileSync(path.join(tempRoot, 'docs/analysis/crossref/appendix/upstream-delta-report.json'), 'utf8')
    ) as { summary: { high_impact_untriaged: number }; deltas: Array<{ file: string }> };
    expect(report.summary.high_impact_untriaged).toBeGreaterThan(0);
    expect(report.deltas.some((item) => item.file === 'SPEC.md')).toBe(true);
    expect(report.deltas.some((item) => item.file === 'elixir/WORKFLOW.md')).toBe(true);

    const blocking = runNode(
      [
        'scripts/check-upstream-parity.js',
        '--fixture',
        'tests/fixtures/upstream-parity/compare-mixed.json',
        '--mode',
        'blocking'
      ],
      tempRoot,
      { SYMPHONY_UPSTREAM_PARITY_HEAD_SHA: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
    );
    expect(blocking.status).toBe(1);
    expect(blocking.stderr).toContain('high-impact delta(s) are untriaged');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});
