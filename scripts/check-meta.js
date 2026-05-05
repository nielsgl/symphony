#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertHumanReadableMarkdownBody } = require('./lib/markdown-body');
const { MANIFEST_RELATIVE_PATH: UI_EVIDENCE_MANIFEST_FILE, validateManifestFile } = require('./lib/ui-evidence');

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
  /^tests\/fixtures\/ui-gate\/dashboard-assets\.fixture\.ts$/,
  /^desktop-static\//,
  /^src-tauri\/src\//
];

const UI_E2E_PASS_ENV = 'SYMPHONY_UI_E2E_PLAYWRIGHT_PASS';
const UI_EVIDENCE_PROFILE_ENV = 'SYMPHONY_UI_EVIDENCE_PROFILE';
const WORKFLOW_PATH_ENV = 'SYMPHONY_WORKFLOW_PATH';
const DEFAULT_WORKFLOW_PATH = 'WORKFLOW.md';
const UI_EVIDENCE_MARKER_FILE = path.join('output', 'playwright', 'ui-e2e-evidence.txt');
const UI_EVIDENCE_MARKER_LINE = 'UI_E2E_EVIDENCE=PASS';
const UI_EVIDENCE_ALLOW_TRACKED_ENV = 'SYMPHONY_UI_EVIDENCE_ALLOW_TRACKED';
const REPO_HYGIENE_ALLOW_TRACKED_ENV = 'SYMPHONY_REPO_HYGIENE_ALLOW_TRACKED';
const UI_EVIDENCE_TRACKED_PATH_PREFIX = 'output/playwright/';
const UI_EVIDENCE_REFERENCE_PATTERN = /output\/playwright\/[^\s`"')\]}]+/g;
const HYGIENE_REPO_ARTIFACT_TRACKED_FORBIDDEN = 'hygiene_repo_artifact_tracked_forbidden';
const HYGIENE_REPO_ARTIFACT_UNEXPECTED_STATE = 'hygiene_repo_artifact_unexpected_state';
const FORBIDDEN_REPO_ARTIFACTS = [
  {
    name: 'Playwright output artifact',
    matcher: (file) => file.startsWith(UI_EVIDENCE_TRACKED_PATH_PREFIX),
    cleanup: 'git restore --staged output/playwright/* && git rm --cached -r output/playwright/ && rm -rf output/playwright/'
  },
  {
    name: 'workspace provision artifact',
    matcher: (file) => file === '.symphony-provision.json',
    cleanup: 'git restore --staged .symphony-provision.json && git rm --cached .symphony-provision.json && rm -f .symphony-provision.json'
  }
];

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

function walkFiles(root, files = []) {
  if (!fs.existsSync(root)) {
    return files;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(absolute, files);
    } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      files.push(absolute);
    }
  }
  return files;
}

function collectCanonicalReasonLiterals() {
  const registryPath = path.join(process.cwd(), 'src', 'observability', 'reason-codes.ts');
  if (!fs.existsSync(registryPath)) {
    return { ok: false, reason: 'missing_registry', literals: [] };
  }
  const content = fs.readFileSync(registryPath, 'utf8');
  const reasonCodesBlock = content.match(/export const REASON_CODES = \{([\s\S]*?)\} as const;/);
  if (!reasonCodesBlock) {
    return { ok: false, reason: 'missing_reason_codes_object', literals: [] };
  }
  const literals = Array.from(reasonCodesBlock[1].matchAll(/:\s*'([a-z0-9_.-]+)'/g))
    .map((match) => match[1])
    .filter((literal) => literal.includes('_') && !literal.startsWith('2026_'));
  return { ok: true, reason: null, literals: Array.from(new Set(literals)).sort() };
}

function enforceCanonicalReasonLiterals() {
  const collected = collectCanonicalReasonLiterals();
  if (!collected.ok) {
    process.stderr.write('Meta check failed: canonical reason-code registry is missing at src/observability/reason-codes.ts.\n');
    process.exit(1);
  }

  const allowedFiles = new Set([
    path.join(process.cwd(), 'src', 'observability', 'reason-codes.ts')
  ]);
  const violations = [];
  const sourceFiles = walkFiles(path.join(process.cwd(), 'src'));
  for (const file of sourceFiles) {
    if (allowedFiles.has(file)) {
      continue;
    }
    const content = fs.readFileSync(file, 'utf8');
    const relative = path.relative(process.cwd(), file).replace(/\\/g, '/');
    for (const literal of collected.literals) {
      const quoted = new RegExp(`['"\`]${literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`, 'g');
      let match;
      while ((match = quoted.exec(content)) !== null) {
        const line = content.slice(0, match.index).split(/\r?\n/).length;
        violations.push(`${relative}:${line}: ${literal}`);
      }
    }
  }

  if (violations.length > 0) {
    process.stderr.write('Meta check failed: reason-code literals must be referenced through src/observability/reason-codes.ts.\n');
    process.stderr.write('Violations:\n');
    for (const violation of violations) {
      process.stderr.write(`  - ${violation}\n`);
    }
    process.exit(1);
  }
  process.stdout.write('Reason-code literal guard passed.\n');
}

