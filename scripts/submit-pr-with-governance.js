#!/usr/bin/env node
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { normalizePrBody } = require('./normalize-pr-body');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = {
    mode: 'create',
    title: '',
    prNumber: '',
    outputFile: ''
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === '--mode' && argv[i + 1]) {
      parsed.mode = argv[i + 1];
      i += 1;
      continue;
    }
    if (current === '--title' && argv[i + 1]) {
      parsed.title = argv[i + 1];
      i += 1;
      continue;
    }
    if ((current === '--pr' || current === '--pr-number') && argv[i + 1]) {
      parsed.prNumber = argv[i + 1];
      i += 1;
      continue;
    }
    if (current === '--output-file' && argv[i + 1]) {
      parsed.outputFile = argv[i + 1];
      i += 1;
      continue;
    }
  }

  return parsed;
}

function runCommand(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    env
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function createGhArgs(parsed, normalizedBodyFile) {
  const relativeBodyFile = path.relative(process.cwd(), normalizedBodyFile) || normalizedBodyFile;
  if (parsed.mode === 'edit') {
    if (parsed.prNumber.trim().length > 0) {
      return ['pr', 'edit', parsed.prNumber.trim(), '--body-file', relativeBodyFile];
    }
    return ['pr', 'edit', '--body-file', relativeBodyFile];
  }

  if (parsed.title.trim().length === 0) {
    fail('submit_pr_invalid_args: --title is required for --mode create');
  }

  return ['pr', 'create', '--title', parsed.title.trim(), '--body-file', relativeBodyFile];
}

function submitWithGovernance(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.mode !== 'create' && parsed.mode !== 'edit') {
    fail("submit_pr_invalid_args: --mode must be one of 'create' or 'edit'");
  }

  const normalized = normalizePrBody({
    outputFile: parsed.outputFile || process.env.SYMPHONY_PR_BODY_NORMALIZED_FILE
  });

  const env = {
    ...process.env,
    SYMPHONY_PR_BODY_FILE: normalized.resolvedOutput
  };

  const skipChecks = String(process.env.SYMPHONY_SUBMIT_PR_SKIP_CHECKS || '').trim().toLowerCase();
  const shouldSkipChecks = skipChecks === '1' || skipChecks === 'true' || skipChecks === 'yes';
  if (!shouldSkipChecks) {
    runCommand('npm', ['run', 'check:pr-governance'], env);
    runCommand('npm', ['run', 'check:meta'], env);
  }

  const ghArgs = createGhArgs(parsed, normalized.resolvedOutput);
  const dryRun = String(process.env.SYMPHONY_SUBMIT_PR_DRY_RUN || '').trim().toLowerCase();
  const isDryRun = dryRun === '1' || dryRun === 'true' || dryRun === 'yes';
  if (isDryRun) {
    process.stdout.write(`[dry-run] gh ${ghArgs.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}\n`);
    return;
  }

  runCommand('gh', ghArgs, env);
}

if (require.main === module) {
  submitWithGovernance();
}

module.exports = {
  submitWithGovernance
};
