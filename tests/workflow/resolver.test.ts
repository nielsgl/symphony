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
    expect(config.workspace.root_source).toBe('default');
    expect(config.workspace.provisioner).toEqual({
      type: 'none',
      base_ref: 'origin/main',
      branch_template: 'feature/{{ issue.identifier }}',
      teardown_mode: 'remove_worktree',
      allow_dirty_repo: false,
      fallback_to_clone_on_worktree_failure: false
    });
    expect(config.codex.command).toBe('codex app-server');
    expect(config.persistence.enabled).toBe(true);
    expect(config.persistence.retention_days).toBe(14);
    expect(config.observability).toEqual({
      dashboard_enabled: true,
      refresh_ms: 4000,
      render_interval_ms: 1000
    });
    expect(config.logging.root).toBe(path.normalize('/home/tester/.symphony/log'));
    expect(config.logging.root_source).toBe('default');
    expect(config.logging.max_bytes).toBe(10 * 1024 * 1024);
    expect(config.logging.max_files).toBe(5);
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
    expect(config.workspace.root_source).toBe('workflow');
  });

  it('resolves $VAR for tracker.project_slug', () => {
    const resolver = new ConfigResolver({
      env: {
        LINEAR_PROJECT_SLUG: 'SYMPHONY'
      },
      homedir: () => '/home/tester',
      tmpdir: () => '/tmp'
    });

    const config = resolver.resolve({
      config: {
        tracker: { kind: 'linear', api_key: 'token', project_slug: '$LINEAR_PROJECT_SLUG' }
      },
      prompt_template: 'prompt'
    });

    expect(config.tracker.project_slug).toBe('SYMPHONY');
  });

  it('uses github defaults for endpoint and token fallback', () => {
    const resolver = new ConfigResolver({
      env: {
        GITHUB_TOKEN: 'gh-token'
      },
      homedir: () => '/home/tester',
      tmpdir: () => '/tmp'
    });

    const config = resolver.resolve({
      config: {
        tracker: {
          kind: 'github',
          owner: 'nielsgl',
          repo: 'symphony'
        }
      },
      prompt_template: 'prompt'
    });

    expect(config.tracker.endpoint).toBe('https://api.github.com/graphql');
    expect(config.tracker.api_key).toBe('gh-token');
    expect(config.tracker.owner).toBe('nielsgl');
    expect(config.tracker.repo).toBe('symphony');
    expect(config.tracker.active_states).toEqual(['Open']);
    expect(config.tracker.terminal_states).toEqual(['Closed']);
  });

  it('uses memory defaults without tracker token fallback', () => {
    const resolver = new ConfigResolver({
      env: {
        LINEAR_API_KEY: 'linear-token',
        GITHUB_TOKEN: 'gh-token'
      },
      homedir: () => '/home/tester',
      tmpdir: () => '/tmp'
    });

    const config = resolver.resolve({
      config: {
        tracker: {
          kind: 'memory'
        }
      },
      prompt_template: 'prompt'
    });

    expect(config.tracker.endpoint).toBe('memory://local');
    expect(config.tracker.api_key).toBe('');
    expect(config.tracker.active_states).toEqual(['Todo', 'In Progress']);
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

  it('resolves optional tracker.assignee from workflow config', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        tracker: {
          kind: 'linear',
          api_key: 'token',
          project_slug: 'ABC',
          assignee: 'me'
        }
      },
      prompt_template: 'prompt'
    });

    expect(config.tracker.assignee).toBe('me');
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
    expect(config.workspace.root_source).toBe('workflow');
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
    expect(config.workspace.root_source).toBe('workflow');
  });

  it('resolves relative workspace.root against workflow directory when workflow path is provided', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve(
      {
        config: {
          workspace: { root: './.symphony/workspaces' }
        },
        prompt_template: 'prompt'
      },
      { workflowPath: '/workspace/projects/todo-app/WORKFLOW.md' }
    );

    expect(config.workspace.root).toBe(path.normalize('/workspace/projects/todo-app/.symphony/workspaces'));
    expect(config.workspace.root_source).toBe('workflow');
  });

  it('resolves relative workspace.provisioner.repo_root against workflow directory', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve(
      {
        config: {
          workspace: {
            provisioner: {
              type: 'worktree',
              repo_root: '../app',
              base_ref: 'origin/main',
              branch_template: 'feature/{{ issue.identifier }}',
              teardown_mode: 'remove_worktree'
            }
          }
        },
        prompt_template: 'prompt'
      },
      { workflowPath: '/workspace/projects/todo-app/WORKFLOW.md' }
    );

    expect(config.workspace.provisioner).toMatchObject({
      type: 'worktree',
      repo_root: path.normalize('/workspace/projects/app'),
      base_ref: 'origin/main',
      branch_template: 'feature/{{ issue.identifier }}',
      teardown_mode: 'remove_worktree'
    });
  });

  it('resolves workspace.provisioner.repo_root dot path against workflow directory', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve(
      {
        config: {
          workspace: {
            provisioner: {
              type: 'worktree',
              repo_root: '.',
              base_ref: 'origin/main',
              branch_template: 'feature/{{ issue.identifier }}',
              teardown_mode: 'remove_worktree'
            }
          }
        },
        prompt_template: 'prompt'
      },
      { workflowPath: '/workspace/projects/todo-app/WORKFLOW.md' }
    );

    expect(config.workspace.provisioner).toMatchObject({
      type: 'worktree',
      repo_root: path.normalize('/workspace/projects/todo-app'),
      base_ref: 'origin/main',
      branch_template: 'feature/{{ issue.identifier }}',
      teardown_mode: 'remove_worktree'
    });
  });

  it('normalizes per-state concurrency map and preserves invalid entries for validation', () => {
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
      'in progress': 3,
      todo: 0,
      blocked: -1,
      review: Number.NaN
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

  it('preserves configured hooks timeout when provided for strict validation', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        hooks: { timeout_ms: 0 }
      },
      prompt_template: 'prompt'
    });

    expect(config.hooks.timeout_ms).toBe(0);
  });

  it('keeps default numeric values when optional fields are missing', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {},
      prompt_template: 'prompt'
    });

    expect(config.polling.interval_ms).toBe(30000);
    expect(config.hooks.timeout_ms).toBe(60000);
    expect(config.agent.max_concurrent_agents).toBe(10);
    expect(config.agent.max_turns).toBe(20);
    expect(config.agent.max_retry_backoff_ms).toBe(300000);
    expect(config.codex.turn_timeout_ms).toBe(3600000);
    expect(config.codex.read_timeout_ms).toBe(5000);
    expect(config.codex.stall_timeout_ms).toBe(300000);
  });

  it('preserves invalid configured numeric values for fail-fast validation', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        polling: { interval_ms: 'abc' },
        hooks: { timeout_ms: 'abc' }
      },
      prompt_template: 'prompt'
    });

    expect(Number.isNaN(config.polling.interval_ms)).toBe(true);
    expect(Number.isNaN(config.hooks.timeout_ms)).toBe(true);
  });

  it('resolves codex profile overrides and persistence path', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        codex: {
          security_profile: 'balanced',
          approval_policy: 'on-request',
          thread_sandbox: 'workspace-write',
          turn_sandbox_policy: 'workspace',
          user_input_policy: 'fail_attempt'
        },
        persistence: {
          enabled: true,
          db_path: '~/symphony/runtime.sqlite',
          retention_days: 30
        }
      },
      prompt_template: 'prompt'
    });

    expect(config.codex.security_profile).toBe('balanced');
    expect(config.codex.approval_policy).toBe('on-request');
    expect(config.persistence.db_path).toBe(path.normalize('/home/tester/symphony/runtime.sqlite'));
    expect(config.persistence.retention_days).toBe(30);
  });

  it('defaults persistence.db_path to workflow directory when workflow path is provided', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve(
      {
        config: {},
        prompt_template: 'prompt'
      },
      { workflowPath: '/workspace/projects/todo-app/WORKFLOW.md' }
    );

    expect(config.persistence.db_path).toBe(path.normalize('/workspace/projects/todo-app/.symphony/runtime.sqlite'));
    expect(config.logging.root).toBe(path.normalize('/workspace/projects/todo-app/.symphony/log'));
    expect(config.logging.root_source).toBe('default');
  });

  it('resolves optional server.host with server.port', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });
    const config = resolver.resolve({
      config: {
        server: {
          port: 3000,
          host: '0.0.0.0'
        }
      },
      prompt_template: 'prompt'
    });

    expect(config.server).toEqual({
      port: 3000,
      host: '0.0.0.0'
    });
  });

  it('resolves optional logging.root from workflow config', () => {
    const resolver = new ConfigResolver({
      env: {
        SYMPHONY_LOG_ROOT: '/var/log/symphony'
      },
      homedir: () => '/home/tester',
      tmpdir: () => '/tmp'
    });

    const config = resolver.resolve(
      {
        config: {
          logging: {
            root: '$SYMPHONY_LOG_ROOT'
          }
        },
        prompt_template: 'prompt'
      },
      { workflowPath: '/workspace/projects/todo-app/WORKFLOW.md' }
    );

    expect(config.logging.root).toBe('/var/log/symphony');
    expect(config.logging.root_source).toBe('workflow');
  });

  it('resolves observability dashboard knobs with safe minimums', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });
    const config = resolver.resolve({
      config: {
        observability: {
          dashboard_enabled: false,
          refresh_ms: 100,
          render_interval_ms: 50
        }
      },
      prompt_template: 'prompt'
    });

    expect(config.observability).toEqual({
      dashboard_enabled: false,
      refresh_ms: 500,
      render_interval_ms: 250
    });
  });

  it('resolves optional logging.max_bytes and logging.max_files from workflow config', () => {
    const resolver = new ConfigResolver({
      env: {},
      homedir: () => '/home/tester',
      tmpdir: () => '/tmp'
    });

    const config = resolver.resolve(
      {
        config: {
          logging: {
            max_bytes: 2097152,
            max_files: 7
          }
        },
        prompt_template: 'prompt'
      },
      { workflowPath: '/workspace/projects/todo-app/WORKFLOW.md' }
    );

    expect(config.logging.max_bytes).toBe(2097152);
    expect(config.logging.max_files).toBe(7);
  });

  it('parses optional worker extension fields', () => {
    const resolver = new ConfigResolver({ env: {}, homedir: () => '/home/tester', tmpdir: () => '/tmp' });

    const config = resolver.resolve({
      config: {
        worker: {
          ssh_hosts: [' build-1 ', '', 'build-2'],
          max_concurrent_agents_per_host: '2'
        }
      },
      prompt_template: 'prompt'
    });

    expect(config.worker).toEqual({
      ssh_hosts: ['build-1', 'build-2'],
      max_concurrent_agents_per_host: 2
    });
  });
});
