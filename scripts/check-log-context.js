#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = process.cwd();
const srcRoot = path.join(repoRoot, 'src');
const files = [];

function collectTypeScriptFiles(directoryPath) {
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      collectTypeScriptFiles(absolutePath);
      continue;
    }

    if (entry.isFile() && absolutePath.endsWith('.ts')) {
      files.push(path.relative(repoRoot, absolutePath));
    }
  }
}

collectTypeScriptFiles(srcRoot);

const violations = [];

for (const relativeFile of files) {
  const absoluteFile = path.join(repoRoot, relativeFile);
  let content;
  try {
    content = fs.readFileSync(absoluteFile, 'utf8');
  } catch (error) {
    console.error(`Log context check failed: cannot read ${relativeFile}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes('context:')) {
      continue;
    }

    for (let offset = 1; offset <= 30 && index + offset < lines.length; offset += 1) {
      const candidate = lines[index + offset];
      if (candidate.includes('issue_identifier:')) {
        continue;
      }
      if (/\bidentifier\s*:/.test(candidate)) {
        violations.push(`${relativeFile}:${index + offset + 1}: ${candidate.trim()}`);
      }
      if (candidate.includes('}')) {
        break;
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Log context check failed: non-canonical `identifier` key found in logging context blocks.');
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}

console.log('Log context check passed');
