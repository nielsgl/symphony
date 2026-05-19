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

describe('CodexRunner dynamic tools', () => {
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
    for (const request of threadStartRequests) {
      expectGeneratedPayloadShape('ThreadStartParams', (request.params as Record<string, unknown>) ?? {}, [
        'approvalPolicy',
        'sandbox',
        'cwd'
      ]);
    }
    expect((threadStartRequests[0].params as Record<string, unknown>).dynamicTools).toBeTruthy();
    expectValueMatchesGeneratedSchema(
      generatedDefinition('ThreadStartParams').properties?.dynamicTools,
      (threadStartRequests[0].params as Record<string, unknown>).dynamicTools,
      'ThreadStartParams.dynamicTools'
    );
    expect((threadStartRequests[1].params as Record<string, unknown>).dynamicTools).toBeUndefined();
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
});
