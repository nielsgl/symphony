#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_MODULE_EXPORTS = [
  'workflow',
  'tracker',
  'orchestrator',
  'workspace',
  'codex',
  'api',
  'observability',
  'security',
  'persistence',
  'runtime'
];

function fail(message) {
  process.stderr.write(`Public API contract check failed: ${message}\n`);
  process.exit(1);
}

function readFileOrFail(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`missing required file ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function main() {
  const repoRoot = process.cwd();
  const indexPath = path.join(repoRoot, 'src', 'index.ts');
  const indexContent = readFileOrFail(indexPath);

  for (const moduleName of REQUIRED_MODULE_EXPORTS) {
    const moduleIndexPath = path.join(repoRoot, 'src', moduleName, 'index.ts');
    if (!fs.existsSync(moduleIndexPath)) {
      fail(`missing module index ${path.relative(repoRoot, moduleIndexPath)}`);
    }

    const exportPattern = new RegExp(`^\\s*export \\* as ${moduleName} from ['\"]\\./${moduleName}['\"];?\\s*$`, 'm');
    if (!exportPattern.test(indexContent)) {
      fail(`src/index.ts must export module '${moduleName}' as \"export * as ${moduleName} from './${moduleName}'\"`);
    }
  }

  process.stdout.write('Public API contract check passed.\n');
}

main();
