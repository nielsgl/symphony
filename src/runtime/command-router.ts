import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import dotenv from 'dotenv';

import type { ResolveLocalCommandOptions, LocalCommandResolution } from './local-command-resolver';
import { LocalCommandResolutionError, resolveLocalCommand } from './local-command-resolver';
import { GUARDRAIL_ACK_FLAG } from './cli';
import { runLocalLinkCommand } from './local-link';
import { runLocalDoctor } from './local-doctor';
import {
  buildSetupConsentRecord,
  createFileSetupConsentStore,
  findValidSetupConsent,
  persistSetupConsent,
  promptSetupConsent,
  resolveWorkflowPosture,
  type SetupConsentSource,
  type SetupConsentStore,
  type WorkflowPosture
} from './setup-consent';

export interface DashboardLaunchContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  envFilePath: string;
  repoRoot: string;
}

export interface CommandRouterDependencies {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  runDashboard: (argv: readonly string[], context: DashboardLaunchContext) => Promise<number>;
  runLinkLocal: (argv: readonly string[]) => Promise<number>;
  resolveLocalCommand: (options: ResolveLocalCommandOptions) => LocalCommandResolution;
  resolveWorkflowPosture: (workflowPath: string, env?: NodeJS.ProcessEnv) => WorkflowPosture;
  setupConsentStore: SetupConsentStore;
  promptSetupConsent: typeof promptSetupConsent;
  loadEnvFile: (envFilePath: string) => void;
  clock: () => Date;
  packageVersion: string;
  repoRoot: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface RunCommandRouterOptions {
  argv: readonly string[];
  deps?: Partial<CommandRouterDependencies>;
}

export type DashboardSupervisorSignal = 'SIGINT' | 'SIGTERM';

interface DashboardSupervisorSignalTarget {
  killed?: boolean;
  kill(signal: DashboardSupervisorSignal): unknown;
}

interface DashboardSupervisorSignalSource {
  once(signal: DashboardSupervisorSignal, listener: () => void): unknown;
  removeListener(signal: DashboardSupervisorSignal, listener: () => void): unknown;
}

export interface DashboardSupervisorSignalBinding {
  cleanup: () => void;
  forwardedSignal: () => DashboardSupervisorSignal | null;
}

const SUPPORTED_COMMANDS = ['dashboard', 'doctor', 'setup', 'profile', 'init', 'link-local'] as const;

function defaultRepoRoot(): string {
  let current = __dirname;
  for (let depth = 0; depth < 5; depth += 1) {
    if (fs.existsSync(path.join(current, 'package.json'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return process.cwd();
}

function readPackageVersion(repoRoot: string): string {
  try {
    const payload = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof payload.version === 'string' ? payload.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function bindDashboardSupervisorSignalForwarding(
  child: DashboardSupervisorSignalTarget,
  signalSource: DashboardSupervisorSignalSource = process
): DashboardSupervisorSignalBinding {
  let forwarded: DashboardSupervisorSignal | null = null;

  const handlers: Record<DashboardSupervisorSignal, () => void> = {
    SIGINT: () => {
      if (forwarded) {
        return;
      }
      forwarded = 'SIGINT';
      if (!child.killed) {
        child.kill('SIGINT');
      }
    },
    SIGTERM: () => {
      if (forwarded) {
        return;
      }
      forwarded = 'SIGTERM';
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    }
  };

  signalSource.once('SIGINT', handlers.SIGINT);
  signalSource.once('SIGTERM', handlers.SIGTERM);

  return {
    cleanup: () => {
      signalSource.removeListener('SIGINT', handlers.SIGINT);
      signalSource.removeListener('SIGTERM', handlers.SIGTERM);
    },
    forwardedSignal: () => forwarded
  };
}

function signalExitCode(signal: DashboardSupervisorSignal): number {
  return signal === 'SIGINT' ? 130 : 143;
}

function runDashboardSupervisor(
  argv: readonly string[],
  context: DashboardLaunchContext
): Promise<number> {
  const supervisorScript = path.join(context.repoRoot, 'scripts', 'start-dashboard-supervisor.js');
  const env = {
    ...process.env,
    ...context.env,
    SYMPHONY_ENV_FILE: context.envFilePath
  };

  return new Promise((resolve) => {
    const child: ChildProcess = spawn(process.execPath, [supervisorScript, ...argv], {
      cwd: context.cwd,
      env,
      stdio: 'inherit'
    });
    const signalBinding = bindDashboardSupervisorSignalForwarding(child);
    let settled = false;

    const settle = (exitCode: number) => {
      if (settled) {
        return;
      }
      settled = true;
      signalBinding.cleanup();
      resolve(exitCode);
    };

    child.on('error', (error) => {
      process.stderr.write(`Failed to start dashboard supervisor: ${error.message}\n`);
      settle(1);
    });

    child.on('exit', (code, signal) => {
      const forwardedSignal = signalBinding.forwardedSignal();
      if (forwardedSignal) {
        settle(signalExitCode(forwardedSignal));
        return;
      }
      if (typeof code === 'number') {
        settle(code);
        return;
      }
      process.stderr.write(`Dashboard supervisor exited from signal ${signal || 'unknown'}\n`);
      settle(1);
    });
  });
}

function defaultDependencies(): CommandRouterDependencies {
  const repoRoot = defaultRepoRoot();
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    runDashboard: (argv, context) => runDashboardSupervisor(argv, context),
    runLinkLocal: (argv) => runLocalLinkCommand({ argv, deps: { repoRoot } }),
    resolveLocalCommand,
    resolveWorkflowPosture,
    setupConsentStore: createFileSetupConsentStore(),
    promptSetupConsent,
    loadEnvFile: (envFilePath) => {
      dotenv.config({ path: envFilePath });
    },
    clock: () => new Date(),
    packageVersion: readPackageVersion(repoRoot),
    repoRoot,
    cwd: process.cwd(),
    env: process.env
  };
}

function renderDashboardResolution(
  resolved: LocalCommandResolution,
  posture: WorkflowPosture,
  consentSource: SetupConsentSource
): string {
  return [
    'Symphony dashboard startup context:',
    `  project root: ${resolved.currentProjectRoot} (${resolved.sources.projectRoot})`,
    `  workflow: ${resolved.workflowPath} (${resolved.sources.workflowPath})`,
    `  env file: ${resolved.envFilePath} (${resolved.sources.envFilePath})`,
    `  profile: ${resolved.profile.name} (${resolved.profile.source})`,
    `  host: ${resolved.host.host} (${resolved.host.source})`,
    `  port: ${resolved.port.port} (${resolved.port.source})`,
    `  required posture: ${posture.posture}`,
    `  reason: ${posture.reason}`,
    `  consent: ${consentSource}`,
    ''
  ].join('\n');
}

function renderHelp(): string {
  return [
    'Symphony local command',
    '',
    'Usage:',
    '  symphony <command> [options]',
    '  symphony --help',
    '  symphony --version',
    '',
    'Commands:',
    '  dashboard       Start the local Symphony dashboard using the existing runner',
    '  doctor          Run local command and dashboard adoption readiness checks',
    '  setup           Reserved for future local setup consent and configuration',
    '  profile         Inspect bounded local command profiles',
    '  init            Show init help; workflow materialization is not implemented in this PRD',
    '  link-local      Link this checkout as a stable local symphony executable',
    '',
    'Run `symphony <command> --help` for command-specific help.'
  ].join('\n');
}

function renderSetupHelp(): string {
  return [
    'Symphony setup',
    '',
    'Usage:',
    '  symphony setup [--yes] [resolver options]',
    '',
    'Records explicit user-local consent for the resolved project/workflow identity.',
    'Project files can declare required posture, but they cannot grant consent.'
  ].join('\n');
}

function renderDoctorHelp(): string {
  return [
    'Symphony doctor',
    '',
    'Usage:',
    '  symphony doctor [--json] [--ci] [--fix] [--yes] [resolver options]',
    '',
    'Checks local command linking, workflow resolution, setup consent, env path,',
    'host/port readiness, and dashboard supervisor prerequisites.',
    '',
    'Exit codes:',
    '  0  clean',
    '  1  warning-only findings',
    '  2  blocker findings'
  ].join('\n');
}

function isWithinPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function hasExplicitSetupConsentArg(argv: readonly string[]): boolean {
  return argv.includes('--yes') || argv.includes('--accept-high-trust-local-run');
}

function renderSetupSummary(params: {
  resolved: LocalCommandResolution;
  posture: WorkflowPosture;
  storePath: string;
}): string {
  return [
    'Symphony setup high-trust consent:',
    `  project root: ${params.resolved.currentProjectRoot} (${params.resolved.sources.projectRoot})`,
    `  workflow: ${params.resolved.workflowPath} (${params.resolved.sources.workflowPath})`,
    `  identity key: ${params.resolved.projectIdentity.key}`,
    `  required posture: ${params.posture.posture}`,
    `  reason: ${params.posture.reason}`,
    `  consent store: ${params.storePath}`,
    '',
    'Consent is user-local and scoped to this exact project/workflow identity.',
    'WORKFLOW.md can explain the required posture, but it cannot grant consent.',
    ''
  ].join('\n');
}

async function runSetupCommand(
  argv: readonly string[],
  deps: CommandRouterDependencies
): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    deps.stdout(`${renderSetupHelp()}\n`);
    return 0;
  }

  let resolved: LocalCommandResolution;
  try {
    resolved = deps.resolveLocalCommand({
      command: 'setup',
      argv,
      cwd: deps.cwd,
      env: deps.env,
      symphonyCheckoutRoot: deps.repoRoot
    });
  } catch (error) {
    const message =
      error instanceof LocalCommandResolutionError || error instanceof Error ? error.message : String(error);
    deps.stderr(`${message}\n`);
    return 1;
  }

  if (isWithinPath(resolved.currentProjectRoot, deps.setupConsentStore.path)) {
    deps.stderr('Refusing to store setup consent under the project checkout; choose a user-local state path.\n');
    return 1;
  }

  const posture = deps.resolveWorkflowPosture(resolved.workflowPath, deps.env);
  deps.stdout(renderSetupSummary({ resolved, posture, storePath: deps.setupConsentStore.path }));

  const approved =
    hasExplicitSetupConsentArg(argv) ||
    (await deps.promptSetupConsent({ resolved, posture, input: process.stdin, output: process.stdout }));
  if (!approved) {
    deps.stderr('Setup consent was not recorded because explicit approval was not provided.\n');
    return 1;
  }

  const record = buildSetupConsentRecord({
    resolved,
    posture,
    approvedAt: deps.clock().toISOString()
  });
  persistSetupConsent(deps.setupConsentStore, record);
  deps.stdout(`Setup consent recorded for identity ${record.identity_key}.\n`);
  return 0;
}

function renderInitHelp(): string {
  return [
    'Symphony init',
    '',
    'Usage:',
    '  symphony init --help',
    '',
    'The init command shape is reserved for later workflow materialization work.',
    'This PRD only exposes help; it does not generate, copy, or overwrite workflows.'
  ].join('\n');
}

function renderProfileHelp(): string {
  return [
    'Symphony profiles',
    '',
    'Usage:',
    '  symphony profile list',
    '  symphony profile show symphony-internal',
    '',
    'Profiles:',
    '  symphony-internal  Protected binding to the checked-in Symphony WORKFLOW.md'
  ].join('\n');
}

function failUnsupported(
  deps: CommandRouterDependencies,
  message: string,
  help: string
): number {
  deps.stderr(`${message}\n\n${help}\n`);
  return 1;
}

function runProfileCommand(argv: readonly string[], deps: CommandRouterDependencies): number {
  const [mode, value, ...extra] = argv;

  if (mode === '--help' || mode === '-h') {
    deps.stdout(`${renderProfileHelp()}\n`);
    return 0;
  }

  if (mode === 'list' && extra.length === 0 && value === undefined) {
    deps.stdout('symphony-internal\tprotected\tchecked-in WORKFLOW.md\n');
    return 0;
  }

  if (mode === 'show' && value === 'symphony-internal' && extra.length === 0) {
    deps.stdout(
      [
        'Profile: symphony-internal',
        'Type: protected',
        `Workflow: ${path.join(deps.repoRoot, 'WORKFLOW.md')}`,
        'Source: checked-in Symphony WORKFLOW.md',
        'Template: no; this is not a generated workflow template'
      ].join('\n') + '\n'
    );
    return 0;
  }

  return failUnsupported(
    deps,
    `Unsupported profile command: ${argv.join(' ') || '(missing mode)'}`,
    renderProfileHelp()
  );
}

function runInitCommand(argv: readonly string[], deps: CommandRouterDependencies): number {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    deps.stdout(`${renderInitHelp()}\n`);
    return 0;
  }

  return failUnsupported(
    deps,
    'Workflow materialization is not implemented in this PRD.',
    renderInitHelp()
  );
}

export async function runCommandRouter(options: RunCommandRouterOptions): Promise<number> {
  const deps = {
    ...defaultDependencies(),
    ...options.deps
  };

  const [command, ...rest] = options.argv;

  if (!command || command === '--help' || command === '-h') {
    deps.stdout(`${renderHelp()}\n`);
    return 0;
  }

  if (command === '--version' || command === '-v') {
    deps.stdout(`${deps.packageVersion}\n`);
    return 0;
  }

  if (command === 'dashboard') {
    let resolved: LocalCommandResolution;
    try {
      resolved = deps.resolveLocalCommand({
        command: 'dashboard',
        argv: rest,
        cwd: deps.cwd,
        env: deps.env,
        symphonyCheckoutRoot: deps.repoRoot
      });
    } catch (error) {
      const message =
        error instanceof LocalCommandResolutionError || error instanceof Error ? error.message : String(error);
      deps.stderr(`${message}\n`);
      return 1;
    }
    let dashboardArgv = resolved.dashboardArgv;
    const posture = deps.resolveWorkflowPosture(resolved.workflowPath, deps.env);
    let consentSource: SetupConsentSource = dashboardArgv.includes(GUARDRAIL_ACK_FLAG) ? 'flag' : 'missing';
    if (consentSource === 'missing') {
      const consent = findValidSetupConsent({ store: deps.setupConsentStore, resolved, posture });
      if (consent) {
        dashboardArgv = [...dashboardArgv, GUARDRAIL_ACK_FLAG];
        consentSource = 'setup';
      }
    }
    deps.loadEnvFile(resolved.envFilePath);
    deps.stdout(renderDashboardResolution(resolved, posture, consentSource));
    return deps.runDashboard(dashboardArgv, {
      cwd: deps.cwd,
      env: deps.env,
      envFilePath: resolved.envFilePath,
      repoRoot: deps.repoRoot
    });
  }

  if (command === 'profile') {
    return runProfileCommand(rest, deps);
  }

  if (command === 'init') {
    return runInitCommand(rest, deps);
  }

  if (command === 'link-local') {
    return deps.runLinkLocal(rest);
  }

  if (command === 'setup') {
    return runSetupCommand(rest, deps);
  }

  if (command === 'doctor') {
    if (rest.length === 1 && (rest[0] === '--help' || rest[0] === '-h')) {
      deps.stdout(`${renderDoctorHelp()}\n`);
      return 0;
    }
    const doctor = await runLocalDoctor({
      argv: rest,
      deps: {
        cwd: deps.cwd,
        env: deps.env,
        repoRoot: deps.repoRoot,
        resolveLocalCommand: deps.resolveLocalCommand,
        resolveWorkflowPosture: deps.resolveWorkflowPosture,
        setupConsentStore: deps.setupConsentStore,
        runLinkLocal: deps.runLinkLocal,
        clock: deps.clock
      }
    });
    if (rest.includes('--json')) {
      deps.stdout(`${JSON.stringify(doctor.result, null, 2)}\n`);
    } else {
      deps.stdout(doctor.human);
    }
    return doctor.result.exitCode;
  }

  return failUnsupported(
    deps,
    `Unknown command '${command}'. Supported commands: ${SUPPORTED_COMMANDS.join(', ')}.`,
    renderHelp()
  );
}
