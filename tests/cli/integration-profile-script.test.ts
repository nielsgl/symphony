import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

const cleanupPaths: string[] = [];

function runProfile(env: NodeJS.ProcessEnv, options: { forceDryRun?: boolean } = {}) {
  const scriptPath = path.resolve(process.cwd(), 'scripts/validate-real-integration-profile.js');
  const dryRunEnv = options.forceDryRun === false ? {} : { SYMPHONY_P9B_DRY_RUN: '1' };

  return spawnSync(process.execPath, [scriptPath], {
    env: {
      ...process.env,
      ...env,
      ...dryRunEnv
    },
    encoding: 'utf8',
    timeout: 60000
  });
}

function runProfileAsync(env: NodeJS.ProcessEnv, options: { forceDryRun?: boolean } = {}) {
  const scriptPath = path.resolve(process.cwd(), 'scripts/validate-real-integration-profile.js');
  const dryRunEnv = options.forceDryRun === false ? {} : { SYMPHONY_P9B_DRY_RUN: '1' };

  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        ...env,
        ...dryRunEnv
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('integration profile async run timed out'));
    }, 60000);

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map(async (targetPath) => {
      await rm(targetPath, { recursive: true, force: true });
    })
  );
});

describe('P9b integration profile script', () => {
  it('reports SKIPPED when LINEAR_API_KEY is missing and strict mode is disabled', () => {
    const result = runProfile({
      LINEAR_API_KEY: '',
      SYMPHONY_REAL_INTEGRATION_REQUIRED: '0'
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('P9B_EVIDENCE_REAL_TRACKER=SKIPPED_MISSING_LINEAR_API_KEY');
    expect(result.stdout).toContain('P9B_PROFILE_RESULT=SKIPPED');
  });

  it('fails when LINEAR_API_KEY is missing and strict mode is enabled', async () => {
    const npmShimDir = await mkdtemp(path.join(os.tmpdir(), 'symphony-p9b-npm-shim-'));
    cleanupPaths.push(npmShimDir);

    const npmShimPath = path.join(npmShimDir, 'npm');
    await writeFile(
      npmShimPath,
      '#!/usr/bin/env sh\nexit 0\n',
      { mode: 0o755 }
    );

    const result = runProfile(
      {
        LINEAR_API_KEY: '',
        SYMPHONY_REAL_INTEGRATION_REQUIRED: '1',
        PATH: `${npmShimDir}:${process.env.PATH || ''}`
      },
      { forceDryRun: false }
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('P9B_EVIDENCE_REAL_TRACKER=FAIL_MISSING_LINEAR_API_KEY');
    expect(result.stdout).toContain('P9B_PROFILE_RESULT=FAIL');
  });

  it('reports PASS in dry-run mode when LINEAR_API_KEY is present', () => {
    const result = runProfile({
      LINEAR_API_KEY: 'test-token',
      SYMPHONY_REAL_INTEGRATION_REQUIRED: '0'
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('P9B_EVIDENCE_REAL_TRACKER=PASS_DRY_RUN_WITH_KEY');
    expect(result.stdout).toContain('P9B_PROFILE_RESULT=PASS');
  });

  it('fails when required mode is combined with dry-run', () => {
    const result = runProfile({
      LINEAR_API_KEY: 'test-token',
      SYMPHONY_REAL_INTEGRATION_REQUIRED: '1'
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('P9B_EVIDENCE_REQUIRED_MODE=FAIL_DRY_RUN_NOT_ALLOWED');
    expect(result.stdout).toContain('P9B_PROFILE_RESULT=FAIL');
  });

  it('[SPEC-17.8-1][SPEC-18.3-1] runs live required mode with operational checks and tracker smoke markers', async () => {
    const npmShimDir = await mkdtemp(path.join(os.tmpdir(), 'symphony-p9b-npm-shim-'));
    cleanupPaths.push(npmShimDir);

    const npmShimPath = path.join(npmShimDir, 'npm');
    await writeFile(
      npmShimPath,
      '#!/usr/bin/env sh\nexit 0\n',
      { mode: 0o755 }
    );

    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        res.writeHead(200, {
          'content-type': 'application/json',
          connection: 'close'
        });
        res.end(JSON.stringify({ data: { viewer: { id: 'viewer-123' } } }));
        return;
      }

      res.writeHead(405, { connection: 'close' });
      res.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('mock server did not provide a TCP address');
    }

    const result = await runProfileAsync(
      {
        LINEAR_API_KEY: 'test-token',
        SYMPHONY_REAL_INTEGRATION_REQUIRED: '1',
        PATH: `${npmShimDir}:${process.env.PATH || ''}`,
        LINEAR_ENDPOINT: `http://127.0.0.1:${address.port}/graphql`
      },
      { forceDryRun: false }
    );

    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('P9B_MODE=LIVE');
    expect(result.stdout).toContain('P9B_EVIDENCE_OPERATIONAL_CHECKS=PASS');
    expect(result.stdout).toContain('P9B_EVIDENCE_REAL_TRACKER=PASS');
    expect(result.stdout).toContain('P9B_PROFILE_RESULT=PASS');
    expect(result.stdout).toContain('P9B_COMMAND=npm test -- --run tests/cli/cli-args.test.ts');
    expect(result.stdout).toContain('P9B_COMMAND=npm test -- --run tests/workspace/workspace-manager.test.ts');
    expect(result.stdout).toContain(
      'P9B_COMMAND=npm test -- --run tests/runtime/bootstrap.test.ts tests/api/server.test.ts'
    );
  });
});
