import fs from 'node:fs';
import path from 'node:path';

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

export const DEFAULT_LOG_FILE_NAME = 'symphony.log';
export const DEFAULT_LOG_ROTATION_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_LOG_ROTATION_MAX_FILES = 5;

export class StderrSink implements LogSink {
  name = 'stderr';

  write(_entry: LogEntry, rendered: string): void {
    process.stderr.write(`${rendered}\n`);
  }
}

function rotateFile(baseFilePath: string, maxFiles: number): void {
  if (maxFiles <= 1) {
    if (fs.existsSync(baseFilePath)) {
      fs.unlinkSync(baseFilePath);
    }
    return;
  }

  const oldestArchivePath = `${baseFilePath}.${maxFiles - 1}`;
  if (fs.existsSync(oldestArchivePath)) {
    fs.unlinkSync(oldestArchivePath);
  }

  for (let index = maxFiles - 2; index >= 1; index -= 1) {
    const sourcePath = `${baseFilePath}.${index}`;
    const targetPath = `${baseFilePath}.${index + 1}`;
    if (fs.existsSync(sourcePath)) {
      fs.renameSync(sourcePath, targetPath);
    }
  }

  if (fs.existsSync(baseFilePath)) {
    fs.renameSync(baseFilePath, `${baseFilePath}.1`);
  }
}

export class RotatingFileSink implements LogSink {
  name = 'file';
  private readonly baseFilePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(options: {
    root: string;
    baseFileName?: string;
    maxBytes?: number;
    maxFiles?: number;
  }) {
    this.baseFilePath = path.join(options.root, options.baseFileName ?? DEFAULT_LOG_FILE_NAME);
    this.maxBytes = options.maxBytes ?? DEFAULT_LOG_ROTATION_MAX_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_LOG_ROTATION_MAX_FILES;
  }

  write(_entry: LogEntry, rendered: string): void {
    const line = `${rendered}\n`;
    this.rotateIfNeeded(Buffer.byteLength(line, 'utf8'));
    fs.appendFileSync(this.baseFilePath, line, 'utf8');
  }

  private rotateIfNeeded(incomingBytes: number): void {
    let currentSize = 0;
    try {
      currentSize = fs.statSync(this.baseFilePath).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }

    if (currentSize + incomingBytes <= this.maxBytes) {
      return;
    }

    rotateFile(this.baseFilePath, this.maxFiles);
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
