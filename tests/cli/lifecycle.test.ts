import { describe, expect, it } from 'vitest';

import { runDashboardCli } from '../../src/runtime/cli-runner';

describe('CLI host lifecycle semantics', () => {
  it('exits success on normal startup and signal-based shutdown', async () => {
    const handlers: Array<() => void | Promise<void>> = [];
    const stdout: string[] = [];

    const runPromise = runDashboardCli([], {
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
      createRuntime: () => {
        throw new Error('startup exploded');
      }
    });

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('Failed to start dashboard: startup exploded');
  });

  it('exits nonzero on abnormal host fatal events', async () => {
    const fatalHandlers: Record<string, (error: unknown) => void> = {};

    const runPromise = runDashboardCli([], {
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

    const runPromise = runDashboardCli([], {
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
});