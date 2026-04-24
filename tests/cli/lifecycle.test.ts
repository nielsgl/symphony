import { describe, expect, it } from 'vitest';

import { runDashboardCli } from '../../src/runtime/cli-runner';
import { GUARDRAIL_ACK_FLAG } from '../../src/runtime/cli';

describe('CLI host lifecycle semantics', () => {
  it('[SPEC-17.7-1] exits success on normal startup and signal-based shutdown', async () => {
    const handlers: Array<() => void | Promise<void>> = [];
    const stdout: string[] = [];

    const runPromise = runDashboardCli([GUARDRAIL_ACK_FLAG], {
      cwd: '/repo',
      env: {},
      stdout: (line) => {
        stdout.push(line);
      },
      stderr: () => undefined,
      logger: { log: () => undefined },
      onFatal: () => undefined,
      onSignal: (_signal, handler) => {
        handlers.push(handler);
      },
      createRuntime: () => ({
        apiServer: null,
        start: async () => undefined,
        stop: async () => undefined
      })
    });

    await Promise.resolve();
    expect(handlers.length).toBeGreaterThan(0);
    await handlers[0]();

    const code = await runPromise;
    expect(code).toBe(0);
    expect(stdout.join('')).toContain('Press Ctrl+C to stop.');
  });

  it('exits nonzero and surfaces startup failures cleanly', async () => {
    const stderr: string[] = [];

    const code = await runDashboardCli([GUARDRAIL_ACK_FLAG], {
      cwd: '/repo',
      env: {},
      stdout: () => undefined,
      stderr: (line) => {
        stderr.push(line);
      },
      logger: { log: () => undefined },
      onFatal: () => undefined,
      onSignal: () => undefined,
      createRuntime: () => {
        throw new Error('startup exploded');
      }
    });

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('Failed to start dashboard: startup exploded');
  });

  it('exits nonzero on abnormal host fatal events', async () => {
    const fatalHandlers: Record<string, (error: unknown) => void> = {};

    const runPromise = runDashboardCli([GUARDRAIL_ACK_FLAG], {
      cwd: '/repo',
      env: {},
      stdout: () => undefined,
      stderr: () => undefined,
      logger: { log: () => undefined },
      onSignal: () => undefined,
      onFatal: (event, handler) => {
        fatalHandlers[event] = handler;
      },
      createRuntime: () => ({
        apiServer: null,
        start: async () => undefined,
        stop: async () => undefined
      })
    });

    await Promise.resolve();
    fatalHandlers.uncaughtException(new Error('boom'));

    const code = await runPromise;
    expect(code).toBe(1);
  });

  it('exits nonzero when shutdown fails during signal handling', async () => {
    const handlers: Array<() => void | Promise<void>> = [];

    const runPromise = runDashboardCli([GUARDRAIL_ACK_FLAG], {
      cwd: '/repo',
      env: {},
      stdout: () => undefined,
      stderr: () => undefined,
      logger: { log: () => undefined },
      onFatal: () => undefined,
      onSignal: (_signal, handler) => {
        handlers.push(handler);
      },
      createRuntime: () => ({
        apiServer: null,
        start: async () => undefined,
        stop: async () => {
          throw new Error('stop failed');
        }
      })
    });

    await Promise.resolve();
    await handlers[0]();
    const code = await runPromise;
    expect(code).toBe(1);
  });

  it('exits nonzero when guardrail acknowledgment flag is missing', async () => {
    const stderr: string[] = [];

    const code = await runDashboardCli([], {
      cwd: '/repo',
      env: {},
      stdout: () => undefined,
      stderr: (line) => {
        stderr.push(line);
      },
      logger: { log: () => undefined },
      onFatal: () => undefined,
      onSignal: () => undefined,
      createRuntime: () => ({
        apiServer: null,
        start: async () => undefined,
        stop: async () => undefined
      })
    });

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('--i-understand-that-this-will-be-running-without-the-usual-guardrails');
  });

  it('does not wire default CLI logger as runtime observer', async () => {
    const handlers: Array<() => void | Promise<void>> = [];
    const createRuntimeCalls: Array<{ logObserver?: unknown }> = [];
    const cliLogger = { log: () => undefined };

    const runPromise = runDashboardCli([GUARDRAIL_ACK_FLAG], {
      cwd: '/repo',
      env: {},
      stdout: () => undefined,
      stderr: () => undefined,
      logger: cliLogger,
      onFatal: () => undefined,
      onSignal: (_signal, handler) => {
        handlers.push(handler);
      },
      createRuntime: (options) => {
        createRuntimeCalls.push(options);
        return {
          apiServer: null,
          start: async () => undefined,
          stop: async () => undefined
        };
      }
    });

    await Promise.resolve();
    expect(createRuntimeCalls).toHaveLength(1);
    expect(createRuntimeCalls[0]?.logObserver).toBeUndefined();
    await handlers[0]();
    await runPromise;
  });
});
