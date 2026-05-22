import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const SUPERVISOR_TIMEOUT_MS = 10_000;

async function readEvents(filePath: string): Promise<any[]> {
  try {
    const contents = await fs.readFile(filePath, 'utf8');
    return contents
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitForEvent(filePath: string, predicate: (event: any) => boolean): Promise<any> {
  const started = Date.now();
  while (Date.now() - started < SUPERVISOR_TIMEOUT_MS) {
    const match = (await readEvents(filePath)).find(predicate);
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for supervisor event');
}

describe('start-dashboard-supervisor', () => {
  const children: Array<ReturnType<typeof spawn>> = [];

  afterEach(() => {
    for (const child of children.splice(0)) {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    }
  });

  it('replaces the dashboard child after a structured restart request', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-supervisor-test-'));
    const eventsPath = path.join(dir, 'events.jsonl');
    const childScript = path.join(dir, 'child.js');
    await fs.writeFile(
      childScript,
      `
const fs = require('node:fs');
const eventsPath = process.env.SUPERVISOR_TEST_EVENTS;
function write(event) {
  fs.appendFileSync(eventsPath, JSON.stringify({ ...event, pid: process.pid }) + '\\n');
}
write({
  type: 'started',
  attempt_id: process.env.SYMPHONY_RESTART_ATTEMPT_ID || null,
  target: process.env.SYMPHONY_RESTART_TARGET_SHA || null,
  old_child_pid: process.env.SYMPHONY_RESTART_OLD_CHILD_PID || null,
  supervised: process.env.SYMPHONY_RESTART_SUPERVISOR
});
if (!process.env.SYMPHONY_RESTART_ATTEMPT_ID) {
  setTimeout(() => {
    process.send({
      type: 'symphony_supervised_restart_request',
      version: 1,
      attempt_id: 'attempt-test',
      target_commit_sha: 'target-sha',
      old_commit_sha: 'old-sha',
      requested_at: '2026-05-22T10:00:00.000Z',
      child_pid: process.pid
    });
  }, 50);
}
process.on('SIGTERM', () => {
  write({ type: 'stopping' });
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
      'utf8'
    );

    const supervisor = spawn(process.execPath, ['scripts/start-dashboard-supervisor.js'], {
      cwd: path.resolve(__dirname, '../..'),
      env: {
        ...process.env,
        SYMPHONY_SUPERVISOR_CHILD_SCRIPT: childScript,
        SUPERVISOR_TEST_EVENTS: eventsPath
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.push(supervisor);

    const restarted = await waitForEvent(eventsPath, (event) => event.type === 'started' && event.attempt_id === 'attempt-test');
    const events = await readEvents(eventsPath);

    expect(events.filter((event) => event.type === 'started')).toHaveLength(2);
    expect(events.some((event) => event.type === 'stopping')).toBe(true);
    expect(restarted).toMatchObject({
      target: 'target-sha',
      old_child_pid: expect.stringMatching(/^\d+$/),
      supervised: '1'
    });
  }, SUPERVISOR_TIMEOUT_MS);

  it('reports startup timeout failure to the replacement child before exiting', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-supervisor-timeout-test-'));
    const eventsPath = path.join(dir, 'events.jsonl');
    const childScript = path.join(dir, 'child.js');
    await fs.writeFile(
      childScript,
      `
const fs = require('node:fs');
const eventsPath = process.env.SUPERVISOR_TEST_EVENTS;
function write(event) {
  fs.appendFileSync(eventsPath, JSON.stringify({ ...event, pid: process.pid }) + '\\n');
}
write({
  type: 'started',
  attempt_id: process.env.SYMPHONY_RESTART_ATTEMPT_ID || null,
  target: process.env.SYMPHONY_RESTART_TARGET_SHA || null
});
process.on('message', (message) => {
  if (message && message.type === 'symphony_supervised_restart_failed') {
    write({
      type: 'restart_failed',
      attempt_id: message.attempt_id,
      target: message.target_commit_sha,
      reason_code: message.reason_code,
      failure_reason: message.failure_reason,
      message: message.message
    });
  }
});
if (!process.env.SYMPHONY_RESTART_ATTEMPT_ID) {
  setTimeout(() => {
    process.send({
      type: 'symphony_supervised_restart_request',
      version: 1,
      attempt_id: 'attempt-timeout',
      target_commit_sha: 'target-sha',
      old_commit_sha: 'old-sha',
      requested_at: '2026-05-22T10:00:00.000Z',
      child_pid: process.pid
    });
  }, 20);
}
process.on('SIGTERM', () => {
  write({ type: 'stopping' });
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
      'utf8'
    );

    const supervisor = spawn(process.execPath, ['scripts/start-dashboard-supervisor.js'], {
      cwd: path.resolve(__dirname, '../..'),
      env: {
        ...process.env,
        SYMPHONY_SUPERVISOR_CHILD_SCRIPT: childScript,
        SYMPHONY_RESTART_STARTUP_TIMEOUT_MS: '80',
        SUPERVISOR_TEST_EVENTS: eventsPath
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.push(supervisor);

    const failed = await waitForEvent(eventsPath, (event) => event.type === 'restart_failed');

    expect(failed).toMatchObject({
      attempt_id: 'attempt-timeout',
      target: 'target-sha',
      reason_code: 'runtime_update_restart_failed',
      failure_reason: 'child_startup_timeout'
    });
    expect(failed.message).toContain('Restart Symphony manually');
  }, SUPERVISOR_TIMEOUT_MS);
});
