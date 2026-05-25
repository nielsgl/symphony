import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import dotenv from 'dotenv';

import type { ResolveLocalCommandOptions, LocalCommandResolution } from './local-command-resolver';
import { LocalCommandResolutionError, resolveLocalCommand } from './local-command-resolver';
import { GUARDRAIL_ACK_FLAG } from './cli';
import { runLocalLinkCommand } from './local-link';
import { runLocalDoctor } from './local-doctor';
import { isWithinPath } from './path-containment';
import { ensureSystemGitignoreEntry, inspectProjectLayout, type ProjectLayoutInspection } from './project-layout-inspector';
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
import {
  getProfileBundle,
  getProfilePack,
  listProfileBundles,
  listProfilePacks,
  resolveProfileSelection,
  type ProfileBundle,
  type ProfilePack,
  type ProfileResolution
} from '../workflow/profile-registry';

export interface DashboardLaunchContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  envFilePath: string;
  repoRoot: string;
}

export interface LinkLocalRunOptions {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export interface CommandRouterDependencies {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  runDashboard: (argv: readonly string[], context: DashboardLaunchContext) => Promise<number>;
  runLinkLocal: (argv: readonly string[], options?: LinkLocalRunOptions) => Promise<number>;
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
    runLinkLocal: (argv, linkOptions) =>
      runLocalLinkCommand({
        argv,
        deps: {
          repoRoot,
          stdout: linkOptions?.stdout,
          stderr: linkOptions?.stderr
        }
      }),
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
    '  setup           Record user-local setup consent for this workflow',
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

function hasExplicitSetupConsentArg(argv: readonly string[]): boolean {
  return argv.includes('--yes') || argv.includes('--accept-high-trust-local-run');
}

function renderSetupSummary(params: {
  resolved: LocalCommandResolution;
  posture: WorkflowPosture;
  storePath: string;
  layout: ProjectLayoutInspection;
}): string {
  const layoutWarnings =
    params.layout.warnings.length === 0
      ? ['  warnings: none']
      : params.layout.warnings.map((warning) => `  warning: ${warning.message} next: ${warning.remediation}`);
  const legacySummary =
    params.layout.legacyRuntimePaths.length === 0
      ? 'none'
      : params.layout.legacyRuntimePaths.map((item) => item.path).join(', ');

  return [
    'Symphony setup high-trust consent:',
    `  project root: ${params.resolved.currentProjectRoot} (${params.resolved.sources.projectRoot})`,
    `  workflow: ${params.resolved.workflowPath} (${params.resolved.sources.workflowPath})`,
    `  identity key: ${params.resolved.projectIdentity.key}`,
    `  required posture: ${params.posture.posture}`,
    `  reason: ${params.posture.reason}`,
    `  consent store: ${params.storePath}`,
    '',
    'Project layout:',
    `  status: ${params.layout.status}`,
    `  workflow root: ${params.layout.workflow.exists ? 'present' : 'missing'} (${params.layout.workflow.path})`,
    `  runtime state root: ${params.layout.runtimeStateRoot.path}/`,
    `  gitignore: ${params.layout.ignoreAnalysis.status}`,
    `  reserved customization: ${params.layout.reservedCustomizationPaths.map((item) => item.path).join(', ')}`,
    `  legacy runtime paths: ${legacySummary}`,
    ...layoutWarnings,
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
  let layout = inspectProjectLayout(resolved.currentProjectRoot);
  deps.stdout(renderSetupSummary({ resolved, posture, storePath: deps.setupConsentStore.path, layout }));

  const approved =
    hasExplicitSetupConsentArg(argv) ||
    (await deps.promptSetupConsent({ resolved, posture, input: process.stdin, output: process.stdout }));
  if (!approved) {
    deps.stderr('Setup consent was not recorded because explicit approval was not provided.\n');
    return 1;
  }

  if (!layout.ignoreAnalysis.hasNarrowSystemIgnore) {
    const fix = ensureSystemGitignoreEntry(resolved.currentProjectRoot);
    deps.stdout(`[${fix.status}] layout.gitignore-system: ${fix.summary}\n`);
    if (fix.status === 'failed') {
      return 1;
    }
    layout = inspectProjectLayout(resolved.currentProjectRoot);
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
    '  symphony profile show <pack-or-bundle>',
    '  symphony profile show symphony-internal',
    '',
    'Discovery only:',
    '  Packs and bundles describe init materialization inputs.',
    '  Runtime execution continues to use the materialized workflow file.',
    '',
    'Examples:',
    '  symphony profile show linear-node',
    '  symphony profile show tracker:memory'
  ].join('\n');
}

function renderProfileList(repoRoot: string): string {
  const lines = [
    'Symphony profile registry',
    '',
    'Packs:',
    ...listProfilePacks().map((pack) => renderProfilePackSummary(pack, repoRoot)),
    '',
    'Bundles:',
    ...listProfileBundles().map(
      (bundle) =>
        `  ${bundle.id}\t${bundle.title}\n    expands: ${bundle.packs.join(', ')}\n    intended use: ${bundle.intendedUse}`
    ),
    '',
    'Conflict model:',
    '  Select exactly one pack for each required dimension: tracker, workspace, toolchain, workflow.',
    '  Packs in the same dimension conflict; choose a bundle or one explicit pack per dimension.',
    '',
    'Protected profiles:',
    `  symphony-internal -> workflow:symphony-internal (${path.join(repoRoot, 'WORKFLOW.md')})`,
    '  Protected bindings are golden references to checked-in workflows, not generated templates.'
  ];
  return `${lines.join('\n')}\n`;
}

function renderProfilePackSummary(pack: ProfilePack, repoRoot: string): string {
  const markers: string[] = [pack.dimension];
  if (pack.protected) {
    markers.push('protected');
  }
  const binding = pack.binding ? `\n    binding: ${renderProfilePackBinding(pack, repoRoot)}` : '';
  return `  ${pack.id}\t${markers.join(', ')}\n    ${pack.summary}\n    intended use: ${pack.intendedUse}${binding}`;
}

function renderProfilePackBinding(pack: ProfilePack, repoRoot: string): string {
  if (!pack.binding) {
    return 'none';
  }
  if (pack.binding.kind === 'checked-in-workflow') {
    return `${path.join(repoRoot, pack.binding.path)} (${pack.binding.description})`;
  }
  return pack.binding.description;
}

function renderProfileSelectionResolution(resolution: ProfileResolution): string[] {
  const lines = [
    'Resolution:',
    `  requested: ${resolution.requested.join(', ') || '(none)'}`,
    `  packs: ${resolution.packs.map((pack) => pack.id).join(', ') || '(none)'}`
  ];

  if (resolution.expandedBundles.length > 0) {
    lines.push('  bundle expansions:');
    for (const expansion of resolution.expandedBundles) {
      lines.push(`    ${expansion.bundle.id} -> ${expansion.packs.join(', ')}`);
    }
  }

  lines.push('  dimensions:');
  for (const dimension of ['tracker', 'workspace', 'toolchain', 'workflow'] as const) {
    lines.push(`    ${dimension}: ${resolution.dimensions[dimension]?.id ?? '(missing)'}`);
  }

  if (resolution.errors.length > 0) {
    lines.push('  errors:');
    for (const error of resolution.errors) {
      lines.push(`    - ${error}`);
    }
  } else {
    lines.push('  errors: none');
  }

  if (resolution.warnings.length > 0) {
    lines.push('  warnings:');
    for (const warning of resolution.warnings) {
      lines.push(`    - ${warning}`);
    }
  }

  return lines;
}

function renderProfileBundle(bundle: ProfileBundle): string {
  const resolution = resolveProfileSelection([bundle.id]);
  return [
    `Bundle: ${bundle.id}`,
    `Title: ${bundle.title}`,
    `Summary: ${bundle.summary}`,
    `Intended use: ${bundle.intendedUse}`,
    `Expands to: ${bundle.packs.join(', ')}`,
    ...renderProfileSelectionResolution(resolution)
  ].join('\n');
}

function renderProfilePack(pack: ProfilePack, repoRoot: string): string {
  const sameDimensionConflicts = listProfilePacks()
    .filter((candidate) => candidate.dimension === pack.dimension && candidate.id !== pack.id)
    .map((candidate) => candidate.id);
  const resolution = resolveProfileSelection([pack.id]);
  const lines = [
    `Pack: ${pack.id}`,
    `Title: ${pack.title}`,
    `Dimension: ${pack.dimension}`,
    `Summary: ${pack.summary}`,
    `Intended use: ${pack.intendedUse}`,
    `Conflicts: ${sameDimensionConflicts.length > 0 ? sameDimensionConflicts.join(', ') : 'none'}`,
    `Protected: ${pack.protected ? 'yes' : 'no'}`,
    `Binding: ${pack.binding ? renderProfilePackBinding(pack, repoRoot) : 'none'}`,
    ...renderProfileSelectionResolution(resolution)
  ];
  if (pack.id === 'workflow:symphony-internal') {
    lines.unshift('Type: protected');
    lines.unshift('Profile: symphony-internal');
  }
  return lines.join('\n');
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
    deps.stdout(renderProfileList(deps.repoRoot));
    return 0;
  }

  if (mode === 'show' && value !== undefined && extra.length === 0) {
    const bundle = getProfileBundle(value);
    if (bundle) {
      deps.stdout(`${renderProfileBundle(bundle)}\n`);
      return 0;
    }

    const pack = getProfilePack(value);
    if (pack) {
      deps.stdout(`${renderProfilePack(pack, deps.repoRoot)}\n`);
      return 0;
    }
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
    const setupConsentStoreInProject = isWithinPath(resolved.currentProjectRoot, deps.setupConsentStore.path);
    if (consentSource === 'missing' && !setupConsentStoreInProject) {
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
    const jsonOutput = rest.includes('--json');
    const doctor = await runLocalDoctor({
      argv: rest,
      deps: {
        cwd: deps.cwd,
        env: deps.env,
        repoRoot: deps.repoRoot,
        resolveLocalCommand: deps.resolveLocalCommand,
        resolveWorkflowPosture: deps.resolveWorkflowPosture,
        setupConsentStore: deps.setupConsentStore,
        runLinkLocal: (argv) =>
          deps.runLinkLocal(
            argv,
            jsonOutput
              ? {
                  stdout: () => undefined,
                  stderr: () => undefined
                }
              : undefined
          ),
        clock: deps.clock
      }
    });
    if (jsonOutput) {
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
