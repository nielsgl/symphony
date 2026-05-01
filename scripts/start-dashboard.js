#!/usr/bin/env node

const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({
  path: process.env.SYMPHONY_ENV_FILE || path.join(process.cwd(), '.env')
});

function normalizeCodexHomeEnv() {
  const raw = process.env.SYMPHONY_CODEX_HOME;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return;
  }

  let normalized = raw.trim();
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1);
  }

  if (normalized.startsWith('$HOME/')) {
    normalized = path.join(process.env.HOME || '', normalized.slice('$HOME/'.length));
  } else if (normalized === '$HOME') {
    normalized = process.env.HOME || normalized;
  } else if (normalized.startsWith('~/')) {
    normalized = path.join(process.env.HOME || '', normalized.slice(2));
  } else if (normalized === '~') {
    normalized = process.env.HOME || normalized;
  }

  process.env.SYMPHONY_CODEX_HOME = normalized;
}

normalizeCodexHomeEnv();

const { runDashboardCli } = require('../dist/src/runtime');

async function main() {
  const exitCode = await runDashboardCli(process.argv.slice(2));
  process.exit(exitCode);
}

if (require.main === module) {
  void main();
}

module.exports = {
  main
};
