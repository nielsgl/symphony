import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LOCAL_SHIM_MARKER = 'symphony-local-shim';
export const LOCAL_SHIM_VERSION = '1';

export interface LocalLinkDependencies {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: () => string;
  run: (
    command: string,
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv }
  ) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'>;
  writeFileAtomic: (targetPath: string, content: string, mode: number) => void;
}

export interface RunLocalLinkOptions {
  argv: readonly string[];
  deps?: Partial<LocalLinkDependencies>;
}

interface ExistingShimMetadata {
  owned: boolean;
  repoRoot?: string;
  verificationError?: string;
}

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

function defaultWriteFileAtomic(targetPath: string, content: string, mode: number): void {
  const parent = path.dirname(targetPath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o755 });
  fs.chmodSync(parent, 0o755);

  const tempPath = path.join(parent, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempPath, content, { flag: 'wx', mode });
    fs.chmodSync(tempPath, mode);
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function defaultDependencies(): LocalLinkDependencies {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    repoRoot: defaultRepoRoot(),
    env: process.env,
    platform: process.platform,
    homedir: os.homedir,
    run: (command, args, options) =>
      spawnSync(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        encoding: 'utf8'
      }),
    writeFileAtomic: defaultWriteFileAtomic
  };
}

function readFlagValue(argv: readonly string[], flag: string): string | undefined {
  const equalsPrefix = `${flag}=`;
  const equalsForm = argv.find((arg) => arg.startsWith(equalsPrefix));
  if (equalsForm) {
    return equalsForm.slice(equalsPrefix.length);
  }

  const index = argv.findIndex((arg) => arg === flag);
  if (index === -1) {
    return undefined;
  }

  const value = argv[index + 1];
  if (!value || value.startsWith('-')) {
    return undefined;
  }

  return value;
}

