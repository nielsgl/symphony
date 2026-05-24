import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

import { buildProjectIdentity, type ProjectIdentity } from '../persistence';

export type LocalCommandName = 'dashboard' | 'doctor' | 'setup';
export type LocalCommandProfile = 'project' | 'symphony-internal';
export type LocalPathSource = 'cli' | 'env' | 'profile' | 'project';
export type LocalScalarSource = 'cli' | 'env' | 'profile' | 'default';

export interface LocalCommandResolution {
  command: LocalCommandName;
  symphonyCheckoutRoot: string;
  currentProjectRoot: string;
  workflowPath: string;
  envFilePath: string;
  profile: {
    name: LocalCommandProfile;
    source: LocalScalarSource;
  };
  host: {
    host: string;
    source: LocalScalarSource;
  };
  port: {
    port: number;
    source: LocalScalarSource;
  };
  projectIdentity: ProjectIdentity;
  sources: {
    projectRoot: LocalPathSource;
    workflowPath: LocalPathSource;
    envFilePath: LocalPathSource;
  };
  dashboardArgv: string[];
}

export interface ResolveLocalCommandOptions {
  command: LocalCommandName;
  argv: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  symphonyCheckoutRoot: string;
}

export class LocalCommandResolutionError extends Error {
  readonly code:
    | 'ambiguous_project_root'
    | 'invalid_port'
    | 'invalid_profile'
    | 'missing_flag_value'
    | 'missing_project_root'
    | 'missing_workflow'
    | 'unreadable_workflow';

  constructor(code: LocalCommandResolutionError['code'], message: string) {
    super(message);
    this.name = 'LocalCommandResolutionError';
    this.code = code;
  }
}

interface FlagRead {
  value: string | undefined;
  present: boolean;
}

interface ReadFlagValueOptions {
  allowSingleDashValue?: boolean;
}

const FLAGS_WITH_VALUE = new Set(['--workflow', '--port', '--host', '--logs-root', '--profile', '--env-file']);
const RESOLVER_MANAGED_FLAGS = new Set(['--workflow', '--port', '--host', '--profile', '--env-file']);

function readFlagValue(argv: readonly string[], flag: string, options: ReadFlagValueOptions = {}): FlagRead {
  const equalsPrefix = `${flag}=`;
  const equalsForm = argv.find((arg) => arg.startsWith(equalsPrefix));
  if (equalsForm) {
    return {
      value: equalsForm.slice(equalsPrefix.length),
      present: true
    };
  }

  const splitIndex = argv.findIndex((arg) => arg === flag);
  if (splitIndex === -1) {
    return { value: undefined, present: false };
  }

  const splitValue = argv[splitIndex + 1];
  if (
    !splitValue ||
    splitValue.startsWith('--') ||
    (splitValue.startsWith('-') && !options.allowSingleDashValue)
  ) {
    return { value: undefined, present: true };
  }

  return { value: splitValue, present: true };
}

function readRequiredFlagValue(
  argv: readonly string[],
  flag: string,
  label: string,
  options: ReadFlagValueOptions = {}
): FlagRead {
  const flagValue = readFlagValue(argv, flag, options);
  if (flagValue.present && (flagValue.value === undefined || flagValue.value.trim().length === 0)) {
    throw new LocalCommandResolutionError('missing_flag_value', `cli ${label} requires a value`);
  }

  return flagValue;
}

function readPositionalWorkflowPath(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (FLAGS_WITH_VALUE.has(token)) {
      if (index + 1 < argv.length && !argv[index + 1].startsWith('-')) {
        index += 1;
      }
      continue;
    }

    if (!token.startsWith('-')) {
      return token;
    }
  }

  return undefined;
}

function parsePortValue(raw: string | undefined, source: LocalScalarSource): { port: number; source: LocalScalarSource } | null {
  if (raw === undefined) {
    return null;
  }

  if (raw.trim().length === 0) {
    throw new LocalCommandResolutionError('missing_flag_value', `${source} port requires a value`);
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new LocalCommandResolutionError('invalid_port', `${source} port '${raw}' must be a non-negative integer`);
  }

  return { port: value, source };
}

function realpathIfPresent(inputPath: string): string {
  try {
    return fs.realpathSync(inputPath);
  } catch {
    return path.resolve(inputPath);
  }
}

