import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

function runNode(args: string[], cwd: string) {
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8'
  });
}

function touchSchemaFiles(root: string) {
  const bundle = JSON.parse(
    fs.readFileSync(path.join(root, 'schema', 'codex_app_server_protocol.schemas.json'), 'utf8')
  ) as { definitions: Record<string, unknown> };

  for (const definition of Object.keys(bundle.definitions)) {
    if (['ClientRequest', 'ServerRequest', 'ServerNotification'].includes(definition)) {
      continue;
    }
    const relative = definition.startsWith('v2/') ? definition : definition;
    const filePath = path.join(root, 'schema', `${relative}.json`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ title: definition.split('/').at(-1) }, null, 2), 'utf8');
  }
}

describe('check-codex-app-server-contract script', () => {
  it('passes against focused generated contract inputs', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-contract-'));
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'tests/fixtures/codex-app-server-contract/good'), path.join(tempRoot, 'generated'), {
      recursive: true
    });
    touchSchemaFiles(path.join(tempRoot, 'generated'));

    const result = runNode(['scripts/check-codex-app-server-contract.js', '--generated-dir', 'generated'], tempRoot);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Codex app-server contract drift check passed.');
    expect(result.stdout).toContain('groups=8');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('fails with actionable output when a critical method drifts', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-contract-'));
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'tests/fixtures/codex-app-server-contract/good'), path.join(tempRoot, 'generated'), {
      recursive: true
    });
    touchSchemaFiles(path.join(tempRoot, 'generated'));

    const bundlePath = path.join(tempRoot, 'generated/schema/codex_app_server_protocol.schemas.json');
    const bundleText = fs.readFileSync(bundlePath, 'utf8').replace('model/rerouted', 'model/redirected');
    fs.writeFileSync(bundlePath, bundleText, 'utf8');

    const result = runNode(['scripts/check-codex-app-server-contract.js', '--generated-dir', 'generated'], tempRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Codex app-server contract drift check failed.');
    expect(result.stderr).toContain("ServerNotification does not include server notification method 'model/rerouted'");

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('fails with actionable output when a generated TypeScript export is missing', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-contract-'));
    fs.cpSync(path.join(root, 'scripts'), path.join(tempRoot, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'tests/fixtures/codex-app-server-contract/good'), path.join(tempRoot, 'generated'), {
      recursive: true
    });
    touchSchemaFiles(path.join(tempRoot, 'generated'));

    const tsPath = path.join(tempRoot, 'generated/ts/index.ts');
    const updated = fs.readFileSync(tsPath, 'utf8').replace('export interface DynamicToolSpec {}\n', '');
    fs.writeFileSync(tsPath, updated, 'utf8');

    const result = runNode(['scripts/check-codex-app-server-contract.js', '--generated-dir', 'generated'], tempRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[dynamic-tool] missing TypeScript export DynamicToolSpec');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});
