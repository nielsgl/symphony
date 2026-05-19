import { beforeEach } from 'vitest';

import { clearCapturedTestLogs, isTestLogCaptureEnabled, readCapturedTestLogs } from '../../src/observability';

beforeEach((context) => {
  clearCapturedTestLogs();

  context.onTestFailed(() => {
    if (!isTestLogCaptureEnabled()) {
      return;
    }

    const captured = readCapturedTestLogs();
    process.stderr.write('--- Symphony captured logs for failed test ---\n');
    process.stderr.write(`test=${JSON.stringify(context.task.name)}\n`);
    process.stderr.write(`captured_lines=${captured.lines.length}\n`);
    process.stderr.write(`dropped_lines=${captured.dropped}\n`);
    process.stderr.write(`line_limit=${captured.lineLimit}\n`);
    for (const line of captured.lines) {
      process.stderr.write(`${line}\n`);
    }
    process.stderr.write('hint="rerun with SYMPHONY_TEST_LOGS=1 for live runtime logs"\n');
    process.stderr.write('--- End Symphony captured logs ---\n');
  });
});
