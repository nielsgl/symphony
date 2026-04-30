#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const checks = [
  'scripts/check-api-contract.js',
  'scripts/check-public-api-contract.js',
  'scripts/check-spec-coverage.js',
  'scripts/check-pr-governance.js',
  'scripts/check-log-context.js'
];

const UI_PATH_PATTERNS = [
  /^src\/api\/dashboard-assets\.ts$/,
  /^desktop-static\//,
  /^src-tauri\/src\//
];

const UI_E2E_PASS_ENV = 'SYMPHONY_UI_E2E_PLAYWRIGHT_PASS';
const UI_EVIDENCE_MARKER_FILE = path.join('output', 'playwright', 'ui-e2e-evidence.txt');
const UI_EVIDENCE_MARKER_LINE = 'UI_E2E_EVIDENCE=PASS';

function runNodeCheck(scriptPath) {
  const result = spawnSync('node', [scriptPath], { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function runGit(args) {
  return spawnSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
}

function listChangedFiles() {
  const changed = new Set();

  const baseRefCheck = runGit(['rev-parse', '--verify', '--quiet', 'origin/main']);
  if (baseRefCheck.status === 0) {
    const committed = runGit(['diff', '--name-only', '--diff-filter=ACMR', 'origin/main...HEAD']);
    if (committed.status === 0) {
      for (const file of committed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
        changed.add(file);
      }
    }
  }

  const unstaged = runGit(['diff', '--name-only', '--diff-filter=ACMR']);
  if (unstaged.status === 0) {
    for (const file of unstaged.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
      changed.add(file);
    }
  }

  const staged = runGit(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
  if (staged.status === 0) {
    for (const file of staged.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
      changed.add(file);
    }
  }

  return Array.from(changed).sort();
}

function hasUiAffectingChange(files) {
  return files.some((file) => UI_PATH_PATTERNS.some((pattern) => pattern.test(file)));
}

function hasUiEvidence() {
  const passFlag = String(process.env[UI_E2E_PASS_ENV] || '').toLowerCase();
  if (passFlag === '1' || passFlag === 'true' || passFlag === 'yes') {
    return { ok: true, mode: `env:${UI_E2E_PASS_ENV}` };
  }

  const markerPath = path.join(process.cwd(), UI_EVIDENCE_MARKER_FILE);
  if (fs.existsSync(markerPath)) {
    const content = fs.readFileSync(markerPath, 'utf8');
    if (content.split(/\r?\n/).some((line) => line.trim() === UI_EVIDENCE_MARKER_LINE)) {
      return { ok: true, mode: `file:${UI_EVIDENCE_MARKER_FILE}` };
    }
  }

  return { ok: false, mode: 'missing' };
}

function enforceUiEvidenceGate() {
  const changedFiles = listChangedFiles();
  if (!hasUiAffectingChange(changedFiles)) {
    process.stdout.write('UI evidence gate skipped: no UI-affecting paths changed.\n');
    return;
  }

  const evidence = hasUiEvidence();
  if (evidence.ok) {
    process.stdout.write(`UI evidence gate passed via ${evidence.mode}.\n`);
    return;
  }

  process.stderr.write('Meta check failed: UI-affecting changes detected without e2e evidence.\n');
  process.stderr.write('Changed UI paths:\n');
  for (const file of changedFiles.filter((candidate) => UI_PATH_PATTERNS.some((pattern) => pattern.test(candidate)))) {
    process.stderr.write(`  - ${file}\n`);
  }
  process.stderr.write(`Provide one of:\n`);
  process.stderr.write(`  1) Run Playwright with ${UI_E2E_PASS_ENV}=1 (for example: ${UI_E2E_PASS_ENV}=1 npm run test:e2e:web)\n`);
  process.stderr.write(`  2) Create ${UI_EVIDENCE_MARKER_FILE} containing line: ${UI_EVIDENCE_MARKER_LINE}\n`);
  process.exit(1);
}

const skipBaseChecks = ['1', 'true', 'yes'].includes(String(process.env.SYMPHONY_META_SKIP_BASE_CHECKS || '').toLowerCase());

if (!skipBaseChecks) {
  for (const check of checks) {
    runNodeCheck(check);
  }
}

enforceUiEvidenceGate();
process.stdout.write('Meta checks passed.\n');
