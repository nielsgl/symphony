#!/usr/bin/env node

const { LocalApiServer } = require('../dist/src/api');
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

function createSnapshotState() {
  return {
    poll_interval_ms: 30000,
    max_concurrent_agents: 1,
    running: new Map(),
    claimed: new Set(),
    retry_attempts: new Map(),
    completed: new Set(),
    codex_totals: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      seconds_running: 0
    },
    codex_rate_limits: null,
    health: {
      dispatch_validation: 'ok',
      last_error: null
    }
  };
}

async function main() {
  const logger = new MultiSinkLogger();
  const state = createSnapshotState();

  const server = new LocalApiServer({
    host: '127.0.0.1',
    port: parsePort(process.argv.slice(2)),
    snapshotSource: {
      getStateSnapshot: () => state
    },
    refreshSource: {
      tick: async () => {
        logger.log({
          level: 'info',
          event: 'manual_refresh_tick',
          message: 'manual refresh tick requested from dashboard'
        });
      }
    },
    logger
  });

  await server.listen();
  const address = server.address();
  process.stdout.write(`Symphony dashboard running at http://127.0.0.1:${address.port}/\n`);
  process.stdout.write('Press Ctrl+C to stop.\n');

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error) => {
  process.stderr.write(`Failed to start dashboard: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
