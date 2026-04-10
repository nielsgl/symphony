import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { CodexRunner } from '../../src/codex';

class FakeProcess {
  pid: number | null = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  private readonly exitEmitter = new EventEmitter();
  readonly writes: string[] = [];
  killed = false;
  stdin = {
    write: (data: string) => {
      this.writes.push(data.trim());
    }
  };

  kill(): void {
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

describe('CodexRunner', () => {
  it('launches with bash command/cwd and performs ordered startup handshake', async () => {
    const fake = new FakeProcess();
    const spawnCalls: Array<{ command: string; cwd: string }> = [];
    const runner = new CodexRunner({
      spawnProcess: ({ command, cwd }) => {
        spawnCalls.push({ command, cwd });
        return fake;
      }
    });

    const promise = runner.startSessionAndRunTurn({
      command: 'codex app-server',
      workspaceCwd: '/tmp/ws',
      prompt: 'hello',
      title: 'ABC-1: Title',
      readTimeoutMs: 1000,
      turnTimeoutMs: 1000
    });

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout('{"method":"turn/completed","params":{}}\n');

    const result = await promise;

    expect(spawnCalls).toEqual([{ command: 'codex app-server', cwd: '/tmp/ws' }]);
    expect(result).toEqual({
      status: 'completed',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1',
      last_event: 'turn_completed'
    });

    const writtenMethods = fake.writes.map((line) => JSON.parse(line).method).filter(Boolean);
    expect(writtenMethods).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
  });

  it('parses partial stdout lines until newline framing boundary', async () => {
    const fake = new FakeProcess();
    const runner = new CodexRunner({
      spawnProcess: () => fake
    });

    const promise = runner.startSessionAndRunTurn({
      command: 'codex app-server',
      workspaceCwd: '/tmp/ws',
      prompt: 'hello',
      title: 'ABC-1: Title',
      readTimeoutMs: 1000,
      turnTimeoutMs: 1000
    });

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n{"method":"turn/com');
    fake.emitStdout('pleted","params":{}}\n');

    const result = await promise;
    expect(result.last_event).toBe('turn_completed');
  });

  it('keeps stderr isolated from stdout protocol parsing', async () => {
    const fake = new FakeProcess();
    const runner = new CodexRunner({
      spawnProcess: () => fake
    });

    const promise = runner.startSessionAndRunTurn({
      command: 'codex app-server',
      workspaceCwd: '/tmp/ws',
      prompt: 'hello',
      title: 'ABC-1: Title',
      readTimeoutMs: 1000,
      turnTimeoutMs: 1000
    });

    fake.emitStderr('not-json stderr line\n');
    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout('{"method":"turn/completed"}\n');

    const result = await promise;
    expect(result.status).toBe('completed');
  });

  it('maps read timeout to response_timeout', async () => {
    const fake = new FakeProcess();
    const runner = new CodexRunner({
      spawnProcess: () => fake
    });

    await expect(
      runner.startSessionAndRunTurn({
        command: 'codex app-server',
        workspaceCwd: '/tmp/ws',
        prompt: 'hello',
        title: 'ABC-1: Title',
        readTimeoutMs: 10,
        turnTimeoutMs: 1000
      })
    ).rejects.toMatchObject({
      code: 'response_timeout'
    });
  });

  it('maps turn timeout to turn_timeout', async () => {
    const fake = new FakeProcess();
    const runner = new CodexRunner({
      spawnProcess: () => fake
    });

    const promise = runner.startSessionAndRunTurn({
      command: 'codex app-server',
      workspaceCwd: '/tmp/ws',
      prompt: 'hello',
      title: 'ABC-1: Title',
      readTimeoutMs: 1000,
      turnTimeoutMs: 10
    });

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');

    await expect(promise).rejects.toMatchObject({
      code: 'turn_timeout'
    });
  });

  it('maps failed/cancelled/input-required terminal events', async () => {
    const fakeFailed = new FakeProcess();
    const runnerFailed = new CodexRunner({ spawnProcess: () => fakeFailed });
    const failedPromise = runnerFailed.startSessionAndRunTurn({
      command: 'codex app-server',
      workspaceCwd: '/tmp/ws',
      prompt: 'hello',
      title: 'ABC-1: Title',
      readTimeoutMs: 1000,
      turnTimeoutMs: 1000
    });
    fakeFailed.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fakeFailed.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fakeFailed.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fakeFailed.emitStdout('{"method":"turn/failed"}\n');
    await expect(failedPromise).resolves.toMatchObject({ error_code: 'turn_failed' });

    const fakeCancelled = new FakeProcess();
    const runnerCancelled = new CodexRunner({ spawnProcess: () => fakeCancelled });
    const cancelledPromise = runnerCancelled.startSessionAndRunTurn({
      command: 'codex app-server',
      workspaceCwd: '/tmp/ws',
      prompt: 'hello',
      title: 'ABC-1: Title',
      readTimeoutMs: 1000,
      turnTimeoutMs: 1000
    });
    fakeCancelled.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fakeCancelled.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fakeCancelled.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fakeCancelled.emitStdout('{"method":"turn/cancelled"}\n');
    await expect(cancelledPromise).resolves.toMatchObject({ error_code: 'turn_cancelled' });

    const fakeInput = new FakeProcess();
    const runnerInput = new CodexRunner({ spawnProcess: () => fakeInput });
    const inputPromise = runnerInput.startSessionAndRunTurn({
      command: 'codex app-server',
      workspaceCwd: '/tmp/ws',
      prompt: 'hello',
      title: 'ABC-1: Title',
      readTimeoutMs: 1000,
      turnTimeoutMs: 1000
    });
    fakeInput.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fakeInput.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fakeInput.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fakeInput.emitStdout('{"method":"turn/input_required"}\n');
    await expect(inputPromise).resolves.toMatchObject({ error_code: 'turn_input_required' });

    const fakeCamelInput = new FakeProcess();
    const runnerCamelInput = new CodexRunner({ spawnProcess: () => fakeCamelInput });
    const camelInputPromise = runnerCamelInput.startSessionAndRunTurn({
      command: 'codex app-server',
      workspaceCwd: '/tmp/ws',
      prompt: 'hello',
      title: 'ABC-1: Title',
      readTimeoutMs: 1000,
      turnTimeoutMs: 1000
    });
    fakeCamelInput.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fakeCamelInput.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fakeCamelInput.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fakeCamelInput.emitStdout('{"method":"item/tool/requestUserInput"}\n');
    await expect(camelInputPromise).resolves.toMatchObject({ error_code: 'turn_input_required' });
  });
});
