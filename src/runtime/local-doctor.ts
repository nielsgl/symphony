import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';

import { ConfigResolver, ConfigValidator, WorkflowLoader } from '../workflow';
import { WorkflowConfigError } from '../workflow/errors';
import type { EffectiveConfig } from '../workflow/types';
import type { ResolveLocalCommandOptions, LocalCommandResolution } from './local-command-resolver';
import { LocalCommandResolutionError } from './local-command-resolver';
import { isWithinPath } from './path-containment';
import {
  ensureSystemGitignoreEntry,
  inspectProjectLayout,
  type ProjectLayoutInspection,
  type ProjectLayoutWarningCode
} from './project-layout-inspector';
import {
  buildSetupConsentRecord,
  findValidSetupConsent,
  persistSetupConsent,
  type SetupConsentSource,
  type SetupConsentStore,
  type WorkflowPosture
} from './setup-consent';

export type DoctorCheckStatus = 'ok' | 'warning' | 'failure';
export type DoctorOverallStatus = DoctorCheckStatus;

export interface DoctorCheck {
  id: string;
  title: string;
  status: DoctorCheckStatus;
  reason: string;
  summary: string;
  remediation?: string;
  details?: Record<string, unknown>;
}

export interface DoctorFixAction {
  id: string;
  status: 'applied' | 'skipped' | 'failed';
  summary: string;
  details?: Record<string, unknown>;
}

export interface DoctorJsonResult {
  version: 1;
  command: 'doctor';
  status: DoctorOverallStatus;
  reason: 'ready' | 'warnings_present' | 'blockers_present';
  exitCode: 0 | 1 | 2;
  ci: boolean;
  fix: boolean;
  cwd: string;
  symphonyCheckoutRoot: string;
  resolution: {
    projectRoot: string | null;
    workflowPath: string | null;
    envFilePath: string | null;
    profile: string | null;
    host: string | null;
    port: number | null;
    ephemeralPort: boolean | null;
    consent: SetupConsentSource | null;
  };
  layout: ProjectLayoutInspection | null;
  checks: DoctorCheck[];
  fixes: DoctorFixAction[];
}

export interface RunLocalDoctorOptions {
  argv: readonly string[];
  deps: LocalDoctorDependencies;
}

export interface LocalDoctorDependencies {
  cwd: string;
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  resolveLocalCommand: (options: ResolveLocalCommandOptions) => LocalCommandResolution;
  resolveWorkflowPosture: (workflowPath: string, env?: NodeJS.ProcessEnv) => WorkflowPosture;
  setupConsentStore: SetupConsentStore;
  runLinkLocal: (argv: readonly string[]) => Promise<number>;
  clock: () => Date;
}

interface DoctorArgs {
  json: boolean;
  ci: boolean;
  fix: boolean;
  yes: boolean;
  resolverArgv: string[];
}

interface ShimMetadata {
  path: string;
  owned: boolean;
  repoRoot: string | null;
  entrypoint: string | null;
  verificationError?: string;
}

const DOCTOR_FLAGS = new Set(['--json', '--ci', '--fix', '--yes', '--accept-high-trust-local-run']);

function parseDoctorArgs(argv: readonly string[]): DoctorArgs | { error: string } {
  const resolverArgv: string[] = [];
  let json = false;
  let ci = false;
  let fix = false;
  let yes = false;

  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--ci') {
      ci = true;
      continue;
    }
    if (arg === '--fix') {
      fix = true;
      continue;
    }
    if (arg === '--yes' || arg === '--accept-high-trust-local-run') {
      yes = true;
      continue;
    }
    if (arg.startsWith('--doctor-')) {
      return { error: `Unsupported doctor option: ${arg}` };
    }
    if (arg.startsWith('--') && DOCTOR_FLAGS.has(arg.split('=')[0])) {
      return { error: `Unsupported doctor option value form: ${arg}` };
    }
    resolverArgv.push(arg);
  }

  return { json, ci, fix, yes, resolverArgv };
}

