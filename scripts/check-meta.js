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
const upstreamParityCheck = 'scripts/check-upstream-parity.js';

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
const UI_EVIDENCE_MANIFEST_FILE = path.join('output', 'playwright', 'ui-evidence.json');
const UI_EVIDENCE_ARTIFACT_BASE_DIR = path.join('output', 'playwright');
const UI_EVIDENCE_ALLOW_TRACKED_ENV = 'SYMPHONY_UI_EVIDENCE_ALLOW_TRACKED';
const UI_EVIDENCE_TRACKED_PATH_PREFIX = 'output/playwright/';

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

function isTrackedUiEvidenceAllowed() {
  const value = String(process.env[UI_EVIDENCE_ALLOW_TRACKED_ENV] || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function listTrackedUiEvidenceFiles() {
  const tracked = new Set();
  let capturedCommittedDiff = false;
  const rootCommit = runGit(['rev-list', '--max-parents=0', '--max-count=1', 'HEAD']);
  const rootSha = rootCommit.status === 0 ? rootCommit.stdout.trim() : '';

  const collectTracked = (result) => {
    if (result.status !== 0) {
      return;
    }
    for (const file of result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
      const normalized = file.replace(/\\/g, '/');
      if (normalized.startsWith(UI_EVIDENCE_TRACKED_PATH_PREFIX)) {
        tracked.add(normalized);
      }
    }
  };

  const baseRefCheck = runGit(['rev-parse', '--verify', '--quiet', 'origin/main']);
  if (baseRefCheck.status === 0) {
    const committed = runGit(['diff', '--name-only', '--diff-filter=ACMR', 'origin/main...HEAD']);
    if (committed.status === 0) {
      capturedCommittedDiff = true;
      collectTracked(committed);
    }
  }

  if (!capturedCommittedDiff && rootSha) {
    const committedFromRoot = runGit(['diff', '--name-only', '--diff-filter=ACMR', `${rootSha}..HEAD`]);
    if (committedFromRoot.status === 0) {
      capturedCommittedDiff = true;
      collectTracked(committedFromRoot);
    }
  }

  if (!capturedCommittedDiff) {
    collectTracked(runGit(['show', '--name-only', '--pretty=format:', '--diff-filter=ACMR', 'HEAD']));
  }

  collectTracked(runGit(['diff', '--cached', '--name-only', '--diff-filter=ACMR']));
  collectTracked(runGit(['diff', '--name-only', '--diff-filter=ACMR']));

  return Array.from(tracked).sort();
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

function validateStrictUiEvidenceManifest(changedUiPaths) {
  const manifestPath = path.join(process.cwd(), UI_EVIDENCE_MANIFEST_FILE);
  const artifactBaseDir = path.resolve(process.cwd(), UI_EVIDENCE_ARTIFACT_BASE_DIR);
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, reason: `missing manifest file: ${UI_EVIDENCE_MANIFEST_FILE}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { ok: false, reason: `invalid JSON in manifest: ${UI_EVIDENCE_MANIFEST_FILE}` };
  }

  const artifacts = Array.isArray(parsed.artifacts) ? parsed.artifacts : null;
  if (!artifacts || artifacts.length < 1) {
    return { ok: false, reason: 'manifest.artifacts must contain at least one item' };
  }

  const uiPaths = Array.isArray(parsed.ui_paths) ? parsed.ui_paths : null;
  if (!uiPaths || uiPaths.length < 1) {
    return { ok: false, reason: 'manifest.ui_paths must contain at least one item' };
  }

  const uiPathSet = new Set(uiPaths.filter((value) => typeof value === 'string'));
  for (const changedPath of changedUiPaths) {
    if (!uiPathSet.has(changedPath)) {
      return { ok: false, reason: `manifest.ui_paths is missing changed UI path: ${changedPath}` };
    }
  }

  if (typeof parsed.captured_at !== 'string' || parsed.captured_at.trim().length === 0 || Number.isNaN(Date.parse(parsed.captured_at))) {
    return { ok: false, reason: 'manifest.captured_at must be a valid datetime string' };
  }

  if (typeof parsed.summary !== 'string' || parsed.summary.trim().length === 0) {
    return { ok: false, reason: 'manifest.summary must be a non-empty string' };
  }

  const publishReference = typeof parsed.publish_reference === 'string' ? parsed.publish_reference.trim() : '';
  if (publishReference.length === 0) {
    return { ok: false, reason: 'manifest.publish_reference must be a non-empty string' };
  }

  for (const [index, artifact] of artifacts.entries()) {
    if (!artifact || typeof artifact !== 'object') {
      return { ok: false, reason: `manifest.artifacts[${index}] must be an object` };
    }

    const artifactPath = typeof artifact.path === 'string' ? artifact.path.trim() : '';
    const artifactType = typeof artifact.type === 'string' ? artifact.type.trim() : '';
    if (!artifactPath) {
      return { ok: false, reason: `manifest.artifacts[${index}].path must be a non-empty string` };
    }
    if (artifactType !== 'image' && artifactType !== 'video') {
      return { ok: false, reason: `manifest.artifacts[${index}].type must be image or video` };
    }

    const normalizedPath = artifactPath.replace(/\\/g, '/');
    if (!normalizedPath.startsWith('output/playwright/')) {
      return { ok: false, reason: `manifest.artifacts[${index}].path must be under output/playwright/` };
    }
    if (artifactType === 'image' && !normalizedPath.endsWith('.png')) {
      return { ok: false, reason: `manifest.artifacts[${index}] image artifact must use .png` };
    }
    if (artifactType === 'video' && !normalizedPath.endsWith('.mp4') && !normalizedPath.endsWith('.webm')) {
      return { ok: false, reason: `manifest.artifacts[${index}] video artifact must use .mp4 or .webm` };
    }

    const resolvedPath = path.resolve(process.cwd(), normalizedPath);
    const relativeToBase = path.relative(artifactBaseDir, resolvedPath);
    if (relativeToBase.startsWith('..') || path.isAbsolute(relativeToBase)) {
      return { ok: false, reason: `manifest.artifacts[${index}].path escapes output/playwright/: ${normalizedPath}` };
    }
    if (!fs.existsSync(resolvedPath)) {
      return { ok: false, reason: `manifest artifact file is missing: ${normalizedPath}` };
    }
  }

  return { ok: true, mode: `file:${UI_EVIDENCE_MANIFEST_FILE}` };
}

function tryLoadSharedFrontmatterParser(repoRoot) {
  const candidates = [
    path.join(repoRoot, 'dist/src/workflow/frontmatter.js'),
    path.join(repoRoot, 'dist/src/workflow/loader.js')
  ];

  for (const candidate of candidates) {
    try {
      const loaded = require(candidate);
      if (loaded && typeof loaded.parseWorkflowFrontMatter === 'function') {
        return loaded.parseWorkflowFrontMatter;
      }
      if (loaded && loaded.WorkflowLoader) {
        const loader = new loaded.WorkflowLoader();
        return (content) => ({
          config: loader.parse(content).config || {}
        });
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function loadWorkflowConfig() {
  const repoRoot = process.cwd();
  const workflowPath = path.resolve(repoRoot, process.env[WORKFLOW_PATH_ENV] || DEFAULT_WORKFLOW_PATH);
  if (!fs.existsSync(workflowPath)) {
    return {};
  }

  const parseWorkflowFrontMatter = tryLoadSharedFrontmatterParser(repoRoot);
  if (typeof parseWorkflowFrontMatter !== 'function') {
    return { __parse_error: 'shared_frontmatter_parser_unavailable' };
  }

  const content = fs.readFileSync(workflowPath, 'utf8');
  try {
    const parsed = parseWorkflowFrontMatter(content);
    if (parsed && typeof parsed.config === 'object' && parsed.config) {
      return parsed.config;
    }
  } catch {
    return { __parse_error: 'shared_frontmatter_parse_failed' };
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
  const workflowConfig = loadWorkflowConfig();
  if (workflowConfig.__parse_error) {
    process.stderr.write(
      `Meta check failed: unable to load workflow validation profile (${workflowConfig.__parse_error}).\n`
    );
    process.stderr.write('Run `npm run build` and retry, or set SYMPHONY_UI_EVIDENCE_PROFILE explicitly.\n');
    process.exit(1);
  }
  const validation = workflowConfig && typeof workflowConfig.validation === 'object' ? workflowConfig.validation : {};
  const configured = String(validation.ui_evidence_profile || '')
    .trim()
    .toLowerCase();

  if (configured === 'baseline' || configured === 'strict') {
    return { profile: configured, source: `workflow:${path.relative(process.cwd(), workflowPath) || DEFAULT_WORKFLOW_PATH}` };
  }

  return { profile: 'baseline', source: 'default:baseline' };
}

function enforceUiEvidenceGate() {
  const uiEvidenceProfile = resolveUiEvidenceProfile();
  process.stdout.write(`UI evidence profile active: ${uiEvidenceProfile.profile} (${uiEvidenceProfile.source}).\n`);

  if (!isTrackedUiEvidenceAllowed()) {
    const trackedEvidenceFiles = listTrackedUiEvidenceFiles();
    if (trackedEvidenceFiles.length > 0) {
      process.stderr.write('Meta check failed: tracked UI evidence artifacts are not allowed under output/playwright/.\n');
      process.stderr.write('Publish artifacts to review surfaces, then unstage/remove them before commit.\n');
      process.stderr.write(`To bypass intentionally, set ${UI_EVIDENCE_ALLOW_TRACKED_ENV}=1.\n`);
      process.stderr.write('Tracked evidence files:\n');
      for (const file of trackedEvidenceFiles) {
        process.stderr.write(`  - ${file}\n`);
      }
      process.stderr.write('Suggested cleanup:\n');
      process.stderr.write('  - git restore --staged output/playwright/*\n');
      process.stderr.write('  - git rm --cached -r output/playwright/  # if already tracked in commit history\n');
      process.stderr.write('  - rm -rf output/playwright/\n');
      process.exit(1);
    }
  }

  const changedFiles = listChangedFiles();
  if (!hasUiAffectingChange(changedFiles)) {
    process.stdout.write('UI evidence gate skipped: no UI-affecting paths changed.\n');
    return;
  }

  const changedUiPaths = changedFiles.filter((candidate) => UI_PATH_PATTERNS.some((pattern) => pattern.test(candidate)));

  if (uiEvidenceProfile.profile === 'strict') {
    const strictEvidence = validateStrictUiEvidenceManifest(changedUiPaths);
    if (!strictEvidence.ok) {
      process.stderr.write('Meta check failed: strict UI evidence profile requires manifest-backed artifacts for UI-affecting changes.\n');
      process.stderr.write(`Validation error: ${strictEvidence.reason}\n`);
      process.stderr.write(`Expected manifest: ${UI_EVIDENCE_MANIFEST_FILE}\n`);
      process.exit(1);
    }
    process.stdout.write(`UI evidence gate passed via ${strictEvidence.mode}.\n`);
    return;
  }

  const evidence = hasUiEvidence();
  if (evidence.ok) {
    process.stdout.write(`UI evidence gate passed via ${evidence.mode}.\n`);
    return;
  }

  process.stderr.write('Meta check failed: UI-affecting changes detected without e2e evidence.\n');
  process.stderr.write('Changed UI paths:\n');
  for (const file of changedUiPaths) {
    process.stderr.write(`  - ${file}\n`);
  }
  process.stderr.write('Provide one of:\n');
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

const runUpstreamParity = ['1', 'true', 'yes'].includes(
  String(process.env.SYMPHONY_UPSTREAM_PARITY_ENABLED || '').toLowerCase()
);
if (runUpstreamParity) {
  const mode = process.env.SYMPHONY_UPSTREAM_PARITY_BLOCKING === '1' ? 'blocking' : 'advisory';
  const result = spawnSync('node', [upstreamParityCheck, '--mode', mode], { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

enforceUiEvidenceGate();
process.stdout.write('Meta checks passed.\n');
