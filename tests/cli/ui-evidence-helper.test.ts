import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

function runHelper(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [path.join(process.cwd(), 'scripts/ui-evidence-helper.js'), ...args], {
    cwd,
    encoding: 'utf8'
  });
}

describe('ui evidence helper', () => {
  it('writes manifest from discovered artifacts with one command', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-evidence-helper-'));
    fs.mkdirSync(path.join(tempRoot, 'output/playwright'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'output/playwright/demo.png'), 'stub', 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'output/playwright/demo.webm'), 'stub', 'utf8');

    const result = runHelper(tempRoot, [
      '--summary',
      'UI evidence capture',
      '--publish-reference',
      'https://linear.app/nielsgl/issue/NIE-48#comment-1',
      '--ui-path',
      'src/api/dashboard-assets.ts'
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('UI evidence manifest written');
    const manifest = JSON.parse(fs.readFileSync(path.join(tempRoot, 'output/playwright/ui-evidence.json'), 'utf8'));
    expect(manifest.artifacts).toHaveLength(2);
    expect(manifest.ui_paths).toEqual(['src/api/dashboard-assets.ts']);
    expect(manifest.summary).toBe('UI evidence capture');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('fails with typed error when artifacts are missing', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-evidence-helper-'));
    const result = runHelper(tempRoot, [
      '--summary',
      'UI evidence capture',
      '--publish-reference',
      'https://linear.app/nielsgl/issue/NIE-48#comment-1',
      '--ui-path',
      'src/api/dashboard-assets.ts'
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ui_evidence_missing_artifacts');
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('fails with typed error for invalid artifact extension', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-evidence-helper-'));
    fs.mkdirSync(path.join(tempRoot, 'output/playwright'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'output/playwright/demo.jpg'), 'stub', 'utf8');
    const result = runHelper(tempRoot, [
      '--summary',
      'UI evidence capture',
      '--publish-reference',
      'https://linear.app/nielsgl/issue/NIE-48#comment-1',
      '--ui-path',
      'src/api/dashboard-assets.ts'
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ui_evidence_invalid_artifact_type');
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('fails with typed error for invalid publish reference', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-evidence-helper-'));
    fs.mkdirSync(path.join(tempRoot, 'output/playwright'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'output/playwright/demo.png'), 'stub', 'utf8');
    const result = runHelper(tempRoot, [
      '--summary',
      'UI evidence capture',
      '--publish-reference',
      'https://example.com/bad',
      '--ui-path',
      'src/api/dashboard-assets.ts'
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ui_evidence_publish_reference_invalid');
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('fails strict linear proof mode when reference is GitHub-only', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-ui-evidence-helper-'));
    fs.mkdirSync(path.join(tempRoot, 'output/playwright'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'output/playwright/demo.webm'), 'stub', 'utf8');
    const result = runHelper(tempRoot, [
      '--summary',
      'UI evidence capture',
      '--publish-reference',
      'https://github.com/nielsgl/symphony/pull/25#issuecomment-123456',
      '--ui-path',
      'src/api/dashboard-assets.ts',
      '--strict-linear-proof'
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ui_evidence_publish_reference_missing_linear_proof');
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});
