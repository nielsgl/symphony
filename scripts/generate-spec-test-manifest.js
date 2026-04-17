#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const root = process.cwd();
const auditPath = path.join(root, 'docs', 'prd', 'SPEC-LINE-PARITY-AUDIT.md');
const policyPath = path.join(root, 'docs', 'prd', 'SPEC-TEST-MANIFEST-POLICY.json');
const outputPath = path.join(root, 'docs', 'prd', 'SPEC-TEST-MANIFEST.json');

if (!fs.existsSync(auditPath)) {
  fail(`Missing audit source: ${path.relative(root, auditPath)}`);
}
if (!fs.existsSync(policyPath)) {
  fail(`Missing manifest policy: ${path.relative(root, policyPath)}`);
}

const audit = fs.readFileSync(auditPath, 'utf8');
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));

function sectionTier(section, defaultTier) {
  const overrides = policy.section_tier_overrides || {};
  const entries = Object.entries(overrides).sort((a, b) => b[0].length - a[0].length);
  for (const [prefix, tier] of entries) {
    if (section === prefix || section.startsWith(`${prefix}.`)) {
      return tier;
    }
  }
  return defaultTier;
}

function expandRange(startId, endId) {
  const startMatch = /^SPEC-([A-Za-z0-9.]+)-(\d+)$/.exec(startId);
  const endMatch = /^SPEC-([A-Za-z0-9.]+)-(\d+)$/.exec(endId);
  if (!startMatch || !endMatch) {
    fail(`Invalid requirement range: ${startId}..${endId}`);
  }

  const sectionA = startMatch[1];
  const sectionB = endMatch[1];
  if (sectionA !== sectionB) {
    fail(`Range crosses sections: ${startId}..${endId}`);
  }

  const start = Number.parseInt(startMatch[2], 10);
  const end = Number.parseInt(endMatch[2], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    fail(`Invalid range bounds: ${startId}..${endId}`);
  }

  const ids = [];
  for (let idx = start; idx <= end; idx += 1) {
    ids.push(`SPEC-${sectionA}-${idx}`);
  }
  return { section: sectionA, ids };
}

const rows = [];
for (const line of audit.split('\n')) {
  if (!line.startsWith('|')) {
    continue;
  }
  if (!line.includes('SPEC-') || line.includes('Unit range')) {
    continue;
  }

  const cols = line
    .split('|')
    .map((value) => value.trim())
    .filter((value, index, arr) => !(index === 0 || index === arr.length - 1));

  if (cols.length < 7) {
    continue;
  }

  const [section, unitRange, , status, profile] = cols;
  if (status !== 'implemented') {
    continue;
  }

  const rangeMatch = /^(SPEC-[A-Za-z0-9.]+-\d+)\.\.(SPEC-[A-Za-z0-9.]+-\d+)$/.exec(unitRange);
  if (!rangeMatch) {
    fail(`Unsupported unit range format: ${unitRange}`);
  }

  rows.push({
    section,
    startId: rangeMatch[1],
    endId: rangeMatch[2],
    profile
  });
}

if (rows.length === 0) {
  fail('No implemented rows found in SPEC-LINE-PARITY-AUDIT.md');
}

const requirements = [];
for (const row of rows) {
  const profilePolicy = policy.profile_policies[row.profile];
  if (!profilePolicy) {
    fail(`Missing profile policy for ${row.profile}`);
  }

  const expanded = expandRange(row.startId, row.endId);
  const executionTier = sectionTier(row.section, profilePolicy.execution_tier || 'pr');

  for (const requirementId of expanded.ids) {
    requirements.push({
      requirement_id: requirementId,
      section: row.section,
      owner_role: policy.owner_role,
      subsystem: profilePolicy.subsystem,
      source_profile: row.profile,
      mandatory_test_ids: profilePolicy.mandatory_test_ids,
      required_observability_signals: profilePolicy.required_observability_signals,
      code_anchors: profilePolicy.code_anchors,
      execution_tier: executionTier
    });
  }
}

const output = {
  meta: {
    generated_at: new Date().toISOString(),
    source_audit: path.relative(root, auditPath),
    source_policy: path.relative(root, policyPath),
    owner_role: policy.owner_role,
    allowed_execution_tiers: ['pr', 'nightly', 'pre-release'],
    normative_status_filter: 'implemented',
    total_requirements: requirements.length
  },
  test_index: policy.test_index,
  requirements
};

fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stdout.write(`Wrote ${path.relative(root, outputPath)} with ${requirements.length} requirements.\n`);
