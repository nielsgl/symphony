import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

function runBootstrap(args: string[]) {
  const scriptPath = path.resolve(process.cwd(), 'scripts/bootstrap-tracker-seeds.js');
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: process.env
  });
}

describe('bootstrap tracker seeds script', () => {
  it('converts linear seed fixture to normalized payload', () => {
    const result = runBootstrap([
      '--tracker=linear',
      '--input=tests/fixtures/tracker-seeds/linear-todo-issues.json'
    ]);

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      tracker: string;
      summary: { total: number; errors: number };
      issues: Array<{ identifier: string; title: string }>;
    };

    expect(output.tracker).toBe('linear');
    expect(output.summary.total).toBe(5);
    expect(output.summary.errors).toBe(0);
    expect(output.issues[0].identifier).toBe('SYM-101');
    expect(output.issues[0].title).toContain('todo model');
  });

  it('converts github seed fixture and writes output file', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'symphony-bootstrap-'));
    cleanupPaths.push(tempDir);
    const outPath = path.join(tempDir, 'github-output.json');

    const result = runBootstrap([
      '--tracker=github',
      '--input=tests/fixtures/tracker-seeds/github-todo-issues.json',
      `--output=${outPath}`
    ]);

    expect(result.status).toBe(0);
    const written = await readFile(outPath, 'utf8');
    const output = JSON.parse(written) as {
      tracker: string;
      summary: { total: number; errors: number };
      issues: Array<{ identifier: string; body: string }>;
    };

    expect(output.tracker).toBe('github');
    expect(output.summary.total).toBe(5);
    expect(output.summary.errors).toBe(0);
    expect(output.issues[0].identifier).toBe('todo-sample#1');
    expect(output.issues[0].body.length).toBeGreaterThan(10);
  });

  it('fails strict mode on invalid input diagnostics', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'symphony-bootstrap-invalid-'));
    cleanupPaths.push(tempDir);

    const invalidPath = path.join(tempDir, 'invalid.json');
    await writeFile(
      invalidPath,
      JSON.stringify([
        {
          identifier: '',
          title: 'Missing body field for github'
        }
      ]),
      'utf8'
    );

    const result = runBootstrap([
      '--tracker=github',
      `--input=${invalidPath}`,
      '--strict'
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Validation failed');
    expect(result.stderr).toContain('missing identifier');
    expect(result.stderr).toContain('missing body');
  });
});
