import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { CodexRunner, CONTINUATION_GUIDANCE } from '../../src/codex';
import type { CodexRunnerStartInput } from '../../src/codex';
import {
  DYNAMIC_TOOL_CONSOLE_RECOVERY_ACTION,
  UNSUPPORTED_DYNAMIC_TOOL_CONSOLE_RESUME_REASON_CODE
} from '../../src/observability/dynamic-tool-capability';
import { CANONICAL_EVENT } from '../../src/observability/events';
import { REASON_CODES } from '../../src/observability/reason-codes';

class FakeProcess {
  pid: number | null = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  private readonly exitEmitter = new EventEmitter();
  readonly writes: string[] = [];
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];
  killed = false;
  stdin = {
    write: (data: string) => {
      this.writes.push(data.trim());
    }
  };

  kill(signal?: NodeJS.Signals | number): void {
    this.signals.push(signal);
    this.killed = true;
  }

  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitEmitter.once(event, listener);
  }

  emitStdout(line: string): void {
    this.stdout.emit('data', Buffer.from(line, 'utf8'));
  }

  emitStderr(line: string): void {
    this.stderr.emit('data', Buffer.from(line, 'utf8'));
  }

  emitExit(code: number | null = 1): void {
    this.exitEmitter.emit('exit', code, null);
  }
}

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-runner-'));
}

function makeStartInput(workspaceCwd: string, overrides: Partial<CodexRunnerStartInput> = {}): CodexRunnerStartInput {
  return {
    command: 'codex app-server',
    workspaceCwd,
    prompt: 'hello',
    title: 'ABC-1: Title',
    readTimeoutMs: 1000,
    turnTimeoutMs: 1000,
    ...overrides
  };
}

function parseWrittenMessages(fake: FakeProcess): Array<Record<string, unknown>> {
  return fake.writes.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function writeTranscriptRecord(codexHome: string, filename: string, record: Record<string, unknown>): void {
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '05', '07');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.appendFileSync(path.join(sessionsDir, filename), `${JSON.stringify(record)}\n`, 'utf8');
}

function appendTranscriptText(codexHome: string, filename: string, text: string): void {
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '05', '07');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.appendFileSync(path.join(sessionsDir, filename), text, 'utf8');
}

