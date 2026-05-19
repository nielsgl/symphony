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

describe('CodexRunner server requests', () => {
  it('auto-approves allowlisted approval requests and rejects unsupported tool calls without stalling', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout('{"id":91,"method":"item/commandExecution/requestApproval","params":{"kind":"command"}}\n');
    fake.emitStdout('{"id":92,"method":"item/tool/call","params":{"name":"unknown"}}\n');
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({ status: 'completed' });

    const responses = parseWrittenMessages(fake).filter((message) => typeof message.id === 'number' && 'result' in message);
    expect(responses).toContainEqual({ id: 91, result: { decision: 'acceptForSession' } });
    expect(responses).toContainEqual(
      expect.objectContaining({
        id: 92,
        result: expect.objectContaining({
          success: false,
          output: expect.stringContaining('"attemptedToolName": "unknown"')
        })
      })
    );
    expect(responses).toContainEqual(
      expect.objectContaining({
        id: 92,
        result: expect.objectContaining({
          output: expect.stringContaining('"supportedTools": [')
        })
      })
    );
  });

  it('uses method-specific approval decisions for allowlisted approval request methods', async () => {
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
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({ status: 'completed' });

    const responses = parseWrittenMessages(fake).filter((message) => typeof message.id === 'number' && 'result' in message);
    expect(responses).toContainEqual({ id: 81, result: { decision: 'acceptForSession' } });
    expect(responses).toContainEqual({ id: 82, result: { decision: 'acceptForSession' } });
    expect(responses).toContainEqual({ id: 83, result: { decision: 'approved_for_session' } });
    expect(responses).toContainEqual({ id: 84, result: { decision: 'approved_for_session' } });
  });

  it('rejects unknown approval-like requests with unsupported protocol evidence', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const events: Array<{ event: string; detail?: string; request_method?: string; request_category?: string; reason_code?: string }> = [];
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
    fake.emitStdout('{"id":85,"method":"approval/request","params":{"kind":"unknown"}}\n');
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({ status: 'completed' });

    const responses = parseWrittenMessages(fake).filter((message) => typeof message.id === 'number' && 'result' in message);
    expect(responses).not.toContainEqual({ id: 85, result: { approved: true } });
    expect(responses).toContainEqual({
      id: 85,
      result: {
        success: false,
        error: 'unsupported_server_request',
        method: 'approval/request',
        category: 'approval',
        reason_code: REASON_CODES.unsupportedApprovalServerRequest
      }
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: CANONICAL_EVENT.codex.unsupportedServerRequest,
          request_method: 'approval/request',
          request_category: 'approval',
          reason_code: REASON_CODES.unsupportedApprovalServerRequest
        })
      ])
    );
  });

  it.each([
    {
      method: 'item/permissions/requestApproval',
      category: 'permission',
      reasonCode: REASON_CODES.unsupportedPermissionServerRequest
    },
    {
      method: 'getAuthStatus',
      category: 'authentication',
      reasonCode: REASON_CODES.unsupportedAuthenticationServerRequest
    },
    {
      method: 'account/chatgptAuthTokens/refresh',
      category: 'account',
      reasonCode: REASON_CODES.unsupportedAccountServerRequest
    },
    {
      method: 'credential/request',
      category: 'safety_sensitive',
      reasonCode: REASON_CODES.unsupportedSafetySensitiveServerRequest
    }
  ])(
    'fails closed for unsupported safety-sensitive $method requests',
    async ({ method, category, reasonCode }) => {
      const fake = new FakeProcess();
      const workspaceCwd = makeWorkspace();
      const events: Array<{ event: string; detail?: string; request_method?: string; request_category?: string; reason_code?: string }> = [];
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
      fake.emitStdout(`${JSON.stringify({ id: 86, method, params: {} })}\n`);
      fake.emitStdout('{"method":"turn/completed"}\n');

      await expect(promise).resolves.toMatchObject({
        status: 'failed',
        last_event: CANONICAL_EVENT.codex.turnInputRequired,
        error_code: REASON_CODES.turnInputRequired,
        error_detail: `unsupported safety-sensitive server request: ${method}`
      });

      const responses = parseWrittenMessages(fake).filter((message) => typeof message.id === 'number' && 'result' in message);
      expect(responses).not.toContainEqual({ id: 86, result: { approved: true } });
      expect(responses).not.toContainEqual({ id: 86, result: { success: true } });
      expect(responses).toContainEqual({
        id: 86,
        result: {
          success: false,
          error: 'unsupported_server_request',
          method,
          category,
          reason_code: reasonCode
        }
      });
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: CANONICAL_EVENT.codex.unsupportedServerRequest,
            request_method: method,
            request_category: category,
            reason_code: reasonCode
          }),
          expect.objectContaining({
            event: CANONICAL_EVENT.codex.turnInputRequired
          })
        ])
      );
    }
  );

  it('rejects unknown server requests so they cannot silently stall a turn', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout('{"id":99,"method":"unknown/serverRequest","params":{}}\n');
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({ status: 'completed' });

    const responses = parseWrittenMessages(fake).filter((message) => typeof message.id === 'number' && 'result' in message);
    expect(responses).toContainEqual({
      id: 99,
      result: {
        success: false,
        error: 'unsupported_server_request',
        method: 'unknown/serverRequest',
        category: 'unsupported',
        reason_code: REASON_CODES.unsupportedServerRequest
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
});
