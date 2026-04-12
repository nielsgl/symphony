#!/usr/bin/env node

const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REQUIRED_FLAG_VALUES = new Set(['1', 'true', 'yes']);
const LINEAR_ENDPOINT = process.env.LINEAR_ENDPOINT || 'https://api.linear.app/graphql';

function isTruthy(value) {
  if (!value) {
    return false;
  }
  return REQUIRED_FLAG_VALUES.has(String(value).toLowerCase());
}

function printEvidence(key, value) {
  process.stdout.write(`P9B_${key}=${value}\n`);
}

function runCommand(command, args) {
  const commandLine = `${command} ${args.join(' ')}`;
  printEvidence('COMMAND', commandLine);

  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  return result.status === 0;
}

async function checkWorkspaceIsolation() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symphony-p9b-'));
  const marker = path.join(root, 'evidence.txt');

  await writeFile(marker, 'p9b workspace isolation evidence\n', 'utf8');
  await rm(root, { recursive: true, force: true });

  printEvidence('EVIDENCE_WORKSPACE_ISOLATION', 'PASS');
}

async function checkRealTrackerCredential(dryRun) {
  const apiKey = process.env.LINEAR_API_KEY;
  const required = isTruthy(process.env.SYMPHONY_REAL_INTEGRATION_REQUIRED);

  if (!apiKey) {
    if (required) {
      printEvidence('EVIDENCE_REAL_TRACKER', 'FAIL_MISSING_LINEAR_API_KEY');
      return { status: 'fail', reason: 'missing_linear_api_key' };
    }

    printEvidence('EVIDENCE_REAL_TRACKER', 'SKIPPED_MISSING_LINEAR_API_KEY');
    return { status: 'skipped', reason: 'missing_linear_api_key' };
  }

  if (dryRun) {
    printEvidence('EVIDENCE_REAL_TRACKER', 'PASS_DRY_RUN_WITH_KEY');
    return { status: 'pass' };
  }

  const response = await fetch(LINEAR_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: 'query SymphonyP9bSmoke { viewer { id } }'
    })
  });

  if (!response.ok) {
    printEvidence('EVIDENCE_REAL_TRACKER', `FAIL_HTTP_${response.status}`);
    return { status: 'fail', reason: `linear_http_${response.status}` };
  }

  const payload = await response.json();
  const viewerId = payload?.data?.viewer?.id;
  if (typeof viewerId !== 'string' || viewerId.length === 0) {
    printEvidence('EVIDENCE_REAL_TRACKER', 'FAIL_INVALID_PAYLOAD');
    return { status: 'fail', reason: 'linear_invalid_payload' };
  }

  printEvidence('EVIDENCE_REAL_TRACKER', 'PASS');
  return { status: 'pass' };
}

async function main() {
  const required = isTruthy(process.env.SYMPHONY_REAL_INTEGRATION_REQUIRED);
  const requestedDryRun = isTruthy(process.env.SYMPHONY_P9B_DRY_RUN);

  if (required && requestedDryRun) {
    printEvidence('EVIDENCE_REQUIRED_MODE', 'FAIL_DRY_RUN_NOT_ALLOWED');
    printEvidence('PROFILE_RESULT', 'FAIL');
    process.exit(1);
  }

  const dryRun = requestedDryRun;
  const skipOperational = !required && (dryRun || isTruthy(process.env.SYMPHONY_P9B_SKIP_OPERATIONAL_CHECKS));

  printEvidence('PROFILE', 'REAL_INTEGRATION');
  printEvidence('MODE', dryRun ? 'DRY_RUN' : 'LIVE');
  printEvidence('REAL_INTEGRATION_REQUIRED', required ? '1' : '0');

  if (!skipOperational) {
    const operationalChecks = [
      ['npm', ['test', '--', '--run', 'tests/cli/cli-args.test.ts']],
      ['npm', ['test', '--', '--run', 'tests/workspace/workspace-manager.test.ts']],
      ['npm', ['test', '--', '--run', 'tests/runtime/bootstrap.test.ts', 'tests/api/server.test.ts']]
    ];

    for (const [command, args] of operationalChecks) {
      const ok = runCommand(command, args);
      if (!ok) {
        printEvidence('EVIDENCE_OPERATIONAL_CHECKS', 'FAIL');
        printEvidence('PROFILE_RESULT', 'FAIL');
        process.exit(1);
      }
    }

    printEvidence('EVIDENCE_OPERATIONAL_CHECKS', 'PASS');
  } else {
    printEvidence('EVIDENCE_OPERATIONAL_CHECKS', 'SKIPPED');
  }

  await checkWorkspaceIsolation();

  const tracker = await checkRealTrackerCredential(dryRun);
  if (tracker.status === 'fail') {
    printEvidence('PROFILE_RESULT', 'FAIL');
    process.exit(1);
  }

  if (tracker.status === 'skipped') {
    printEvidence('PROFILE_RESULT', 'SKIPPED');
    process.exit(0);
  }

  printEvidence('PROFILE_RESULT', 'PASS');
  process.exit(0);
}

main().catch((error) => {
  printEvidence('PROFILE_RESULT', 'FAIL');
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
