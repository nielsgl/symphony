import { describe, expect, it } from 'vitest';

import { EffectiveConfigStore } from '../../src/workflow/store';

function makeSnapshotInputs() {
  return {
    workflowDefinition: {
      config: { tracker: { kind: 'linear' } },
      prompt_template: 'Prompt'
    },
    effectiveConfig: {
      tracker: {
        kind: 'linear',
        endpoint: 'https://api.linear.app/graphql',
        api_key: 'token',
        project_slug: 'ABC',
        active_states: ['Todo', 'In Progress'],
        terminal_states: ['Done']
      },
      polling: { interval_ms: 30000 },
      workspace: {
        root: '/tmp/symphony',
        root_source: 'workflow' as const,
        provisioner: {
          type: 'none' as const,
          base_ref: 'origin/main',
          branch_template: 'feature/{{ issue.identifier }}',
          teardown_mode: 'remove_worktree' as const,
          allow_dirty_repo: false,
          fallback_to_clone_on_worktree_failure: false
        },
        copy_ignored: {
          enabled: false,
          include_file: '/tmp/symphony/.worktreeinclude',
          from: 'primary_worktree' as const,
          conflict_policy: 'skip' as const,
          require_gitignored: true,
          max_files: 10_000,
          max_total_bytes: 5 * 1024 * 1024 * 1024,
          allow_patterns: [],
          deny_patterns: []
        }
      },
      hooks: { timeout_ms: 60000 },
      agent: {
        max_concurrent_agents: 10,
        max_retry_backoff_ms: 300000,
        max_turns: 20,
        max_concurrent_agents_by_state: {}
      },
      codex: {
        command: 'codex app-server',
        turn_timeout_ms: 3600000,
        read_timeout_ms: 5000,
        stall_timeout_ms: 300000
      },
      persistence: {
        enabled: true,
        db_path: '/tmp/symphony/runtime.sqlite',
        retention_days: 14
      },
      logging: {
        root: '/tmp/symphony/log',
        root_source: 'workflow' as const,
        max_bytes: 10 * 1024 * 1024,
        max_files: 5
      },
      validation: {
        ui_evidence_profile: 'baseline'
      }
    },
    promptTemplate: 'Prompt',
    lastReloadStatus: {
      ok: true,
      at: new Date('2026-04-10T00:00:00Z').toISOString(),
      source: 'startup' as const
    }
  };
}

describe('EffectiveConfigStore', () => {
  it('atomically stores a snapshot with version hash', () => {
    const store = new EffectiveConfigStore();
    const snapshot = store.setSnapshot(makeSnapshotInputs());

    expect(snapshot.versionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(store.getSnapshot()).toEqual(snapshot);
  });

  it('changes version hash when effective config changes', () => {
    const store = new EffectiveConfigStore();
    const first = store.setSnapshot(makeSnapshotInputs());

    const secondInput = makeSnapshotInputs();
    secondInput.effectiveConfig.polling.interval_ms = 15000;
    const second = store.setSnapshot(secondInput);

    expect(second.versionHash).not.toBe(first.versionHash);
  });
});
