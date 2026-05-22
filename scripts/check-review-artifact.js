#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { assertHumanReadableMarkdownBody } = require('./lib/markdown-body');

function fail(message) {
  process.stderr.write(`review_artifact_invalid: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { bodyFile: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--body-file') {
      out.bodyFile = argv[index + 1] || '';
      index += 1;
    } else if (arg.startsWith('--body-file=')) {
      out.bodyFile = arg.slice('--body-file='.length);
    } else {
      fail(`unsupported argument ${arg}`);
    }
  }
  return out;
}

function readReviewBody(argv) {
  const parsed = parseArgs(argv);
  const bodyFile = parsed.bodyFile || process.env.SYMPHONY_REVIEW_BODY_FILE || '';
  const body = process.env.SYMPHONY_REVIEW_BODY || '';
  if (bodyFile.trim()) {
    const resolved = path.resolve(process.cwd(), bodyFile.trim());
    if (!fs.existsSync(resolved)) {
      fail(`body file does not exist: ${resolved}`);
    }
    return fs.readFileSync(resolved, 'utf8');
  }
  if (body.trim()) {
    return body;
  }
  fail('provide SYMPHONY_REVIEW_BODY, SYMPHONY_REVIEW_BODY_FILE, or --body-file');
}

function sectionContent(body, heading) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `### ${heading}`);
  if (start < 0) {
    return null;
  }
  const collected = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^#{2,3}\s+/.test(line)) {
      break;
    }
    collected.push(line);
  }
  return collected.join('\n').trim();
}

function requireSection(body, heading) {
  const content = sectionContent(body, heading);
  if (!content) {
    fail(`missing or empty section: ${heading}`);
  }
  return content;
}

function requireField(section, label) {
  const pattern = new RegExp(`^-\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(.+)$`, 'mi');
  const match = section.match(pattern);
  if (!match || !match[1].trim()) {
    fail(`missing required Scope Read field: ${label}`);
  }
}

function tableRows(section) {
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|') && !/^\|\s*-+/.test(line));
}

function splitRow(row) {
  return row
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function requireTableEvidence(section, heading, expectedHeaders) {
  const rows = tableRows(section);
  if (rows.length < 2) {
    fail(`${heading} must include a markdown table with at least one evidence row`);
  }
  const headers = splitRow(rows[0]).map((header) => header.toLowerCase());
  for (const expected of expectedHeaders) {
    if (!headers.includes(expected.toLowerCase())) {
      fail(`${heading} table missing header: ${expected}`);
    }
  }
  const evidenceIndex = headers.indexOf('evidence');
  const verdictIndex = headers.indexOf('verdict');
  const dataRows = rows.slice(1);
  if (dataRows.length === 0) {
    fail(`${heading} table must include at least one data row`);
  }
  for (const row of dataRows) {
    const cells = splitRow(row);
    const evidence = cells[evidenceIndex] || '';
    const verdict = cells[verdictIndex] || '';
    if (!evidence || /^n\/?a$/i.test(evidence) || /^-+$/.test(evidence)) {
      fail(`${heading} row is missing evidence: ${row}`);
    }
    if (!verdict || /^n\/?a$/i.test(verdict) || /^-+$/.test(verdict)) {
      fail(`${heading} row is missing verdict: ${row}`);
    }
  }
}

function validateReviewArtifact(rawBody) {
  const body = assertHumanReadableMarkdownBody(rawBody);
  if (!/^## Agent Review\s*$/m.test(body)) {
    fail('missing top-level "## Agent Review" heading');
  }

  const scope = requireSection(body, 'Scope Read');
  for (const field of ['Issue', 'PR', 'Head SHA', 'Prior findings reviewed']) {
    requireField(scope, field);
  }

  const invariants = requireSection(body, 'Independent Invariants');
  if (!/^- |\d+\. /m.test(invariants)) {
    fail('Independent Invariants must list at least one invariant');
  }

  requireTableEvidence(
    requireSection(body, 'Acceptance Criteria Mapping'),
    'Acceptance Criteria Mapping',
    ['Criterion', 'Evidence', 'Verdict']
  );
  requireTableEvidence(
    requireSection(body, 'Triggered Review Lenses'),
    'Triggered Review Lenses',
    ['Lens', 'Trigger', 'Evidence', 'Verdict']
  );

  const findings = requireSection(body, 'Findings');
  if (!/(P1|P2|P3|No blocking findings)/i.test(findings)) {
    fail('Findings must list P1/P2/P3 findings or `No blocking findings`');
  }

  const verdict = requireSection(body, 'Verdict');
  if (!/(Blocked: move to In Progress|Reset required: move to Rework|Pass: route to Human Review|Pass: route to Merging)/.test(verdict)) {
    fail('Verdict must use one of the allowed routing outcomes');
  }
}

if (require.main === module) {
  try {
    validateReviewArtifact(readReviewBody(process.argv.slice(2)));
    process.stdout.write('Review artifact check passed.\n');
  } catch (error) {
    if (error && error.code === 'pr_body_escaped_newlines') {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

module.exports = {
  validateReviewArtifact
};
