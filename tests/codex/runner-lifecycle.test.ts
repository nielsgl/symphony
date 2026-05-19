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

describe('CodexRunner lifecycle', () => {
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
      protocol_warnings: [],
      model_reroute: null,
      requested_model: null,
      effective_model: null,
      terminal_source: 'app_server_protocol'
    });

    const writtenMethods = parseWrittenMessages(fake)
      .map((line) => (typeof line.method === 'string' ? line.method : null))
      .filter((method): method is string => Boolean(method));
    expect(writtenMethods).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start', 'thread/read']);

    const initialize = parseWrittenMessages(fake).find((line) => line.method === 'initialize') as
      | { params?: Record<string, unknown> }
      | undefined;
    expectGeneratedMethod('ClientRequest', 'initialize');
    expectGeneratedPayloadShape('InitializeParams', initialize?.params ?? {}, ['clientInfo', 'capabilities']);
    expect(initialize?.params?.clientInfo).toEqual({ name: 'symphony', version: '0.1.0' });
    expect(initialize?.params?.capabilities).toEqual({ experimentalApi: true });

    const initialized = parseWrittenMessages(fake).find((line) => line.method === 'initialized') as
      | { params?: Record<string, unknown> }
      | undefined;
    expectGeneratedMethod('ClientNotification', 'initialized');
    expect(initialized?.params).toEqual({});

    const turnStart = parseWrittenMessages(fake).find((line) => line.method === 'turn/start') as
      | { params?: Record<string, unknown> }
      | undefined;
    expectGeneratedMethod('ClientRequest', 'turn/start');
    expectGeneratedPayloadShape('TurnStartParams', turnStart?.params ?? {}, [
      'threadId',
      'input',
      'cwd',
      'approvalPolicy',
      'sandboxPolicy'
    ]);
    expect(turnStart?.params?.cwd).toBe(workspaceCwd);
    expect(turnStart?.params?.title).toBe('ABC-1: Title');
    expect(turnStart?.params?.input).toEqual([{ type: 'text', text: 'hello' }]);
    expect((turnStart?.params?.sandboxPolicy as { type: string }).type).toBe('workspaceWrite');
    const threadStart = parseWrittenMessages(fake).find((line) => line.method === 'thread/start') as
      | { params?: Record<string, unknown> }
      | undefined;
    expectGeneratedMethod('ClientRequest', 'thread/start');
    expectGeneratedPayloadShape('ThreadStartParams', threadStart?.params ?? {}, [
      'approvalPolicy',
      'sandbox',
      'cwd',
      'dynamicTools'
    ]);
    expect(threadStart?.params?.cwd).toBe(workspaceCwd);
    expect(threadStart?.params?.approvalPolicy).toBe('never');
    expect(threadStart?.params?.sandbox).toBe('workspace-write');
    expect(threadStart?.params?.dynamicTools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'linear_graphql' })])
    );
  });

  it('emits app-server Thread.updatedAt activity metadata from thread/read for the active thread', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const events: Array<{ event: string; thread_id?: string; codex_thread_activity_at_ms?: number | null }> = [];
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
    fake.emitStdout('{"id":4,"result":{"thread":{"id":"thread-1","updatedAt":1770000000,"status":"running"}}}\n');
    fake.emitStdout('{"method":"turn/completed","params":{}}\n');

    await promise;

    expect(events).toContainEqual(
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.threadActivityUpdated,
        thread_id: 'thread-1',
        codex_thread_activity_at_ms: 1770000000000,
        codex_thread_activity_source: 'app_server_protocol_thread_updated_at',
        codex_thread_activity_status: 'running'
      })
    );
    const threadRead = parseWrittenMessages(fake).find((line) => line.method === 'thread/read') as
      | { params?: Record<string, unknown> }
      | undefined;
    expect(threadRead?.params).toEqual({ threadId: 'thread-1', includeTurns: false });
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
    fake.emitStdout('{"id":5,"result":{"turn":{"id":"turn-2"}}}\n');
    fake.emitStdout('{"method":"turn/completed"}\n');
    fake.emitStdout('{"id":7,"result":{"turn":{"id":"turn-3"}}}\n');
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
    fake.emitStdout('{"id":5,"result":{"turn":{"id":"turn-2"}}}\n');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    fake.emitStdout('{"method":"turn/completed"}\n');
    await promise;
    expect(settled).toBe(true);
  });

  it('resumes an existing thread in the provisioned workspace without forking or provisioning', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const spawnCalls: Array<{ command: string; cwd: string }> = [];
    const runner = new CodexRunner({
      spawnProcess: ({ command, cwd }) => {
        spawnCalls.push({ command, cwd });
        return fake;
      }
    });
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

    expect(spawnCalls).toEqual([{ command: 'codex app-server', cwd: workspaceCwd }]);
    const messages = parseWrittenMessages(fake);
    expect(messages.map((message) => message.method).filter(Boolean)).toEqual([
      'initialize',
      'initialized',
      'thread/resume',
      'turn/interrupt',
      'turn/start'
    ]);
    // Workspace provisioning belongs to WorkspaceManager; app-server resume only
    // re-enters an existing conversation in the already-provisioned cwd.
    expect(messages).not.toContainEqual(expect.objectContaining({ method: 'thread/fork' }));
    const threadResume = messages.find((message) => message.method === 'thread/resume') as {
      params?: Record<string, unknown>;
    };
    expectGeneratedMethod('ClientRequest', 'thread/resume');
    expectGeneratedPayloadShape('ThreadResumeParams', threadResume.params ?? {}, [
      'threadId',
      'cwd',
      'approvalPolicy',
      'sandbox',
      'persistExtendedHistory'
    ]);
    expect(threadResume.params).toMatchObject({
      threadId: 'thread-recover',
      cwd: workspaceCwd,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      persistExtendedHistory: true
    });
    expect(messages.find((message) => message.method === 'turn/interrupt')?.params).toEqual({
      threadId: 'thread-recover',
      turnId: 'turn-old'
    });
    const recoveryTurnStart = messages.find((message) => message.method === 'turn/start') as {
      params?: Record<string, unknown>;
    };
    expectGeneratedPayloadShape('TurnStartParams', recoveryTurnStart.params ?? {}, [
      'threadId',
      'input',
      'cwd',
      'approvalPolicy',
      'sandboxPolicy'
    ]);
    expect(recoveryTurnStart.params).toMatchObject({
      threadId: 'thread-recover',
      cwd: workspaceCwd,
      title: 'ABC-1: Title',
      input: [{ type: 'text', text: 'Recover from an interrupted/stalled turn.' }],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'workspaceWrite' }
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

  it('maps invalid workspace cwd to invalid_workspace_cwd before launch', async () => {
    let spawnCalled = false;
    const runner = new CodexRunner({
      spawnProcess: () => {
        spawnCalled = true;
        throw new Error('should not be called');
      }
    });

    await expect(
      runner.startSessionAndRunTurn(
        makeStartInput('/tmp/symphony-does-not-exist-123456789')
      )
    ).rejects.toMatchObject({ code: 'invalid_workspace_cwd' });
    expect(spawnCalled).toBe(false);
  });

  it('maps invalid remote workspace cwd to invalid_remote_workspace_cwd before launch', async () => {
    let spawnCalled = false;
    const runner = new CodexRunner({
      spawnProcess: () => {
        spawnCalled = true;
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
    expect(spawnCalled).toBe(false);
  });

  it('guards invalid local recovery cwd before app-server resume launch', async () => {
    let spawnCalled = false;
    const runner = new CodexRunner({
      spawnProcess: () => {
        spawnCalled = true;
        throw new Error('should not be called');
      }
    });

    await expect(
      runner.resumeThreadInterruptAndRunTurn({
        ...makeStartInput('/tmp/symphony-recovery-does-not-exist-123456789'),
        previousThreadId: 'thread-recover',
        previousTurnId: 'turn-old',
        previousSessionId: 'session-old'
      })
    ).rejects.toMatchObject({ code: 'invalid_workspace_cwd' });
    expect(spawnCalled).toBe(false);
  });

  it('guards invalid remote recovery cwd before app-server resume launch', async () => {
    let spawnCalled = false;
    const runner = new CodexRunner({
      spawnProcess: () => {
        spawnCalled = true;
        throw new Error('should not be called');
      }
    });

    await expect(
      runner.resumeThreadInterruptAndRunTurn({
        ...makeStartInput('/tmp/workspace\nbad', {
          workerHost: 'build-1'
        }),
        previousThreadId: 'thread-recover',
        previousTurnId: 'turn-old',
        previousSessionId: 'session-old'
      })
    ).rejects.toMatchObject({ code: 'invalid_remote_workspace_cwd' });
    expect(spawnCalled).toBe(false);
  });
});
