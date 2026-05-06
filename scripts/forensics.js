#!/usr/bin/env node

const fs = require('node:fs/promises');

const {
  assertForensicsBundle,
  diffForensicsBundles,
  replayForensicsBundle
} = require('../dist/src/api/forensics');

function usage() {
  console.error(`Usage:
  npm run forensics -- export --issue <ISSUE> [--base-url http://127.0.0.1:3000] [--out bundle.json]
  npm run forensics -- replay --bundle bundle.json [--out replay.json]
  npm run forensics -- diff --left good.json --right bad.json [--out diff.json]`);
}

function readArg(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

async function readBundle(filePath) {
  const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assertForensicsBundle(parsed);
  return parsed;
}

async function writeJson(payload, outPath) {
  const rendered = `${JSON.stringify(payload, null, 2)}\n`;
  if (outPath) {
    await fs.writeFile(outPath, rendered);
    return;
  }
  process.stdout.write(rendered);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    usage();
    process.exit(command ? 0 : 1);
  }

  if (command === 'export') {
    const issue = readArg(args, '--issue');
    if (!issue) {
      throw new Error('export requires --issue');
    }
    const baseUrl = readArg(args, '--base-url', process.env.SYMPHONY_API_BASE_URL || 'http://127.0.0.1:3000');
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v1/issues/${encodeURIComponent(issue)}/forensics/export`);
    if (!response.ok) {
      throw new Error(`export failed: HTTP ${response.status} ${await response.text()}`);
    }
    const bundle = await response.json();
    assertForensicsBundle(bundle);
    await writeJson(bundle, readArg(args, '--out'));
    return;
  }

  if (command === 'replay') {
    const bundlePath = readArg(args, '--bundle');
    if (!bundlePath) {
      throw new Error('replay requires --bundle');
    }
    await writeJson(replayForensicsBundle(await readBundle(bundlePath)), readArg(args, '--out'));
    return;
  }

  if (command === 'diff') {
    const leftPath = readArg(args, '--left');
    const rightPath = readArg(args, '--right');
    if (!leftPath || !rightPath) {
      throw new Error('diff requires --left and --right');
    }
    await writeJson(diffForensicsBundles(await readBundle(leftPath), await readBundle(rightPath)), readArg(args, '--out'));
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