function findExecutableOnPath(env: NodeJS.ProcessEnv): string | null {
  const entries = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const entry of entries) {
    const candidate = path.join(entry, 'symphony');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

function parseShimMetadata(executablePath: string): ShimMetadata {
  let content: string;
  try {
    content = fs.readFileSync(executablePath, 'utf8');
  } catch (error) {
    return {
      path: executablePath,
      owned: false,
      repoRoot: null,
      entrypoint: null,
      verificationError: (error as Error).message
    };
  }

  const owned = content.includes('# symphony-local-shim');
  const repoRoot = content.match(/^# symphony-repo-root: (.+)$/m)?.[1] ?? null;
  const entrypoint = content.match(/^# symphony-entrypoint: (.+)$/m)?.[1] ?? null;
  return { path: executablePath, owned, repoRoot, entrypoint };
}

function addCheck(checks: DoctorCheck[], check: DoctorCheck): void {
  checks.push(check);
}

function statusRank(status: DoctorCheckStatus): number {
  if (status === 'failure') {
    return 2;
  }
  if (status === 'warning') {
    return 1;
  }
  return 0;
}

function summarizeStatus(checks: readonly DoctorCheck[]): {
  status: DoctorOverallStatus;
  reason: DoctorJsonResult['reason'];
  exitCode: 0 | 1 | 2;
} {
  const worst = checks.reduce((current, check) => Math.max(current, statusRank(check.status)), 0);
  if (worst === 2) {
    return { status: 'failure', reason: 'blockers_present', exitCode: 2 };
  }
  if (worst === 1) {
    return { status: 'warning', reason: 'warnings_present', exitCode: 1 };
  }
  return { status: 'ok', reason: 'ready', exitCode: 0 };
}

function layoutWarningSeverity(code: ProjectLayoutWarningCode): DoctorCheckStatus {
  return code === 'workflow_missing' || code === 'invalid_layout_path' || code === 'gitignore_unreadable'
    ? 'failure'
    : 'warning';
}

function addLayoutChecks(checks: DoctorCheck[], layout: ProjectLayoutInspection): void {
  addCheck(checks, {
    id: 'layout.workflow',
    title: 'Root WORKFLOW.md is canonical',
    status: layout.workflow.exists ? 'ok' : 'failure',
    reason: layout.workflow.exists ? 'workflow_root_present' : 'workflow_root_missing',
    summary: layout.workflow.exists ? 'Root WORKFLOW.md is present.' : 'Root WORKFLOW.md is missing.',
    remediation: layout.workflow.remediation,
    details: { workflow: layout.workflow, projectContractPaths: layout.projectContractPaths }
  });
  addCheck(checks, {
    id: 'layout.runtime_state_root',
    title: '.symphony/system runtime root is reserved',
    status: 'ok',
    reason: 'runtime_state_root_reserved',
    summary: '.symphony/system/ is the runtime-owned local state root.',
    details: { runtimeStateRoot: layout.runtimeStateRoot, runtimeOwnedPaths: layout.runtimeOwnedPaths }
  });
  addCheck(checks, {
    id: 'layout.gitignore_system',
    title: '.gitignore covers runtime state root',
    status: layout.ignoreAnalysis.hasNarrowSystemIgnore
      ? 'ok'
      : layout.ignoreAnalysis.status === 'unreadable'
        ? 'failure'
        : 'warning',
    reason: layout.ignoreAnalysis.hasNarrowSystemIgnore
      ? 'system_ignore_present'
      : layout.ignoreAnalysis.status === 'unreadable'
        ? 'gitignore_unreadable'
        : 'system_ignore_missing',
    summary: layout.ignoreAnalysis.hasNarrowSystemIgnore
      ? '.gitignore includes .symphony/system/.'
      : '.gitignore does not narrowly ignore .symphony/system/.',
    remediation: layout.ignoreAnalysis.hasNarrowSystemIgnore
      ? undefined
      : 'Add .symphony/system/ to .gitignore; `symphony doctor --fix --yes` can append it safely.',
    details: { ignoreAnalysis: layout.ignoreAnalysis }
  });
  addCheck(checks, {
    id: 'layout.broad_symphony_ignore',
    title: 'Broad .symphony/ ignores are not hiding project customization',
    status: layout.ignoreAnalysis.hasBroadSymphonyIgnore ? 'warning' : 'ok',
    reason: layout.ignoreAnalysis.hasBroadSymphonyIgnore ? 'broad_symphony_ignore_present' : 'no_broad_symphony_ignore',
    summary: layout.ignoreAnalysis.hasBroadSymphonyIgnore
      ? 'A broad .symphony/ ignore may hide future project-owned customization.'
      : 'No broad .symphony/ ignore was found.',
    remediation: layout.ignoreAnalysis.hasBroadSymphonyIgnore
      ? 'Migrate broad .symphony/ ignores to .symphony/system/ manually; doctor will not remove broad ignores.'
      : undefined,
    details: {
      patterns: layout.ignoreAnalysis.patterns.filter((pattern) => pattern.kind === 'broad-symphony')
    }
  });
  addCheck(checks, {
    id: 'layout.reserved_customization',
    title: 'Reserved customization paths remain project-owned',
    status: 'ok',
    reason: 'reserved_customization_reported',
    summary: 'Reserved .symphony customization paths are reported and are not loaded by runtime.',
    details: { reservedCustomizationPaths: layout.reservedCustomizationPaths }
  });
  addCheck(checks, {
    id: 'layout.legacy_runtime_paths',
    title: 'Legacy runtime paths are absent',
    status: layout.legacyRuntimePaths.length === 0 ? 'ok' : 'warning',
    reason: layout.legacyRuntimePaths.length === 0 ? 'legacy_runtime_paths_absent' : 'legacy_runtime_paths_present',
    summary:
      layout.legacyRuntimePaths.length === 0
        ? 'No legacy runtime state paths were found.'
        : `Found ${layout.legacyRuntimePaths.length} legacy runtime state path(s).`,
    remediation:
      layout.legacyRuntimePaths.length === 0
        ? undefined
        : 'Migrate runtime state to .symphony/system/ manually after verifying no active process uses the legacy paths.',
    details: { legacyRuntimePaths: layout.legacyRuntimePaths }
  });

  for (const warning of layout.warnings.filter((item) =>
    ['invalid_layout_path', 'gitignore_unreadable'].includes(item.code)
  )) {
    addCheck(checks, {
      id: `layout.warning.${warning.code}`,
      title: `Layout warning: ${warning.code}`,
      status: layoutWarningSeverity(warning.code),
      reason: warning.code,
      summary: warning.message,
      remediation: warning.remediation,
      details: { path: warning.path }
    });
  }
}

function checkCheckoutEntrypoint(repoRoot: string, label: string): DoctorCheck {
  const scriptEntrypoint = path.join(repoRoot, 'scripts', 'symphony.js');
  const builtEntrypoint = path.join(repoRoot, 'dist', 'src', 'runtime', 'command-router.js');
  if (!fs.existsSync(repoRoot)) {
    return {
      id: `${label}.checkout_exists`,
      title: `${label} checkout exists`,
      status: 'failure',
      reason: 'checkout_missing',
      summary: `Checkout does not exist: ${repoRoot}`,
      remediation: 'Refresh the local link from an existing Symphony checkout with `npm run link:local`.',
      details: { repoRoot }
    };
  }
  if (!fs.existsSync(scriptEntrypoint)) {
    return {
      id: `${label}.cli_script`,
      title: `${label} CLI script exists`,
      status: 'failure',
      reason: 'cli_script_missing',
      summary: `CLI script is missing: ${scriptEntrypoint}`,
      remediation: 'Refresh the local link from a valid Symphony checkout with `npm run link:local`.',
      details: { scriptEntrypoint }
    };
  }
  if (!fs.existsSync(builtEntrypoint)) {
    return {
      id: `${label}.built_cli`,
      title: `${label} built CLI entrypoint exists`,
      status: 'failure',
      reason: 'build_missing',
      summary: `Built CLI entrypoint is missing: ${builtEntrypoint}`,
      remediation: 'Run `npm run build` in the Symphony checkout, then rerun `npm run link:local`.',
      details: { builtEntrypoint }
    };
  }
  return {
    id: `${label}.built_cli`,
    title: `${label} built CLI entrypoint exists`,
    status: 'ok',
    reason: 'built_cli_ready',
    summary: `Built CLI entrypoint is present: ${builtEntrypoint}`,
    details: { scriptEntrypoint, builtEntrypoint }
  };
}

function canListen(host: string, port: number): Promise<boolean> {
  if (port === 0) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

function readEnvFileValues(envFilePath: string): NodeJS.ProcessEnv {
  try {
    return dotenv.parse(fs.readFileSync(envFilePath));
  } catch {
    return {};
  }
}

function findCommandOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const [executable] = command.trim().split(/\s+/);
  if (!executable) {
    return null;
  }

  if (executable.includes(path.sep)) {
    try {
      fs.accessSync(executable, fs.constants.X_OK);
      return fs.realpathSync(executable);
    } catch {
      return null;
    }
  }

  for (const entry of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, executable);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Continue searching PATH.
    }
  }

  return null;
}

function validateWorkflow(resolved: LocalCommandResolution, env: NodeJS.ProcessEnv): {
  check: DoctorCheck;
  effectiveConfig: EffectiveConfig | null;
} {
  try {
    const definition = new WorkflowLoader().load({ explicitPath: resolved.workflowPath });
    const effective = new ConfigResolver({ env }).resolve(definition, { workflowPath: resolved.workflowPath });
    const validation = new ConfigValidator().validate(effective);
    if (!validation.ok) {
      return {
        check: {
          id: 'workflow.effective_config',
          title: 'Workflow effective config validates',
          status: 'failure',
          reason: validation.error_code,
          summary: validation.message,
          remediation: 'Fix WORKFLOW.md or the referenced environment variables before starting the dashboard.',
          details: { workflowPath: resolved.workflowPath, at: validation.at }
        },
        effectiveConfig: null
      };
    }
    return {
      check: {
        id: 'workflow.effective_config',
        title: 'Workflow effective config validates',
        status: 'ok',
        reason: 'workflow_config_valid',
        summary: 'Workflow syntax and effective configuration are valid for local startup.',
        details: { workflowPath: resolved.workflowPath }
      },
      effectiveConfig: effective
    };
  } catch (error) {
    const code = error instanceof WorkflowConfigError ? error.code : 'workflow_validation_failed';
    const message = error instanceof Error ? error.message : String(error);
    return {
      check: {
        id: 'workflow.effective_config',
        title: 'Workflow effective config validates',
        status: 'failure',
        reason: code,
        summary: message,
        remediation: 'Fix WORKFLOW.md syntax/configuration before starting the dashboard.',
        details: { workflowPath: resolved.workflowPath }
      },
      effectiveConfig: null
    };
  }
}

function runGit(cwd: string, args: readonly string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  };
}

