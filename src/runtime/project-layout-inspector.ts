import fs from 'node:fs';
import path from 'node:path';

export type ProjectLayoutStatus = 'ok' | 'warning';
export type ProjectLayoutOwner = 'project-contract' | 'runtime-state' | 'project-customization' | 'legacy-runtime';
export type ProjectLayoutPathStatus = 'present' | 'missing' | 'reserved' | 'legacy-present';
export type ProjectLayoutWarningCode =
  | 'workflow_missing'
  | 'system_ignore_missing'
  | 'broad_symphony_ignore'
  | 'legacy_runtime_ignore'
  | 'legacy_runtime_path_present'
  | 'invalid_layout_path'
  | 'gitignore_unreadable';

export interface ProjectLayoutWarning {
  code: ProjectLayoutWarningCode;
  path: string;
  message: string;
  remediation: string;
}

export interface ProjectLayoutPathClassification {
  path: string;
  owner: ProjectLayoutOwner;
  role: string;
  status: ProjectLayoutPathStatus;
  exists: boolean;
  remediation?: string;
}

export type ProjectLayoutIgnorePatternKind = 'narrow-system' | 'broad-symphony' | 'legacy-runtime' | 'other';
export type ProjectLayoutIgnoreStatus =
  | 'missing'
  | 'narrow-system'
  | 'broad-symphony'
  | 'mixed-legacy'
  | 'unclassified'
  | 'unreadable';

export interface ProjectLayoutIgnorePattern {
  line: number;
  pattern: string;
  negated: boolean;
  kind: ProjectLayoutIgnorePatternKind;
}

export interface ProjectLayoutIgnoreAnalysis {
  path: '.gitignore';
  exists: boolean;
  status: ProjectLayoutIgnoreStatus;
  patterns: ProjectLayoutIgnorePattern[];
  hasNarrowSystemIgnore: boolean;
  hasBroadSymphonyIgnore: boolean;
  hasLegacyRuntimeIgnore: boolean;
  remediation: string;
  warnings: ProjectLayoutWarning[];
}

export interface ProjectLayoutInspection {
  status: ProjectLayoutStatus;
  projectRoot: string;
  workflow: {
    path: 'WORKFLOW.md';
    exists: boolean;
    canonical: true;
    remediation?: string;
  };
  projectContractPaths: ProjectLayoutPathClassification[];
  runtimeStateRoot: {
    path: '.symphony/system';
    owner: 'runtime-state';
  };
  runtimeOwnedPaths: ProjectLayoutPathClassification[];
  reservedCustomizationPaths: Array<
    ProjectLayoutPathClassification & {
      owner: 'project-customization';
      loadedByRuntime: false;
    }
  >;
  legacyRuntimePaths: ProjectLayoutPathClassification[];
  ignoreAnalysis: ProjectLayoutIgnoreAnalysis;
  warnings: ProjectLayoutWarning[];
}

export interface ProjectLayoutGitignoreFixResult {
  status: 'applied' | 'skipped' | 'failed';
  summary: string;
  details?: Record<string, unknown>;
}

const WORKFLOW_PATH = 'WORKFLOW.md' as const;
const RUNTIME_STATE_ROOT = '.symphony/system' as const;
const GITIGNORE_PATH = '.gitignore' as const;

const RUNTIME_PATHS: Array<{ path: string; role: string }> = [
  { path: RUNTIME_STATE_ROOT, role: 'runtime state root' },
  { path: '.symphony/system/workspaces', role: 'runtime workspaces' },
  { path: '.symphony/system/logs', role: 'runtime logs' },
  { path: '.symphony/system/runtime.sqlite', role: 'runtime persistence' }
];

const RESERVED_CUSTOMIZATION_PATHS: Array<{ path: string; role: string }> = [
  { path: '.symphony/skills', role: 'reserved project-owned skills customization' },
  { path: '.symphony/prompts', role: 'reserved project-owned prompt customization' }
];

const LEGACY_RUNTIME_PATHS: Array<{ path: string; role: string }> = [
  { path: '.symphony/workspaces', role: 'legacy runtime workspaces' },
  { path: '.symphony/log', role: 'legacy runtime logs' },
  { path: '.symphony/logs', role: 'legacy runtime logs' },
  { path: '.symphony/runtime.sqlite', role: 'legacy runtime persistence' },
  { path: '.symphony/state.db', role: 'legacy runtime state database' }
];

function exists(projectRoot: string, relativePath: string): boolean {
  return fs.existsSync(path.join(projectRoot, relativePath));
}

function safeStat(fullPath: string): fs.Stats | null {
  try {
    return fs.statSync(fullPath);
  } catch {
    return null;
  }
}

