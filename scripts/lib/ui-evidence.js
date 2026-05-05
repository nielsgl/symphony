const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_RELATIVE_PATH = path.join('output', 'playwright', 'ui-evidence.json');
const ARTIFACT_BASE_DIR = path.join('output', 'playwright');
const ARTIFACT_PATH_PREFIX = 'output/playwright/';

const LINEAR_REFERENCE_PATTERN = /^https:\/\/linear\.app\/[^/]+\/issue\/[A-Z]+-\d+(?:[/?#].*)?$/;
const GITHUB_PR_COMMENT_PATTERN = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+#issuecomment-\d+$/;

function normalizeArtifactPath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function toTypedError(code, message, details = {}) {
  return { ok: false, code, message, details };
}

function inferArtifactType(artifactPath) {
  const normalized = normalizeArtifactPath(artifactPath).toLowerCase();
  if (normalized.endsWith('.png')) {
    return 'image';
  }
  if (normalized.endsWith('.mp4') || normalized.endsWith('.webm')) {
    return 'video';
  }
  return null;
}

function listFilesRecursive(directoryPath) {
  const discovered = [];
  if (!fs.existsSync(directoryPath)) {
    return discovered;
  }
  const stack = [directoryPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (entry.isFile()) {
        discovered.push(absolute);
      }
    }
  }
  return discovered.sort();
}

function discoverArtifacts(repoRoot) {
  const baseDir = path.resolve(repoRoot, ARTIFACT_BASE_DIR);
  const files = listFilesRecursive(baseDir);
  const artifacts = [];
  for (const absolute of files) {
    const relative = normalizeArtifactPath(path.relative(repoRoot, absolute));
    if (!relative.startsWith(ARTIFACT_PATH_PREFIX)) {
      continue;
    }
    if (relative === MANIFEST_RELATIVE_PATH) {
      continue;
    }
    const type = inferArtifactType(relative);
    if (!type) {
      return toTypedError('ui_evidence_invalid_artifact_type', `Unsupported artifact extension: ${relative}`, { path: relative });
    }
    artifacts.push({ path: relative, type });
  }
  if (artifacts.length < 1) {
    return toTypedError('ui_evidence_missing_artifacts', `No .png/.mp4/.webm artifacts found under ${ARTIFACT_BASE_DIR}`, {
      artifact_base_dir: ARTIFACT_BASE_DIR
    });
  }
  return { ok: true, artifacts };
}

function isValidPublishReference(reference) {
  return LINEAR_REFERENCE_PATTERN.test(reference) || GITHUB_PR_COMMENT_PATTERN.test(reference);
}

function hasLinearProof(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return false;
  }
  const checkLinear = (value) => typeof value === 'string' && LINEAR_REFERENCE_PATTERN.test(value.trim());
  if (checkLinear(parsed.publish_reference)) {
    return true;
  }
  const artifacts = Array.isArray(parsed.artifacts) ? parsed.artifacts : [];
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== 'object') {
      continue;
    }
    if (checkLinear(artifact.publish_reference) || checkLinear(artifact.published_url)) {
      return true;
    }
  }
  const mapped = parsed.published_artifacts;
  if (mapped && typeof mapped === 'object') {
    for (const value of Object.values(mapped)) {
      if (checkLinear(value)) {
        return true;
      }
    }
  }
  return false;
}

function parseManifestFile(repoRoot) {
  const manifestPath = path.resolve(repoRoot, MANIFEST_RELATIVE_PATH);
  if (!fs.existsSync(manifestPath)) {
    return toTypedError('ui_evidence_manifest_missing', `Missing manifest file: ${MANIFEST_RELATIVE_PATH}`, { manifest_path: MANIFEST_RELATIVE_PATH });
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return toTypedError('ui_evidence_manifest_invalid_json', `Invalid JSON in manifest: ${MANIFEST_RELATIVE_PATH}`, {
      manifest_path: MANIFEST_RELATIVE_PATH
    });
  }
  return { ok: true, parsed, manifestPath };
}

