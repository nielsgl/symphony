#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const repoRoot = process.cwd();
const serverPath = path.join(repoRoot, 'src', 'api', 'server.ts');
const typesPath = path.join(repoRoot, 'src', 'api', 'types.ts');

if (!fs.existsSync(serverPath) || !fs.existsSync(typesPath)) {
  fail('API contract check failed: expected src/api/server.ts and src/api/types.ts to exist.');
}

const server = fs.readFileSync(serverPath, 'utf8');
const types = fs.readFileSync(typesPath, 'utf8');

const serverRequiredPatterns = [
  '^\\/api\\/v1\\/state$',
  '^\\/api\\/v1\\/refresh$',
  '^\\/api\\/v1\\/events$',
  '^\\/api\\/v1\\/diagnostics$',
  '^\\/api\\/v1\\/history$',
  '^\\/api\\/v1\\/ui-state$'
];

for (const pattern of serverRequiredPatterns) {
  if (!server.includes(pattern)) {
    fail(`API contract check failed: server missing endpoint pattern ${pattern}`);
  }
}

const typeRequiredPatterns = [
  'export interface ApiEventEnvelope',
  'export interface ApiStateResponse',
  'export interface ApiIssueResponse',
  'export interface ApiStateErrorResponse'
];

for (const pattern of typeRequiredPatterns) {
  if (!types.includes(pattern)) {
    fail(`API contract check failed: types missing ${pattern}`);
  }
}

process.stdout.write('API contract check passed.\n');