function parseRemoteBaseRef(baseRef: string): { remote: string; ref: string } | null {
  const [remote, ...rest] = baseRef.split('/');
  if (!remote || rest.length === 0) {
    return null;
  }

  return { remote, ref: rest.join('/') };
}

function checkBaseRef(repoRoot: string, baseRef: string): DoctorCheck {
  const localRef = runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
  if (localRef.ok) {
    return {
      id: 'workspace.base_ref',
      title: 'Workspace base ref is ready',
      status: 'ok',
      reason: 'base_ref_exists',
      summary: `Base ref ${baseRef} resolves locally.`,
      details: { repoRoot, baseRef, source: 'local' }
    };
  }

  const remoteRef = parseRemoteBaseRef(baseRef);
  if (remoteRef) {
    const remote = runGit(repoRoot, ['ls-remote', '--exit-code', remoteRef.remote, remoteRef.ref]);
    if (remote.ok) {
      return {
        id: 'workspace.base_ref',
        title: 'Workspace base ref is ready',
        status: 'ok',
        reason: 'base_ref_fetchable',
        summary: `Base ref ${baseRef} is fetchable from ${remoteRef.remote}.`,
        details: { repoRoot, baseRef, source: 'remote', remote: remoteRef.remote, ref: remoteRef.ref }
      };
    }
  }

  return {
    id: 'workspace.base_ref',
    title: 'Workspace base ref is ready',
    status: 'failure',
    reason: 'base_ref_unavailable',
    summary: `Base ref ${baseRef} does not resolve locally and was not fetchable.`,
    remediation: 'Fetch the configured base ref or update workspace.provisioner.base_ref before running agents.',
    details: { repoRoot, baseRef, stderr: localRef.stderr.trim() }
  };
}

