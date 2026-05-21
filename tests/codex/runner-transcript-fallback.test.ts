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

const TRANSCRIPT_SCAN_INTERVAL_MS = 100;
const FIXED_TEST_NOW = new Date('2026-05-21T12:00:00.000Z');

describe('CodexRunner transcript fallback', () => {
  it('completes when transcript terminal evidence arrives before the hard turn deadline', async () => {
    vi.useFakeTimers();
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-'));
    const runner = new CodexRunner({
      spawnProcess: () => fake
    });

    try {
      const promise = runner.startSessionAndRunTurn(
        makeStartInput(workspaceCwd, {
          commandEnv: { CODEX_HOME: codexHome },
          turnTimeoutMs: 200
        })
      );

      fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
      fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-transcript-before-deadline"}}}\n');
      fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-transcript-before-deadline"}}}\n');

      await vi.advanceTimersByTimeAsync(90);
      writeTranscriptRecord(codexHome, 'rollout-thread-transcript-before-deadline.jsonl', {
        timestamp: '2026-05-07T19:45:20.171Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-transcript-before-deadline'
        }
      });
      await vi.advanceTimersByTimeAsync(10);

      await expect(promise).resolves.toMatchObject({
        status: 'completed',
        thread_id: 'thread-transcript-before-deadline',
        turn_id: 'turn-transcript-before-deadline',
        terminal_source: 'session_transcript'
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('completes a turn from matching session transcript task_complete without protocol terminal notification', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-'));
    const events: CodexRunnerEvent[] = [];
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
    expect(events).toContainEqual(
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.tokenUsageUpdated,
        thread_id: 'thread-transcript',
        turn_id: 'turn-transcript',
        session_id: 'thread-transcript-turn-transcript',
        usage: {
          input_tokens: 30,
          output_tokens: 12,
          total_tokens: 42
        },
        token_telemetry_status: 'available',
        token_telemetry_last_source: 'transcript_token_count',
        token_telemetry_last_at_ms: Date.parse('2026-05-07T19:45:20.168Z'),
        rate_limits: {
          limit_id: 'codex'
        }
      })
    );
  });

  it('deduplicates transcript token usage events and emits increasing snapshots', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-'));
    const events: CodexRunnerEvent[] = [];
    const runner = new CodexRunner({ spawnProcess: () => fake });

    const promise = runner.startSessionAndRunTurn(
      makeStartInput(workspaceCwd, {
        commandEnv: { CODEX_HOME: codexHome },
        onEvent: (event) => events.push(event),
        turnTimeoutMs: 1000
      })
    );

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-token-progress"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-token-progress"}}}\n');
    writeTranscriptRecord(codexHome, 'rollout-thread-token-progress.jsonl', {
      timestamp: '2026-05-07T19:45:20.100Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 7,
            output_tokens: 3,
            total_tokens: 10
          }
        }
      }
    });
    writeTranscriptRecord(codexHome, 'rollout-thread-token-progress.jsonl', {
      timestamp: '2026-05-07T19:45:20.110Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 7,
            output_tokens: 3,
            total_tokens: 10
          }
        }
      }
    });
    writeTranscriptRecord(codexHome, 'rollout-thread-token-progress.jsonl', {
      timestamp: '2026-05-07T19:45:20.120Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 11,
            output_tokens: 4,
            total_tokens: 15
          }
        }
      }
    });
    writeTranscriptRecord(codexHome, 'rollout-thread-token-progress.jsonl', {
      timestamp: '2026-05-07T19:45:20.130Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-token-progress',
        last_agent_message: 'done from token progress transcript'
      }
    });

    await expect(promise).resolves.toMatchObject({
      status: 'completed',
      thread_id: 'thread-token-progress',
      turn_id: 'turn-token-progress',
      usage: {
        input_tokens: 11,
        output_tokens: 4,
        total_tokens: 15
      }
    });
    const tokenEvents = events.filter((event) => event.event === CANONICAL_EVENT.codex.tokenUsageUpdated);
    expect(tokenEvents).toHaveLength(2);
    expect(tokenEvents[0]).toMatchObject({
      thread_id: 'thread-token-progress',
      turn_id: 'turn-token-progress',
      session_id: 'thread-token-progress-turn-token-progress',
      usage: {
        input_tokens: 7,
        output_tokens: 3,
        total_tokens: 10
      },
      token_telemetry_last_source: 'transcript_token_count',
      token_telemetry_last_at_ms: Date.parse('2026-05-07T19:45:20.100Z')
    });
    expect(tokenEvents[1]).toMatchObject({
      usage: {
        input_tokens: 11,
        output_tokens: 4,
        total_tokens: 15
      },
      token_telemetry_last_at_ms: Date.parse('2026-05-07T19:45:20.120Z')
    });
  });

  it('completes after a transcript task_complete JSONL record is split across scans', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_TEST_NOW);
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

    try {
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
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_SCAN_INTERVAL_MS);
      appendTranscriptText(codexHome, 'rollout-thread-split.jsonl', `${terminalRecord.slice(70)}\n`);
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_SCAN_INTERVAL_MS);

      await expect(promise).resolves.toMatchObject({
        status: 'completed',
        thread_id: 'thread-split',
        turn_id: 'turn-split',
        terminal_source: 'session_transcript',
        last_agent_message: 'split complete'
      });
    } finally {
      vi.useRealTimers();
    }
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

  it('bounds and caches runner transcript fallback discovery when no transcript matches', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-'));
    const sessionsDir = path.join(codexHome, 'sessions', '2026', '05');
    fs.mkdirSync(sessionsDir, { recursive: true });
    for (let index = 0; index < 60; index += 1) {
      const historicalDir = path.join(sessionsDir, String(index).padStart(2, '0'));
      fs.mkdirSync(historicalDir, { recursive: true });
      fs.writeFileSync(
        path.join(historicalDir, `rollout-2026-05-01T00-00-${String(index).padStart(2, '0')}-historical.jsonl`),
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          type: 'event_msg',
          payload: { type: 'noise', padding: 'x'.repeat(1024) }
        })}\n`,
        'utf8'
      );
    }

    const runner = new CodexRunner({ spawnProcess: () => fake });
    const readdirSpy = vi.spyOn(fs, 'readdirSync');
    const promise = runner.startSessionAndRunTurn(
      makeStartInput(workspaceCwd, {
        commandEnv: { CODEX_HOME: codexHome },
        turnTimeoutMs: 300
      })
    );

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-missing-bounded"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-missing-bounded"}}}\n');

    await expect(promise).rejects.toMatchObject({ code: REASON_CODES.turnTimeout });

    expect(readdirSpy.mock.calls.length).toBeLessThanOrEqual(70);
    readdirSpy.mockRestore();
  });

  it('prioritizes newer fallback transcript directories before old siblings under discovery budget', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-'));
    const sessionsDir = path.join(codexHome, 'sessions', '2026', '05');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const oldDir = path.join(sessionsDir, '06');
    fs.mkdirSync(oldDir, { recursive: true });
    for (let index = 0; index < 30; index += 1) {
      fs.writeFileSync(
        path.join(oldDir, `rollout-2026-05-06T00-00-${String(index).padStart(2, '0')}-old.jsonl`),
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          type: 'event_msg',
          payload: { type: 'noise', padding: 'x'.repeat(128) }
        })}\n`,
        'utf8'
      );
    }
    fs.mkdirSync(path.join(sessionsDir, '07'), { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, '07', 'rollout-2026-05-07T23-59-59-active.jsonl'),
      `${JSON.stringify({
        timestamp: '2026-05-07T23:59:59.999Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          thread_id: 'thread-priority',
          turn_id: 'turn-priority',
          last_agent_message: 'newest fallback transcript won'
        }
      })}\n`,
      'utf8'
    );

    const runner = new CodexRunner({ spawnProcess: () => fake });
    const promise = runner.startSessionAndRunTurn(
      makeStartInput(workspaceCwd, {
        commandEnv: { CODEX_HOME: codexHome },
        turnTimeoutMs: 3000
      })
    );

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-priority"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-priority"}}}\n');

    await expect(promise).resolves.toMatchObject({
      status: 'completed',
      thread_id: 'thread-priority',
      turn_id: 'turn-priority',
      terminal_source: 'session_transcript',
      last_agent_message: 'newest fallback transcript won',
      transcript_lookup: expect.objectContaining({
        source: 'fallback',
        candidate_count: 1,
        exhausted: false
      })
    });
  });

  it('prioritizes the active fallback transcript before newer same-directory noise under discovery budget', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-'));
    const sessionsDir = path.join(codexHome, 'sessions', '2026', '05', '07');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const filenameTimestamp = (date: Date) => date.toISOString().slice(0, 19).replace(/:/g, '-');
    const activeStartedAtMs = Date.now();
    const activeTranscriptTimestamp = filenameTimestamp(new Date(activeStartedAtMs - 10_000));

    fs.writeFileSync(
      path.join(sessionsDir, `rollout-${activeTranscriptTimestamp}-active.jsonl`),
      `${JSON.stringify({
        timestamp: new Date(activeStartedAtMs - 10_000).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          thread_id: 'thread-long-running',
          turn_id: 'turn-long-running',
          last_agent_message: 'older active fallback transcript won'
        }
      })}\n`,
      'utf8'
    );
    for (let index = 0; index < 40; index += 1) {
      const noiseTimestamp = filenameTimestamp(new Date(activeStartedAtMs + (60 + index) * 60_000));
      fs.writeFileSync(
        path.join(sessionsDir, `rollout-${noiseTimestamp}-noise.jsonl`),
        `${JSON.stringify({
          timestamp: new Date(activeStartedAtMs + (60 + index) * 60_000).toISOString(),
          type: 'event_msg',
          payload: { type: 'noise', padding: 'x'.repeat(128) }
        })}\n`,
        'utf8'
      );
    }

    const runner = new CodexRunner({ spawnProcess: () => fake });
    const promise = runner.startSessionAndRunTurn(
      makeStartInput(workspaceCwd, {
        commandEnv: { CODEX_HOME: codexHome },
        turnTimeoutMs: 3000
      })
    );

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-long-running"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-long-running"}}}\n');

    await expect(promise).resolves.toMatchObject({
      status: 'completed',
      thread_id: 'thread-long-running',
      turn_id: 'turn-long-running',
      terminal_source: 'session_transcript',
      last_agent_message: 'older active fallback transcript won',
      transcript_lookup: expect.objectContaining({
        source: 'fallback',
        candidate_count: 1,
        exhausted: false
      })
    });
  });

  it('prioritizes the active fallback transcript directory before newer sibling noise under discovery budget', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-'));
    const filenameTimestamp = (date: Date) => date.toISOString().slice(0, 19).replace(/:/g, '-');
    const activeStartedAtMs = Date.now();
    const activeDate = new Date(activeStartedAtMs - 10_000);
    const newerDate = new Date(activeStartedAtMs + 24 * 60 * 60 * 1000);
    const datePathParts = (date: Date): [string, string, string] => [
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0')
    ];
    const activeDir = path.join(codexHome, 'sessions', ...datePathParts(activeDate));
    const newerDir = path.join(codexHome, 'sessions', ...datePathParts(newerDate));
    fs.mkdirSync(activeDir, { recursive: true });
    fs.mkdirSync(newerDir, { recursive: true });

    for (let index = 0; index < 40; index += 1) {
      const noiseTimestamp = filenameTimestamp(new Date(newerDate.getTime() + index * 60_000));
      fs.writeFileSync(
        path.join(newerDir, `rollout-${noiseTimestamp}-noise.jsonl`),
        `${JSON.stringify({
          timestamp: new Date(newerDate.getTime() + index * 60_000).toISOString(),
          type: 'event_msg',
          payload: { type: 'noise', padding: 'x'.repeat(128) }
        })}\n`,
        'utf8'
      );
    }
    const activeTranscriptTimestamp = filenameTimestamp(activeDate);
    fs.writeFileSync(
      path.join(activeDir, `rollout-${activeTranscriptTimestamp}-active.jsonl`),
      `${JSON.stringify({
        timestamp: activeDate.toISOString(),
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          thread_id: 'thread-sibling-priority',
          turn_id: 'turn-sibling-priority',
          last_agent_message: 'active sibling directory won'
        }
      })}\n`,
      'utf8'
    );

    const runner = new CodexRunner({ spawnProcess: () => fake });
    const promise = runner.startSessionAndRunTurn(
      makeStartInput(workspaceCwd, {
        commandEnv: { CODEX_HOME: codexHome },
        turnTimeoutMs: 1000
      })
    );

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-sibling-priority"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-sibling-priority"}}}\n');

    await expect(promise).resolves.toMatchObject({
      status: 'completed',
      thread_id: 'thread-sibling-priority',
      turn_id: 'turn-sibling-priority',
      terminal_source: 'session_transcript',
      last_agent_message: 'active sibling directory won',
      transcript_lookup: expect.objectContaining({
        source: 'fallback',
        candidate_count: 1,
        exhausted: false
      })
    });
  });

  it('rescans after an initial empty fallback lookup when the active transcript appears later', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_TEST_NOW);
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-'));
    const sessionsDir = path.join(codexHome, 'sessions', '2026', '05', '07');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const runner = new CodexRunner({ spawnProcess: () => fake });
    try {
      const promise = runner.startSessionAndRunTurn(
        makeStartInput(workspaceCwd, {
          commandEnv: { CODEX_HOME: codexHome },
          turnTimeoutMs: 3000
        })
      );

      fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
      fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-late-transcript"}}}\n');
      fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-late-transcript"}}}\n');

      await vi.advanceTimersByTimeAsync(TRANSCRIPT_SCAN_INTERVAL_MS);
      fs.writeFileSync(
        path.join(sessionsDir, 'rollout-2026-05-07T16-23-49-late.jsonl'),
        `${JSON.stringify({
          timestamp: '2026-05-07T16:23:49.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            thread_id: 'thread-late-transcript',
            turn_id: 'turn-late-transcript',
            last_agent_message: 'late transcript discovered'
          }
        })}\n`,
        'utf8'
      );
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_SCAN_INTERVAL_MS);

      await expect(promise).resolves.toMatchObject({
        status: 'completed',
        thread_id: 'thread-late-transcript',
        turn_id: 'turn-late-transcript',
        terminal_source: 'session_transcript',
        last_agent_message: 'late transcript discovered',
        transcript_lookup: expect.objectContaining({
          source: 'fallback',
          candidate_count: 1,
          exhausted: false
        })
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rescans after initial budget exhaustion when the active transcript appears later', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_TEST_NOW);
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-'));
    const sessionsDir = path.join(codexHome, 'sessions', '2026', '05', '07');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const filenameTimestamp = (date: Date) => date.toISOString().slice(0, 19).replace(/:/g, '-');
    const activeStartedAtMs = FIXED_TEST_NOW.getTime();

    for (let index = 0; index < 40; index += 1) {
      const noiseTimestamp = filenameTimestamp(new Date(activeStartedAtMs + (60 + index) * 60_000));
      fs.writeFileSync(
        path.join(sessionsDir, `rollout-${noiseTimestamp}-noise.jsonl`),
        `${JSON.stringify({
          timestamp: new Date(activeStartedAtMs + (60 + index) * 60_000).toISOString(),
          type: 'event_msg',
          payload: { type: 'noise', padding: 'x'.repeat(128) }
        })}\n`,
        'utf8'
      );
    }

    const runner = new CodexRunner({ spawnProcess: () => fake });
    try {
      const promise = runner.startSessionAndRunTurn(
        makeStartInput(workspaceCwd, {
          commandEnv: { CODEX_HOME: codexHome },
          turnTimeoutMs: 3000
        })
      );

      fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
      fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-late-budget"}}}\n');
      fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-late-budget"}}}\n');

      await vi.advanceTimersByTimeAsync(TRANSCRIPT_SCAN_INTERVAL_MS);
      const activeTranscriptTimestamp = filenameTimestamp(new Date(activeStartedAtMs - 10_000));
      fs.writeFileSync(
        path.join(sessionsDir, `rollout-${activeTranscriptTimestamp}-active.jsonl`),
        `${JSON.stringify({
          timestamp: new Date(activeStartedAtMs - 10_000).toISOString(),
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            thread_id: 'thread-late-budget',
            turn_id: 'turn-late-budget',
            last_agent_message: 'late transcript after budget exhaustion'
          }
        })}\n`,
        'utf8'
      );
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_SCAN_INTERVAL_MS);

      await expect(promise).resolves.toMatchObject({
        status: 'completed',
        thread_id: 'thread-late-budget',
        turn_id: 'turn-late-budget',
        terminal_source: 'session_transcript',
        last_agent_message: 'late transcript after budget exhaustion',
        transcript_lookup: expect.objectContaining({
          source: 'fallback',
          candidate_count: 1,
          exhausted: false
        })
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits transcript lookup diagnostics when fallback budget is exhausted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_TEST_NOW);
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-'));
    const sessionsDir = path.join(codexHome, 'sessions', '2026', '05', '07');
    fs.mkdirSync(sessionsDir, { recursive: true });
    for (let index = 0; index < 60; index += 1) {
      fs.writeFileSync(
        path.join(sessionsDir, `rollout-2026-05-07T00-00-${String(index).padStart(2, '0')}-old.jsonl`),
        `${JSON.stringify({
          timestamp: FIXED_TEST_NOW.toISOString(),
          type: 'event_msg',
          payload: { type: 'noise', padding: 'x'.repeat(1024) }
        })}\n`,
        'utf8'
      );
    }
    const events: CodexRunnerEvent[] = [];
    const runner = new CodexRunner({ spawnProcess: () => fake });
    try {
      const promise = runner.startSessionAndRunTurn(
        makeStartInput(workspaceCwd, {
          commandEnv: { CODEX_HOME: codexHome },
          onEvent: (event) => events.push(event),
          turnTimeoutMs: 1000
        })
      );

      fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
      fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-diagnostics"}}}\n');
      fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-diagnostics"}}}\n');

      const timeoutExpectation = expect(promise).rejects.toMatchObject({ code: REASON_CODES.turnTimeout });
      await vi.advanceTimersByTimeAsync(1000);

      await timeoutExpectation;
      expect(events).toContainEqual(
        expect.objectContaining({
          event: CANONICAL_EVENT.codex.transcriptLookup,
          transcript_lookup_source: 'budget_exhausted',
          transcript_lookup_exhausted: true,
          transcript_lookup_reason_codes: expect.arrayContaining(['transcript_discovery_file_count_budget_exhausted'])
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('finds filename-matched transcripts beyond the fallback probe budget', async () => {
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-'));
    const now = new Date();
    const sessionsDir = path.join(
      codexHome,
      'sessions',
      String(now.getFullYear()).padStart(4, '0'),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    );
    fs.mkdirSync(sessionsDir, { recursive: true });
    for (let index = 0; index < 60; index += 1) {
      fs.writeFileSync(
        path.join(sessionsDir, `rollout-2026-05-07T23-59-${String(index).padStart(2, '0')}-noise.jsonl`),
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          type: 'event_msg',
          payload: { type: 'noise', padding: 'x'.repeat(1024) }
        })}\n`,
        'utf8'
      );
    }
    fs.writeFileSync(
      path.join(sessionsDir, 'rollout-2026-05-07T00-00-00-thread-filename-budget.jsonl'),
      `${JSON.stringify({
        timestamp: '2026-05-07T00:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          thread_id: 'thread-filename-budget',
          turn_id: 'turn-filename-budget',
          last_agent_message: 'filename lookup found active transcript'
        }
      })}\n`,
      'utf8'
    );

    const runner = new CodexRunner({ spawnProcess: () => fake });
    const promise = runner.startSessionAndRunTurn(
      makeStartInput(workspaceCwd, {
        commandEnv: { CODEX_HOME: codexHome },
        turnTimeoutMs: 1000
      })
    );

    fake.emitStdout('{"id":1,"result":{"ok":true}}\n');
    fake.emitStdout('{"id":2,"result":{"thread":{"id":"thread-filename-budget"}}}\n');
    fake.emitStdout('{"id":3,"result":{"turn":{"id":"turn-filename-budget"}}}\n');

    await expect(promise).resolves.toMatchObject({
      status: 'completed',
      thread_id: 'thread-filename-budget',
      turn_id: 'turn-filename-budget',
      terminal_source: 'session_transcript',
      last_agent_message: 'filename lookup found active transcript',
      transcript_lookup: expect.objectContaining({
        source: 'filename',
        candidate_count: 1,
        files_considered: 61,
        files_parsed: 0,
        bytes_read: 0,
        exhausted: false
      })
    });
  });

  it('keeps wrong-lineage transcript task_complete diagnostic-only until protocol completion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_TEST_NOW);
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-'));
    const events: Array<{ event: string; terminal_source?: string; detail?: string }> = [];
    const runner = new CodexRunner({ spawnProcess: () => fake });

    try {
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

      await vi.advanceTimersByTimeAsync(TRANSCRIPT_SCAN_INTERVAL_MS);
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
    } finally {
      vi.useRealTimers();
    }
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
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_TEST_NOW);
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-'));
    const events: Array<{ event: string; terminal_source?: string; detail?: string }> = [];
    const runner = new CodexRunner({ spawnProcess: () => fake });

    try {
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

      await vi.advanceTimersByTimeAsync(TRANSCRIPT_SCAN_INTERVAL_MS);
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
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { type: 'task_failed', expectedEvent: CANONICAL_EVENT.codex.turnFailed, expectedError: 'turn_failed' },
    { type: 'task_cancelled', expectedEvent: CANONICAL_EVENT.codex.turnCancelled, expectedError: 'turn_cancelled' },
    { type: 'task_input_required', expectedEvent: CANONICAL_EVENT.codex.turnInputRequired, expectedError: REASON_CODES.turnInputRequired }
  ])('maps transcript-only $type terminal evidence through the runner result', async ({ type, expectedEvent, expectedError }) => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_TEST_NOW);
    const fake = new FakeProcess();
    const workspaceCwd = makeWorkspace();
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-'));
    const runner = new CodexRunner({ spawnProcess: () => fake });

    try {
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
      await vi.advanceTimersByTimeAsync(TRANSCRIPT_SCAN_INTERVAL_MS);

      await expect(promise).resolves.toMatchObject({
        status: 'failed',
        thread_id: 'thread-terminal',
        turn_id: 'turn-terminal',
        last_event: expectedEvent,
        error_code: expectedError,
        terminal_source: 'session_transcript'
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
