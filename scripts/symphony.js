#!/usr/bin/env node

const { runCommandRouter } = require('../dist/src/runtime/command-router');

async function main() {
  const exitCode = await runCommandRouter({ argv: process.argv.slice(2) });
  process.exitCode = exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  main
};
