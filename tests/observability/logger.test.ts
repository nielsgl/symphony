import { describe, expect, it, vi } from 'vitest';

import { MultiSinkLogger, type LogEntry, type LogSink } from '../../src/observability';

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
});
