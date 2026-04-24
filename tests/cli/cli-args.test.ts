import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  GUARDRAIL_ACK_FLAG,
  parseGuardrailAck,
  parseLogsRoot,
  parseOfflineMode,
  parsePort,
  parseWorkflowPath,
  resolveCliRuntimeOptions
} from '../../src/runtime/cli';

describe('runtime CLI argument resolution', () => {
  it('prefers positional workflow path over --workflow and env', () => {
    const cwd = '/tmp/symphony';
    const env = {
      SYMPHONY_WORKFLOW_PATH: '/tmp/env/WORKFLOW.md'
    } as NodeJS.ProcessEnv;

    const parsed = parseWorkflowPath(
      ['custom/WORKFLOW.md', '--workflow=/tmp/flag/WORKFLOW.md'],
      env,
      cwd
    );

    expect(parsed.workflowPath).toBe('custom/WORKFLOW.md');
    expect(parsed.source).toBe('positional');
  });

  it('falls back to --workflow, env, and default in order', () => {
    const cwd = '/tmp/symphony';

    const byFlag = parseWorkflowPath(['--workflow=/tmp/flag/WORKFLOW.md'], {}, cwd);
    expect(byFlag.workflowPath).toBe('/tmp/flag/WORKFLOW.md');
    expect(byFlag.source).toBe('flag');

    const byEnv = parseWorkflowPath([], { SYMPHONY_WORKFLOW_PATH: '/tmp/env/WORKFLOW.md' }, cwd);
    expect(byEnv.workflowPath).toBe('/tmp/env/WORKFLOW.md');
    expect(byEnv.source).toBe('env');

    const byDefault = parseWorkflowPath([], {}, cwd);
    expect(byDefault.workflowPath).toBe(path.join(cwd, 'WORKFLOW.md'));
    expect(byDefault.source).toBe('default');
  });

  it('supports split-form --workflow path syntax', () => {
    const parsed = parseWorkflowPath(['--workflow', '/tmp/split/WORKFLOW.md'], {}, '/tmp/symphony');
    expect(parsed.workflowPath).toBe('/tmp/split/WORKFLOW.md');
    expect(parsed.source).toBe('flag');
  });

  it('uses CLI port over env port and accepts ephemeral port 0', () => {
    const parsed = parsePort(['--port=0'], {
      SYMPHONY_PORT: '4321'
    });

    expect(parsed.port).toBe(0);
    expect(parsed.source).toBe('cli');
  });

  it('uses env port when CLI port is absent and keeps HTTP unset otherwise', () => {
    const byEnv = parsePort([], {
      SYMPHONY_PORT: '4321'
    });
    expect(byEnv.port).toBe(4321);
    expect(byEnv.source).toBe('env');

    const unset = parsePort([], {});
    expect(unset.port).toBeUndefined();
    expect(unset.source).toBe('unset');
  });

  it('supports split-form --port value syntax', () => {
    const parsed = parsePort(['--port', '3001'], {});
    expect(parsed.port).toBe(3001);
    expect(parsed.source).toBe('cli');
  });

  it('parses optional logs root from equals and split flag forms', () => {
    const byEquals = parseLogsRoot(['--logs-root=/tmp/symphony-logs']);
    expect(byEquals).toEqual({
      logsRoot: '/tmp/symphony-logs',
      source: 'cli'
    });

    const bySplit = parseLogsRoot(['--logs-root', '/tmp/symphony-logs-split']);
    expect(bySplit).toEqual({
      logsRoot: '/tmp/symphony-logs-split',
      source: 'cli'
    });

    const unset = parseLogsRoot([]);
    expect(unset).toEqual({
      logsRoot: undefined,
      source: 'unset'
    });
  });

  it('resolves offline mode from CLI flag, then env, then default', () => {
    const byFlag = parseOfflineMode(['--offline'], {});
    expect(byFlag.offlineMode).toBe(true);
    expect(byFlag.source).toBe('flag');

    const byEnv = parseOfflineMode([], { SYMPHONY_OFFLINE: 'true' });
    expect(byEnv.offlineMode).toBe(true);
    expect(byEnv.source).toBe('env');

    const byDefault = parseOfflineMode([], {});
    expect(byDefault.offlineMode).toBe(false);
    expect(byDefault.source).toBe('default');
  });

  it('returns one cohesive runtime options object', () => {
    const parsed = resolveCliRuntimeOptions(
      ['workflow.md', '--port=0', '--offline', '--logs-root', '/tmp/log-root', GUARDRAIL_ACK_FLAG],
      {
        SYMPHONY_WORKFLOW_PATH: '/tmp/env/WORKFLOW.md',
        SYMPHONY_PORT: '3000'
      },
      '/tmp/symphony'
    );

    expect(parsed.workflow.workflowPath).toBe('workflow.md');
    expect(parsed.workflow.source).toBe('positional');
    expect(parsed.port.port).toBe(0);
    expect(parsed.port.source).toBe('cli');
    expect(parsed.offline.offlineMode).toBe(true);
    expect(parsed.offline.source).toBe('flag');
    expect(parsed.logs.logsRoot).toBe('/tmp/log-root');
    expect(parsed.logs.source).toBe('cli');
    expect(parsed.guardrails.acknowledged).toBe(true);
    expect(parsed.guardrails.source).toBe('flag');
  });

  it('parses mandatory guardrail acknowledgment flag', () => {
    expect(parseGuardrailAck([])).toEqual({
      acknowledged: false,
      source: 'missing'
    });

    expect(parseGuardrailAck([GUARDRAIL_ACK_FLAG])).toEqual({
      acknowledged: true,
      source: 'flag'
    });
  });
});
