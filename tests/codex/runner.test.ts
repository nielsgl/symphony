import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { CodexRunner, CONTINUATION_GUIDANCE } from '../../src/codex';
import type { CodexRunnerStartInput } from '../../src/codex';
import { CANONICAL_EVENT } from '../../src/observability/events';

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
      rate_limits: null
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

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));
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

    await expect(elicitationPromise).resolves.toMatchObject({ error_code: 'turn_input_required' });

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

  it('ignores info.last_token_usage when no absolute total is present', async () => {
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
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0
      }
    });
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
