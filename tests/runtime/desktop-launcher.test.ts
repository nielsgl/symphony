import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createBackendLaunchConfig, parseDashboardUrl } from '../../src/runtime';

describe('desktop launcher helpers', () => {
  it('parses dashboard startup URL from launcher output', () => {
    const line = 'Symphony dashboard running at http://127.0.0.1:4123/';
    expect(parseDashboardUrl(line)).toBe('http://127.0.0.1:4123/');
    expect(parseDashboardUrl('unrelated line')).toBeNull();
  });

  it('builds backend launch config with explicit workflow path', () => {
    const repoRoot = '/tmp/symphony';
    const config = createBackendLaunchConfig({
      repoRoot,
      workflowPath: '/tmp/custom/WORKFLOW.md',
      nodeBinary: '/usr/local/bin/node'
    });

    expect(config.nodeBinary).toBe('/usr/local/bin/node');
    expect(config.scriptPath).toBe(path.join(repoRoot, 'scripts', 'start-dashboard.js'));
    expect(config.args).toEqual([
      path.join(repoRoot, 'scripts', 'start-dashboard.js'),
      '--port=0',
      '--workflow=/tmp/custom/WORKFLOW.md'
    ]);
    expect(config.cwd).toBe(repoRoot);
  });

  it('defaults workflow file to repository WORKFLOW.md', () => {
    const repoRoot = '/tmp/symphony';
    const config = createBackendLaunchConfig({ repoRoot, nodeBinary: '/usr/bin/node' });

    expect(config.args[2]).toBe(`--workflow=${path.join(repoRoot, 'WORKFLOW.md')}`);
  });

  it('adds offline argument when desktop offline mode is enabled', () => {
    const repoRoot = '/tmp/symphony';
    const config = createBackendLaunchConfig({
      repoRoot,
      nodeBinary: '/usr/bin/node',
      offlineMode: true
    });

    expect(config.args).toContain('--offline');
  });
});
