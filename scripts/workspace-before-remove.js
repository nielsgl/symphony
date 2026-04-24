#!/usr/bin/env node
const { spawnSync } = require('node:child_process');

function run(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function readTrimmed(output) {
  return String(output || '').trim();
}

function main() {
  const branchResult = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branchResult.status !== 0) {
    process.stdout.write('workspace-before-remove: skipped (unable to detect git branch)\n');
    return;
  }

  const branch = readTrimmed(branchResult.stdout);
  if (!branch || branch === 'HEAD') {
    process.stdout.write('workspace-before-remove: skipped (detached HEAD or empty branch)\n');
    return;
  }

  const ghVersion = run('gh', ['--version']);
  if (ghVersion.status !== 0) {
    process.stdout.write(`workspace-before-remove: skipped (gh unavailable) branch=${branch}\n`);
    return;
  }

  const listResult = run('gh', ['pr', 'list', '--state', 'open', '--head', branch, '--json', 'number,url']);
  if (listResult.status !== 0) {
    process.stdout.write(`workspace-before-remove: skipped (unable to list PRs) branch=${branch}\n`);
    return;
  }

  let pullRequests = [];
  try {
    const parsed = JSON.parse(readTrimmed(listResult.stdout) || '[]');
    if (Array.isArray(parsed)) {
      pullRequests = parsed;
    }
  } catch {
    process.stdout.write(`workspace-before-remove: skipped (invalid gh pr list payload) branch=${branch}\n`);
    return;
  }

  if (pullRequests.length === 0) {
    process.stdout.write(`workspace-before-remove: no open PRs for branch=${branch}\n`);
    return;
  }

  const comment = `Closing from workspace cleanup for branch ${branch}.`;
  let closedCount = 0;

  for (const pr of pullRequests) {
    const number = pr && typeof pr.number === 'number' ? String(pr.number) : '';
    if (!number) {
      continue;
    }

    const closeResult = run('gh', ['pr', 'close', number, '--comment', comment, '--delete-branch=false']);
    if (closeResult.status === 0) {
      closedCount += 1;
      continue;
    }

    process.stdout.write(`workspace-before-remove: failed to close PR #${number}; continuing\n`);
  }

  process.stdout.write(`workspace-before-remove: completed branch=${branch} closed=${closedCount}\n`);
}

main();
