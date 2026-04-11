#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rootDir = path.resolve(__dirname, '..');
const resourcesDir = path.join(rootDir, 'src-tauri', 'resources');

function resolvePkgPlatform(platform) {
  if (platform === 'darwin') {
    return 'macos';
  }
  if (platform === 'win32') {
    return 'win';
  }
  if (platform === 'linux') {
    return 'linux';
  }
  throw new Error(`Unsupported platform for desktop sidecar build: ${platform}`);
}

function resolvePkgArch(arch) {
  if (arch === 'x64') {
    return 'x64';
  }
  if (arch === 'arm64') {
    return 'arm64';
  }
  throw new Error(`Unsupported architecture for desktop sidecar build: ${arch}`);
}

function resolveOutputPath() {
  const extension = process.platform === 'win32' ? '.exe' : '';
  return path.join(resourcesDir, `symphony-backend${extension}`);
}

function ensureExecutable(filePath) {
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o755);
  }
}

function run() {
  const sourceEntry = path.join(rootDir, 'scripts', 'start-dashboard.js');
  if (!fs.existsSync(sourceEntry)) {
    throw new Error(`Missing source entrypoint: ${sourceEntry}`);
  }

  fs.mkdirSync(resourcesDir, { recursive: true });

  const target = `node18-${resolvePkgPlatform(process.platform)}-${resolvePkgArch(process.arch)}`;
  const outputPath = resolveOutputPath();

  const pkgArgs = [
    'pkg',
    sourceEntry,
    '--target',
    target,
    '--output',
    outputPath
  ];

  const result = spawnSync('npx', pkgArgs, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });

  if (result.status !== 0) {
    throw new Error('pkg sidecar build failed');
  }

  ensureExecutable(outputPath);
  process.stdout.write(`Built desktop backend sidecar: ${outputPath}\n`);
}

try {
  run();
} catch (error) {
  process.stderr.write(`Failed to build desktop backend sidecar: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
