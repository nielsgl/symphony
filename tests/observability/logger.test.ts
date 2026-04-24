import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  MultiSinkLogger,
  RotatingFileSink,
  StderrSink,
  type LogEntry,
  type LogSink
} from '../../src/observability';

class MemorySink implements LogSink {
  name = 'memory';
  readonly entries: string[] = [];

  write(_entry: LogEntry, rendered: string): void {
    this.entries.push(rendered);
  }
}

describe('MultiSinkLogger', () => {
  it('renders stable key=value logs with context fields', () => {
    const sink = new MemorySink();
    const logger = new MultiSinkLogger({
      sinks: [sink],
      nowIso: () => '2026-04-11T12:00:00.000Z'
    });

    logger.log({
      level: 'info',
      event: 'worker_event',
      message: 'turn_completed',
      context: {
        issue_id: 'i-1',
        issue_identifier: 'ABC-1',
        session_id: 'thread-1-turn-1'
      }
    });

    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]).toContain('level=info');
    expect(sink.entries[0]).toContain('event=worker_event');
    expect(sink.entries[0]).toContain('issue_id="i-1"');
    expect(sink.entries[0]).toContain('issue_identifier="ABC-1"');
    expect(sink.entries[0]).toContain('session_id="thread-1-turn-1"');
  });

  it('continues logging when one sink fails and emits a sink warning', () => {
    const healthySink = new MemorySink();
    const failingSink: LogSink = {
      name: 'failing',
      write: vi.fn(() => {
        throw new Error('disk full');
      })
    };

    const logger = new MultiSinkLogger({
      sinks: [failingSink, healthySink],
      nowIso: () => '2026-04-11T12:00:00.000Z'
    });

    logger.log({
      level: 'warn',
      event: 'api_internal_error',
      message: 'boom'
    });

    expect(healthySink.entries.some((entry) => entry.includes('event=api_internal_error'))).toBe(true);
  });

  it('redacts secrets in message and context', () => {
    const sink = new MemorySink();
    const logger = new MultiSinkLogger({ sinks: [sink], nowIso: () => '2026-04-11T12:00:00.000Z' });

    logger.log({
      level: 'info',
      event: 'tracker_auth',
      message: 'request failed token=abcd1234',
      context: {
        api_key: 'shh',
        issue_id: 'i-1'
      }
    });

    expect(sink.entries[0]).toContain('api_key="***REDACTED***"');
    expect(sink.entries[0]).not.toContain('abcd1234');
  });

  it('writes redacted entries to rotating file sink', () => {
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-log-test-'));
    const logger = new MultiSinkLogger({
      sinks: [
        new StderrSink(),
        new RotatingFileSink({
          root: logRoot,
          maxBytes: 1024,
          maxFiles: 5
        })
      ],
      nowIso: () => '2026-04-11T12:00:00.000Z'
    });

    logger.log({
      level: 'error',
      event: 'worker_event',
      message: 'token=abc123',
      context: {
        issue_identifier: 'ABC-1',
        api_key: 'secret'
      }
    });

    const fileContent = fs.readFileSync(path.join(logRoot, 'symphony.log'), 'utf8');
    expect(fileContent).toContain('issue_identifier="ABC-1"');
    expect(fileContent).toContain('api_key="***REDACTED***"');
    expect(fileContent).not.toContain('abc123');

    fs.rmSync(logRoot, { recursive: true, force: true });
  });

  it('rotates log files when max bytes are exceeded and enforces retention cap', () => {
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-log-rotate-'));
    const logger = new MultiSinkLogger({
      sinks: [
        new RotatingFileSink({
          root: logRoot,
          maxBytes: 200,
          maxFiles: 3
        })
      ],
      nowIso: () => '2026-04-11T12:00:00.000Z'
    });

    for (let index = 0; index < 40; index += 1) {
      logger.log({
        level: 'info',
        event: 'rotation.test',
        message: `entry-${index}-${'x'.repeat(60)}`
      });
    }

    expect(fs.existsSync(path.join(logRoot, 'symphony.log'))).toBe(true);
    expect(fs.existsSync(path.join(logRoot, 'symphony.log.1'))).toBe(true);
    expect(fs.existsSync(path.join(logRoot, 'symphony.log.2'))).toBe(true);
    expect(fs.existsSync(path.join(logRoot, 'symphony.log.3'))).toBe(false);

    fs.rmSync(logRoot, { recursive: true, force: true });
  });
});
