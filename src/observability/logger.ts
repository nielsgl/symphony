import { redactLogInput } from '../security/redaction';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  event: string;
  message: string;
  timestamp: string;
  context: Record<string, string | number | boolean | null>;
}

export interface LogSink {
  name: string;
  write(entry: LogEntry, rendered: string): void;
}

export interface StructuredLogger {
  log(params: {
    level: LogLevel;
    event: string;
    message: string;
    context?: Record<string, string | number | boolean | null | undefined>;
  }): void;
}

class StderrSink implements LogSink {
  name = 'stderr';

  write(_entry: LogEntry, rendered: string): void {
    process.stderr.write(`${rendered}\n`);
  }
}

function asContext(
  raw: Record<string, string | number | boolean | null | undefined>
): Record<string, string | number | boolean | null> {
  const next: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue;
    }
    next[key] = value;
  }

  return next;
}

function renderEntry(entry: LogEntry): string {
  const parts = [`ts=${JSON.stringify(entry.timestamp)}`, `level=${entry.level}`, `event=${entry.event}`];
  const contextKeys = Object.keys(entry.context).sort();
  for (const key of contextKeys) {
    parts.push(`${key}=${JSON.stringify(entry.context[key])}`);
  }
  parts.push(`message=${JSON.stringify(entry.message)}`);
  return parts.join(' ');
}

export class MultiSinkLogger implements StructuredLogger {
  private readonly sinks: LogSink[];
  private readonly fallbackSink: LogSink;
  private readonly nowIso: () => string;

  constructor(options: { sinks?: LogSink[]; nowIso?: () => string } = {}) {
    this.fallbackSink = new StderrSink();
    this.sinks = options.sinks && options.sinks.length > 0 ? options.sinks : [this.fallbackSink];
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  log(params: {
    level: LogLevel;
    event: string;
    message: string;
    context?: Record<string, string | number | boolean | null | undefined>;
  }): void {
    const safe = redactLogInput({
      message: params.message,
      context: asContext(params.context ?? {})
    });

    const entry: LogEntry = {
      level: params.level,
      event: params.event,
      message: safe.message,
      timestamp: this.nowIso(),
      context: safe.context
    };

    const rendered = renderEntry(entry);
    let successfulWrites = 0;

    for (const sink of this.sinks) {
      try {
        sink.write(entry, rendered);
        successfulWrites += 1;
      } catch (error) {
        this.emitSinkFailureWarning(sink.name, error, successfulWrites > 0);
      }
    }

    if (successfulWrites === 0) {
      try {
        this.fallbackSink.write(entry, rendered);
      } catch {
        // Intentionally swallow final sink errors to keep orchestration alive.
      }
    }
  }

  private emitSinkFailureWarning(sinkName: string, error: unknown, alreadyVisible: boolean): void {
    const warning: LogEntry = {
      level: 'warn',
      event: 'log_sink_failure',
      message: error instanceof Error ? error.message : 'unknown sink error',
      timestamp: this.nowIso(),
      context: {
        sink: sinkName,
        surviving_sink_available: alreadyVisible
      }
    };

    try {
      this.fallbackSink.write(warning, renderEntry(warning));
    } catch {
      // Swallow to avoid cascading failures.
    }
  }
}