describe('CodexRunner', () => {
  it('[SPEC-10.1-1][SPEC-17.5-1] launches with bash command/cwd and performs ordered startup handshake', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const spawnCalls: Array<{ command: string; cwd: string }> = [];
    const runner = new CodexRunner({
      spawnProcess: ({ command, cwd }) => {
        spawnCalls.push({ command, cwd });
        return fake;
      }
    });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout('{"method":"turn/completed","params":{}}\n');

    const result = await promise;

    expect(spawnCalls).toEqual([{ command: 'codex app-server', cwd: workspaceCwd }]);
    expect(result).toEqual({
      status: 'completed',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1',
      last_event: CANONICAL_EVENT.codex.turnCompleted,
      turns_completed: 1,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0
      },
      token_telemetry_status: 'unavailable',
      token_telemetry_last_source: null,
      token_telemetry_last_at_ms: null,
      rate_limits: null,
      terminal_source: 'app_server_protocol'
    });

    const writtenMethods = parseWrittenMessages(fake)
      .map((line) => (typeof line.method === 'string' ? line.method : null))
      .filter((method): method is string => Boolean(method));
    expect(writtenMethods).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);

    const turnStart = parseWrittenMessages(fake).find((line) => line.method === 'turn/start') as
      | { params?: Record<string, unknown> }
      | undefined;
    expect((turnStart?.params?.sandboxPolicy as { type: string }).type).toBe('workspaceWrite');
    const threadStart = parseWrittenMessages(fake).find((line) => line.method === 'thread/start') as
      | { params?: Record<string, unknown> }
      | undefined;
    expect(threadStart?.params?.dynamicTools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'linear_graphql' })])
    );
  });

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

  it('launches typed commands with native args and env instead of bash interpolation', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const spawnCalls: Array<{ command: string; args?: string[]; env?: Record<string, string>; cwd: string }> = [];
    const runner = new CodexRunner({
      spawnProcess: ({ command, args, env, cwd }) => {
        spawnCalls.push({ command, args, env, cwd });
        return fake;
      }
    });

    const promise = runner.startSessionAndRunTurn(
      makeStartInput(workspaceCwd, {
        command: 'codex',
        commandArgs: ['--config', 'model="gpt-test"', '--config', 'model_reasoning_effort=medium', 'app-server'],
        commandEnv: { CODEX_HOME: '/tmp/codex-home' }
      })
    );

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout('{"method":"turn/completed","params":{}}\n');

    await expect(promise).resolves.toMatchObject({ status: 'completed' });
    expect(spawnCalls).toEqual([
      {
        command: 'codex',
        args: ['--config', 'model="gpt-test"', '--config', 'model_reasoning_effort=medium', 'app-server'],
        env: { CODEX_HOME: '/tmp/codex-home' },
        cwd: workspaceCwd
      }
    ]);
  });

  it('retries thread/start without dynamicTools when app-server requires experimentalApi capability', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({
      spawnProcess: () => fake
    });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout(
      '{"id":2,"error":{"code":"invalid_request","message":"thread/start.dynamicTools requires experimentalApi capability"}}\n'
    );
    fake.emitStdout('{"id":3,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":4,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout('{"method":"turn/completed","params":{}}\n');

    await expect(promise).resolves.toMatchObject({
      status: 'completed',
      thread_id: 'thread-1',
      turn_id: 'turn-1'
    });

    const threadStartRequests = parseWrittenMessages(fake).filter((line) => line.method === 'thread/start');
    expect(threadStartRequests).toHaveLength(2);
    expect((threadStartRequests[0].params as Record<string, unknown>).dynamicTools).toBeTruthy();
    expect((threadStartRequests[1].params as Record<string, unknown>).dynamicTools).toBeUndefined();
  });

  it('maps legacy kebab-case turn sandbox policy values to protocol camelCase', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(
      makeStartInput(workspaceCwd, {
        turnSandboxPolicy: { type: 'danger-full-access' }
      })
    );

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout('{"method":"turn/completed","params":{}}\n');

    await expect(promise).resolves.toMatchObject({ status: 'completed' });

    const turnStart = parseWrittenMessages(fake).find((line) => line.method === 'turn/start') as
      | { params?: Record<string, unknown> }
      | undefined;
    expect((turnStart?.params?.sandboxPolicy as { type: string }).type).toBe('dangerFullAccess');
  });

  it('forwards object-form approval policy to thread/start and turn/start', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const policy = {
      reject: {
        sandbox_approval: true,
        rules: true,
        mcp_elicitations: true
      }
    };
    const promise = runner.startSessionAndRunTurn(
      makeStartInput(workspaceCwd, {
        approvalPolicy: policy
      })
    );

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({ status: 'completed' });

    const messages = parseWrittenMessages(fake);
    const threadStart = messages.find((line) => line.method === 'thread/start') as { params?: Record<string, unknown> };
    const turnStart = messages.find((line) => line.method === 'turn/start') as { params?: Record<string, unknown> };
    expect(threadStart.params?.approvalPolicy).toEqual(policy);
    expect(turnStart.params?.approvalPolicy).toEqual(policy);
  });

  it('supports continuation turns on the same thread within one process', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({
      spawnProcess: () => fake
    });

    const promise = runner.startSessionAndRunTurn(
      makeStartInput(workspaceCwd, {
        maxTurns: 3
      })
    );

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');

    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout('{"method":"turn/completed"}\n');
    fake.emitStdout('{"id":4,"result":{"turn":{"id":"turn-2"}}}\n');
    fake.emitStdout('{"method":"turn/completed"}\n');
    fake.emitStdout('{"id":5,"result":{"turn":{"id":"turn-3"}}}\n');
    fake.emitStdout('{"method":"turn/completed"}\n');

    const result = await promise;
    expect(result).toMatchObject({
      status: 'completed',
      thread_id: 'thread-1',
      turn_id: 'turn-3',
      session_id: 'thread-1-turn-3',
      turns_completed: 3
    });

    const turnStarts = parseWrittenMessages(fake).filter((message) => message.method === 'turn/start');
    expect(turnStarts).toHaveLength(3);
    expect(turnStarts[0].params).toMatchObject({ threadId: 'thread-1' });
    expect(turnStarts[1].params).toMatchObject({ threadId: 'thread-1' });
    expect(turnStarts[2].params).toMatchObject({ threadId: 'thread-1' });

    const secondTurnText = ((turnStarts[1].params as Record<string, unknown>).input as Array<Record<string, unknown>>)[0].text;
    expect(secondTurnText).toBe(CONTINUATION_GUIDANCE);
  });

  it('waits for a fresh terminal event for each continuation turn', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    let settled = false;
    const promise = runner
      .startSessionAndRunTurn(
        makeStartInput(workspaceCwd, {
          maxTurns: 2
        })
      )
      .then(() => {
        settled = true;
      });

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout('{"method":"turn/completed"}\n');
    fake.emitStdout('{"id":4,"result":{"turn":{"id":"turn-2"}}}\n');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    fake.emitStdout('{"method":"turn/completed"}\n');
    await promise;
    expect(settled).toBe(true);
  });

  it('resumes an existing thread, interrupts the previous turn, and starts a guarded recovery turn', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });
    const events: string[] = [];

    const promise = runner.resumeThreadInterruptAndRunTurn(
      {
        ...makeStartInput(workspaceCwd, {
          prompt: 'Recover from an interrupted/stalled turn.',
          onEvent: (event) => events.push(event.event)
        }),
        previousThreadId: 'thread-recover',
        previousTurnId: 'turn-old',
        previousSessionId: 'session-old'
      }
    );

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-recover"}}}\n');
    fake.emitStdout('{"id":3,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":4,"result":{"turn":{"id":"turn-recovery"}}}\n');
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({
      status: 'completed',
      thread_id: 'thread-recover',
      turn_id: 'turn-recovery',
      session_id: 'thread-recover-turn-recovery'
    });

    const messages = parseWrittenMessages(fake);
    expect(messages.map((message) => message.method).filter(Boolean)).toEqual([
      'initialize',
      'initialized',
      'thread/resume',
      'turn/interrupt',
      'turn/start'
    ]);
    expect(messages.find((message) => message.method === 'thread/resume')?.params).toMatchObject({
      threadId: 'thread-recover',
      cwd: workspaceCwd,
      persistExtendedHistory: true
    });
    expect(messages.find((message) => message.method === 'turn/interrupt')?.params).toEqual({
      threadId: 'thread-recover',
      turnId: 'turn-old'
    });
    expect(messages.find((message) => message.method === 'turn/start')?.params).toMatchObject({
      threadId: 'thread-recover',
      cwd: workspaceCwd
    });
    expect(events).toEqual(
      expect.arrayContaining([
        CANONICAL_EVENT.codex.sessionStarted,
        CANONICAL_EVENT.codex.turnCancelled,
        CANONICAL_EVENT.codex.promptSent,
        CANONICAL_EVENT.codex.turnStarted,
        CANONICAL_EVENT.codex.turnCompleted
      ])
    );
  });

  it('accepts compatible payload variants for nested ids', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"threadId":"thread-alt"}}\n');
    fake.emitStdout('{"id":3,"result":{"turnId":"turn-alt"}}\n');
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({
      thread_id: 'thread-alt',
      turn_id: 'turn-alt',
      session_id: 'thread-alt-turn-alt'
    });
  });

  it('parses partial stdout lines until newline framing boundary', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({
      spawnProcess: () => fake
    });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n{"method":"turn/com');
    fake.emitStdout('pleted","params":{}}\n');

    const result = await promise;
    expect(result.last_event).toBe(CANONICAL_EVENT.codex.turnCompleted);
  });

  it('emits malformed protocol diagnostics without stalling turn completion', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const events: Array<{ event: string; detail?: string; session_id?: string }> = [];
    const runner = new CodexRunner({
      spawnProcess: () => fake
    });

    const promise = runner.startSessionAndRunTurn(
      makeStartInput(workspaceCwd, {
        onEvent: (event) => events.push(event)
      })
    );

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    await new Promise((resolve) => setImmediate(resolve));
    fake.emitStdout('{"method":"turn/completed"\n');
    fake.emitStdout('{"method":"turn/completed","params":{}}\n');

    await expect(promise).resolves.toMatchObject({ status: 'completed' });
    const malformed = events.filter((event) => event.event === CANONICAL_EVENT.codex.protocolMalformedLine);
    expect(malformed).toHaveLength(1);
    expect(malformed[0]?.detail).toContain('{"method":"turn/completed"');
    expect(malformed[0]?.session_id).toBe('thread-1-turn-1');
  });

  it('keeps stderr isolated from stdout protocol parsing', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({
      spawnProcess: () => fake
    });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStderr('not-json stderr line\n');
    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout('{"method":"turn/completed"}\n');

    const result = await promise;
    expect(result.status).toBe('completed');
  });

  it('emits codex side-output events with turn context when available', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const events: Array<{ event: string; detail?: string; session_id?: string }> = [];
    const runner = new CodexRunner({
      spawnProcess: () => fake
    });

    const promise = runner.startSessionAndRunTurn(
      makeStartInput(workspaceCwd, {
        onEvent: (event) => events.push(event)
      })
    );

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    await new Promise((resolve) => setImmediate(resolve));
    fake.emitStderr('codex side-output line\n');
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({ status: 'completed' });
    const sideOutput = events.filter((event) => event.event === CANONICAL_EVENT.codex.sideOutput);
    expect(sideOutput).toHaveLength(1);
    expect(sideOutput[0]?.detail).toContain('codex side-output line');
    expect(sideOutput[0]?.session_id).toBe('thread-1-turn-1');
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
      code: 'turn_timeout'
    });
  });

  it('keeps waiting beyond the original turn timeout while real progress is still arriving', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-'));
    const runner = new CodexRunner({
      spawnProcess: () => fake
    });

    const promise = runner.startSessionAndRunTurn(
      makeStartInput(workspaceCwd, {
        commandEnv: { CODEX_HOME: codexHome },
        turnTimeoutMs: 60
      })
    );

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-progress"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-progress"}}}\n');

    await new Promise((resolve) => setTimeout(resolve, 40));
    fake.emitStdout('{"method":"token/count","params":{"info":{"last_token_usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}}\n');
    await new Promise((resolve) => setTimeout(resolve, 40));
    writeTranscriptRecord(codexHome, 'rollout-thread-progress.jsonl', {
      timestamp: '2026-05-07T19:45:20.171Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-progress'
      }
    });

    await expect(promise).resolves.toMatchObject({
      status: 'completed',
      thread_id: 'thread-progress',
      turn_id: 'turn-progress',
      terminal_source: 'session_transcript'
    });
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

  it('maps invalid workspace cwd to invalid_workspace_cwd before launch', async () => {
    const runner = new CodexRunner({
      spawnProcess: () => {
        throw new Error('should not be called');
      }
    });

    await expect(
      runner.startSessionAndRunTurn(
        makeStartInput('/tmp/symphony-does-not-exist-123456789')
      )
    ).rejects.toMatchObject({ code: 'invalid_workspace_cwd' });
  });

  it('maps invalid remote workspace cwd to invalid_remote_workspace_cwd before launch', async () => {
    const runner = new CodexRunner({
      spawnProcess: () => {
        throw new Error('should not be called');
      }
    });

    await expect(
      runner.startSessionAndRunTurn(
        makeStartInput('/tmp/workspace\nbad', {
          workerHost: 'build-1'
        })
      )
    ).rejects.toMatchObject({ code: 'invalid_remote_workspace_cwd' });
  });

  it('auto-approves approval requests and rejects unsupported tool calls without stalling', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout('{"id":91,"method":"approval/request","params":{"kind":"command"}}\n');
    fake.emitStdout('{"id":92,"method":"item/tool/call","params":{"name":"unknown"}}\n');
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({ status: 'completed' });

    const responses = parseWrittenMessages(fake).filter((message) => typeof message.id === 'number' && 'result' in message);
    expect(responses).toContainEqual({ id: 91, result: { approved: true } });
    expect(responses).toContainEqual(
      expect.objectContaining({
        id: 92,
        result: expect.objectContaining({
          success: false,
          output: expect.stringContaining('Unsupported dynamic tool')
        })
      })
    );
  });

  it('uses method-specific approval decisions for known approval request methods', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout('{"id":81,"method":"item/commandExecution/requestApproval","params":{}}\n');
    fake.emitStdout('{"id":82,"method":"item/fileChange/requestApproval","params":{}}\n');
    fake.emitStdout('{"id":83,"method":"execCommandApproval","params":{}}\n');
    fake.emitStdout('{"id":84,"method":"applyPatchApproval","params":{}}\n');
    fake.emitStdout('{"id":85,"method":"approval/request","params":{"kind":"unknown"}}\n');
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({ status: 'completed' });

    const responses = parseWrittenMessages(fake).filter((message) => typeof message.id === 'number' && 'result' in message);
    expect(responses).toContainEqual({ id: 81, result: { decision: 'acceptForSession' } });
    expect(responses).toContainEqual({ id: 82, result: { decision: 'acceptForSession' } });
    expect(responses).toContainEqual({ id: 83, result: { decision: 'approved_for_session' } });
    expect(responses).toContainEqual({ id: 84, result: { decision: 'approved_for_session' } });
    expect(responses).toContainEqual({ id: 85, result: { approved: true } });
  });

  it('executes supported dynamic tool calls and returns tool output payload', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const events: Array<{ event: string; detail?: string; tool_call_id?: string; tool_name?: string }> = [];
    const runner = new CodexRunner({
      spawnProcess: () => fake,
      dynamicToolExecutor: {
        toolSpecs: () => [{ name: 'linear_graphql', description: 'tool', inputSchema: {} }],
        execute: async () => ({
          success: true,
          output: '{"ok":true}',
          contentItems: [{ type: 'inputText', text: '{"ok":true}' }]
        })
      }
    });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd, { onEvent: (event) => events.push(event) }));
    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout('{"id":100,"method":"item/tool/call","params":{"name":"linear_graphql","arguments":{"query":"q"}}}\n');
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({ status: 'completed' });
    const responses = parseWrittenMessages(fake).filter((message) => message.id === 100);
    expect(responses).toContainEqual({
      id: 100,
      result: {
        success: true,
        output: '{"ok":true}',
        contentItems: [{ type: 'inputText', text: '{"ok":true}' }]
      }
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: CANONICAL_EVENT.codex.toolCallStarted,
          detail: 'linear_graphql',
          tool_call_id: '100',
          tool_name: 'linear_graphql'
        }),
        expect.objectContaining({
          event: CANONICAL_EVENT.codex.toolCallCompleted,
          detail: 'linear_graphql',
          tool_call_id: '100',
          tool_name: 'linear_graphql'
        })
      ])
    );
  });

  it('emits app-server response item function_call and function_call_output ledger events', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const events: Array<{
      event: string;
      detail?: string;
      tool_call_id?: string;
      tool_name?: string;
      tool_call_evidence_source?: string;
    }> = [];
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd, { onEvent: (event) => events.push(event) }));
    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout(
      '{"method":"item/started","params":{"item":{"type":"function_call","name":"linear_graphql","call_id":"call_protocol_1"}}}\n'
    );
    fake.emitStdout(
      '{"method":"rawResponseItem/completed","params":{"rawResponseItem":{"type":"function_call_output","call_id":"call_protocol_1","output":"{}"}}}\n'
    );
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({ status: 'completed' });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: CANONICAL_EVENT.codex.toolCallStarted,
          detail: 'linear_graphql',
          tool_call_id: 'call_protocol_1',
          tool_name: 'linear_graphql',
          tool_call_evidence_source: 'app_server_protocol',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          session_id: 'thread-1-turn-1'
        }),
        expect.objectContaining({
          event: CANONICAL_EVENT.codex.toolCallCompleted,
          tool_call_id: 'call_protocol_1',
          tool_call_evidence_source: 'app_server_protocol',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          session_id: 'thread-1-turn-1'
        })
      ])
    );
  });

  it('emits failed dynamic tool response without stalling when supported tool execution fails', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({
      spawnProcess: () => fake,
      dynamicToolExecutor: {
        toolSpecs: () => [{ name: 'linear_graphql', description: 'tool', inputSchema: {} }],
        execute: async () => ({
          success: false,
          output: '{"error":"failed"}',
          contentItems: [{ type: 'inputText', text: '{"error":"failed"}' }]
        })
      }
    });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));
    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout('{"id":101,"method":"item/tool/call","params":{"name":"linear_graphql","arguments":{"query":"q"}}}\n');
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({ status: 'completed' });
    const responses = parseWrittenMessages(fake).filter((message) => message.id === 101);
    expect(responses).toContainEqual({
      id: 101,
      result: {
        success: false,
        output: '{"error":"failed"}',
        contentItems: [{ type: 'inputText', text: '{"error":"failed"}' }]
      }
    });
  });

  it('emits a capability mismatch diagnostic for TUI dynamic-tool rejection and still completes after fallback', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const events: Array<{ event: string; detail?: string; thread_id?: string; turn_id?: string }> = [];
    const runner = new CodexRunner({
      spawnProcess: () => fake,
      dynamicToolExecutor: {
        toolSpecs: () => [{ name: 'linear_graphql', description: 'tool', inputSchema: {} }],
        execute: async () => ({
          success: false,
          output: JSON.stringify({ error: { message: 'Dynamic tool calls are not available in TUI yet.' } }),
          contentItems: [{ type: 'inputText', text: 'Dynamic tool calls are not available in TUI yet.' }]
        })
      }
    });

    const promise = runner.startSessionAndRunTurn(
      makeStartInput(workspaceCwd, {
        onEvent: (event) => events.push(event)
      })
    );
    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout('{"id":101,"method":"item/tool/call","params":{"name":"linear_graphql","arguments":{"query":"q"}}}\n');
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({ status: 'completed' });
    const mismatch = events.find((event) => event.event === CANONICAL_EVENT.codex.dynamicToolCapabilityMismatch);
    expect(mismatch).toMatchObject({
      thread_id: 'thread-1',
      turn_id: 'turn-1'
    });
    expect(JSON.parse(mismatch?.detail ?? '{}')).toMatchObject({
      reason_code: UNSUPPORTED_DYNAMIC_TOOL_CONSOLE_RESUME_REASON_CODE,
      source_environment: 'console_tui',
      attempted_tool_name: 'linear_graphql',
      call_id: '101',
      unsupported_capability_message: 'Dynamic tool calls are not available in TUI yet.',
      recommended_recovery_action: DYNAMIC_TOOL_CONSOLE_RECOVERY_ACTION
    });
    expect(events.some((event) => event.event === CANONICAL_EVENT.codex.toolCallFailed)).toBe(false);
  });

  it('rejects unknown server requests so they cannot silently stall a turn', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout('{"id":99,"method":"account/chatgptAuthTokens/refresh","params":{}}\n');
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({ status: 'completed' });

    const responses = parseWrittenMessages(fake).filter((message) => typeof message.id === 'number' && 'result' in message);
    expect(responses).toContainEqual({
      id: 99,
      result: {
        success: false,
        error: 'unsupported_server_request',
        method: 'account/chatgptAuthTokens/refresh'
      }
    });
  });

  it('fails hard on user-input-required signals from compatible payload shapes', async () => {
    const fakeMethod = new FakeProcess();
    const workspaceCwdMethod = makeWorkspace();
    const runnerMethod = new CodexRunner({ spawnProcess: () => fakeMethod });

    const methodPromise = runnerMethod.startSessionAndRunTurn(makeStartInput(workspaceCwdMethod));
    fakeMethod.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fakeMethod.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fakeMethod.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fakeMethod.emitStdout('{"method":"item/tool/requestUserInput"}\n');
    await expect(methodPromise).resolves.toMatchObject({ error_code: 'turn_input_required' });

    const fakeParams = new FakeProcess();
    const workspaceCwdParams = makeWorkspace();
    const runnerParams = new CodexRunner({ spawnProcess: () => fakeParams });

    const paramsPromise = runnerParams.startSessionAndRunTurn(makeStartInput(workspaceCwdParams));
    fakeParams.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fakeParams.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fakeParams.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fakeParams.emitStdout('{"method":"turn/update","params":{"inputRequired":true}}\n');
    await expect(paramsPromise).resolves.toMatchObject({ error_code: 'turn_input_required' });

    const fakeElicitation = new FakeProcess();
    const workspaceCwdElicitation = makeWorkspace();
    const runnerElicitation = new CodexRunner({ spawnProcess: () => fakeElicitation });

    const elicitationPromise = runnerElicitation.startSessionAndRunTurn(makeStartInput(workspaceCwdElicitation));
    fakeElicitation.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fakeElicitation.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fakeElicitation.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fakeElicitation.emitStdout('{"id":77,"method":"mcpServer/elicitation/request","params":{"threadId":"thread-1"}}\n');

    await expect(elicitationPromise).resolves.toMatchObject({
      error_code: 'turn_input_required',
      error_detail: 'mcp elicitation request input_required_unanswerable'
    });

    const responses = parseWrittenMessages(fakeElicitation).filter(
      (message) => typeof message.id === 'number' && 'result' in message
    );
    expect(responses.find((message) => message.id === 77)).toBeUndefined();
  });

  it('auto-answers mcp elicitation approvals when approval options are present', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout(
      '{"id":110,"method":"mcpServer/elicitation/request","params":{"questions":[{"id":"mcp_approval","options":[{"label":"Approve Once"},{"label":"Approve this Session"},{"label":"Cancel"}]}]}}\n'
    );
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({ status: 'completed' });

    const responses = parseWrittenMessages(fake).filter((message) => message.id === 110);
    expect(responses).toContainEqual({
      id: 110,
      result: {
        answers: {
          mcp_approval: {
            answers: ['Approve this Session']
          }
        }
      }
    });
  });

  it('auto-answers mcp elicitation approvals using permissive option matching', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout(
      '{"id":111,"method":"mcpServer/elicitation/request","params":{"questions":[{"id":"mcp_approval","options":[{"label":"Cancel"},{"label":"Allow for this session"}]}]}}\n'
    );
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({ status: 'completed' });

    const responses = parseWrittenMessages(fake).filter((message) => message.id === 111);
    expect(responses).toContainEqual({
      id: 111,
      result: {
        answers: {
          mcp_approval: {
            answers: ['Allow for this session']
          }
        }
      }
    });
  });

  it('auto-answers mcp elicitation with non-interactive fallback when no approval options exist', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout(
      '{"id":112,"method":"mcpServer/elicitation/request","params":{"questions":[{"id":"mcp_reason","options":[{"label":"Use default"},{"label":"Skip"}]}]}}\n'
    );
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({ status: 'completed' });

    const responses = parseWrittenMessages(fake).filter((message) => message.id === 112);
    expect(responses).toContainEqual({
      id: 112,
      result: {
        answers: {
          mcp_reason: {
            answers: ['This is a non-interactive session. Operator input is unavailable.']
          }
        }
      }
    });
  });

  it('auto-answers tool requestUserInput approvals when approval options are present', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const events: string[] = [];
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(
      makeStartInput(workspaceCwd, {
        onEvent: (event) => events.push(event.event)
      })
    );

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout(
      '{"id":88,"method":"item/tool/requestUserInput","params":{"questions":[{"id":"q1","options":[{"label":"Cancel"},{"label":"Approve this Session"}]}]}}\n'
    );
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({ status: 'completed' });

    const responses = parseWrittenMessages(fake).filter((message) => message.id === 88);
    expect(responses).toContainEqual({
      id: 88,
      result: {
        answers: {
          q1: {
            answers: ['Approve this Session']
          }
        }
      }
    });
    expect(events).toContain(CANONICAL_EVENT.codex.toolInputAutoAnswered);
  });

  it('auto-answers tool requestUserInput with non-interactive fallback when no approval options exist', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout(
      '{"id":89,"method":"item/tool/requestUserInput","params":{"questions":[{"id":"q1","options":[{"label":"Cancel"}]}]}}\n'
    );
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({ status: 'completed' });

    const responses = parseWrittenMessages(fake).filter((message) => message.id === 89);
    expect(responses).toContainEqual({
      id: 89,
      result: {
        answers: {
          q1: {
            answers: ['This is a non-interactive session. Operator input is unavailable.']
          }
        }
      }
    });
  });

  it('fails with turn_input_required when tool requestUserInput cannot be auto-answered', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout('{"id":90,"method":"item/tool/requestUserInput","params":{"questions":[{"options":[{"label":"Approve this Session"}]}]}}\n');

    await expect(promise).resolves.toMatchObject({ error_code: 'turn_input_required' });

    const responses = parseWrittenMessages(fake).filter((message) => message.id === 90);
    expect(responses).toEqual([]);
  });

  it('submits blocked input natively on the same protocol session and completes the pending turn', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout('{"id":90,"method":"item/tool/requestUserInput","params":{"questions":[{"options":[{"label":"Continue"}]}]}}\n');

    const blocked = await promise;
    expect(blocked).toMatchObject({
      status: 'failed',
      error_code: 'turn_input_required',
      thread_id: 'thread-1',
      session_id: 'thread-1-turn-1'
    });

    const nativePromise = runner.submitBlockedInputNative({
      previous_session_id: blocked.session_id,
      previous_thread_id: blocked.thread_id,
      request_id: '90',
      answer: { text: 'Continue' }
    });
    await expect(nativePromise).resolves.toEqual({ applied: true, code: 'native_applied' });

    const responses = parseWrittenMessages(fake).filter((message) => message.id === 90);
    expect(responses).toContainEqual({
      id: 90,
      result: {
        answers: {
          q1: {
            answers: ['Continue']
          }
        }
      }
    });
  });

  it('returns request_not_found for mismatched native request id and keeps pending request active', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout('{"id":90,"method":"item/tool/requestUserInput","params":{"questions":[{"options":[{"label":"Continue"}]}]}}\n');

    const blocked = await promise;
    expect(blocked).toMatchObject({
      status: 'failed',
      error_code: 'turn_input_required',
      thread_id: 'thread-1',
      session_id: 'thread-1-turn-1'
    });

    await expect(
      runner.submitBlockedInputNative({
        previous_session_id: blocked.session_id,
        previous_thread_id: blocked.thread_id,
        request_id: '91',
        answer: { text: 'Continue' }
      })
    ).resolves.toMatchObject({ applied: false, code: 'request_not_found' });

    await expect(
      runner.submitBlockedInputNative({
        previous_session_id: blocked.session_id,
        previous_thread_id: blocked.thread_id,
        request_id: '90',
        answer: { text: 'Continue' }
      })
    ).resolves.toEqual({ applied: true, code: 'native_applied' });
  });

  it('[SPEC-13.5-1] extracts usage/rate-limit telemetry from compatible payload variants', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout(
      '{"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"inputTokens":10,"outputTokens":4,"totalTokens":14,"cachedInputTokens":3,"reasoningOutputTokens":2,"modelContextWindow":8192},"last":{"inputTokens":9,"outputTokens":9,"totalTokens":18}}}}\n'
    );
    fake.emitStdout(
      '{"method":"thread/tokenUsage/updated","params":{"usage":{"input_tokens":99,"output_tokens":99,"total_tokens":99}}}\n'
    );
    fake.emitStdout(
      '{"method":"token/count","params":{"info":{"total_token_usage":{"input_tokens":17,"output_tokens":6,"total_tokens":23,"cached_input_tokens":5,"reasoning_output_tokens":4,"model_context_window":16384},"last_token_usage":{"input_tokens":999,"output_tokens":999,"total_tokens":999}}}}\n'
    );
    fake.emitStdout('{"method":"limits/update","params":{"rateLimits":{"remaining":42,"limit":100}}}\n');
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({
      usage: {
        input_tokens: 17,
        output_tokens: 6,
        total_tokens: 23,
        cached_input_tokens: 5,
        reasoning_output_tokens: 4,
        model_context_window: 16384
      },
      rate_limits: {
        remaining: 42,
        limit: 100
      }
    });
  });

  it('does not decrement aggregate usage when absolute totals arrive out of order', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout(
      '{"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"inputTokens":20,"outputTokens":10,"totalTokens":30},"last":{"inputTokens":20,"outputTokens":10,"totalTokens":30}}}}\n'
    );
    fake.emitStdout(
      '{"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"inputTokens":10,"outputTokens":5,"totalTokens":15},"last":{"inputTokens":1,"outputTokens":1,"totalTokens":2}}}}\n'
    );
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({
      usage: {
        input_tokens: 20,
        output_tokens: 10,
        total_tokens: 30
      }
    });
  });

  it('captures model_context_window from tokenUsage container when total payload omits it', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout(
      '{"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"modelContextWindow":131072,"total":{"inputTokens":11,"outputTokens":7,"totalTokens":18},"last":{"inputTokens":11,"outputTokens":7,"totalTokens":18}}}}\n'
    );
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
        model_context_window: 131072
      }
    });
  });

  it('uses last_token_usage as a live estimate when absolute totals are absent', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout(
      '{"method":"token/count","params":{"info":{"last_token_usage":{"input_tokens":99,"output_tokens":99,"total_tokens":198}}}}\n'
    );
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({
      usage: {
        input_tokens: 99,
        output_tokens: 99,
        total_tokens: 198
      }
    });
  });

  it('replaces live estimate with canonical absolute totals when they arrive', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout(
      '{"method":"token/count","params":{"info":{"last_token_usage":{"input_tokens":99,"output_tokens":99,"total_tokens":198}}}}\n'
    );
    fake.emitStdout(
      '{"method":"token/count","params":{"info":{"total_token_usage":{"input_tokens":17,"output_tokens":6,"total_tokens":23}}}}\n'
    );
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({
      usage: {
        input_tokens: 17,
        output_tokens: 6,
        total_tokens: 23
      }
    });
  });

  it('accepts numeric-string totals and usage.total_token_usage wrapper payloads', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout(
      '{"method":"thread/tokenUsage/updated","params":{"token_usage":{"total":{"inputTokens":"10","outputTokens":"4","totalTokens":"14","cachedInputTokens":"2","reasoningOutputTokens":"1","modelContextWindow":"131072"}}}}\n'
    );
    fake.emitStdout(
      '{"method":"token/count","params":{"usage":{"total_token_usage":{"input_tokens":"17","output_tokens":"6","total_tokens":"23","cached_input_tokens":"5","reasoning_output_tokens":"4","model_context_window":"131072"}}}}\n'
    );
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({
      usage: {
        input_tokens: 17,
        output_tokens: 6,
        total_tokens: 23,
        cached_input_tokens: 5,
        reasoning_output_tokens: 4,
        model_context_window: 131072
      }
    });
  });

  it('applies token telemetry precedence across terminal, incremental, and persisted fallback payloads', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout(
      '{"method":"codex/persistedUsage","params":{"persisted_usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n'
    );
    fake.emitStdout(
      '{"method":"token/count","params":{"info":{"last_token_usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}}\n'
    );
    fake.emitStdout(
      '{"method":"turn/completed","params":{"usage":{"input_tokens":30,"output_tokens":12,"total_tokens":42}}}\n'
    );

    await expect(promise).resolves.toMatchObject({
      usage: {
        input_tokens: 30,
        output_tokens: 12,
        total_tokens: 42
      },
      token_telemetry_status: 'available',
      token_telemetry_last_source: 'terminal_turn_summary'
    });
  });

  it('completes a turn from matching session transcript task_complete without protocol terminal notification', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-'));
    const events: Array<{ event: string; terminal_source?: string; detail?: string }> = [];
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(
      makeStartInput(workspaceCwd, {
        commandEnv: { CODEX_HOME: codexHome },
        onEvent: (event) => events.push(event),
        turnTimeoutMs: 1000
      })
    );

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-transcript"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-transcript"}}}\n');
    writeTranscriptRecord(codexHome, 'rollout-thread-transcript.jsonl', {
      timestamp: '2026-05-07T19:45:20.168Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 30,
            output_tokens: 12,
            total_tokens: 42
          }
        },
        rate_limits: {
          limit_id: 'codex'
        }
      }
    });
    writeTranscriptRecord(codexHome, 'rollout-thread-transcript.jsonl', {
      timestamp: '2026-05-07T19:45:20.171Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-transcript',
        last_agent_message: 'done from transcript',
        duration_ms: 111124,
        time_to_first_token_ms: 6884
      }
    });

    await expect(promise).resolves.toMatchObject({
      status: 'completed',
      thread_id: 'thread-transcript',
      turn_id: 'turn-transcript',
      session_id: 'thread-transcript-turn-transcript',
      terminal_source: 'session_transcript',
      last_agent_message: 'done from transcript',
      completed_at_ms: Date.parse('2026-05-07T19:45:20.171Z'),
      duration_ms: 111124,
      time_to_first_token_ms: 6884,
      usage: {
        input_tokens: 30,
        output_tokens: 12,
        total_tokens: 42
      },
      rate_limits: {
        limit_id: 'codex'
      }
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.turnCompleted,
        terminal_source: 'session_transcript'
      })
    );
  });

  it('completes after a transcript task_complete JSONL record is split across scans', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-'));
    const runner = new CodexRunner({ spawnProcess: () => fake });
    const terminalRecord = JSON.stringify({
      timestamp: '2026-05-07T19:45:20.171Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-split',
        last_agent_message: 'split complete'
      }
    });

    const promise = runner.startSessionAndRunTurn(
      makeStartInput(workspaceCwd, {
        commandEnv: { CODEX_HOME: codexHome },
        turnTimeoutMs: 1000
      })
    );

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-split"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-split"}}}\n');
    appendTranscriptText(codexHome, 'rollout-thread-split.jsonl', terminalRecord.slice(0, 70));
    await new Promise((resolve) => setTimeout(resolve, 150));
    appendTranscriptText(codexHome, 'rollout-thread-split.jsonl', `${terminalRecord.slice(70)}\n`);

    await expect(promise).resolves.toMatchObject({
      status: 'completed',
      thread_id: 'thread-split',
      turn_id: 'turn-split',
      terminal_source: 'session_transcript',
      last_agent_message: 'split complete'
    });
  });

  it('keeps scanning after a complete malformed transcript line', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-'));
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(
      makeStartInput(workspaceCwd, {
        commandEnv: { CODEX_HOME: codexHome },
        turnTimeoutMs: 1000
      })
    );

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-malformed"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-malformed"}}}\n');
    appendTranscriptText(codexHome, 'rollout-thread-malformed.jsonl', '{"type":"event_msg"\n');
    writeTranscriptRecord(codexHome, 'rollout-thread-malformed.jsonl', {
      timestamp: '2026-05-07T19:45:20.171Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-malformed'
      }
    });

    await expect(promise).resolves.toMatchObject({
      status: 'completed',
      thread_id: 'thread-malformed',
      turn_id: 'turn-malformed',
      terminal_source: 'session_transcript'
    });
  });

  it('keeps wrong-lineage transcript task_complete diagnostic-only until protocol completion', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-'));
    const events: Array<{ event: string; terminal_source?: string; detail?: string }> = [];
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(
      makeStartInput(workspaceCwd, {
        commandEnv: { CODEX_HOME: codexHome },
        onEvent: (event) => events.push(event),
        turnTimeoutMs: 1000
      })
    );

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-active"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-active"}}}\n');
    writeTranscriptRecord(codexHome, 'rollout-thread-active.jsonl', {
      timestamp: '2026-05-07T19:45:20.171Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-other',
        last_agent_message: 'wrong turn'
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({
      status: 'completed',
      thread_id: 'thread-active',
      turn_id: 'turn-active',
      terminal_source: 'app_server_protocol'
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.sideOutput,
        terminal_source: 'session_transcript',
        detail: expect.stringContaining('reason=turn_mismatch')
      })
    );
  });

  it.each([
    {
      name: 'wrong thread',
      payload: { type: 'task_complete', thread_id: 'thread-other', turn_id: 'turn-active' },
      reason: 'reason=thread_mismatch'
    },
    {
      name: 'wrong session',
      payload: { type: 'task_complete', turn_id: 'turn-active', session_id: 'session-other' },
      reason: 'reason=session_mismatch'
    }
  ])('keeps $name transcript task_complete diagnostic-only until protocol completion', async ({ payload, reason }) => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-'));
    const events: Array<{ event: string; terminal_source?: string; detail?: string }> = [];
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(
      makeStartInput(workspaceCwd, {
        commandEnv: { CODEX_HOME: codexHome },
        onEvent: (event) => events.push(event),
        turnTimeoutMs: 1000
      })
    );

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-active"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-active"}}}\n');
    writeTranscriptRecord(codexHome, 'rollout-thread-active.jsonl', {
      timestamp: '2026-05-07T19:45:20.171Z',
      type: 'event_msg',
      payload
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({
      status: 'completed',
      thread_id: 'thread-active',
      turn_id: 'turn-active',
      terminal_source: 'app_server_protocol'
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.sideOutput,
        terminal_source: 'session_transcript',
        detail: expect.stringContaining(reason)
      })
    );
  });

  it.each([
    { type: 'task_failed', expectedEvent: CANONICAL_EVENT.codex.turnFailed, expectedError: 'turn_failed' },
    { type: 'task_cancelled', expectedEvent: CANONICAL_EVENT.codex.turnCancelled, expectedError: 'turn_cancelled' },
    { type: 'task_input_required', expectedEvent: CANONICAL_EVENT.codex.turnInputRequired, expectedError: REASON_CODES.turnInputRequired }
  ])('maps transcript-only $type terminal evidence through the runner result', async ({ type, expectedEvent, expectedError }) => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-'));
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(
      makeStartInput(workspaceCwd, {
        commandEnv: { CODEX_HOME: codexHome },
        turnTimeoutMs: 1000
      })
    );

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-terminal"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-terminal"}}}\n');
    writeTranscriptRecord(codexHome, 'rollout-thread-terminal.jsonl', {
      timestamp: '2026-05-07T19:45:20.171Z',
      type: 'event_msg',
      payload: {
        type,
        turn_id: 'turn-terminal'
      }
    });

    await expect(promise).resolves.toMatchObject({
      status: 'failed',
      thread_id: 'thread-terminal',
      turn_id: 'turn-terminal',
      last_event: expectedEvent,
      error_code: expectedError,
      terminal_source: 'session_transcript'
    });
  });

  it('keeps incremental usage ahead of a later persisted fallback record', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout(
      '{"method":"token/count","params":{"info":{"last_token_usage":{"input_tokens":8,"output_tokens":4,"total_tokens":12}}}}\n'
    );
    fake.emitStdout(
      '{"method":"codex/persistedUsage","params":{"persisted_usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n'
    );
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({
      usage: {
        input_tokens: 8,
        output_tokens: 4,
        total_tokens: 12
      },
      token_telemetry_status: 'available',
      token_telemetry_last_source: 'last_token_usage'
    });
  });

  it('collects terminal usage across Codex home, model, and reasoning command variants', async () => {
    const variants = [
      { codexHome: 'default', model: false, reasoning: false },
      { codexHome: 'default', model: false, reasoning: true },
      { codexHome: 'default', model: true, reasoning: false },
      { codexHome: 'default', model: true, reasoning: true },
      { codexHome: 'alternate', model: false, reasoning: false },
      { codexHome: 'alternate', model: false, reasoning: true },
      { codexHome: 'alternate', model: true, reasoning: false },
      { codexHome: 'alternate', model: true, reasoning: true }
    ];

    for (const variant of variants) {
      const fake = new FakeProcess();
      const workspaceCwd = makeWorkspace();
      const commandParts = [
        variant.codexHome === 'alternate' ? 'SYMPHONY_CODEX_HOME=/tmp/symphony-codex-home codex app-server' : 'codex app-server',
        variant.model ? '--config model="gpt-5.4"' : '',
        variant.reasoning ? '--config model_reasoning_effort="high"' : ''
      ].filter(Boolean);
      const runner = new CodexRunner({ spawnProcess: () => fake });

      const promise = runner.startSessionAndRunTurn(
        makeStartInput(workspaceCwd, {
          command: commandParts.join(' ')
        })
      );

      fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
      fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
      fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
      fake.emitStdout(
        '{"method":"turn/completed","params":{"summary":{"usage":{"inputTokens":21,"outputTokens":9,"totalTokens":30}}}}\n'
      );

      await expect(promise).resolves.toMatchObject({
        usage: {
          input_tokens: 21,
          output_tokens: 9,
          total_tokens: 30
        },
        token_telemetry_status: 'available',
        token_telemetry_last_source: 'terminal_turn_summary'
      });
    }
  });

  it('handles a bounded high-volume stream deterministically', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');

    for (let index = 0; index < 400; index += 1) {
      if (index % 40 === 0) {
        fake.emitStdout(`{"id":${1000 + index},"method":"approval/request","params":{"kind":"command"}}\n`);
      } else if (index % 55 === 0) {
        fake.emitStdout(`{"id":${2000 + index},"method":"item/tool/call","params":{"name":"x"}}\n`);
      } else {
        fake.emitStdout('{"method":"notification","params":{"kind":"tick"}}\n');
      }
    }

    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({ status: 'completed' });
    expect(fake.killed).toBe(true);
  });
});
