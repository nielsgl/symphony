import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { inspectProjectLayout } from '../../src/runtime/project-layout-inspector';

function makeProject(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-layout-')));
}

function writeProjectFile(projectRoot: string, relativePath: string, body: string): void {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, body, 'utf8');
}

function mkdirProject(projectRoot: string, relativePath: string): void {
  fs.mkdirSync(path.join(projectRoot, relativePath), { recursive: true });
}

function listProjectFiles(projectRoot: string): string[] {
  const entries: string[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      const relativePath = path.relative(projectRoot, fullPath).split(path.sep).join('/');
      entries.push(entry.isDirectory() ? `${relativePath}/` : relativePath);
      if (entry.isDirectory()) {
        visit(fullPath);
      }
    }
  };

  visit(projectRoot);
  return entries.sort();
}

function warningCodes(projectRoot: string): string[] {
  return inspectProjectLayout(projectRoot).warnings.map((warning) => warning.code).sort();
}

describe('project layout inspector', () => {
  it('reports an empty project without mutating files', () => {
    const projectRoot = makeProject();
    const before = listProjectFiles(projectRoot);

    const result = inspectProjectLayout(projectRoot);

    expect(result.status).toBe('warning');
    expect(result.projectRoot).toBe(projectRoot);
    expect(result.workflow).toEqual({
      path: 'WORKFLOW.md',
      exists: false,
      canonical: true,
      remediation: 'Create WORKFLOW.md at the project root.'
    });
    expect(result.projectContractPaths).toEqual([
      {
        path: 'WORKFLOW.md',
        owner: 'project-contract',
        role: 'canonical committed runtime contract',
        status: 'missing',
        exists: false,
        remediation: 'Create WORKFLOW.md at the project root.'
      }
    ]);
    expect(result.runtimeStateRoot).toEqual({
      path: '.symphony/system',
      owner: 'runtime-state'
    });
    expect(result.ignoreAnalysis.status).toBe('missing');
    expect(result.runtimeOwnedPaths.map((item) => item.path)).toEqual([
      '.symphony/system',
      '.symphony/system/workspaces',
      '.symphony/system/logs',
      '.symphony/system/runtime.sqlite'
    ]);
    expect(warningCodes(projectRoot)).toEqual(['system_ignore_missing', 'workflow_missing']);
    expect(listProjectFiles(projectRoot)).toEqual(before);
  });

  it('reports root WORKFLOW.md as the canonical committed runtime contract', () => {
    const projectRoot = makeProject();
    writeProjectFile(projectRoot, 'WORKFLOW.md', '# workflow\n');
    writeProjectFile(projectRoot, '.gitignore', '.symphony/system/\n');

    const result = inspectProjectLayout(projectRoot);

    expect(result.status).toBe('ok');
    expect(result.workflow).toEqual({
      path: 'WORKFLOW.md',
      exists: true,
      canonical: true,
      remediation: undefined
    });
    expect(result.projectContractPaths).toEqual([
      {
        path: 'WORKFLOW.md',
        owner: 'project-contract',
        role: 'canonical committed runtime contract',
        status: 'present',
        exists: true,
        remediation: undefined
      }
    ]);
    expect(result.ignoreAnalysis.status).toBe('narrow-system');
    expect(result.ignoreAnalysis.hasNarrowSystemIgnore).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('detects broad .symphony ignore rules separately from narrow system ignores', () => {
    const projectRoot = makeProject();
    writeProjectFile(projectRoot, 'WORKFLOW.md', '# workflow\n');
    writeProjectFile(projectRoot, '.gitignore', '.symphony/\n');

    const result = inspectProjectLayout(projectRoot);

    expect(result.ignoreAnalysis.status).toBe('broad-symphony');
    expect(result.ignoreAnalysis.hasBroadSymphonyIgnore).toBe(true);
    expect(result.ignoreAnalysis.hasNarrowSystemIgnore).toBe(false);
    expect(result.warnings.map((warning) => warning.code).sort()).toEqual([
      'broad_symphony_ignore',
      'system_ignore_missing'
    ]);
    expect(result.warnings.find((warning) => warning.code === 'broad_symphony_ignore')).toMatchObject({
      path: '.symphony',
      remediation: 'Replace the broad ignore with .symphony/system/.'
    });
  });

  it('accepts narrow .symphony/system ignores without broad warnings', () => {
    const projectRoot = makeProject();
    writeProjectFile(projectRoot, 'WORKFLOW.md', '# workflow\n');
    writeProjectFile(projectRoot, '.gitignore', '/.symphony/system/**\n');

    const result = inspectProjectLayout(projectRoot);

    expect(result.status).toBe('ok');
    expect(result.ignoreAnalysis).toMatchObject({
      status: 'narrow-system',
      hasNarrowSystemIgnore: true,
      hasBroadSymphonyIgnore: false,
      hasLegacyRuntimeIgnore: false
    });
  });

  it('detects legacy runtime state paths when present', () => {
    const projectRoot = makeProject();
    writeProjectFile(projectRoot, 'WORKFLOW.md', '# workflow\n');
    writeProjectFile(projectRoot, '.gitignore', '.symphony/system/\n');
    mkdirProject(projectRoot, '.symphony/workspaces');
    mkdirProject(projectRoot, '.symphony/log');
    writeProjectFile(projectRoot, '.symphony/runtime.sqlite', 'sqlite\n');
    writeProjectFile(projectRoot, '.symphony/runtime.sqlite-wal', 'wal\n');
    writeProjectFile(projectRoot, '.symphony/state.db', 'state\n');

    const result = inspectProjectLayout(projectRoot);

    expect(result.legacyRuntimePaths.map((item) => item.path).sort()).toEqual([
      '.symphony/log',
      '.symphony/runtime.sqlite',
      '.symphony/runtime.sqlite-wal',
      '.symphony/state.db',
      '.symphony/workspaces'
    ]);
    expect(result.legacyRuntimePaths.every((item) => item.owner === 'legacy-runtime')).toBe(true);
    expect(result.warnings.filter((warning) => warning.code === 'legacy_runtime_path_present')).toHaveLength(5);
  });

  it('reserves customization directories without enabling runtime loading', () => {
    const projectRoot = makeProject();
    writeProjectFile(projectRoot, 'WORKFLOW.md', '# workflow\n');
    writeProjectFile(projectRoot, '.gitignore', '.symphony/system/\n');
    mkdirProject(projectRoot, '.symphony/skills');
    mkdirProject(projectRoot, '.symphony/prompts');

    const result = inspectProjectLayout(projectRoot);

    expect(result.reservedCustomizationPaths).toEqual([
      expect.objectContaining({
        path: '.symphony/skills',
        owner: 'project-customization',
        status: 'reserved',
        exists: true,
        loadedByRuntime: false
      }),
      expect.objectContaining({
        path: '.symphony/prompts',
        owner: 'project-customization',
        status: 'reserved',
        exists: true,
        loadedByRuntime: false
      })
    ]);
    expect(result.status).toBe('ok');
  });

  it('reports mixed legacy ignore patterns with machine-readable remediation', () => {
    const projectRoot = makeProject();
    writeProjectFile(projectRoot, 'WORKFLOW.md', '# workflow\n');
    writeProjectFile(
      projectRoot,
      '.gitignore',
      [
        '# legacy runtime state',
        '.symphony/workspaces/',
        '.symphony/runtime.sqlite',
        '.symphony/runtime.sqlite-*',
        '.symphony/system/'
      ].join('\n')
    );

    const result = inspectProjectLayout(projectRoot);

    expect(result.ignoreAnalysis.status).toBe('mixed-legacy');
    expect(result.ignoreAnalysis.hasNarrowSystemIgnore).toBe(true);
    expect(result.ignoreAnalysis.hasLegacyRuntimeIgnore).toBe(true);
    expect(result.ignoreAnalysis.patterns.filter((pattern) => pattern.kind === 'legacy-runtime')).toHaveLength(3);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'legacy_runtime_ignore',
        path: '.gitignore',
        remediation: 'Replace legacy .symphony runtime ignore rules with .symphony/system/.'
      })
    ]);
  });

  it('does not create, move, or delete project files while inspecting a populated layout', () => {
    const projectRoot = makeProject();
    writeProjectFile(projectRoot, 'WORKFLOW.md', '# workflow\n');
    writeProjectFile(projectRoot, '.gitignore', '.symphony/\n');
    writeProjectFile(projectRoot, '.symphony/runtime.sqlite-shm', 'shm\n');
    mkdirProject(projectRoot, '.symphony/skills');
    const before = listProjectFiles(projectRoot);

    inspectProjectLayout(projectRoot);

    expect(listProjectFiles(projectRoot)).toEqual(before);
  });

  it('reports a file at .symphony as structured invalid layout state', () => {
    const projectRoot = makeProject();
    writeProjectFile(projectRoot, 'WORKFLOW.md', '# workflow\n');
    writeProjectFile(projectRoot, '.gitignore', '.symphony/system/\n');
    writeProjectFile(projectRoot, '.symphony', 'not a directory\n');
    const before = listProjectFiles(projectRoot);

    const result = inspectProjectLayout(projectRoot);

    expect(result.status).toBe('warning');
    expect(result.legacyRuntimePaths).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'invalid_layout_path',
        path: '.symphony',
        remediation:
          'Move or remove the invalid .symphony path so runtime-owned state can live under .symphony/system/.'
      })
    ]);
    expect(listProjectFiles(projectRoot)).toEqual(before);
  });

  it('reports a directory at .gitignore as structured unreadable ignore state', () => {
    const projectRoot = makeProject();
    writeProjectFile(projectRoot, 'WORKFLOW.md', '# workflow\n');
    mkdirProject(projectRoot, '.gitignore');
    const before = listProjectFiles(projectRoot);

    const result = inspectProjectLayout(projectRoot);

    expect(result.status).toBe('warning');
    expect(result.ignoreAnalysis).toMatchObject({
      path: '.gitignore',
      exists: true,
      status: 'unreadable',
      patterns: [],
      hasNarrowSystemIgnore: false,
      hasBroadSymphonyIgnore: false,
      hasLegacyRuntimeIgnore: false,
      remediation: 'Replace .gitignore with a readable file that includes .symphony/system/.'
    });
    expect(result.warnings.map((warning) => warning.code).sort()).toEqual([
      'gitignore_unreadable',
      'system_ignore_missing'
    ]);
    expect(result.warnings.find((warning) => warning.code === 'gitignore_unreadable')).toMatchObject({
      path: '.gitignore',
      remediation: 'Replace .gitignore with a readable file that includes .symphony/system/.'
    });
    expect(listProjectFiles(projectRoot)).toEqual(before);
  });

  (process.platform === 'win32' ? it.skip : it)(
    'reports an unreadable .symphony directory as structured invalid layout state',
    () => {
      const projectRoot = makeProject();
      writeProjectFile(projectRoot, 'WORKFLOW.md', '# workflow\n');
      writeProjectFile(projectRoot, '.gitignore', '.symphony/system/\n');
      mkdirProject(projectRoot, '.symphony');
      const symphonyRoot = path.join(projectRoot, '.symphony');
      const before = listProjectFiles(projectRoot);

      let result: ReturnType<typeof inspectProjectLayout>;
      fs.chmodSync(symphonyRoot, 0o000);
      try {
        result = inspectProjectLayout(projectRoot);
      } finally {
        fs.chmodSync(symphonyRoot, 0o700);
      }

      expect(result.status).toBe('warning');
      expect(result.legacyRuntimePaths).toEqual([]);
      expect(result.warnings).toEqual([
        expect.objectContaining({
          code: 'invalid_layout_path',
          path: '.symphony',
          message: '.symphony exists but could not be scanned.',
          remediation:
            'Make .symphony readable so legacy runtime state can be inspected and moved under .symphony/system/.'
        })
      ]);
      expect(listProjectFiles(projectRoot)).toEqual(before);
    }
  );
});
