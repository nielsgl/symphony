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

describe('CodexRunner telemetry', () => {
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

  it('normalizes generated app-server token, rate-limit, warning, and model-reroute signals', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const events: CodexRunnerEvent[] = [];
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const tokenTotal = {
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          total: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
          last: { inputTokens: 10, outputTokens: 4, totalTokens: 14 }
        }
      }
    } satisfies ThreadTokenUsageUpdatedNotification & Record<string, unknown>;
    const tokenDelta = {
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          delta: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
        }
      }
    } satisfies ThreadTokenUsageUpdatedNotification & Record<string, unknown>;
    const rateLimit = {
      method: 'account/rateLimits/updated',
      params: {
        account: {
          rateLimits: {
            primary: { remaining: 41, limit: 100, resetAt: '2026-05-11T13:30:00.000Z' }
          }
        }
      }
    } satisfies AccountRateLimitsUpdatedNotification & Record<string, unknown>;
    const warning = {
      method: 'warning',
      params: { message: 'configuration will be updated by the server' }
    } satisfies WarningNotification & Record<string, unknown>;
    const guardianWarning = {
      method: 'guardianWarning',
      params: { message: 'guardian policy warning' }
    } satisfies GuardianWarningNotification & Record<string, unknown>;
    const configWarning = {
      method: 'configWarning',
      params: { message: 'deprecated config key' }
    } satisfies ConfigWarningNotification & Record<string, unknown>;
    const deprecationNotice = {
      method: 'deprecationNotice',
      params: { message: 'old protocol key is deprecated', severity: 'info' }
    } satisfies DeprecationNoticeNotification & Record<string, unknown>;
    const modelReroute = {
      method: 'model/rerouted',
      params: {
        requestedModel: 'gpt-requested',
        effectiveModel: 'gpt-effective'
      }
    } satisfies ModelReroutedNotification & Record<string, unknown>;

    const promise = runner.startSessionAndRunTurn(
      makeStartInput(workspaceCwd, {
        command: 'codex',
        commandArgs: ['--config', 'model="gpt-requested"', 'app-server'],
        onEvent: (event) => events.push(event)
      })
    );

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    for (const notification of [
      tokenTotal,
      tokenDelta,
      rateLimit,
      warning,
      guardianWarning,
      configWarning,
      deprecationNotice,
      modelReroute
    ]) {
      fake.emitStdout(`${JSON.stringify(notification)}\n`);
    }
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({
      usage: {
        input_tokens: 13,
        output_tokens: 6,
        total_tokens: 19
      },
      rate_limits: {
        primary: { remaining: 41, limit: 100, resetAt: '2026-05-11T13:30:00.000Z' }
      },
      protocol_warnings: [
        {
          method: 'warning',
          reason_code: 'codex_protocol_warning',
          message: 'configuration will be updated by the server',
          severity: 'warn',
          source: 'app_server_protocol'
        },
        {
          method: 'guardianWarning',
          reason_code: 'codex_protocol_guardian_warning',
          message: 'guardian policy warning',
          severity: 'warn',
          source: 'app_server_protocol'
        },
        {
          method: 'configWarning',
          reason_code: 'codex_protocol_config_warning',
          message: 'deprecated config key',
          severity: 'warn',
          source: 'app_server_protocol'
        },
        {
          method: 'deprecationNotice',
          reason_code: 'codex_protocol_deprecation_notice',
          message: 'old protocol key is deprecated',
          severity: 'info',
          source: 'app_server_protocol'
        }
      ],
      model_reroute: {
        requested_model: 'gpt-requested',
        effective_model: 'gpt-effective',
        reason_code: 'codex_model_rerouted',
        source: 'app_server_protocol'
      },
      requested_model: 'gpt-requested',
      effective_model: 'gpt-effective'
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: CANONICAL_EVENT.codex.rateLimitsUpdated }),
        expect.objectContaining({ event: CANONICAL_EVENT.codex.protocolWarning }),
        expect.objectContaining({ event: CANONICAL_EVENT.codex.modelRerouted })
      ])
    );
  });

  it('preserves token, rate-limit, and model state when generated telemetry fields are malformed', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const goodRateLimit = {
      method: 'account/rateLimits/updated',
      params: { limits: { remaining: 7, limit: 10 } }
    } satisfies AccountRateLimitsUpdatedNotification & Record<string, unknown>;
    const malformedRateLimit = {
      method: 'account/rateLimits/updated',
      params: { rateLimits: 'not-an-object' }
    } satisfies AccountRateLimitsUpdatedNotification & Record<string, unknown>;
    const goodModelReroute = {
      method: 'model/rerouted',
      params: { requestedModel: 'gpt-requested', effectiveModel: 'gpt-effective' }
    } satisfies ModelReroutedNotification & Record<string, unknown>;
    const malformedModelReroute = {
      method: 'model/rerouted',
      params: { requestedModel: 'gpt-requested' }
    } satisfies ModelReroutedNotification & Record<string, unknown>;

    const promise = runner.startSessionAndRunTurn(makeStartInput(workspaceCwd));

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-1"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-1"}}}\n');
    fake.emitStdout(
      '{"method":"thread/tokenUsage/updated","params":{"tokenUsage":{"total":{"inputTokens":9,"outputTokens":3,"totalTokens":12}}}}\n'
    );
    fake.emitStdout(`${JSON.stringify(goodRateLimit)}\n`);
    fake.emitStdout(`${JSON.stringify(goodModelReroute)}\n`);
    fake.emitStdout(
      '{"method":"thread/tokenUsage/updated","params":{"tokenUsage":{"total":{"inputTokens":"missing","outputTokens":99,"totalTokens":99},"delta":{"inputTokens":"bad","outputTokens":99,"totalTokens":99}}}}\n'
    );
    fake.emitStdout(`${JSON.stringify(malformedRateLimit)}\n`);
    fake.emitStdout(`${JSON.stringify(malformedModelReroute)}\n`);
    fake.emitStdout('{"method":"turn/completed"}\n');

    await expect(promise).resolves.toMatchObject({
      usage: {
        input_tokens: 9,
        output_tokens: 3,
        total_tokens: 12
      },
      rate_limits: {
        remaining: 7,
        limit: 10
      },
      model_reroute: {
        requested_model: 'gpt-requested',
        effective_model: 'gpt-effective'
      },
      effective_model: 'gpt-effective'
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
});
