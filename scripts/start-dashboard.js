#!/usr/bin/env node

const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({
  path: process.env.SYMPHONY_ENV_FILE || path.join(process.cwd(), '.env')
});

const { createRuntimeEnvironment } = require('../dist/src/runtime');
const { MultiSinkLogger } = require('../dist/src/observability');

function parsePort(argv) {
  const portFlag = argv.find((arg) => arg.startsWith('--port='));
  if (portFlag) {
    const value = Number(portFlag.split('=')[1]);
    if (Number.isInteger(value) && value >= 0) {
      return value;
    }
  }

  const envPort = process.env.SYMPHONY_PORT;
  if (envPort) {
    const value = Number(envPort);
    if (Number.isInteger(value) && value >= 0) {
      return value;
    }
  }

  return 3000;
}

function parseWorkflowPath(argv) {
  const workflowFlag = argv.find((arg) => arg.startsWith('--workflow='));
  if (workflowFlag) {
    return workflowFlag.split('=')[1];
  }

  return process.env.SYMPHONY_WORKFLOW_PATH || path.join(process.cwd(), 'WORKFLOW.md');
}

function parseOfflineMode(argv) {
  if (argv.includes('--offline')) {
    return true;
  }

  const value = process.env.SYMPHONY_OFFLINE;
  return value === '1' || value === 'true';
}

function createNoopTrackerAdapter() {
  return {
    fetch_candidate_issues: async () => [],
    fetch_issues_by_states: async () => [],
    fetch_issue_states_by_ids: async () => []
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const logger = new MultiSinkLogger();
  const offlineMode = parseOfflineMode(argv);
  const runtime = createRuntimeEnvironment({
    host: '127.0.0.1',
    port: parsePort(argv),
    workflowPath: parseWorkflowPath(argv),
    logger,
    trackerAdapter: offlineMode ? createNoopTrackerAdapter() : undefined
  });

  await runtime.start();
  const address = runtime.apiServer.address();
  process.stdout.write(`Symphony dashboard running at http://127.0.0.1:${address.port}/\n`);
  process.stdout.write(`Workflow: ${parseWorkflowPath(argv)}\n`);
  process.stdout.write(`Offline mode: ${offlineMode ? 'enabled' : 'disabled'}\n`);
  process.stdout.write('Press Ctrl+C to stop.\n');

  const shutdown = async () => {
    await runtime.stop();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error) => {
  process.stderr.write(`Failed to start dashboard: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