function findProjectWorkflowRoots(cwd: string): string[] {
  const roots: string[] = [];
  let current = path.resolve(cwd);
  for (;;) {
    const workflowPath = path.join(current, 'WORKFLOW.md');
    if (fs.existsSync(workflowPath)) {
      roots.push(current);
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return roots;
}

function assertReadableWorkflow(workflowPath: string): void {
  if (!fs.existsSync(workflowPath)) {
    throw new LocalCommandResolutionError(
      'missing_workflow',
      `Workflow file not found at ${workflowPath}. Pass --workflow <path> or run from a project containing WORKFLOW.md.`
    );
  }

  try {
    fs.accessSync(workflowPath, fs.constants.R_OK);
  } catch {
    throw new LocalCommandResolutionError(
      'unreadable_workflow',
      `Workflow file is not readable at ${workflowPath}. Check file permissions or pass --workflow <path>.`
    );
  }
}

function resolveProfile(argv: readonly string[], env: NodeJS.ProcessEnv): { name: LocalCommandProfile; source: LocalScalarSource } {
  const cliProfile = readRequiredFlagValue(argv, '--profile', 'profile').value;
  const rawProfile = cliProfile ?? env.SYMPHONY_PROFILE;
  const source: LocalScalarSource = cliProfile !== undefined ? 'cli' : rawProfile !== undefined ? 'env' : 'default';
  const normalized = (rawProfile ?? 'project').trim();
  if (normalized === 'project' || normalized === 'symphony-internal') {
    return { name: normalized, source };
  }

  throw new LocalCommandResolutionError(
    'invalid_profile',
    `Unknown Symphony profile '${normalized}'. Supported profiles: project, symphony-internal.`
  );
}

function resolveHost(argv: readonly string[], env: NodeJS.ProcessEnv): { host: string; source: LocalScalarSource } {
  const cliHost = readRequiredFlagValue(argv, '--host', 'host').value;
  if (cliHost !== undefined && cliHost.trim().length > 0) {
    return { host: cliHost.trim(), source: 'cli' };
  }

  if (env.SYMPHONY_HOST && env.SYMPHONY_HOST.trim().length > 0) {
    return { host: env.SYMPHONY_HOST.trim(), source: 'env' };
  }

  return { host: '127.0.0.1', source: 'default' };
}

function resolvePort(argv: readonly string[], env: NodeJS.ProcessEnv): { port: number; source: LocalScalarSource } {
  const portFlag = readFlagValue(argv, '--port', { allowSingleDashValue: true });
  if (portFlag.present && portFlag.value === undefined) {
    throw new LocalCommandResolutionError('missing_flag_value', 'cli port requires a value');
  }

  const cliPort = parsePortValue(portFlag.value, 'cli');
  if (cliPort) {
    return cliPort;
  }

  const envPort = parsePortValue(env.SYMPHONY_PORT, 'env');
  if (envPort) {
    return envPort;
  }

  return { port: 0, source: 'default' };
}

function stripManagedDashboardArgs(argv: readonly string[]): string[] {
  const stripped: string[] = [];
  let positionalWorkflowSkipped = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const equalsFlag = token.startsWith('--') ? token.slice(0, token.indexOf('=') === -1 ? token.length : token.indexOf('=')) : token;
    if (RESOLVER_MANAGED_FLAGS.has(equalsFlag)) {
      if (token === equalsFlag && index + 1 < argv.length && !argv[index + 1].startsWith('-')) {
        index += 1;
      }
      continue;
    }

    if (FLAGS_WITH_VALUE.has(token)) {
      stripped.push(token);
      if (index + 1 < argv.length && !argv[index + 1].startsWith('-')) {
        stripped.push(argv[index + 1]);
        index += 1;
      }
      continue;
    }

    if (!positionalWorkflowSkipped && !token.startsWith('-')) {
      positionalWorkflowSkipped = true;
      continue;
    }

    stripped.push(token);
  }

  return stripped;
}

function resolveInputPath(rawPath: string, baseDir: string): string {
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(baseDir, rawPath);
}

function readEnvFileValues(envFilePath: string): NodeJS.ProcessEnv {
  try {
    return dotenv.parse(fs.readFileSync(envFilePath));
  } catch {
    return {};
  }
}

function resolveProjectRoot(params: {
  cwd: string;
  profile: LocalCommandProfile;
  symphonyCheckoutRoot: string;
  workflowPath?: string;
  workflowPathSource?: LocalPathSource;
}): { projectRoot: string; source: LocalPathSource } {
  if (params.profile === 'symphony-internal') {
    return { projectRoot: params.symphonyCheckoutRoot, source: 'profile' };
  }

  if (params.workflowPath && params.workflowPathSource && params.workflowPathSource !== 'project') {
    return { projectRoot: realpathIfPresent(path.dirname(params.workflowPath)), source: params.workflowPathSource };
  }

  const roots = findProjectWorkflowRoots(params.cwd);
  if (roots.length > 1 && !params.workflowPath) {
    throw new LocalCommandResolutionError(
      'ambiguous_project_root',
      `Multiple ancestor WORKFLOW.md files were found from ${params.cwd}: ${roots.join(', ')}. Pass --workflow <path> to choose one.`
    );
  }

  if (roots.length === 1) {
    return { projectRoot: realpathIfPresent(roots[0]), source: 'project' };
  }

  if (params.workflowPath) {
    return { projectRoot: realpathIfPresent(path.dirname(params.workflowPath)), source: 'cli' };
  }

  throw new LocalCommandResolutionError(
    'missing_project_root',
    `No project root with WORKFLOW.md was found from ${params.cwd}. Run from a Symphony project or pass --workflow <path>.`
  );
}

export function resolveLocalCommand(options: ResolveLocalCommandOptions): LocalCommandResolution {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const symphonyCheckoutRoot = realpathIfPresent(options.symphonyCheckoutRoot);
  const profile = resolveProfile(options.argv, env);

  const positionalWorkflowPath = readPositionalWorkflowPath(options.argv);
  const workflowFlag = readRequiredFlagValue(options.argv, '--workflow', 'workflow').value;
  const explicitWorkflowPath = positionalWorkflowPath ?? workflowFlag ?? env.SYMPHONY_WORKFLOW_PATH;
  const explicitWorkflowSource: LocalPathSource =
    positionalWorkflowPath || workflowFlag ? 'cli' : env.SYMPHONY_WORKFLOW_PATH ? 'env' : 'project';

  let workflowPath: string;
  let workflowPathSource: LocalPathSource;

  if (profile.name === 'symphony-internal') {
    workflowPath = path.join(symphonyCheckoutRoot, 'WORKFLOW.md');
    workflowPathSource = 'profile';
  } else if (explicitWorkflowPath) {
    workflowPath = path.isAbsolute(explicitWorkflowPath)
      ? explicitWorkflowPath
      : path.resolve(cwd, explicitWorkflowPath);
    workflowPathSource = explicitWorkflowSource;
  } else {
    const roots = findProjectWorkflowRoots(cwd);
    if (roots.length > 1) {
      throw new LocalCommandResolutionError(
        'ambiguous_project_root',
        `Multiple ancestor WORKFLOW.md files were found from ${cwd}: ${roots.join(', ')}. Pass --workflow <path> to choose one.`
      );
    }
    if (roots.length === 0) {
      throw new LocalCommandResolutionError(
        'missing_workflow',
        `No WORKFLOW.md was found from ${cwd}. Run from a Symphony project or pass --workflow <path>.`
      );
    }
    workflowPath = path.join(roots[0], 'WORKFLOW.md');
    workflowPathSource = 'project';
  }

  workflowPath = realpathIfPresent(workflowPath);
  assertReadableWorkflow(workflowPath);

  const project = resolveProjectRoot({
    cwd,
    profile: profile.name,
    symphonyCheckoutRoot,
    workflowPath,
    workflowPathSource
  });
  const envFileFlag = readRequiredFlagValue(options.argv, '--env-file', 'env file').value;
  const rawEnvFilePath = envFileFlag ?? env.SYMPHONY_ENV_FILE ?? path.join(project.projectRoot, '.env');
  const envFileBase = envFileFlag || env.SYMPHONY_ENV_FILE ? cwd : project.projectRoot;
  const envFilePath = realpathIfPresent(resolveInputPath(rawEnvFilePath, envFileBase));
  const envFilePathSource: LocalPathSource = envFileFlag ? 'cli' : env.SYMPHONY_ENV_FILE ? 'env' : 'project';
  const effectiveEnv = {
    ...readEnvFileValues(envFilePath),
    ...env
  };
  const host = resolveHost(options.argv, effectiveEnv);
  const port = resolvePort(options.argv, effectiveEnv);
  const projectIdentity = buildProjectIdentity({
    projectRoot: project.projectRoot,
    workflowPath
  });
  const dashboardArgv = [
    ...stripManagedDashboardArgs(options.argv),
    `--workflow=${workflowPath}`,
    `--host=${host.host}`,
    `--port=${port.port}`
  ];

  return {
    command: options.command,
    symphonyCheckoutRoot,
    currentProjectRoot: project.projectRoot,
    workflowPath,
    envFilePath,
    profile,
    host,
    port,
    projectIdentity,
    sources: {
      projectRoot: project.source,
      workflowPath: workflowPathSource,
      envFilePath: envFilePathSource
    },
    dashboardArgv
  };
}
