import fs from 'node:fs';
import path from 'node:path';

import { runDashboardCli } from './cli-runner';
import { runLocalLinkCommand } from './local-link';

export interface CommandRouterDependencies {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  runDashboard: (argv: readonly string[]) => Promise<number>;
  runLinkLocal: (argv: readonly string[]) => Promise<number>;
  packageVersion: string;
  repoRoot: string;
}

export interface RunCommandRouterOptions {
  argv: readonly string[];
  deps?: Partial<CommandRouterDependencies>;
}

const SUPPORTED_COMMANDS = ['dashboard', 'doctor', 'setup', 'profile', 'init', 'link-local'] as const;

const NOT_IMPLEMENTED_COMMANDS = new Set(['doctor', 'setup']);

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

function defaultDependencies(): CommandRouterDependencies {
  const repoRoot = defaultRepoRoot();
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    runDashboard: (argv) => runDashboardCli(argv),
    runLinkLocal: (argv) => runLocalLinkCommand({ argv, deps: { repoRoot } }),
    packageVersion: readPackageVersion(repoRoot),
    repoRoot
  };
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
    '  doctor          Reserved for local adoption readiness checks',
    '  setup           Reserved for future local setup consent and configuration',
    '  profile         Inspect bounded local command profiles',
    '  init            Show init help; workflow materialization is not implemented in this PRD',
    '  link-local      Link this checkout as a stable local symphony executable',
    '',
    'Run `symphony <command> --help` for command-specific help.'
  ].join('\n');
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
    return deps.runDashboard(rest);
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

  if (NOT_IMPLEMENTED_COMMANDS.has(command)) {
    return failUnsupported(
      deps,
      `Command '${command}' is recognized but not implemented in this PRD.`,
      renderHelp()
    );
  }

  return failUnsupported(
    deps,
    `Unknown command '${command}'. Supported commands: ${SUPPORTED_COMMANDS.join(', ')}.`,
    renderHelp()
  );
}