function hasUiAffectingChange(files) {
  return files.some((file) => UI_PATH_PATTERNS.some((pattern) => pattern.test(file)));
}

function isTrackedUiEvidenceAllowed() {
  const value = String(process.env[UI_EVIDENCE_ALLOW_TRACKED_ENV] || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function isTrackedRepoHygieneAllowed() {
  const value = String(process.env[REPO_HYGIENE_ALLOW_TRACKED_ENV] || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function normalizeGitPath(file) {
  return String(file || '').replace(/\\/g, '/').trim();
}

function forbiddenArtifactForPath(file) {
  const normalized = normalizeGitPath(file);
  return FORBIDDEN_REPO_ARTIFACTS.find((artifact) => artifact.matcher(normalized)) || null;
}

function isForbiddenRepoArtifactAllowed(entry) {
  if (isTrackedRepoHygieneAllowed()) {
    return true;
  }
  return normalizeGitPath(entry?.path).startsWith(UI_EVIDENCE_TRACKED_PATH_PREFIX) && isTrackedUiEvidenceAllowed();
}

function emitRepoHygieneDiagnostic(code, message, entries, remediation) {
  process.stderr.write(`${code}: ${message}\n`);
  if (entries.length > 0) {
    process.stderr.write('Artifacts:\n');
    for (const entry of entries) {
      const status = entry.status ? `${entry.status} ` : '';
      const name = entry.name ? ` (${entry.name})` : '';
      process.stderr.write(`  - ${status}${entry.path}${name}\n`);
    }
  }
  process.stderr.write(`Remediation: ${remediation}\n`);
}

function collectForbiddenFromGitResult(result, target, entries) {
  if (result.status !== 0) {
    emitRepoHygieneDiagnostic(
      HYGIENE_REPO_ARTIFACT_UNEXPECTED_STATE,
      `unable to inspect repository artifact state via git ${target}`,
      [],
      'Confirm git is available and rerun `npm run check:meta` from the repository root.'
    );
    process.exit(1);
  }

  for (const file of result.stdout.split('\n').map(normalizeGitPath).filter(Boolean)) {
    const artifact = forbiddenArtifactForPath(file);
    if (artifact) {
      entries.add(JSON.stringify({ path: file, name: artifact.name }));
    }
  }
}

function listTrackedForbiddenRepoArtifacts() {
  const tracked = new Set();
  let capturedCommittedDiff = false;
  const rootCommit = runGit(['rev-list', '--max-parents=0', '--max-count=1', 'HEAD']);
  const rootSha = rootCommit.status === 0 ? rootCommit.stdout.trim() : '';

  const baseRefCheck = runGit(['rev-parse', '--verify', '--quiet', 'origin/main']);
  if (baseRefCheck.status === 0) {
    const committed = runGit(['diff', '--name-only', '--diff-filter=ACMR', 'origin/main...HEAD']);
    if (committed.status === 0) {
      capturedCommittedDiff = true;
      collectForbiddenFromGitResult(committed, 'diff origin/main...HEAD', tracked);
    }
  }

  if (!capturedCommittedDiff && rootSha) {
    const committedFromRoot = runGit(['diff', '--name-only', '--diff-filter=ACMR', `${rootSha}..HEAD`]);
    if (committedFromRoot.status === 0) {
      capturedCommittedDiff = true;
      collectForbiddenFromGitResult(committedFromRoot, 'diff root..HEAD', tracked);
    }
  }

  if (!capturedCommittedDiff) {
    collectForbiddenFromGitResult(runGit(['show', '--name-only', '--pretty=format:', '--diff-filter=ACMR', 'HEAD']), 'show HEAD', tracked);
  }

  collectForbiddenFromGitResult(runGit(['diff', '--cached', '--name-only', '--diff-filter=ACMR']), 'diff --cached', tracked);
  collectForbiddenFromGitResult(runGit(['diff', '--name-only', '--diff-filter=ACMR']), 'diff', tracked);

  return Array.from(tracked)
    .map((entry) => JSON.parse(entry))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function listStagedForbiddenRepoArtifactEntries() {
  const staged = runGit(['diff', '--cached', '--name-status']);
  if (staged.status !== 0) {
    emitRepoHygieneDiagnostic(
      HYGIENE_REPO_ARTIFACT_UNEXPECTED_STATE,
      'unable to inspect staged repository artifact state',
      [],
      'Confirm git is available and rerun `npm run check:meta` from the repository root.'
    );
    process.exit(1);
  }

  const entries = [];
  for (const rawLine of staged.stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length < 2) {
      continue;
    }
    const status = parts[0];
    const pathCandidate = normalizeGitPath(parts[parts.length - 1]);
    const artifact = forbiddenArtifactForPath(pathCandidate);
    if (artifact) {
      entries.push({ status, path: pathCandidate, name: artifact.name });
    }
  }
  return entries;
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

function extractArtifactReferences(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return [];
  }
  return Array.from(new Set((text.match(UI_EVIDENCE_REFERENCE_PATTERN) || []).map((entry) => entry.replace(/\\/g, '/'))));
}

function collectPublishedArtifactReferences(parsedManifest) {
  const published = new Set();
  if (!parsedManifest || typeof parsedManifest !== 'object') {
    return published;
  }

  const artifacts = Array.isArray(parsedManifest.artifacts) ? parsedManifest.artifacts : [];
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== 'object') {
      continue;
    }
    const artifactPath = typeof artifact.path === 'string' ? artifact.path.replace(/\\/g, '/').trim() : '';
    if (!artifactPath.startsWith('output/playwright/')) {
      continue;
    }
    const hasPublishRef = typeof artifact.publish_reference === 'string' && artifact.publish_reference.trim().length > 0;
    const hasPublishedUrl = typeof artifact.published_url === 'string' && artifact.published_url.trim().length > 0;
    if (hasPublishRef || hasPublishedUrl) {
      published.add(artifactPath);
    }
  }

  const mapped = parsedManifest.published_artifacts;
  if (mapped && typeof mapped === 'object') {
    for (const [artifactPath, reference] of Object.entries(mapped)) {
      const normalizedPath = String(artifactPath || '').replace(/\\/g, '/').trim();
      if (!normalizedPath.startsWith('output/playwright/')) {
        continue;
      }
      if (typeof reference === 'string' && reference.trim().length > 0) {
        published.add(normalizedPath);
      }
    }
  }
  return published;
}

function enforceEvidencePublicationReferences() {
  const references = new Set();
  const bodyInputs = [String(process.env.SYMPHONY_PR_BODY || ''), String(process.env.SYMPHONY_REVIEW_BODY || '')];
  const bodyFileInputs = [String(process.env.SYMPHONY_PR_BODY_FILE || ''), String(process.env.SYMPHONY_REVIEW_BODY_FILE || '')]
    .map((value) => value.trim())
    .filter(Boolean);

  try {
    for (const body of bodyInputs) {
      const normalized = assertHumanReadableMarkdownBody(body);
      for (const match of extractArtifactReferences(normalized)) {
        references.add(match);
      }
    }
    for (const bodyPath of bodyFileInputs) {
      const resolvedPath = path.resolve(process.cwd(), bodyPath);
      if (!fs.existsSync(resolvedPath)) {
        continue;
      }
      const normalized = assertHumanReadableMarkdownBody(fs.readFileSync(resolvedPath, 'utf8'));
      for (const match of extractArtifactReferences(normalized)) {
        references.add(match);
      }
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'pr_body_escaped_newlines: body contains escaped newline sequences; normalize before submit'}\n`);
    process.exit(1);
  }

  const manifestPath = path.join(process.cwd(), UI_EVIDENCE_MANIFEST_FILE);
  if (fs.existsSync(manifestPath)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      parsed = null;
    }
    if (parsed && Array.isArray(parsed.artifacts)) {
      for (const artifact of parsed.artifacts) {
        if (!artifact || typeof artifact !== 'object') {
          continue;
        }
        const artifactPath = typeof artifact.path === 'string' ? artifact.path.replace(/\\/g, '/').trim() : '';
        if (artifactPath.startsWith('output/playwright/')) {
          references.add(artifactPath);
        }
      }
    }

    if (references.size > 0) {
      const published = collectPublishedArtifactReferences(parsed);
      for (const artifactPath of references) {
        if (!published.has(artifactPath)) {
          process.stderr.write(
            'ui_evidence_unpublished: artifact referenced without markdown publish_reference or published_url\n'
          );
          process.stderr.write(`Artifact: ${artifactPath}\n`);
          process.stderr.write(
            'Add artifact.publish_reference, artifact.published_url, or published_artifacts[path] pointing to a Linear issue comment or GitHub PR comment.\n'
          );
          process.exit(1);
        }
      }
    }
  } else if (references.size > 0) {
    process.stderr.write('ui_evidence_unpublished: artifact referenced without markdown publish_reference or published_url\n');
    process.stderr.write(`Expected manifest: ${UI_EVIDENCE_MANIFEST_FILE}\n`);
    process.exit(1);
  }
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

  if (!isTrackedRepoHygieneAllowed()) {
    const stagedEvidenceEntries = listStagedForbiddenRepoArtifactEntries().filter((entry) => !isForbiddenRepoArtifactAllowed(entry));
    if (stagedEvidenceEntries.length > 0) {
      emitRepoHygieneDiagnostic(
        HYGIENE_REPO_ARTIFACT_TRACKED_FORBIDDEN,
        'staged UI evidence entries are not allowed under output/playwright/ and provision artifacts are not allowed at repository root.',
        stagedEvidenceEntries,
        `Publish review artifacts externally, unstage/remove forbidden files, or intentionally bypass with ${REPO_HYGIENE_ALLOW_TRACKED_ENV}=1.`
      );
      process.stderr.write('Suggested cleanup:\n');
      process.stderr.write('  - git restore --staged output/playwright/* .symphony-provision.json\n');
      process.stderr.write('  - git rm --cached -r output/playwright/ .symphony-provision.json  # if already tracked in commit history\n');
      process.stderr.write('  - rm -rf output/playwright/ .symphony-provision.json\n');
      process.exit(1);
    }

    const trackedEvidenceFiles = listTrackedForbiddenRepoArtifacts().filter((entry) => !isForbiddenRepoArtifactAllowed(entry));
    if (trackedEvidenceFiles.length > 0) {
      emitRepoHygieneDiagnostic(
        HYGIENE_REPO_ARTIFACT_TRACKED_FORBIDDEN,
        'tracked UI evidence artifacts are not allowed under output/playwright/ and provision artifacts are not allowed at repository root.',
        trackedEvidenceFiles,
        `Publish review artifacts externally, unstage/remove forbidden files, or intentionally bypass with ${REPO_HYGIENE_ALLOW_TRACKED_ENV}=1.`
      );
      process.stderr.write('Suggested cleanup:\n');
      process.stderr.write('  - git restore --staged output/playwright/* .symphony-provision.json\n');
      process.stderr.write('  - git rm --cached -r output/playwright/ .symphony-provision.json  # if already tracked in commit history\n');
      process.stderr.write('  - rm -rf output/playwright/ .symphony-provision.json\n');
      process.exit(1);
    }
  }

  const changedFiles = listChangedFiles();
  if (!hasUiAffectingChange(changedFiles)) {
    enforceEvidencePublicationReferences();
    process.stdout.write('UI evidence gate skipped: no UI-affecting paths changed.\n');
    return;
  }

  const changedUiPaths = changedFiles.filter((candidate) => UI_PATH_PATTERNS.some((pattern) => pattern.test(candidate)));

  if (uiEvidenceProfile.profile === 'strict') {
    const strictEvidence = validateManifestFile(process.cwd(), { changedUiPaths, requireLinearProof: true });
    if (!strictEvidence.ok) {
      process.stderr.write('Meta check failed: strict UI evidence profile requires manifest-backed artifacts for UI-affecting changes.\n');
      process.stderr.write(`Validation error: ${strictEvidence.code}: ${strictEvidence.message}\n`);
      process.stderr.write(`Expected manifest: ${UI_EVIDENCE_MANIFEST_FILE}\n`);
      process.exit(1);
    }
    enforceEvidencePublicationReferences();
    process.stdout.write(`UI evidence gate passed via ${strictEvidence.mode}.\n`);
    return;
  }

  const evidence = hasUiEvidence();
  if (evidence.ok) {
    enforceEvidencePublicationReferences();
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

enforceCanonicalReasonLiterals();
enforceUiEvidenceGate();
process.stdout.write('Meta checks passed.\n');
