import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const backlogHygiene = require('../../scripts/backlog-hygiene-report.js') as {
  ERROR_CODE: string;
  parseArgs: (argv: string[]) => {
    format: string;
    projectSlug?: string;
    teamKey?: string;
    staleDays: number;
    now?: string;
    input: string | null;
  };
  buildStaleReport: (
    issues: unknown[],
    options: { now: string; staleDays?: number }
  ) => Array<{
    id: string;
    title: string;
    status: string;
    priority: number | null;
    days_since_update: number;
    recommended_action: 'close' | 're-scope' | 'prioritize' | 'defer';
  }>;
  formatTable: (report: unknown[]) => string;
};

function runScript(args: string[], cwd: string) {
  return spawnSync(process.execPath, ['scripts/backlog-hygiene-report.js', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      LINEAR_API_KEY: ''
    }
  });
}

describe('backlog hygiene report', () => {
  it('parses report CLI options', () => {
    const parsed = backlogHygiene.parseArgs([
      '--format=json',
      '--project-slug=symphony',
      '--team-key=NIE',
      '--stale-days=45',
      '--now=2026-05-05T00:00:00.000Z',
      '--input=issues.json'
    ]);

    expect(parsed.format).toBe('json');
    expect(parsed.projectSlug).toBe('symphony');
    expect(parsed.teamKey).toBe('NIE');
    expect(parsed.staleDays).toBe(45);
    expect(parsed.now).toBe('2026-05-05T00:00:00.000Z');
    expect(parsed.input).toBe('issues.json');
  });

  it('selects only stale backlog and todo issues with the fixed schema', () => {
    const report = backlogHygiene.buildStaleReport(
      [
        {
          identifier: 'NIE-1',
          title: 'Old backlog',
          priority: 3,
          updatedAt: '2026-03-01T00:00:00.000Z',
          state: { name: 'Backlog' }
        },
        {
          identifier: 'NIE-2',
          title: 'Old todo',
          priority: 2,
          updatedAt: '2026-03-20T00:00:00.000Z',
          state: { name: 'Todo' }
        },
        {
          identifier: 'NIE-3',
          title: 'Fresh todo',
          priority: 4,
          updatedAt: '2026-04-20T00:00:00.000Z',
          state: { name: 'Todo' }
        },
        {
          identifier: 'NIE-4',
          title: 'Completed stale',
          priority: 2,
          updatedAt: '2026-03-01T00:00:00.000Z',
          completedAt: '2026-03-02T00:00:00.000Z',
          state: { name: 'Todo' }
        },
        {
          identifier: 'NIE-5',
          title: 'In progress stale',
          priority: 1,
          updatedAt: '2026-03-01T00:00:00.000Z',
          state: { name: 'In Progress' }
        }
      ],
      { now: '2026-05-05T00:00:00.000Z' }
    );

    expect(report).toEqual([
      {
        id: 'NIE-1',
        title: 'Old backlog',
        status: 'Backlog',
        priority: 3,
        days_since_update: 65,
        recommended_action: 'defer'
      },
      {
        id: 'NIE-2',
        title: 'Old todo',
        status: 'Todo',
        priority: 2,
        days_since_update: 46,
        recommended_action: 'prioritize'
      }
    ]);
    expect(Object.keys(report[0])).toEqual([
      'id',
      'title',
      'status',
      'priority',
      'days_since_update',
      'recommended_action'
    ]);
  });

  it('emits JSON and compact table forms from an input fixture', () => {
    const root = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-backlog-hygiene-'));
    fs.mkdirSync(path.join(tempRoot, 'scripts'), { recursive: true });
    fs.copyFileSync(
      path.join(root, 'scripts/backlog-hygiene-report.js'),
      path.join(tempRoot, 'scripts/backlog-hygiene-report.js')
    );
    fs.writeFileSync(
      path.join(tempRoot, 'issues.json'),
      JSON.stringify([
        {
          identifier: 'NIE-1',
          title: 'Old todo',
          priority: 4,
          updatedAt: '2026-03-01T00:00:00.000Z',
          state: { name: 'Todo' }
        }
      ]),
      'utf8'
    );

    const json = runScript(['--format=json', '--input=issues.json', '--now=2026-05-05T00:00:00.000Z'], tempRoot);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual([
      {
        id: 'NIE-1',
        title: 'Old todo',
        status: 'Todo',
        priority: 4,
        days_since_update: 65,
        recommended_action: 're-scope'
      }
    ]);

    const table = runScript(['--format=table', '--input=issues.json', '--now=2026-05-05T00:00:00.000Z'], tempRoot);
    expect(table.status).toBe(0);
    expect(table.stdout).toContain('ID');
    expect(table.stdout).toContain('NIE-1');
    expect(table.stdout).toContain('re-scope');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('reports typed generation failures', () => {
    const result = runScript(['--format=xml'], process.cwd());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(backlogHygiene.ERROR_CODE);
  });
});
