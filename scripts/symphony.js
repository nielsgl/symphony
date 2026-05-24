#!/usr/bin/env node

const { runCommandRouter } = require('../dist/src/runtime/command-router');

async function main() {
  const exitCode = await runCommandRouter({ argv: process.argv.slice(2) });
  process.exit(exitCode);
}

if (require.main === module) {
  void main();
}

module.exports = {
  main
};
