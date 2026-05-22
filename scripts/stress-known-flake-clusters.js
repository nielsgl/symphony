#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const clusters = [
  [
    'api-runtime',
    ['tests/api/server-refresh-events.test.ts', 'tests/runtime/bootstrap.test.ts']
  ],
  [
    'codex-workspace-git',
    [
      'tests/codex/runner-transcript-fallback.test.ts',
      'tests/workspace/workspace-manager.test.ts',
      'tests/cli/worktree-bootstrap.test.ts'
    ]
  ]
];

function parseIterations(argv) {
  const index = argv.indexOf('--iterations');
  if (index === -1) {
    return 20;
  }
  const raw = argv[index + 1];
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('--iterations must be a positive integer');
  }
  return parsed;
}

const iterations = parseIterations(process.argv.slice(2));

for (const [name, files] of clusters) {
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    console.log(`[stress-known-flake-clusters] ${name} iteration ${iteration}/${iterations}`);
    const result = spawnSync('npm', ['test', '--', ...files], {
      stdio: 'inherit',
      shell: process.platform === 'win32'
    });
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
}
