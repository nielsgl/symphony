#!/usr/bin/env node

const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({
  path: process.env.SYMPHONY_ENV_FILE || path.join(process.cwd(), '.env')
});

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
