#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const root = process.cwd();
const statusPath = path.join(root, 'docs', 'prd', 'STATUS.md');
const crossrefPath = path.join(root, 'docs', 'analysis', 'crossref', '02-cross-reference-matrix.md');
const recommendationsPath = path.join(root, 'docs', 'analysis', 'crossref', '03-recommendations-and-migration-plan.md');

for (const p of [statusPath, crossrefPath, recommendationsPath]) {
  if (!fs.existsSync(p)) {
    fail(`Governance check failed: missing required document ${path.relative(root, p)}`);
  }
}

const statusContent = fs.readFileSync(statusPath, 'utf8');
if (!statusContent.includes('Next-agent routing')) {
  fail('Governance check failed: STATUS.md missing Next-agent routing section.');
}

const matrixContent = fs.readFileSync(crossrefPath, 'utf8');
if (!matrixContent.includes('Cross-Reference Matrix')) {
  fail('Governance check failed: cross-reference matrix header missing.');
}

const recommendationContent = fs.readFileSync(recommendationsPath, 'utf8');
if (!recommendationContent.includes('Recommendations and Migration Plan')) {
  fail('Governance check failed: recommendations header missing.');
}

process.stdout.write('PR governance check passed.\n');
