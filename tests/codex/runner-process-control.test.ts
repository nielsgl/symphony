import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CodexRunner, CONTINUATION_GUIDANCE } from '../../src/codex';
import type { CodexRunnerEvent } from '../../src/codex';
import {
  DYNAMIC_TOOL_CONSOLE_RECOVERY_ACTION,
  UNSUPPORTED_DYNAMIC_TOOL_CONSOLE_RESUME_REASON_CODE
} from '../../src/observability/dynamic-tool-capability';
import { CANONICAL_EVENT } from '../../src/observability/events';
import { REASON_CODES } from '../../src/observability/reason-codes';
import type {
  AccountRateLimitsUpdatedNotification,
  ConfigWarningNotification,
  DeprecationNoticeNotification,
  GuardianWarningNotification,
  ModelReroutedNotification,
  ThreadTokenUsageUpdatedNotification,
  WarningNotification
} from '../fixtures/codex-app-server-contract/good/ts';
import {
  appendTranscriptText,
  expectGeneratedMethod,
  expectGeneratedPayloadShape,
  expectValueMatchesGeneratedSchema,
  FakeProcess,
  generatedDefinition,
  makeStartInput,
  makeWorkspace,
  parseWrittenMessages,
  writeTranscriptRecord
} from './runner-test-harness';