function addWorkspaceChecks(checks: DoctorCheck[], resolved: LocalCommandResolution, effectiveConfig: EffectiveConfig): void {
  const provisioner = effectiveConfig.workspace.provisioner;
  if (provisioner.type === 'none') {
    addCheck(checks, {
      id: 'workspace.provisioner',
      title: 'Workspace provisioner is configured',
      status: 'ok',
      reason: 'workspace_provisioner_disabled',
      summary: 'Workspace provisioning is disabled for this workflow.',
      details: { type: provisioner.type }
    });
    return;
  }

  const repoRoot = provisioner.repo_root ?? resolved.currentProjectRoot;
  const repoStat = fs.existsSync(repoRoot) ? fs.statSync(repoRoot) : null;
  if (!repoStat?.isDirectory()) {
    addCheck(checks, {
      id: 'workspace.git_repository',
      title: 'Workspace repository is ready',
      status: 'failure',
      reason: 'repo_root_missing',
      summary: `workspace.provisioner.repo_root is not a directory: ${repoRoot}`,
      remediation: 'Set workspace.provisioner.repo_root to an existing git checkout.',
      details: { type: provisioner.type, repoRoot }
    });
    return;
  }

  const insideWorkTree = runGit(repoRoot, ['rev-parse', '--is-inside-work-tree']);
  if (!insideWorkTree.ok || insideWorkTree.stdout.trim() !== 'true') {
    addCheck(checks, {
      id: 'workspace.git_repository',
      title: 'Workspace repository is ready',
      status: 'failure',
      reason: 'repo_root_not_git_repository',
      summary: `workspace.provisioner.repo_root is not a git work tree: ${repoRoot}`,
      remediation: 'Use a git checkout for workspace.provisioner.repo_root.',
      details: { type: provisioner.type, repoRoot, stderr: insideWorkTree.stderr.trim() }
    });
    return;
  }

  addCheck(checks, {
    id: 'workspace.git_repository',
    title: 'Workspace repository is ready',
    status: 'ok',
    reason: 'repo_root_git_repository',
    summary: `workspace.provisioner.repo_root is a git work tree: ${repoRoot}`,
    details: { type: provisioner.type, repoRoot }
  });

  if (provisioner.type === 'worktree') {
    const worktreeList = runGit(repoRoot, ['worktree', 'list', '--porcelain']);
    addCheck(checks, {
      id: 'workspace.worktree',
      title: 'Git worktree support is ready',
      status: worktreeList.ok ? 'ok' : 'failure',
      reason: worktreeList.ok ? 'worktree_list_ready' : 'worktree_list_failed',
      summary: worktreeList.ok ? 'Git worktree metadata can be inspected.' : 'Git worktree metadata could not be inspected.',
      remediation: worktreeList.ok ? undefined : 'Repair git worktree metadata before provisioning issue workspaces.',
      details: { repoRoot, stderr: worktreeList.stderr.trim() }
    });
  }

  addCheck(checks, checkBaseRef(repoRoot, provisioner.base_ref));

  const status = runGit(repoRoot, ['status', '--porcelain']);
  const dirty = status.stdout.trim().length > 0;
  addCheck(checks, {
    id: 'workspace.dirty_policy',
    title: 'Dirty repository policy is satisfied',
    status: !dirty || provisioner.allow_dirty_repo ? 'ok' : 'failure',
    reason: dirty
      ? provisioner.allow_dirty_repo
        ? 'dirty_repo_allowed'
        : 'dirty_repo_blocked'
      : 'repo_clean',
    summary: dirty
      ? provisioner.allow_dirty_repo
        ? 'Repository has local changes and workflow allows dirty provisioning.'
        : 'Repository has local changes but workflow blocks dirty provisioning.'
      : 'Repository has no local changes.',
    remediation: dirty && !provisioner.allow_dirty_repo ? 'Commit, stash, or discard local changes before provisioning workspaces.' : undefined,
    details: {
      repoRoot,
      allowDirtyRepo: provisioner.allow_dirty_repo,
      dirtyEntries: status.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, 20)
    }
  });
}

