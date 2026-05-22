#!/usr/bin/env node

const path = require('node:path');
const { fork } = require('node:child_process');

const childScript = process.env.SYMPHONY_SUPERVISOR_CHILD_SCRIPT || path.join(__dirname, 'start-dashboard.js');
const childArgs = process.argv.slice(2);
const shutdownTimeoutMs = Number(process.env.SYMPHONY_RESTART_SHUTDOWN_TIMEOUT_MS || 30_000);
const startupTimeoutMs = Number(process.env.SYMPHONY_RESTART_STARTUP_TIMEOUT_MS || 30_000);

let child = null;
let stopping = false;
let restartInFlight = null;
let shutdownTimer = null;
let startupTimer = null;

function clearTimer(timer) {
  if (timer) {
    clearTimeout(timer);
  }
}

function notifyChildRestartFailed(reason, metadata) {
  if (!child || typeof child.send !== 'function' || !child.connected) {
    return;
  }
  child.send({
    type: 'symphony_supervised_restart_failed',
    version: 1,
    attempt_id: metadata?.attempt_id || null,
    target_commit_sha: metadata?.target_commit_sha || null,
    reason_code: 'runtime_update_restart_failed',
    failure_reason: reason,
    message: `Supervisor restart failed: ${reason}. Restart Symphony manually with npm run start:dashboard and inspect supervisor logs.`,
    failed_at: new Date().toISOString()
  });
}

function failRestart(reason, metadata) {
  console.error(`[symphony-supervisor] restart failed reason=${reason} attempt=${metadata?.attempt_id || 'unknown'}`);
  notifyChildRestartFailed(reason, metadata);
  stopping = true;
  process.exitCode = 1;
  setTimeout(() => {
    if (child && !child.killed) {
      child.kill('SIGTERM');
    }
    process.exit(1);
  }, 500).unref();
}

function spawnChild(restartMetadata) {
  const env = {
    ...process.env,
    SYMPHONY_RESTART_SUPERVISOR: '1'
  };
  if (restartMetadata) {
    env.SYMPHONY_RESTART_ATTEMPT_ID = restartMetadata.attempt_id;
    env.SYMPHONY_RESTART_TARGET_SHA = restartMetadata.target_commit_sha || '';
    env.SYMPHONY_RESTART_OLD_CHILD_PID = String(restartMetadata.old_child_pid || '');
    env.SYMPHONY_RESTART_STARTED_AT = restartMetadata.started_at;
  }

  child = fork(childScript, childArgs, {
    cwd: process.cwd(),
    env,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc']
  });

  console.error(`[symphony-supervisor] child spawned pid=${child.pid}`);

  if (restartMetadata) {
    startupTimer = setTimeout(() => {
      failRestart('child_startup_timeout', restartMetadata);
    }, startupTimeoutMs);
    startupTimer.unref();
  }

  child.on('message', (message) => {
    if (message && message.type === 'symphony_supervised_restart_ready') {
      clearTimer(startupTimer);
      startupTimer = null;
      return;
    }
    if (!message || message.type !== 'symphony_supervised_restart_request') {
      return;
    }
    if (restartInFlight) {
      console.error('[symphony-supervisor] duplicate restart request ignored');
      return;
    }
    restartInFlight = {
      attempt_id: String(message.attempt_id || ''),
      target_commit_sha: message.target_commit_sha || null,
      old_child_pid: child && child.pid ? child.pid : message.child_pid || null,
      started_at: new Date().toISOString()
    };
    console.error(
      `[symphony-supervisor] restart requested attempt=${restartInFlight.attempt_id} target=${restartInFlight.target_commit_sha || 'unknown'}`
    );
    shutdownTimer = setTimeout(() => {
      failRestart('old_child_shutdown_timeout', restartInFlight);
    }, shutdownTimeoutMs);
    shutdownTimer.unref();
    setTimeout(() => {
      if (child && !child.killed) {
        child.kill('SIGTERM');
      }
    }, 150);
  });

  child.on('exit', (code, signal) => {
    const pendingRestart = restartInFlight;
    const exitingChild = child;
    child = null;
    clearTimer(shutdownTimer);
    shutdownTimer = null;
    clearTimer(startupTimer);
    startupTimer = null;
    if (stopping) {
      process.exit(code === null ? 0 : code);
      return;
    }
    if (!pendingRestart) {
      console.error(`[symphony-supervisor] child exited code=${code} signal=${signal || 'none'}`);
      process.exit(code === null ? 1 : code);
      return;
    }
    console.error(
      `[symphony-supervisor] old child exited pid=${exitingChild && exitingChild.pid ? exitingChild.pid : 'unknown'} code=${code} signal=${signal || 'none'}`
    );
    restartInFlight = null;
    spawnChild(pendingRestart);
  });
}

function stop(signal) {
  stopping = true;
  if (child && !child.killed) {
    child.kill(signal);
    return;
  }
  process.exit(0);
}

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

spawnChild(null);
