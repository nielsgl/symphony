#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const root = process.cwd();
const manifestPath = path.join(root, 'docs', 'prd', 'SPEC-TEST-MANIFEST.json');
const auditPath = path.join(root, 'docs', 'prd', 'SPEC-LINE-PARITY-AUDIT.md');
const traceabilityPath = path.join(root, 'docs', 'prd', 'TRACEABILITY-MATRIX.md');
const statusPath = path.join(root, 'docs', 'prd', 'STATUS.md');

for (const target of [manifestPath, auditPath, traceabilityPath, statusPath]) {
  if (!fs.existsSync(target)) {
    fail(`SPEC coverage check failed: missing ${path.relative(root, target)}`);
  }
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const audit = fs.readFileSync(auditPath, 'utf8');
const traceability = fs.readFileSync(traceabilityPath, 'utf8');
const status = fs.readFileSync(statusPath, 'utf8');
const observabilityEvidenceCorpus = `${traceability}\n${audit}\n${status}`;
const observabilityCorpusLower = observabilityEvidenceCorpus.toLowerCase();

function hasObservabilitySignal(signal) {
  const normalizedSignal = String(signal).toLowerCase().trim();
  if (!normalizedSignal) {
    return false;
  }
  if (observabilityCorpusLower.includes(normalizedSignal)) {
    return true;
  }

  // Allow phrase-style anchors (e.g. "runtime health") by requiring all meaningful terms.
  const parts = normalizedSignal
    .split(/[^a-z0-9/_.*-]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);

  return parts.length > 1 && parts.every((part) => observabilityCorpusLower.includes(part));
}

if (!Array.isArray(manifest.requirements) || manifest.requirements.length === 0) {
  fail('SPEC coverage check failed: manifest.requirements is empty.');
}
if (!manifest.test_index || typeof manifest.test_index !== 'object') {
  fail('SPEC coverage check failed: manifest.test_index is missing.');
}

const implementedRequirementIds = new Set();
for (const line of audit.split('\n')) {
  if (!line.startsWith('|') || !line.includes('SPEC-') || line.includes('Unit range')) {
    continue;
  }

  const cols = line
    .split('|')
    .map((value) => value.trim())
    .filter((value, index, arr) => !(index === 0 || index === arr.length - 1));
  if (cols.length < 4) {
    continue;
  }

  const unitRange = cols[1];
  const status = cols[3];
  if (status !== 'implemented') {
    continue;
  }

  const rangeMatch = /^(SPEC-[A-Za-z0-9.]+-(\d+))\.\.(SPEC-([A-Za-z0-9.]+)-(\d+))$/.exec(unitRange);
  if (!rangeMatch) {
    fail(`SPEC coverage check failed: unsupported range format '${unitRange}'.`);
  }

  const startId = rangeMatch[1];
  const endId = rangeMatch[3];
  const sectionStart = /SPEC-([A-Za-z0-9.]+)-\d+/.exec(startId)?.[1];
  const sectionEnd = /SPEC-([A-Za-z0-9.]+)-\d+/.exec(endId)?.[1];
  if (!sectionStart || !sectionEnd || sectionStart !== sectionEnd) {
    fail(`SPEC coverage check failed: range crosses sections '${unitRange}'.`);
  }

  const start = Number.parseInt(rangeMatch[2], 10);
  const end = Number.parseInt(rangeMatch[5], 10);
  for (let idx = start; idx <= end; idx += 1) {
    implementedRequirementIds.add(`SPEC-${sectionStart}-${idx}`);
  }
}

const manifestIds = new Set(manifest.requirements.map((entry) => entry.requirement_id));
for (const id of implementedRequirementIds) {
  if (!manifestIds.has(id)) {
    fail(`SPEC coverage check failed: missing manifest entry for requirement ${id}.`);
  }
}

const allowedTiers = new Set(['pr', 'nightly', 'pre-release']);
for (const requirement of manifest.requirements) {
  if (!implementedRequirementIds.has(requirement.requirement_id)) {
    fail(`SPEC coverage check failed: non-implemented requirement present in manifest: ${requirement.requirement_id}`);
  }

  if (!requirement.owner_role || typeof requirement.owner_role !== 'string') {
    fail(`SPEC coverage check failed: owner_role missing for ${requirement.requirement_id}.`);
  }
  if (!allowedTiers.has(requirement.execution_tier)) {
    fail(`SPEC coverage check failed: invalid execution_tier '${requirement.execution_tier}' for ${requirement.requirement_id}.`);
  }

  if (!Array.isArray(requirement.code_anchors) || requirement.code_anchors.length === 0) {
    fail(`SPEC coverage check failed: code anchors missing for ${requirement.requirement_id}.`);
  }
  for (const anchor of requirement.code_anchors) {
    const anchorPath = path.join(root, anchor);
    if (!fs.existsSync(anchorPath)) {
      fail(`SPEC coverage check failed: code anchor missing on disk for ${requirement.requirement_id}: ${anchor}`);
    }
  }

  if (!Array.isArray(requirement.mandatory_test_ids) || requirement.mandatory_test_ids.length === 0) {
    fail(`SPEC coverage check failed: mandatory test IDs missing for ${requirement.requirement_id}.`);
  }

  for (const testId of requirement.mandatory_test_ids) {
    const testRef = manifest.test_index[testId];
    if (!testRef) {
      fail(`SPEC coverage check failed: test index missing required test ID ${testId}.`);
    }
    const testPath = path.join(root, testRef.file);
    if (!fs.existsSync(testPath)) {
      fail(`SPEC coverage check failed: mapped test file not found for ${testId}: ${testRef.file}`);
    }
    const testContent = fs.readFileSync(testPath, 'utf8');
    if (!testContent.includes(testRef.title_contains) || !testContent.includes(testId)) {
      fail(`SPEC coverage check failed: mapped test title/tag missing for ${testId} in ${testRef.file}`);
    }
  }

  if (!Array.isArray(requirement.required_observability_signals) || requirement.required_observability_signals.length === 0) {
    fail(`SPEC coverage check failed: observability signals missing for ${requirement.requirement_id}.`);
  }

  for (const signal of requirement.required_observability_signals) {
    if (!hasObservabilitySignal(signal)) {
      fail(
        `SPEC coverage check failed: observability signal '${signal}' not found in evidence corpus for ${requirement.requirement_id}.`
      );
    }
  }
}

process.stdout.write(
  `SPEC coverage check passed. Requirements=${manifest.requirements.length} mapped with full triad evidence.\n`
);
