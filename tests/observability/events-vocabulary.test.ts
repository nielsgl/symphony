import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CANONICAL_EVENT, EVENT_VOCABULARY_VERSION } from '../../src/observability/events';

function flattenCanonicalEvents(value: unknown): string[] {
  if (!value || typeof value !== 'object') {
    return [];
  }

  const output: string[] = [];
  for (const nested of Object.values(value as Record<string, unknown>)) {
    if (typeof nested === 'string') {
      output.push(nested);
      continue;
    }
    output.push(...flattenCanonicalEvents(nested));
  }

  return output;
}

function findRawEventLiterals(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const offenders: string[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    if (!line.includes('event:')) {
      continue;
    }
    if (!/\bevent:\s*'[^']+'/.test(line)) {
      continue;
    }
    if (line.includes('once(event:')) {
      continue;
    }
    if (line.includes('onFatal: (event:')) {
      continue;
    }
    offenders.push(line.trim());
  }

  return offenders;
}

describe('canonical event vocabulary', () => {
  it('is explicitly versioned and has unique canonical names', () => {
    expect(EVENT_VOCABULARY_VERSION).toBe('v2');

    const names = flattenCanonicalEvents(CANONICAL_EVENT);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  it('does not use ad-hoc event string literals in covered emitters', () => {
    const root = process.cwd();
    const coveredFiles = [
      'src/workflow/watcher.ts',
      'src/orchestrator/core.ts',
      'src/orchestrator/local-runner-bridge.ts',
      'src/runtime/bootstrap.ts',
      'src/runtime/cli-runner.ts',
      'src/api/server.ts'
    ].map((file) => path.join(root, file));

    const offenders = coveredFiles.flatMap((filePath) => findRawEventLiterals(filePath).map((line) => `${filePath}: ${line}`));
    expect(offenders).toEqual([]);
  });
});