function validateManifestObject(repoRoot, parsed, options = {}) {
  const artifacts = Array.isArray(parsed.artifacts) ? parsed.artifacts : null;
  if (!artifacts || artifacts.length < 1) {
    return toTypedError('ui_evidence_missing_artifacts', 'manifest.artifacts must contain at least one item');
  }
  const uiPaths = Array.isArray(parsed.ui_paths) ? parsed.ui_paths : null;
  if (!uiPaths || uiPaths.length < 1) {
    return toTypedError('ui_evidence_ui_paths_mismatch', 'manifest.ui_paths must contain at least one item');
  }
  const changedUiPaths = Array.isArray(options.changedUiPaths) ? options.changedUiPaths : [];
  const uiPathSet = new Set(uiPaths.filter((value) => typeof value === 'string'));
  for (const changedPath of changedUiPaths) {
    if (!uiPathSet.has(changedPath)) {
      return toTypedError('ui_evidence_ui_paths_mismatch', `manifest.ui_paths is missing changed UI path: ${changedPath}`, {
        missing_ui_path: changedPath
      });
    }
  }
  if (typeof parsed.captured_at !== 'string' || parsed.captured_at.trim().length === 0 || Number.isNaN(Date.parse(parsed.captured_at))) {
    return toTypedError('ui_evidence_manifest_invalid_json', 'manifest.captured_at must be a valid datetime string');
  }
  if (typeof parsed.summary !== 'string' || parsed.summary.trim().length === 0) {
    return toTypedError('ui_evidence_manifest_invalid_json', 'manifest.summary must be a non-empty string');
  }
  const publishReference = typeof parsed.publish_reference === 'string' ? parsed.publish_reference.trim() : '';
  if (!publishReference || !isValidPublishReference(publishReference)) {
    return toTypedError(
      'ui_evidence_publish_reference_invalid',
      'manifest.publish_reference must match allowed Linear issue URL or GitHub PR comment URL'
    );
  }

  const artifactBaseDir = path.resolve(repoRoot, ARTIFACT_BASE_DIR);
  for (const [index, artifact] of artifacts.entries()) {
    if (!artifact || typeof artifact !== 'object') {
      return toTypedError('ui_evidence_manifest_invalid_json', `manifest.artifacts[${index}] must be an object`);
    }
    const artifactPath = typeof artifact.path === 'string' ? artifact.path.trim() : '';
    if (!artifactPath) {
      return toTypedError('ui_evidence_manifest_invalid_json', `manifest.artifacts[${index}].path must be a non-empty string`);
    }
    const normalizedPath = normalizeArtifactPath(artifactPath);
    if (!normalizedPath.startsWith(ARTIFACT_PATH_PREFIX)) {
      return toTypedError(
        'ui_evidence_invalid_artifact_type',
        `manifest.artifacts[${index}].path must be under ${ARTIFACT_PATH_PREFIX}`
      );
    }

    const artifactType = typeof artifact.type === 'string' ? artifact.type.trim() : '';
    const inferredType = inferArtifactType(normalizedPath);
    if (!inferredType || artifactType !== inferredType) {
      return toTypedError(
        'ui_evidence_invalid_artifact_type',
        `manifest.artifacts[${index}] expected type '${inferredType || 'unknown'}' for path '${normalizedPath}'`
      );
    }

    const resolvedPath = path.resolve(repoRoot, normalizedPath);
    const relativeToBase = path.relative(artifactBaseDir, resolvedPath);
    if (relativeToBase.startsWith('..') || path.isAbsolute(relativeToBase)) {
      return toTypedError('ui_evidence_invalid_artifact_type', `manifest.artifacts[${index}].path escapes ${ARTIFACT_PATH_PREFIX}`, {
        path: normalizedPath
      });
    }
    if (!fs.existsSync(resolvedPath)) {
      return toTypedError('ui_evidence_missing_artifacts', `manifest artifact file is missing: ${normalizedPath}`, {
        path: normalizedPath
      });
    }
  }

  if (options.requireLinearProof && !hasLinearProof(parsed)) {
    return toTypedError(
      'ui_evidence_publish_reference_missing_linear_proof',
      'Strict mode requires at least one Linear-hosted publish reference'
    );
  }

  return { ok: true, mode: `file:${MANIFEST_RELATIVE_PATH}` };
}

function validateManifestFile(repoRoot, options = {}) {
  const loaded = parseManifestFile(repoRoot);
  if (!loaded.ok) {
    return loaded;
  }
  return validateManifestObject(repoRoot, loaded.parsed, options);
}

function buildManifestFromArtifacts(repoRoot, input) {
  const discovered = discoverArtifacts(repoRoot);
  if (!discovered.ok) {
    return discovered;
  }
  const manifest = {
    artifacts: discovered.artifacts,
    ui_paths: Array.isArray(input.uiPaths) ? input.uiPaths : [],
    captured_at: input.capturedAt,
    summary: input.summary,
    publish_reference: input.publishReference
  };
  return { ok: true, manifest };
}

module.exports = {
  MANIFEST_RELATIVE_PATH,
  ARTIFACT_BASE_DIR,
  discoverArtifacts,
  validateManifestFile,
  validateManifestObject,
  buildManifestFromArtifacts
};