function renderHelp(): string {
  return [
    'Symphony local checkout linking',
    '',
    'Usage:',
    '  symphony link-local [--target <path>]',
    '  npm run link:local -- [--target <path>]',
    '',
    'The default target is ~/.local/bin/symphony.'
  ].join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function renderShim(repoRoot: string): string {
  const entrypoint = path.join(repoRoot, 'scripts', 'symphony.js');
  return [
    '#!/usr/bin/env bash',
    `# ${LOCAL_SHIM_MARKER}`,
    `# symphony-shim-version: ${LOCAL_SHIM_VERSION}`,
    `# symphony-repo-root: ${repoRoot}`,
    `# symphony-entrypoint: ${entrypoint}`,
    'set -euo pipefail',
    `exec /usr/bin/env node ${shellQuote(entrypoint)} "$@"`,
    ''
  ].join('\n');
}

function parseExistingShim(targetPath: string): ExistingShimMetadata {
  if (!fs.existsSync(targetPath)) {
    return { owned: false };
  }

  let stat: fs.Stats;
  let content: string;
  try {
    stat = fs.lstatSync(targetPath);
    if (!stat.isFile()) {
      return { owned: false };
    }

    content = fs.readFileSync(targetPath, 'utf8');
  } catch (error) {
    return {
      owned: false,
      verificationError: (error as Error).message
    };
  }

  if (!content.includes(`# ${LOCAL_SHIM_MARKER}`)) {
    return { owned: false };
  }

  const repoRootMatch = content.match(/^# symphony-repo-root: (.+)$/m);
  return {
    owned: true,
    repoRoot: repoRootMatch?.[1]
  };
}

function resolveTargetPath(argv: readonly string[], deps: LocalLinkDependencies): string {
  const target = readFlagValue(argv, '--target');
  if (target) {
    return path.resolve(target.replace(/^~(?=$|\/)/, deps.homedir()));
  }

  return path.join(deps.homedir(), '.local', 'bin', 'symphony');
}

function pathContainsDirectory(pathValue: string | undefined, directory: string): boolean {
  const entries = (pathValue ?? '').split(path.delimiter).filter(Boolean);
  return entries.some((entry) => path.resolve(entry) === path.resolve(directory));
}

function detectShell(env: NodeJS.ProcessEnv): string {
  const shell = path.basename(env.SHELL ?? '');
  if (shell === 'zsh' || shell === 'bash' || shell === 'fish') {
    return shell;
  }

  return 'sh';
}

function renderPathGuidance(binDir: string, deps: LocalLinkDependencies): string {
  const quoted = shellQuote(binDir);
  switch (detectShell(deps.env)) {
    case 'fish':
      return `Add it with: fish_add_path ${quoted}`;
    case 'zsh':
      return `Add it with: echo 'export PATH="${binDir}:$PATH"' >> ~/.zshrc && source ~/.zshrc`;
    case 'bash':
      return `Add it with: echo 'export PATH="${binDir}:$PATH"' >> ~/.bashrc && source ~/.bashrc`;
    default:
      return `Add it with: export PATH="${binDir}:$PATH"`;
  }
}

function runStep(
  deps: LocalLinkDependencies,
  command: string,
  args: readonly string[],
  failureMessage: string
): { ok: true; stdout: string } | { ok: false; message: string } {
  const result = deps.run(command, args, { cwd: deps.repoRoot, env: deps.env });
  if (result.status === 0) {
    return { ok: true, stdout: result.stdout ?? '' };
  }

  const detail = result.error?.message || result.stderr || result.stdout || `exit ${result.status ?? 'unknown'}`;
  return { ok: false, message: `${failureMessage}: ${String(detail).trim()}` };
}

export async function runLocalLinkCommand(options: RunLocalLinkOptions): Promise<number> {
  const deps = defaultDependencies();
  for (const [key, value] of Object.entries(options.deps ?? {})) {
    if (value !== undefined) {
      (deps as unknown as Record<string, unknown>)[key] = value;
    }
  }

  if (options.argv.includes('--help') || options.argv.includes('-h')) {
    deps.stdout(`${renderHelp()}\n`);
    return 0;
  }

  const unknownFlag = options.argv.find(
    (arg) => arg.startsWith('-') && arg !== '--target' && !arg.startsWith('--target=')
  );
  if (unknownFlag) {
    deps.stderr(`Unsupported link-local option: ${unknownFlag}\n\n${renderHelp()}\n`);
    return 1;
  }

  const targetPath = resolveTargetPath(options.argv, deps);
  const binDir = path.dirname(targetPath);
  const entrypoint = path.join(deps.repoRoot, 'scripts', 'symphony.js');

  if (!fs.existsSync(entrypoint)) {
    deps.stderr(`Symphony CLI entrypoint is missing: ${entrypoint}\n`);
    return 1;
  }

  const existing = parseExistingShim(targetPath);
  if (fs.existsSync(targetPath) && !existing.owned) {
    const reason = existing.verificationError
      ? `Cannot verify whether the existing target is Symphony-owned: ${existing.verificationError}`
      : 'The existing target is not marked as a Symphony local shim.';
    deps.stderr(
      [
        `Refusing to overwrite existing non-Symphony or unverifiable executable: ${targetPath}`,
        reason,
        'Move or remove that file, or choose a different target with `--target <path>`.'
      ].join('\n') + '\n'
    );
    return 1;
  }

  const build = runStep(deps, 'npm', ['run', 'build'], 'Failed to build Symphony before linking');
  if (!build.ok) {
    deps.stderr(`${build.message}\n`);
    return 1;
  }

  const directVersion = runStep(
    deps,
    process.execPath,
    [entrypoint, '--version'],
    'Failed to verify Symphony CLI entrypoint'
  );
  if (!directVersion.ok) {
    deps.stderr(`${directVersion.message}\n`);
    return 1;
  }

  try {
    deps.writeFileAtomic(targetPath, renderShim(deps.repoRoot), 0o755);
  } catch (error) {
    deps.stderr(`Failed to write Symphony shim atomically: ${(error as Error).message}\n`);
    return 1;
  }

  const linkedVersion = runStep(
    deps,
    targetPath,
    ['--version'],
    'Failed to verify linked Symphony shim'
  );
  if (!linkedVersion.ok) {
    deps.stderr(`${linkedVersion.message}\n`);
    return 1;
  }

  const pathReady = pathContainsDirectory(deps.env.PATH, binDir);
  const action = existing.owned ? 'Updated' : 'Linked';

  deps.stdout(
    [
      `${action} Symphony local shim: ${targetPath}`,
      `Checkout: ${deps.repoRoot}`,
      `Version: ${linkedVersion.stdout.trim()}`,
      '',
      'Update: rerun `npm run link:local` from this checkout.',
      `Unlink: rm ${shellQuote(targetPath)}`,
      `Inspect: sed -n '1,8p' ${shellQuote(targetPath)}`
    ].join('\n') + '\n'
  );

  if (!pathReady) {
    deps.stdout(
      [
        '',
        `PATH warning: ${binDir} is not on PATH, so the command is linked but not fully usable as \`symphony\` yet.`,
        renderPathGuidance(binDir, deps)
      ].join('\n') + '\n'
    );
  }

  return 0;
}
