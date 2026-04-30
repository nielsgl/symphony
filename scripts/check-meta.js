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
const UI_EVIDENCE_PROFILE_ENV = 'SYMPHONY_UI_EVIDENCE_PROFILE';
const WORKFLOW_PATH_ENV = 'SYMPHONY_WORKFLOW_PATH';
const DEFAULT_WORKFLOW_PATH = 'WORKFLOW.md';
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
  let capturedCommittedDiff = false;

  const baseRefCheck = runGit(['rev-parse', '--verify', '--quiet', 'origin/main']);
  if (baseRefCheck.status === 0) {
    const committed = runGit(['diff', '--name-only', '--diff-filter=ACMR', 'origin/main...HEAD']);
    if (committed.status === 0) {
      capturedCommittedDiff = true;
      for (const file of committed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
        changed.add(file);
      }
    }
  }

  if (!capturedCommittedDiff) {
    // Fallback for CI clones/worktrees that do not have origin/main available locally.
    // Prefer branch-history diff from repository root so multi-commit UI changes are still detected.
    const rootCommit = runGit(['rev-list', '--max-parents=0', '--max-count=1', 'HEAD']);
    const rootSha = rootCommit.status === 0 ? rootCommit.stdout.trim() : '';
    if (rootSha) {
      const committedFromRoot = runGit(['diff', '--name-only', '--diff-filter=ACMR', `${rootSha}..HEAD`]);
      if (committedFromRoot.status === 0) {
        capturedCommittedDiff = true;
        for (const file of committedFromRoot.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
          changed.add(file);
        }
      }
    }
  }

  if (!capturedCommittedDiff) {
    const headCommitFiles = runGit(['show', '--name-only', '--pretty=format:', '--diff-filter=ACMR', 'HEAD']);
    if (headCommitFiles.status === 0) {
      for (const file of headCommitFiles.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
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

function parseWorkflowFrontMatter(workflowPath) {
  if (!fs.existsSync(workflowPath)) {
    return {};
  }

  const content = fs.readFileSync(workflowPath, 'utf8');
  if (!content.startsWith('---')) {
    return {};
  }

  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return {};
  }

  const [, rawFrontMatter] = match;
  const lines = rawFrontMatter.split('\n');
  let inValidation = false;
  let validationIndent = 0;

  for (const line of lines) {
    const normalized = line.replace(/\t/g, '  ');
    const trimmed = normalized.trim();

    if (!inValidation) {
      const validationMatch = normalized.match(/^(\s*)validation:\s*(?:#.*)?$/);
      if (validationMatch) {
        inValidation = true;
        validationIndent = validationMatch[1].length;
      }
      continue;
    }

    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }

    const indent = normalized.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent <= validationIndent) {
      break;
    }

    const profileMatch = normalized.match(
      /^\s*ui_evidence_profile:\s*(?:"(baseline|strict)"|'(baseline|strict)'|(baseline|strict))\s*(?:#.*)?$/i
    );
    if (profileMatch) {
      const profile = (profileMatch[1] || profileMatch[2] || profileMatch[3] || '').toLowerCase();
      if (profile === 'baseline' || profile === 'strict') {
        return { validation: { ui_evidence_profile: profile } };
      }
    }
  }

  return {};
}

function resolveUiEvidenceProfile() {
  const envOverride = String(process.env[UI_EVIDENCE_PROFILE_ENV] || '').trim().toLowerCase();
  if (envOverride.length > 0 && envOverride !== 'baseline' && envOverride !== 'strict') {
    process.stderr.write(
      `Meta check failed: unsupported ${UI_EVIDENCE_PROFILE_ENV} '${envOverride}'. Expected one of: baseline, strict.\n`
    );
    process.exit(1);
  }
  if (envOverride === 'baseline' || envOverride === 'strict') {
    return { profile: envOverride, source: `env:${UI_EVIDENCE_PROFILE_ENV}` };
  }

  const workflowPath = path.resolve(process.cwd(), process.env[WORKFLOW_PATH_ENV] || DEFAULT_WORKFLOW_PATH);
  const frontMatter = parseWorkflowFrontMatter(workflowPath);
  const configured = String(frontMatter.validation?.ui_evidence_profile || '')
    .trim()
    .toLowerCase();
  if (configured === 'baseline' || configured === 'strict') {
    return { profile: configured, source: `workflow:${path.relative(process.cwd(), workflowPath) || DEFAULT_WORKFLOW_PATH}` };
  }

  return { profile: 'baseline', source: 'default:baseline' };
}

function enforceUiEvidenceGate() {
  const uiEvidenceProfile = resolveUiEvidenceProfile();
  process.stdout.write(
    `UI evidence profile active: ${uiEvidenceProfile.profile} (${uiEvidenceProfile.source}).\n`
  );

  const changedFiles = listChangedFiles();
  if (!hasUiAffectingChange(changedFiles)) {
    process.stdout.write('UI evidence gate skipped: no UI-affecting paths changed.\n');
    return;
  }

  const evidence = hasUiEvidence();

  if (uiEvidenceProfile.profile === 'strict') {
    const markerPath = path.join(process.cwd(), UI_EVIDENCE_MARKER_FILE);
    const markerPresent =
      fs.existsSync(markerPath) &&
      fs
        .readFileSync(markerPath, 'utf8')
        .split(/\r?\n/)
        .some((line) => line.trim() === UI_EVIDENCE_MARKER_LINE);
    if (!markerPresent) {
      process.stderr.write(
        'Meta check failed: strict UI evidence profile requires artifact marker file for UI-affecting changes.\n'
      );
      process.stderr.write(`Missing or invalid marker file: ${UI_EVIDENCE_MARKER_FILE}\n`);
      process.stderr.write(`Expected line in file: ${UI_EVIDENCE_MARKER_LINE}\n`);
      process.stderr.write(`Remediation: run e2e and persist evidence marker artifact before check:meta.\n`);
      process.exit(1);
    }
  }

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