describe('CodexRunner process control', () => {
  it('settles deterministically and force-kills a cancelled app-server process that does not exit', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeProcess();
      const workspaceCwd = makeWorkspace();
      const controller = new AbortController();
      const runner = new CodexRunner({
        spawnProcess: () => fake
      });

      const promise = runner.startSessionAndRunTurn(
        makeStartInput(workspaceCwd, {
          cancellationSignal: controller.signal
        })
      );

      fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
      fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
      fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');

      const assertion = expect(promise).rejects.toMatchObject({
        code: 'turn_cancelled',
        message: 'worker_cancelled:operator_cancel_turn:forced_kill_requested'
      });
      controller.abort('operator_cancel_turn');
      await vi.advanceTimersByTimeAsync(700);

      await assertion;
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves graceful cancellation outcome when process exit races protocol port_exit', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeProcess();
      const originalKill = fake.kill.bind(fake);
      fake.kill = (signal?: NodeJS.Signals | number): void => {
        originalKill(signal);
        if (signal === 'SIGTERM') {
          setTimeout(() => fake.emitExit(0), 0);
        }
      };
      const workspaceCwd = makeWorkspace();
      const controller = new AbortController();
      const runner = new CodexRunner({
        spawnProcess: () => fake
      });

      const promise = runner.startSessionAndRunTurn(
        makeStartInput(workspaceCwd, {
          cancellationSignal: controller.signal
        })
      );

      fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
      fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
      fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');

      const assertion = expect(promise).rejects.toMatchObject({
        code: 'turn_cancelled',
        message: 'worker_cancelled:operator_cancel_turn:graceful_exit'
      });
      controller.abort('operator_cancel_turn');
      await vi.advanceTimersByTimeAsync(1);

      await assertion;
      expect(fake.signals).toEqual(['SIGTERM']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves forced-kill-exited cancellation outcome when process exit races protocol port_exit', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeProcess();
      const originalKill = fake.kill.bind(fake);
      fake.kill = (signal?: NodeJS.Signals | number): void => {
        originalKill(signal);
        if (signal === 'SIGKILL') {
          setTimeout(() => fake.emitExit(0), 0);
        }
      };
      const workspaceCwd = makeWorkspace();
      const controller = new AbortController();
      const runner = new CodexRunner({
        spawnProcess: () => fake
      });

      const promise = runner.startSessionAndRunTurn(
        makeStartInput(workspaceCwd, {
          cancellationSignal: controller.signal
        })
      );

      fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
      fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
      fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');

      const assertion = expect(promise).rejects.toMatchObject({
        code: 'turn_cancelled',
        message: 'worker_cancelled:operator_cancel_turn:forced_kill_exited'
      });
      controller.abort('operator_cancel_turn');
      await vi.advanceTimersByTimeAsync(600);

      await assertion;
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps read timeout to response_timeout', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({
      spawnProcess: () => fake
    });

    await expect(
      runner.startSessionAndRunTurn(
        makeStartInput(workspaceCwd, {
          readTimeoutMs: 10,
          turnTimeoutMs: 1000
        })
      )
    ).rejects.toMatchObject({
      code: 'response_timeout'
    });
  });

  it('maps turn timeout to turn_timeout', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({
      spawnProcess: () => fake
    });

    const promise = runner.startSessionAndRunTurn(
      makeStartInput(workspaceCwd, {
        turnTimeoutMs: 10
      })
    );

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');

    await expect(promise).rejects.toMatchObject({
      code: REASON_CODES.turnTimeout
    });
  });

  it('enforces turn timeout as a hard deadline despite repeated rate-limit metadata notifications', async () => {
    vi.useFakeTimers();
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const events: CodexRunnerEvent[] = [];
    const runner = new CodexRunner({
      spawnProcess: () => fake
    });

    try {
      const promise = runner.startSessionAndRunTurn(
        makeStartInput(workspaceCwd, {
          turnTimeoutMs: 100,
          onEvent: (event) => events.push(event)
        })
      );
      const rejection = expect(promise).rejects.toMatchObject({
        code: REASON_CODES.turnTimeout,
        message: expect.stringContaining('hard wall-clock deadline')
      });

      fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
      fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-rate-limit-stall"}}}\n');
      fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-rate-limit-stall"}}}\n');
      await vi.advanceTimersByTimeAsync(40);
      fake.emitStdout(
        `${JSON.stringify({
          method: 'account/rateLimits/updated',
          params: {
            account: {
              rateLimits: {
                primary: { remaining: 41, limit: 100, resetAt: '2026-05-11T13:30:00.000Z' }
              }
            }
          }
        } satisfies AccountRateLimitsUpdatedNotification & Record<string, unknown>)}\n`
      );
      await vi.advanceTimersByTimeAsync(40);
      fake.emitStdout(
        `${JSON.stringify({
          method: 'account/rateLimits/updated',
          params: {
            account: {
              rateLimits: {
                primary: { remaining: 40, limit: 100, resetAt: '2026-05-11T13:30:00.000Z' }
              }
            }
          }
        } satisfies AccountRateLimitsUpdatedNotification & Record<string, unknown>)}\n`
      );
      await vi.advanceTimersByTimeAsync(21);

      await rejection;
      expect(events).toContainEqual(
        expect.objectContaining({
          event: CANONICAL_EVENT.codex.turnTimedOut,
          reason_code: REASON_CODES.turnTimeout,
          thread_id: 'thread-rate-limit-stall',
          turn_id: 'turn-rate-limit-stall',
          session_id: 'thread-rate-limit-stall-turn-rate-limit-stall',
          detail: expect.stringContaining('timeout_ms=100')
        })
      );
      expect(events).not.toContainEqual(expect.objectContaining({ event: CANONICAL_EVENT.codex.startupFailed }));
    } finally {
      fake.emitExit();
      vi.useRealTimers();
    }
  });

  it('enforces turn timeout as a hard deadline while synthetic wait heartbeats continue', async () => {
    vi.useFakeTimers();
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const events: CodexRunnerEvent[] = [];
    const runner = new CodexRunner({
      spawnProcess: () => fake
    });

    try {
      const promise = runner.startSessionAndRunTurn(
        makeStartInput(workspaceCwd, {
          turnTimeoutMs: 5100,
          onEvent: (event) => events.push(event)
        })
      );
      const rejection = expect(promise).rejects.toMatchObject({
        code: REASON_CODES.turnTimeout,
        message: expect.stringContaining('hard wall-clock deadline')
      });

      fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
      fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-heartbeat-stall"}}}\n');
      fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-heartbeat-stall"}}}\n');
      await vi.advanceTimersByTimeAsync(5101);

      await rejection;
      expect(events).toContainEqual(
        expect.objectContaining({
          event: CANONICAL_EVENT.codex.turnWaiting,
          detail: 'waiting_for_turn_completion elapsed_s=5'
        })
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          event: CANONICAL_EVENT.codex.turnTimedOut,
          reason_code: REASON_CODES.turnTimeout,
          thread_id: 'thread-heartbeat-stall',
          turn_id: 'turn-heartbeat-stall',
          session_id: 'thread-heartbeat-stall-turn-heartbeat-stall'
        })
      );
      expect(events).not.toContainEqual(expect.objectContaining({ event: CANONICAL_EVENT.codex.startupFailed }));
    } finally {
      fake.emitExit();
      vi.useRealTimers();
    }
  });

  it('completes when app-server terminal evidence arrives before the hard turn deadline', async () => {
    vi.useFakeTimers();
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({
      spawnProcess: () => fake
    });

    try {
      const promise = runner.startSessionAndRunTurn(
        makeStartInput(workspaceCwd, {
          turnTimeoutMs: 100
        })
      );

      fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
      fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-terminal-before-deadline"}}}\n');
      fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-terminal-before-deadline"}}}\n');
      await vi.advanceTimersByTimeAsync(90);
      fake.emitStdout('{"method":"turn/completed"}\n');

      await expect(promise).resolves.toMatchObject({
        status: 'completed',
        thread_id: 'thread-terminal-before-deadline',
        turn_id: 'turn-terminal-before-deadline',
        terminal_source: 'app_server_protocol'
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps process exit to port_exit', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));
    fake.emitExit();

    await expect(promise).rejects.toMatchObject({ code: 'port_exit' });
  });

  it('maps codex command-not-found stderr to codex_not_found', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));
    fake.emitStderr('codex: command not found\n');
    fake.emitExit(127);

    await expect(promise).rejects.toMatchObject({ code: 'codex_not_found' });
  });
});