function normalizeProjectPattern(pattern: string): string {
  let normalized = pattern.trim();
  if (normalized.startsWith('/')) {
    normalized = normalized.slice(1);
  }
  while (normalized.endsWith('/') && normalized.length > 1) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function stripInlineComment(line: string): string {
  const marker = line.indexOf(' #');
  return marker === -1 ? line : line.slice(0, marker);
}

function classifyIgnorePattern(pattern: string): ProjectLayoutIgnorePatternKind {
  const normalized = normalizeProjectPattern(pattern);

  if (normalized === '.symphony' || normalized === '.symphony/*' || normalized === '.symphony/**') {
    return 'broad-symphony';
  }

  if (
    normalized === '.symphony/system' ||
    normalized === '.symphony/system/*' ||
    normalized === '.symphony/system/**'
  ) {
    return 'narrow-system';
  }

  if (
    normalized === '.symphony/workspaces' ||
    normalized === '.symphony/workspaces/*' ||
    normalized === '.symphony/workspaces/**' ||
    normalized === '.symphony/log' ||
    normalized === '.symphony/log/*' ||
    normalized === '.symphony/log/**' ||
    normalized === '.symphony/logs' ||
    normalized === '.symphony/logs/*' ||
    normalized === '.symphony/logs/**' ||
    normalized === '.symphony/runtime.sqlite' ||
    normalized === '.symphony/runtime.sqlite.bak-*' ||
    normalized === '.symphony/runtime.sqlite-*' ||
    normalized === '.symphony/state.db'
  ) {
    return 'legacy-runtime';
  }

  return 'other';
}

function analyzeGitignore(projectRoot: string): ProjectLayoutIgnoreAnalysis {
  const gitignorePath = path.join(projectRoot, GITIGNORE_PATH);
  if (!fs.existsSync(gitignorePath)) {
    return {
      path: GITIGNORE_PATH,
      exists: false,
      status: 'missing',
      patterns: [],
      hasNarrowSystemIgnore: false,
      hasBroadSymphonyIgnore: false,
      hasLegacyRuntimeIgnore: false,
      remediation: 'Add .symphony/system/ to .gitignore so runtime-owned local state stays uncommitted.',
      warnings: []
    };
  }

  const gitignoreStat = safeStat(gitignorePath);
  if (!gitignoreStat?.isFile()) {
    return {
      path: GITIGNORE_PATH,
      exists: true,
      status: 'unreadable',
      patterns: [],
      hasNarrowSystemIgnore: false,
      hasBroadSymphonyIgnore: false,
      hasLegacyRuntimeIgnore: false,
      remediation: 'Replace .gitignore with a readable file that includes .symphony/system/.',
      warnings: [
        {
          code: 'gitignore_unreadable',
          path: GITIGNORE_PATH,
          message: '.gitignore exists but is not a readable file.',
          remediation: 'Replace .gitignore with a readable file that includes .symphony/system/.'
        }
      ]
    };
  }

  let body: string;
  try {
    body = fs.readFileSync(gitignorePath, 'utf8');
  } catch {
    return {
      path: GITIGNORE_PATH,
      exists: true,
      status: 'unreadable',
      patterns: [],
      hasNarrowSystemIgnore: false,
      hasBroadSymphonyIgnore: false,
      hasLegacyRuntimeIgnore: false,
      remediation: 'Make .gitignore readable and include .symphony/system/.',
      warnings: [
        {
          code: 'gitignore_unreadable',
          path: GITIGNORE_PATH,
          message: '.gitignore exists but could not be read.',
          remediation: 'Make .gitignore readable and include .symphony/system/.'
        }
      ]
    };
  }

  const patterns = body
    .split(/\r?\n/)
    .map((rawLine, index) => {
      const trimmed = stripInlineComment(rawLine).trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) {
        return null;
      }

      const negated = trimmed.startsWith('!');
      const pattern = negated ? trimmed.slice(1).trim() : trimmed;
      return {
        line: index + 1,
        pattern,
        negated,
        kind: classifyIgnorePattern(pattern)
      } satisfies ProjectLayoutIgnorePattern;
    })
    .filter((pattern): pattern is ProjectLayoutIgnorePattern => pattern !== null);

  const activePatterns = patterns.filter((pattern) => !pattern.negated);
  const hasNarrowSystemIgnore = activePatterns.some((pattern) => pattern.kind === 'narrow-system');
  const hasBroadSymphonyIgnore = activePatterns.some((pattern) => pattern.kind === 'broad-symphony');
  const hasLegacyRuntimeIgnore = activePatterns.some((pattern) => pattern.kind === 'legacy-runtime');
  const status: ProjectLayoutIgnoreStatus = hasLegacyRuntimeIgnore
    ? 'mixed-legacy'
    : hasBroadSymphonyIgnore
      ? 'broad-symphony'
      : hasNarrowSystemIgnore
        ? 'narrow-system'
        : 'unclassified';
  const remediation =
    status === 'narrow-system'
      ? 'No remediation needed; .symphony/system/ is ignored without hiding project-owned customization paths.'
      : status === 'broad-symphony'
        ? 'Replace broad .symphony/ ignores with .symphony/system/ so future project-owned customization paths can be committed.'
        : status === 'mixed-legacy'
          ? 'Replace legacy .symphony runtime ignores with .symphony/system/ and remove stale legacy runtime state.'
          : 'Add .symphony/system/ to .gitignore so runtime-owned local state stays uncommitted.';

  return {
    path: GITIGNORE_PATH,
    exists: true,
    status,
    patterns,
    hasNarrowSystemIgnore,
    hasBroadSymphonyIgnore,
    hasLegacyRuntimeIgnore,
    remediation,
    warnings: []
  };
}

