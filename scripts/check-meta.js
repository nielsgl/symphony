#!/usr/bin/env node
const { spawnSync } = require('node:child_process');

const checks = [
  'scripts/check-api-contract.js',
  'scripts/check-spec-coverage.js',
  'scripts/check-pr-governance.js',
  'scripts/check-log-context.js'
];

for (const check of checks) {
  const result = spawnSync('node', [check], { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

process.stdout.write('Meta checks passed.\n');
