import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ConfigResolver } from '../../src/workflow/resolver';
import type { WorkflowDefinition } from '../../src/workflow/types';

const baseWorkflow: WorkflowDefinition = {
  config: {},
  prompt_template: 'prompt'
};

describe('ConfigResolver', () => {
  it('applies defaults when optional fields are absent', () => {
    const resolver = new ConfigResolver({
      env: {},
      homedir: () => '/home/tester',
      tmpdir: () => '/tmp'
    });

    const config = resolver.resolve(baseWorkflow);

    expect(config.polling.interval_ms).toBe(30000);
    expect(config.tracker.active_states).toEqual(['Todo', 'In Progress']);
    expect(config.workspace.root).toBe('/tmp/symphony_workspaces');
    expect(config.codex.command).toBe('codex app-server');
  });

  it('resolves $VAR for tracker.api_key and workspace.root', () => {
    const resolver = new ConfigResolver({
      env: {
        LINEAR_API_KEY: 'secret-token',
        WORKSPACE_ROOT: '/srv/workspaces'
      },
      homedir: () => '/home/tester',
      tmpdir: () => '/tmp'
    });

    const config = resolver.resolve({
      config: {
        tracker: { kind: 'linear', api_key: '$LINEAR_API_KEY', project_slug: 'ABC' },
        workspace: { root: '$WORKSPACE_ROOT' }
      },
      prompt_template: 'prompt'
    });

    expect(config.tracker.api_key).toBe('secret-token');
    expect(config.workspace.root).toBe('/srv/workspaces');
  });

  it('treats empty resolved $VAR as missing value', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        tracker: { kind: 'linear', api_key: '$LINEAR_API_KEY', project_slug: 'ABC' }
      },
      prompt_template: 'prompt'
    });

    expect(config.tracker.api_key).toBe('');
  });

  it('expands ~ for path-intended fields', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        workspace: { root: '~/sym/workspaces' }
      },
      prompt_template: 'prompt'
    });

    expect(config.workspace.root).toBe(path.normalize('/home/tester/sym/workspaces'));
  });

  it('preserves bare path strings without separators', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        workspace: { root: 'relativeRoot' }
      },
      prompt_template: 'prompt'
    });

    expect(config.workspace.root).toBe('relativeRoot');
  });

  it('normalizes per-state concurrency map and ignores invalid entries', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        agent: {
          max_concurrent_agents_by_state: {
            'In Progress': '3',
            Todo: 0,
            Blocked: -1,
            Review: 'abc'
          }
        }
      },
      prompt_template: 'prompt'
    });

    expect(config.agent.max_concurrent_agents_by_state).toEqual({
      'in progress': 3
    });
  });

  it('preserves codex.command as a shell command string', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        codex: { command: 'codex app-server --profile danger-full-access' }
      },
      prompt_template: 'prompt'
    });

    expect(config.codex.command).toBe('codex app-server --profile danger-full-access');
  });

  it('falls back hooks timeout to default when configured non-positive', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        hooks: { timeout_ms: 0 }
      },
      prompt_template: 'prompt'
    });

    expect(config.hooks.timeout_ms).toBe(60000);
  });
});