function classifyExpectedRuntimePath(projectRoot: string, item: { path: string; role: string }): ProjectLayoutPathClassification {
  return {
    path: item.path,
    owner: 'runtime-state',
    role: item.role,
    status: exists(projectRoot, item.path) ? 'present' : 'missing',
    exists: exists(projectRoot, item.path),
    remediation: 'Runtime may create this path under .symphony/system/ during local execution.'
  };
}

function classifyReservedPath(
  projectRoot: string,
  item: { path: string; role: string }
): ProjectLayoutPathClassification & { owner: 'project-customization'; loadedByRuntime: false } {
  return {
    path: item.path,
    owner: 'project-customization',
    role: item.role,
    status: 'reserved',
    exists: exists(projectRoot, item.path),
    loadedByRuntime: false,
    remediation: 'Reserved for future committed project customization; runtime loading is intentionally disabled.'
  };
}

interface LegacyRuntimeSidecarScan {
  paths: ProjectLayoutPathClassification[];
  warnings: ProjectLayoutWarning[];
}

function scanLegacyRuntimeSidecars(projectRoot: string): LegacyRuntimeSidecarScan {
  const symphonyRoot = path.join(projectRoot, '.symphony');
  if (!fs.existsSync(symphonyRoot)) {
    return { paths: [], warnings: [] };
  }

  if (!safeStat(symphonyRoot)?.isDirectory()) {
    return { paths: [], warnings: [] };
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(symphonyRoot);
  } catch {
    return {
      paths: [],
      warnings: [
        {
          code: 'invalid_layout_path',
          path: '.symphony',
          message: '.symphony exists but could not be scanned.',
          remediation: 'Make .symphony readable so legacy runtime state can be inspected and moved under .symphony/system/.'
        }
      ]
    };
  }

  return {
    paths: entries
      .filter((entry) => entry.startsWith('runtime.sqlite-') || entry.startsWith('runtime.sqlite.bak-'))
      .sort()
      .map((entry) => ({
        path: `.symphony/${entry}`,
        owner: 'legacy-runtime',
        role: entry.startsWith('runtime.sqlite.bak-')
          ? 'legacy runtime persistence backup'
          : 'legacy runtime persistence sidecar',
        status: 'legacy-present',
        exists: true,
        remediation: 'Move runtime persistence under .symphony/system/ and remove the legacy sidecar after migration.'
      })),
    warnings: []
  };
}

function detectInvalidLayoutPaths(projectRoot: string): ProjectLayoutWarning[] {
  const symphonyRoot = path.join(projectRoot, '.symphony');
  if (!fs.existsSync(symphonyRoot)) {
    return [];
  }

  if (safeStat(symphonyRoot)?.isDirectory()) {
    return [];
  }

  return [
    {
      code: 'invalid_layout_path',
      path: '.symphony',
      message: '.symphony exists but is not a directory.',
      remediation: 'Move or remove the invalid .symphony path so runtime-owned state can live under .symphony/system/.'
    }
  ];
}

function classifyLegacyPath(projectRoot: string, item: { path: string; role: string }): ProjectLayoutPathClassification | null {
  if (!exists(projectRoot, item.path)) {
    return null;
  }

  return {
    path: item.path,
    owner: 'legacy-runtime',
    role: item.role,
    status: 'legacy-present',
    exists: true,
    remediation: 'Move runtime-owned state under .symphony/system/ and remove the legacy path after migration.'
  };
}

