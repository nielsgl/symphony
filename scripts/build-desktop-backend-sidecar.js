#!/usr/bin/env node

function run() {
  throw new Error(
    [
      'Desktop backend sidecar packaging is disabled because the legacy',
      '`pkg` packager has no audit-safe fixed release.',
      'Run a packaging replacement spike before re-enabling this build path.'
    ].join(' ')
  );
}

try {
  run();
} catch (error) {
  process.stderr.write(`Failed to build desktop backend sidecar: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