function addCodexCommandCheck(checks: DoctorCheck[], effectiveConfig: EffectiveConfig, env: NodeJS.ProcessEnv): void {
  const command = effectiveConfig.codex.command;
  const executablePath = findCommandOnPath(command, env);
  addCheck(checks, {
    id: 'codex.command',
    title: 'Codex command is available',
    status: executablePath ? 'ok' : 'failure',
    reason: executablePath ? 'codex_command_available' : 'codex_command_missing',
    summary: executablePath ? `Codex command resolves to ${executablePath}.` : `Codex command is not executable: ${command}`,
    remediation: executablePath ? undefined : 'Install Codex or set codex.command to an executable command before starting agents.',
    details: { command, executablePath }
  });
}

function renderHuman(result: DoctorJsonResult): string {
  const lines = [
    `Symphony doctor: ${result.status}`,
    `Reason: ${result.reason}`,
    `Exit code: ${result.exitCode}`,
    '',
    'Resolved context:',
    `  cwd: ${result.cwd}`,
    `  symphony checkout: ${result.symphonyCheckoutRoot}`,
    `  project root: ${result.resolution.projectRoot ?? '(unresolved)'}`,
    `  workflow: ${result.resolution.workflowPath ?? '(unresolved)'}`,
    `  env file: ${result.resolution.envFilePath ?? '(unresolved)'}`,
    `  profile: ${result.resolution.profile ?? '(unresolved)'}`,
    `  host: ${result.resolution.host ?? '(unresolved)'}`,
    `  port: ${
      result.resolution.port === null
        ? '(unresolved)'
        : `${result.resolution.port}${result.resolution.ephemeralPort ? ' (ephemeral)' : ''}`
    }`,
    `  consent: ${result.resolution.consent ?? '(unresolved)'}`,
    '',
    'Checks:'
  ];

  for (const check of result.checks) {
    lines.push(`  [${check.status}] ${check.title}: ${check.summary}`);
    if (check.remediation) {
      lines.push(`    next: ${check.remediation}`);
    }
  }

  if (result.fixes.length > 0) {
    lines.push('', 'Fix actions:');
    for (const fix of result.fixes) {
      lines.push(`  [${fix.status}] ${fix.id}: ${fix.summary}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export async function runLocalDoctor(options: RunLocalDoctorOptions): Promise<{
  result: DoctorJsonResult;
  human: string;
}> {
  const parsed = parseDoctorArgs(options.argv);
  const checks: DoctorCheck[] = [];
  const fixes: DoctorFixAction[] = [];
  const deps = options.deps;
  let resolved: LocalCommandResolution | null = null;
  let consentSource: SetupConsentSource | null = null;
  let layout: ProjectLayoutInspection | null = null;

  if ('error' in parsed) {
    addCheck(checks, {
      id: 'doctor.options',
      title: 'Doctor options parse',
      status: 'failure',
      reason: 'invalid_doctor_option',
      summary: parsed.error,
      remediation: 'Run `symphony doctor --help` for supported options.'
    });
  }

  const args = 'error' in parsed ? { json: false, ci: false, fix: false, yes: false, resolverArgv: [] } : parsed;
  const executablePath = findExecutableOnPath(deps.env);
  let shim: ShimMetadata | null = null;

  if (!executablePath) {
    addCheck(checks, {
      id: 'executable.discoverable',
      title: 'Local symphony executable is discoverable on PATH',
      status: 'failure',
      reason: 'path_missing',
      summary: '`symphony` was not found on PATH.',
      remediation: 'Run `npm run link:local` from the Symphony checkout, then ensure the linked bin directory is on PATH.'
    });
  } else {
    shim = parseShimMetadata(executablePath);
    if (!shim.owned) {
      addCheck(checks, {
        id: 'executable.discoverable',
        title: 'Local symphony executable is discoverable on PATH',
        status: 'failure',
        reason: 'link_unverifiable',
        summary: `Found ${executablePath}, but it is not a Symphony local shim.`,
        remediation: 'Run `npm run link:local` from the expected Symphony checkout or choose a PATH entry that points at the local shim.',
        details: { executablePath, verificationError: shim.verificationError }
      });
    } else if (shim.repoRoot && path.resolve(shim.repoRoot) !== path.resolve(deps.repoRoot)) {
      addCheck(checks, {
        id: 'executable.checkout',
        title: 'Local symphony executable points at this checkout',
        status: 'failure',
        reason: 'checkout_mismatch',
        summary: `PATH shim points at ${shim.repoRoot}, expected ${deps.repoRoot}.`,
        remediation: 'Refresh the local shim from this checkout with `npm run link:local`.',
        details: { executablePath, shimRepoRoot: shim.repoRoot, expectedRepoRoot: deps.repoRoot }
      });
    } else {
      addCheck(checks, {
        id: 'executable.checkout',
        title: 'Local symphony executable points at this checkout',
        status: 'ok',
        reason: 'checkout_match',
        summary: `PATH shim points at ${shim.repoRoot ?? deps.repoRoot}.`,
        details: { executablePath, shimRepoRoot: shim.repoRoot, shimEntrypoint: shim.entrypoint }
      });
    }
  }

  const shimRepoRoot = shim?.repoRoot ?? deps.repoRoot;
  addCheck(checks, checkCheckoutEntrypoint(shimRepoRoot, 'shim_checkout'));

  if (
    args.fix &&
    checks.some(
      (check) =>
        check.status !== 'ok' &&
        (check.id.startsWith('executable.') || check.reason === 'build_missing' || check.reason === 'checkout_missing')
    )
  ) {
    const exitCode = await deps.runLinkLocal([]);
    fixes.push({
      id: 'link-local',
      status: exitCode === 0 ? 'applied' : 'failed',
      summary:
        exitCode === 0
          ? 'Invoked `symphony link-local` remediation. Rerun doctor to verify PATH and shim state.'
          : `Link-local remediation failed with exit ${exitCode}.`,
      details: { exitCode }
    });
  }

  try {
    resolved = deps.resolveLocalCommand({
      command: 'doctor',
      argv: args.resolverArgv,
      cwd: deps.cwd,
      env: deps.env,
      symphonyCheckoutRoot: deps.repoRoot
    });
    addCheck(checks, {
      id: 'resolver.workflow',
      title: 'Project workflow resolves',
      status: 'ok',
      reason: 'workflow_resolved',
      summary: `Resolved workflow ${resolved.workflowPath}.`,
      details: {
        projectRoot: resolved.currentProjectRoot,
        workflowPath: resolved.workflowPath,
        workflowSource: resolved.sources.workflowPath
      }
    });
    const dashboardEnv = {
      ...readEnvFileValues(resolved.envFilePath),
      ...deps.env
    };
    const workflowValidation = validateWorkflow(resolved, dashboardEnv);
    addCheck(checks, workflowValidation.check);
    if (workflowValidation.effectiveConfig) {
      addCodexCommandCheck(checks, workflowValidation.effectiveConfig, dashboardEnv);
      addWorkspaceChecks(checks, resolved, workflowValidation.effectiveConfig);
    }
    addCheck(checks, {
      id: 'env.path',
      title: 'Project env file path resolved',
      status: 'ok',
      reason: 'env_path_resolved',
      summary: `Would load ${resolved.envFilePath}.`,
      remediation: fs.existsSync(resolved.envFilePath)
        ? undefined
        : 'Create this .env file if the workflow requires local environment variables; doctor does not print secret values.',
      details: {
        envFilePath: resolved.envFilePath,
        source: resolved.sources.envFilePath,
        exists: fs.existsSync(resolved.envFilePath)
      }
    });

    layout = inspectProjectLayout(resolved.currentProjectRoot);
    if (args.fix && args.yes && !layout.ignoreAnalysis.hasNarrowSystemIgnore) {
      const fix = ensureSystemGitignoreEntry(resolved.currentProjectRoot);
      fixes.push({
        id: 'layout.gitignore-system',
        status: fix.status,
        summary: fix.summary,
        details: fix.details
      });
      layout = inspectProjectLayout(resolved.currentProjectRoot);
    } else if (args.fix && !layout.ignoreAnalysis.hasNarrowSystemIgnore) {
      fixes.push({
        id: 'layout.gitignore-system',
        status: 'skipped',
        summary: 'Runtime-state gitignore entry was not added because `--yes` was not provided.'
      });
    }
    addLayoutChecks(checks, layout);

    const portAvailable = await canListen(resolved.host.host, resolved.port.port);
    addCheck(checks, {
      id: 'server.port',
      title: 'Dashboard host and port are available',
      status: portAvailable ? 'ok' : 'failure',
      reason: resolved.port.port === 0 ? 'ephemeral_port' : portAvailable ? 'fixed_port_available' : 'port_unavailable',
      summary:
        resolved.port.port === 0
          ? `Dashboard will request an ephemeral port on ${resolved.host.host}.`
          : portAvailable
            ? `Dashboard can bind ${resolved.host.host}:${resolved.port.port}.`
            : `Dashboard cannot bind ${resolved.host.host}:${resolved.port.port}.`,
      remediation: portAvailable ? undefined : 'Choose a different port with `--port <number>` or stop the process using that port.',
      details: { host: resolved.host.host, port: resolved.port.port, source: resolved.port.source }
    });

    const posture = deps.resolveWorkflowPosture(resolved.workflowPath, dashboardEnv);
    consentSource = args.resolverArgv.includes('--i-understand-that-this-will-be-running-without-the-usual-guardrails')
      ? 'flag'
      : 'missing';
    const setupConsentStoreInProject = isWithinPath(resolved.currentProjectRoot, deps.setupConsentStore.path);
    if (consentSource === 'missing' && !setupConsentStoreInProject) {
      const consent = findValidSetupConsent({ store: deps.setupConsentStore, resolved, posture });
      consentSource = consent ? 'setup' : 'missing';
    }
    if (consentSource === 'missing' && args.fix && args.yes) {
      if (setupConsentStoreInProject) {
        fixes.push({
          id: 'setup-consent',
          status: 'failed',
          summary:
            'Refused to record setup consent because the configured local state path is inside the project checkout.',
          details: { storeLocation: 'project_checkout' }
        });
      } else {
        const record = buildSetupConsentRecord({
          resolved,
          posture,
          approvedAt: deps.clock().toISOString()
        });
        persistSetupConsent(deps.setupConsentStore, record);
        consentSource = 'setup';
        fixes.push({
          id: 'setup-consent',
          status: 'applied',
          summary: `Recorded explicit setup consent for identity ${record.identity_key}.`
        });
      }
    } else if (consentSource === 'missing' && args.fix) {
      fixes.push({
        id: 'setup-consent',
        status: 'skipped',
        summary: 'Setup consent was not recorded because `--yes` was not provided.'
      });
    }
    addCheck(checks, {
      id: 'setup.consent',
      title: 'High-trust setup consent is available',
      status: consentSource === 'missing' ? 'failure' : 'ok',
      reason: consentSource === 'missing' ? 'setup_consent_missing' : `setup_consent_${consentSource}`,
      summary:
        consentSource === 'missing'
          ? `No user-local setup consent exists for required posture ${posture.posture}.`
          : `Setup consent source is ${consentSource} for required posture ${posture.posture}.`,
      remediation:
        consentSource === 'missing'
          ? setupConsentStoreInProject
            ? 'Choose a user-local Symphony state path outside the project checkout, then rerun `symphony setup --yes` or `symphony doctor --fix --yes`.'
            : 'Run `symphony setup --yes` for this project/workflow, or rerun doctor with `--fix --yes` to record explicit local consent.'
          : undefined,
      details: { posture: posture.posture, reason: posture.reason, evidence: posture.evidence }
    });
    addCheck(checks, {
      id: 'dashboard.prerequisites',
      title: 'Dashboard supervisor prerequisites are present',
      status: fs.existsSync(path.join(deps.repoRoot, 'scripts', 'start-dashboard-supervisor.js')) ? 'ok' : 'failure',
      reason: fs.existsSync(path.join(deps.repoRoot, 'scripts', 'start-dashboard-supervisor.js'))
        ? 'dashboard_supervisor_ready'
        : 'dashboard_supervisor_missing',
      summary: fs.existsSync(path.join(deps.repoRoot, 'scripts', 'start-dashboard-supervisor.js'))
        ? 'Dashboard supervisor script is present.'
        : 'Dashboard supervisor script is missing.',
      remediation: fs.existsSync(path.join(deps.repoRoot, 'scripts', 'start-dashboard-supervisor.js'))
        ? undefined
        : 'Refresh the Symphony checkout or rebuild before launching the dashboard.'
    });
  } catch (error) {
    const reason = error instanceof LocalCommandResolutionError ? error.code : 'resolver_failed';
    const message = error instanceof Error ? error.message : String(error);
    addCheck(checks, {
      id: 'resolver.workflow',
      title: 'Project workflow resolves',
      status: 'failure',
      reason,
      summary: message,
      remediation: 'Run from a project containing WORKFLOW.md or pass `--workflow <path>`.'
    });
  }

  const summary = summarizeStatus(checks);
  const result: DoctorJsonResult = {
    version: 1,
    command: 'doctor',
    status: summary.status,
    reason: summary.reason,
    exitCode: summary.exitCode,
    ci: args.ci,
    fix: args.fix,
    cwd: deps.cwd,
    symphonyCheckoutRoot: deps.repoRoot,
    resolution: {
      projectRoot: resolved?.currentProjectRoot ?? null,
      workflowPath: resolved?.workflowPath ?? null,
      envFilePath: resolved?.envFilePath ?? null,
      profile: resolved?.profile.name ?? null,
      host: resolved?.host.host ?? null,
      port: resolved?.port.port ?? null,
      ephemeralPort: resolved ? resolved.port.port === 0 : null,
      consent: consentSource
    },
    layout,
    checks,
    fixes
  };

  return { result, human: renderHuman(result) };
}
