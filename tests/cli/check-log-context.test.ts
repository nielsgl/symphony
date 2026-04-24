import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = path.resolve(__dirname, '../../scripts/check-log-context.js');

async function makeScratchRepo(sourceContent: string): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-log-context-'));
  await fs.mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, 'src', 'sample.ts'), sourceContent, 'utf8');
  return repoRoot;
}

describe('check-log-context script', () => {
  const scratchDirs: string[] = [];

  afterEach(async () => {
    while (scratchDirs.length > 0) {
      const dir = scratchDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('passes when logging context only uses canonical keys', async () => {
    const repoRoot = await makeScratchRepo(`
      const logger = { log: (_entry: unknown) => undefined };
      logger.log({
        level: 'info',
        event: 'runtime.started',
        message: 'ok',
        context: {
          issue_identifier: 'ABC-1',
          session_id: 'thread-1-turn-1'
        }
      });
    `);
    scratchDirs.push(repoRoot);

    const result = spawnSync('node', [SCRIPT_PATH], {
      cwd: repoRoot,
      encoding: 'utf8'
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Log context check passed');
  });

  it('fails with precise file and line diagnostics for identifier key', async () => {
    const repoRoot = await makeScratchRepo(`
      const logger = { log: (_entry: unknown) => undefined };
      logger.log({
        level: 'warn',
        event: 'orchestration.dispatch.spawn.failed',
        message: 'bad context key',
        context: {
          issue_identifier: 'ABC-1',
          meta: {
            identifier: 'ABC-1'
          }
        }
      });
    `);
    scratchDirs.push(repoRoot);

    const result = spawnSync('node', [SCRIPT_PATH], {
      cwd: repoRoot,
      encoding: 'utf8'
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Log context check failed');
    expect(result.stderr).toMatch(/src\/sample\.ts:\d+:\d+: identifier/);
  });
});
