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

describe('CodexRunner protocol', () => {
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