export function inspectProjectLayout(projectRoot: string): ProjectLayoutInspection {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const workflowExists = exists(resolvedProjectRoot, WORKFLOW_PATH);
  const projectContractPaths: ProjectLayoutPathClassification[] = [
    {
      path: WORKFLOW_PATH,
      owner: 'project-contract',
      role: 'canonical committed runtime contract',
      status: workflowExists ? 'present' : 'missing',
      exists: workflowExists,
      remediation: workflowExists ? undefined : 'Create WORKFLOW.md at the project root.'
    }
  ];
  const runtimeOwnedPaths = RUNTIME_PATHS.map((item) => classifyExpectedRuntimePath(resolvedProjectRoot, item));
  const reservedCustomizationPaths = RESERVED_CUSTOMIZATION_PATHS.map((item) => classifyReservedPath(resolvedProjectRoot, item));
  const legacySidecarScan = scanLegacyRuntimeSidecars(resolvedProjectRoot);
  const legacyRuntimePaths = [
    ...LEGACY_RUNTIME_PATHS.map((item) => classifyLegacyPath(resolvedProjectRoot, item)).filter(
      (item): item is ProjectLayoutPathClassification => item !== null
    ),
    ...legacySidecarScan.paths
  ];
  const ignoreAnalysis = analyzeGitignore(resolvedProjectRoot);
  const warnings: ProjectLayoutWarning[] = [
    ...ignoreAnalysis.warnings,
    ...detectInvalidLayoutPaths(resolvedProjectRoot),
    ...legacySidecarScan.warnings
  ];

  if (!workflowExists) {
    warnings.push({
      code: 'workflow_missing',
      path: WORKFLOW_PATH,
      message: 'Root WORKFLOW.md is missing.',
      remediation: 'Create WORKFLOW.md at the project root or run from a project that already has one.'
    });
  }

  if (!ignoreAnalysis.hasNarrowSystemIgnore) {
    warnings.push({
      code: 'system_ignore_missing',
      path: RUNTIME_STATE_ROOT,
      message: '.symphony/system/ is not narrowly ignored.',
      remediation: 'Add .symphony/system/ to .gitignore.'
    });
  }

  if (ignoreAnalysis.hasBroadSymphonyIgnore) {
    warnings.push({
      code: 'broad_symphony_ignore',
      path: '.symphony',
      message: 'A broad .symphony/ ignore hides future project-owned customization paths.',
      remediation: 'Replace the broad ignore with .symphony/system/.'
    });
  }

  if (ignoreAnalysis.hasLegacyRuntimeIgnore) {
    warnings.push({
      code: 'legacy_runtime_ignore',
      path: GITIGNORE_PATH,
      message: '.gitignore contains legacy runtime-state patterns.',
      remediation: 'Replace legacy .symphony runtime ignore rules with .symphony/system/.'
    });
  }

  for (const legacyPath of legacyRuntimePaths) {
    warnings.push({
      code: 'legacy_runtime_path_present',
      path: legacyPath.path,
      message: `Legacy runtime state exists at ${legacyPath.path}.`,
      remediation: legacyPath.remediation ?? 'Move runtime state under .symphony/system/.'
    });
  }

  return {
    status: warnings.length === 0 ? 'ok' : 'warning',
    projectRoot: resolvedProjectRoot,
    workflow: {
      path: WORKFLOW_PATH,
      exists: workflowExists,
      canonical: true,
      remediation: workflowExists ? undefined : 'Create WORKFLOW.md at the project root.'
    },
    projectContractPaths,
    runtimeStateRoot: {
      path: RUNTIME_STATE_ROOT,
      owner: 'runtime-state'
    },
    runtimeOwnedPaths,
    reservedCustomizationPaths,
    legacyRuntimePaths,
    ignoreAnalysis,
    warnings
  };
}

export function ensureSystemGitignoreEntry(projectRoot: string): ProjectLayoutGitignoreFixResult {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const inspection = inspectProjectLayout(resolvedProjectRoot);
  const gitignorePath = path.join(resolvedProjectRoot, GITIGNORE_PATH);

  if (inspection.ignoreAnalysis.hasNarrowSystemIgnore) {
    return {
      status: 'skipped',
      summary: '.gitignore already includes .symphony/system/.',
      details: { path: GITIGNORE_PATH }
    };
  }

  if (inspection.ignoreAnalysis.exists) {
    const stat = safeStat(gitignorePath);
    if (!stat?.isFile()) {
      return {
        status: 'failed',
        summary: '.gitignore exists but is not a writable file.',
        details: { path: GITIGNORE_PATH, reason: 'gitignore_not_file' }
      };
    }
  }

  try {
    const current = inspection.ignoreAnalysis.exists ? fs.readFileSync(gitignorePath, 'utf8') : '';
    const prefix = current.length === 0 ? '' : current.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(gitignorePath, `${current}${prefix}.symphony/system/\n`, 'utf8');
    return {
      status: 'applied',
      summary: 'Added .symphony/system/ to .gitignore.',
      details: { path: GITIGNORE_PATH, pattern: '.symphony/system/' }
    };
  } catch (error) {
    return {
      status: 'failed',
      summary: `Could not update .gitignore: ${(error as Error).message}`,
      details: { path: GITIGNORE_PATH, reason: 'write_failed' }
    };
  }
}
