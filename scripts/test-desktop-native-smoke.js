#!/usr/bin/env node

const { spawn, spawnSync } = require('node:child_process');

const desktopPort = process.env.SYMPHONY_DESKTOP_PORT || process.env.SYMPHONY_PORT || '3900';
const runtimeUrl = `http://127.0.0.1:${desktopPort}/api/v1/state`;
const startupTimeoutMs = 180_000;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRuntimeReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(runtimeUrl, { cache: 'no-store' });
      if (response.ok) {
        return;
      }
    } catch {
      // Runtime not ready yet.
    }
    await wait(500);
  }
  throw new Error(`Timed out waiting for runtime at ${runtimeUrl}`);
}

async function waitForRuntimeStopped(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(runtimeUrl, { cache: 'no-store' });
    } catch {
      return;
    }
    await wait(500);
  }
  throw new Error(`Runtime still reachable after desktop shutdown at ${runtimeUrl}`);
}

function terminateDesktopProcessTree(child) {
  if (!child || child.killed) {
    return;
  }

  if (process.platform === 'win32') {
    child.kill('SIGTERM');
    return;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

function readMacWindowTitle() {
  const script = `tell application "System Events" to tell process "Symphony" to if exists (window 1) then name of window 1 else ""`;
  const result = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error((result.stderr || 'failed to query Symphony window title').trim());
  }
  return (result.stdout || '').trim();
}

async function verifyMacWindowVisible() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const title = readMacWindowTitle();
      if (title) {
        return title;
      }
    } catch {
      // Process may not be visible yet.
    }
    await wait(300);
  }
  throw new Error('Timed out waiting for Symphony native window visibility');
}

function shouldSkipNativeWindowVisibilityCheck() {
  const value = process.env.SYMPHONY_ALLOW_WINDOW_VISIBILITY_SKIP;
  return value === '1' || value === 'true';
}

async function main() {
  const env = {
    ...process.env,
    SYMPHONY_OFFLINE: process.env.SYMPHONY_OFFLINE || '1',
    SYMPHONY_DESKTOP_PORT: desktopPort,
    SYMPHONY_PORT: desktopPort
  };

  const child = spawn('npm', ['run', 'start:desktop'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  });

  let output = '';
  let handoffSeen = false;

  child.stdout.on('data', (chunk) => {
    const text = String(chunk);
    output += text;
    if (text.includes('desktop_window_handoff_url=')) {
      handoffSeen = true;
    }
    process.stdout.write(text);
  });

  child.stderr.on('data', (chunk) => {
    const text = String(chunk);
    output += text;
    process.stderr.write(text);
  });

  const onExit = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  try {
    await waitForRuntimeReady(startupTimeoutMs);

    if (process.platform === 'darwin') {
      if (shouldSkipNativeWindowVisibilityCheck()) {
        process.stdout.write('Native window visibility check skipped by SYMPHONY_ALLOW_WINDOW_VISIBILITY_SKIP.\n');
      } else {
        const title = await verifyMacWindowVisible();
        process.stdout.write(`Native window visible: ${title}\n`);
      }
    }

    if (!handoffSeen) {
      throw new Error('Missing desktop_window_handoff_url log from Tauri host');
    }

    terminateDesktopProcessTree(child);
    await waitForRuntimeStopped(45_000);

    const exit = await onExit;
    if (exit.code !== 0 && exit.signal !== 'SIGTERM') {
      throw new Error(`Desktop process exited unexpectedly: code=${exit.code} signal=${exit.signal}`);
    }

    process.stdout.write('Desktop native smoke test passed.\n');
  } catch (error) {
    terminateDesktopProcessTree(child);
    await onExit;
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
