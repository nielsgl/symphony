import type { LogEntry, LogSink } from './logger';

const DEFAULT_CAPTURE_LINE_LIMIT = 500;

interface CaptureState {
  lines: string[];
  dropped: number;
}

const captureState: CaptureState = {
  lines: [],
  dropped: 0
};

function parseCaptureLineLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SYMPHONY_TEST_LOG_CAPTURE_LINES;
  if (!raw) {
    return DEFAULT_CAPTURE_LINE_LIMIT;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CAPTURE_LINE_LIMIT;
}

export function isTestLogCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SYMPHONY_TEST_LOG_CAPTURE !== '0';
}

export class TestLogCaptureSink implements LogSink {
  name = 'test-capture';

  write(_entry: LogEntry, rendered: string): void {
    if (!isTestLogCaptureEnabled()) {
      return;
    }

    const lineLimit = parseCaptureLineLimit();
    captureState.lines.push(rendered);
    while (captureState.lines.length > lineLimit) {
      captureState.lines.shift();
      captureState.dropped += 1;
    }
  }
}

export function clearCapturedTestLogs(): void {
  captureState.lines = [];
  captureState.dropped = 0;
}

export function readCapturedTestLogs(): {
  lines: string[];
  dropped: number;
  lineLimit: number;
} {
  return {
    lines: [...captureState.lines],
    dropped: captureState.dropped,
    lineLimit: parseCaptureLineLimit()
  };
}
