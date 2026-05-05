#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {
  MANIFEST_RELATIVE_PATH,
  buildManifestFromArtifacts,
  validateManifestObject
} = require('./lib/ui-evidence');

function readArgs(argv) {
  const options = {
    summary: '',
    publishReference: '',
    capturedAt: new Date().toISOString(),
    uiPaths: [],
    strictLinearProof: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--summary') {
      options.summary = String(argv[index + 1] || '');
      index += 1;
      continue;
    }
    if (token === '--publish-reference') {
      options.publishReference = String(argv[index + 1] || '');
      index += 1;
      continue;
    }
    if (token === '--captured-at') {
      options.capturedAt = String(argv[index + 1] || '');
      index += 1;
      continue;
    }
    if (token === '--ui-path') {
      options.uiPaths.push(String(argv[index + 1] || '').trim());
      index += 1;
      continue;
    }
    if (token === '--strict-linear-proof') {
      options.strictLinearProof = true;
      continue;
    }
  }

  options.uiPaths = options.uiPaths.filter(Boolean);
  return options;
}

function printTypedError(error) {
  process.stderr.write(`${error.code}: ${error.message}\n`);
  if (error.details && Object.keys(error.details).length > 0) {
    process.stderr.write(`${JSON.stringify(error.details)}\n`);
  }
}

function main() {
  const options = readArgs(process.argv.slice(2));
  const built = buildManifestFromArtifacts(process.cwd(), options);
  if (!built.ok) {
    printTypedError(built);
    process.exit(1);
  }

  const validated = validateManifestObject(process.cwd(), built.manifest, {
    requireLinearProof: options.strictLinearProof
  });
  if (!validated.ok) {
    printTypedError(validated);
    process.exit(1);
  }

  const manifestPath = path.resolve(process.cwd(), MANIFEST_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(built.manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`UI evidence manifest written: ${MANIFEST_RELATIVE_PATH}\n`);
}

main();
