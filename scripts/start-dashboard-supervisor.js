#!/usr/bin/env node

const path = require('node:path');
const fs = require('node:fs');
const { fork } = require('node:child_process');

const childScript = process.env.SYMPHONY_SUPERVISOR_CHILD_SCRIPT || path.join(__dirname, 'start-dashboard.js');
const childArgs = process.argv.slice(2);
const shutdownTimeoutMs = Number(process.env.SYMPHONY_RESTART_SHUTDOWN_TIMEOUT_MS || 30_000);
const startupTimeoutMs = Number(process.env.SYMPHONY_RESTART_STARTUP_TIMEOUT_MS || 30_000);
const killGraceMs = Number(process.env.SYMPHONY_RESTART_KILL_GRACE_MS || 5_000);
const failureHandoffFile = process.env.SYMPHONY_RESTART_FAILURE_HANDOFF_FILE || path.join(process.cwd(), '.symphony', 'runtime-restart-failure.json');

let child = null;
let stopping = false;
let supervisorExitCode = 0;
let restartInFlight = null;
let shutdownTimer = null;
let startupTimer = null;
let killTimer = null;

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

function writeFailureHandoff(reason, metadata) {
  if (!metadata?.attempt_id) {
    return;
  }
  const payload = {
    version: 1,
    attempt_id: metadata.attempt_id,
    target_commit_sha: metadata.target_commit_sha || null,
    old_child_pid: typeof metadata.old_child_pid === 'number' ? metadata.old_child_pid : null,
    new_child_pid: child && child.pid ? child.pid : null,
    started_at: metadata.started_at || null,
    failed_at: new Date().toISOString(),
    reason_code: 'runtime_update_restart_failed',
    failure_reason: reason,
    message: `Supervisor restart failed: ${reason}. Restart Symphony manually with npm run start:dashboard and inspect supervisor logs.`
  };
  try {
    fs.mkdirSync(path.dirname(failureHandoffFile), { recursive: true });
    fs.writeFileSync(failureHandoffFile, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  } catch (error) {
    console.error(`[symphony-supervisor] failed to write restart failure handoff: ${error && error.message ? error.message : String(error)}`);
  }
}

function failRestart(reason, metadata) {
  console.error(`[symphony-supervisor] restart failed reason=${reason} attempt=${metadata?.attempt_id || 'unknown'}`);
  writeFailureHandoff(reason, metadata);
  notifyChildRestartFailed(reason, metadata);
  stopping = true;
  supervisorExitCode = 1;
  process.exitCode = supervisorExitCode;
  if (!child) {
    process.exit(supervisorExitCode);
    return;
  }
  const childToTerminate = child;
  if (!childToTerminate.killed) {
    childToTerminate.kill('SIGTERM');
  }
  clearTimer(killTimer);
  killTimer = setTimeout(() => {
    if (child === childToTerminate) {
      console.error(`[symphony-supervisor] restart failure child did not exit after SIGTERM; sending SIGKILL pid=${childToTerminate.pid}`);
      childToTerminate.kill('SIGKILL');
    }
  }, killGraceMs);
}

function spawnChild(restartMetadata) {
  const env = {
    ...process.env,
    SYMPHONY_RESTART_SUPERVISOR: '1',
    SYMPHONY_RESTART_FAILURE_HANDOFF_FILE: failureHandoffFile
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
    clearTimer(killTimer);
    killTimer = null;
    if (stopping) {
      process.exit(supervisorExitCode);
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
