import { describe, expect, it } from 'vitest';

import { ConfigValidator } from '../../src/workflow/validator';
import type { EffectiveConfig } from '../../src/workflow/types';

function baseConfig(): EffectiveConfig {
  return {
    tracker: {
      kind: 'linear',
      endpoint: 'https://api.linear.app/graphql',
      api_key: 'token',
      project_slug: 'ABC',
      active_states: ['Todo', 'In Progress'],
      terminal_states: ['Done']
    },
    polling: { interval_ms: 30000 },
    workspace: { root: '/tmp/symphony' },
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
    }
  };
}

describe('ConfigValidator', () => {
  it('returns ok for valid config', () => {
    const validator = new ConfigValidator();
    expect(validator.validate(baseConfig())).toEqual({ ok: true, at: expect.any(String) });
  });

  it('enforces supported tracker kind', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.tracker.kind = 'jira';

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('unsupported_tracker_kind');
    }
  });

  it('enforces tracker api key after resolution', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.tracker.api_key = '';

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('missing_tracker_api_key');
    }
  });

  it('enforces project slug for linear tracker', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.tracker.project_slug = '   ';

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('missing_tracker_project_slug');
    }
  });

  it('requires owner and repo for github tracker', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.tracker.kind = 'github';
    config.tracker.project_slug = '';
    config.tracker.owner = ' ';
    config.tracker.repo = 'symphony';

    const missingOwner = validator.validate(config);
    expect(missingOwner.ok).toBe(false);
    if (!missingOwner.ok) {
      expect(missingOwner.error_code).toBe('missing_tracker_owner');
    }

    config.tracker.owner = 'nielsgl';
    config.tracker.repo = '';

    const missingRepo = validator.validate(config);
    expect(missingRepo.ok).toBe(false);
    if (!missingRepo.ok) {
      expect(missingRepo.error_code).toBe('missing_tracker_repo');
    }
  });

  it('accepts valid github tracker config', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.tracker.kind = 'github';
    config.tracker.project_slug = '';
    config.tracker.owner = 'nielsgl';
    config.tracker.repo = 'symphony';
    config.tracker.active_states = ['Open'];

    expect(validator.validate(config)).toEqual({ ok: true, at: expect.any(String) });
  });

  it('rejects github tracker config when active_states cannot map to open/closed', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.tracker.kind = 'github';
    config.tracker.project_slug = '';
    config.tracker.owner = 'nielsgl';
    config.tracker.repo = 'symphony';
    config.tracker.active_states = ['Todo', 'In Progress'];

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_tracker_active_states_for_github');
    }
  });

  it('enforces non-empty codex command', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.codex.command = '   ';

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('missing_codex_command');
    }
  });

  it('blocks dispatch but allows reconciliation on failed preflight', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.codex.command = '';

    const outcome = validator.evaluateDispatchPreflight(config);
    expect(outcome.dispatch_allowed).toBe(false);
    expect(outcome.reconciliation_allowed).toBe(true);
    expect(outcome.validation.ok).toBe(false);
  });

  it('rejects unsupported codex approval policy values', () => {
    const validator = new ConfigValidator();
    const config = baseConfig();
    config.codex.approval_policy = 'always';

    const result = validator.validate(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe('invalid_codex_approval_policy');
    }
  });
});
