import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const trial = require('../../scripts/lib/local-multi-project-trial.js') as {
  parseArgs(argv: string[]): {
    report: string | null;
    projectRoots: Array<{ path: string; required: boolean; shape: string }>;
    requiredProjectRoots: Array<{ path: string; required: boolean; shape: string }>;
  };
  runTrial(options: Record<string, unknown>): Promise<{ report: any; reportPath: string }>;
  summarizeEnv(env: Record<string, string | undefined>): any;
};

describe('local multi-project trial harness', () => {
  it('parses optional and required project roots without hardcoded paths', () => {
    const options = trial.parseArgs([
      '--project-shape',
      'existing-node',
      '--project-root',
      '/tmp/project-a',
      '--required-project-root',
      '/tmp/project-b'
    ]);

    expect(options.projectRoots).toEqual([{ path: '/tmp/project-a', required: false, shape: 'existing-node' }]);
    expect(options.requiredProjectRoots).toEqual([{ path: '/tmp/project-b', required: true, shape: 'existing-node' }]);
  });

  it('summarizes SYMPHONY and hosted credential environment without secret values', () => {
    const summary = trial.summarizeEnv({
      SYMPHONY_PORT: '1234',
      SYMPHONY_API_TOKEN: 'super-secret-token',
      GITHUB_TOKEN: 'ghp_secret'
    });

    expect(summary.symphony).toContainEqual({
      name: 'SYMPHONY_API_TOKEN',
      present: true,
      secret_like: true,
      value: '<redacted>'
    });
    expect(summary.symphony).toContainEqual({
      name: 'SYMPHONY_PORT',
      present: true,
      secret_like: false,
      value: '<present>'
    });
    expect(summary.hosted_credentials.find((item: any) => item.name === 'GITHUB_TOKEN')).toMatchObject({
      present: true,
      value: '<redacted>'
    });
  });

  it('fails closed when build output is missing and writes report shape', async () => {
    const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-trial-missing-build-')));
    const reportPath = path.join(repoRoot, 'trial-report.json');
    const { report } = await trial.runTrial({
      repoRoot,
      report: reportPath,
      env: {},
      operator: {
        source: 'local-development-fallback',
        command: process.execPath,
        argsPrefix: ['missing-script.js'],
        buildArtifact: path.join(repoRoot, 'dist', 'src', 'runtime', 'command-router.js'),
        fallbackEntrypoint: path.join(repoRoot, 'scripts', 'symphony.js')
      }
    });

    expect(report.summary.status).toBe('blocked');
    expect(report.lanes[0]).toMatchObject({
      id: 'preflight',
      status: 'blocked',
      findings: [
        {
          category: 'environment_prerequisite',
          severity: 'blocker'
        }
      ]
    });
    expect(JSON.parse(fs.readFileSync(reportPath, 'utf8'))).toMatchObject({
      version: 1,
      trial: 'local_multi_project',
      summary: { status: 'blocked' }
    });
  });
});
