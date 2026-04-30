import os from 'node:os';
import path from 'node:path';

import { DEFAULT_LOG_ROTATION_MAX_BYTES, DEFAULT_LOG_ROTATION_MAX_FILES } from '../observability';
import { WorkflowConfigError } from './errors';
import type { EffectiveConfig, WorkflowDefinition } from './types';

interface ResolverOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  tmpdir?: () => string;
}

interface ResolveOptions {
  workflowPath?: string;
}

const DEFAULT_LINEAR_ACTIVE_STATES = ['Todo', 'In Progress'];
const DEFAULT_LINEAR_TERMINAL_STATES = ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done'];
const DEFAULT_GITHUB_ACTIVE_STATES = ['Open'];
const DEFAULT_GITHUB_TERMINAL_STATES = ['Closed'];

function getDefaultActiveStates(trackerKind: string): string[] {
  if (trackerKind === 'github') {
    return DEFAULT_GITHUB_ACTIVE_STATES;
  }

  return DEFAULT_LINEAR_ACTIVE_STATES;
}

function getDefaultTerminalStates(trackerKind: string): string[] {
  if (trackerKind === 'github') {
    return DEFAULT_GITHUB_TERMINAL_STATES;
  }

  return DEFAULT_LINEAR_TERMINAL_STATES;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function parseApprovalPolicy(
  value: unknown
):
  | string
  | {
      reject?: {
        sandbox_approval?: boolean;
        rules?: boolean;
        mcp_elicitations?: boolean;
      };
    }
  | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const rejectRaw = record.reject;
  if (typeof rejectRaw !== 'object' || rejectRaw === null || Array.isArray(rejectRaw)) {
    return {};
  }

  const rejectRecord = rejectRaw as Record<string, unknown>;
  const reject: {
    sandbox_approval?: boolean;
    rules?: boolean;
    mcp_elicitations?: boolean;
  } = {};

  if (typeof rejectRecord.sandbox_approval === 'boolean') {
    reject.sandbox_approval = rejectRecord.sandbox_approval;
  }
  if (typeof rejectRecord.rules === 'boolean') {
    reject.rules = rejectRecord.rules;
  }
  if (typeof rejectRecord.mcp_elicitations === 'boolean') {
    reject.mcp_elicitations = rejectRecord.mcp_elicitations;
  }

  return Object.keys(reject).length > 0 ? { reject } : {};
}

function readInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) {
    return parseInt(value, 10);
  }

  return fallback;
}

function readIntStrict(value: unknown, fallback: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value === 'string' && value.trim().length === 0) {
    return fallback;
  }

  return readInt(value, Number.NaN);
}

function readString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    return value;
  }

  return fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }

  return fallback;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  return value.filter((entry): entry is string => typeof entry === 'string');
}

function resolveEnvToken(value: string, env: NodeJS.ProcessEnv): string {
  if (!value.startsWith('$')) {
    return value;
  }

  const varName = value.slice(1);
  if (!varName) {
    return '';
  }

  return env[varName] ?? '';
}

function expandHome(value: string, homedir: string): string {
  if (value === '~') {
    return homedir;
  }

  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homedir, value.slice(2));
  }

  return value;
}

function hasPathSeparator(value: string): boolean {
  return (
    value.includes('/') ||
    value.includes('\\') ||
    value === '~' ||
    value.startsWith('~/') ||
    value.startsWith('~\\') ||
    value === '.' ||
    value === '..'
  );
}

function resolvePathLikeValue(
  value: unknown,
  env: NodeJS.ProcessEnv,
  homedir: string,
  fallback: string,
  options?: {
    relativeBaseDir?: string;
  }
): string {
  const raw = readString(value, fallback);
  const envResolved = resolveEnvToken(raw, env);
  const homeResolved = expandHome(envResolved, homedir);

  if (!hasPathSeparator(homeResolved)) {
    return homeResolved;
  }

  if (!path.isAbsolute(homeResolved) && options?.relativeBaseDir) {
    return path.normalize(path.resolve(options.relativeBaseDir, homeResolved));
  }

  return path.normalize(homeResolved);
}

function normalizePerStateMap(value: unknown): Record<string, number> {
  const record = asRecord(value);
  const out: Record<string, number> = {};

  for (const [key, raw] of Object.entries(record)) {
    const parsed = readIntStrict(raw, Number.NaN);
    out[key.toLowerCase()] = parsed;
  }

  return out;
}

export class ConfigResolver {
  private readonly env: NodeJS.ProcessEnv;
  private readonly homedir: () => string;
  private readonly tmpdir: () => string;

  constructor(options: ResolverOptions = {}) {
    this.env = options.env ?? process.env;
    this.homedir = options.homedir ?? os.homedir;
    this.tmpdir = options.tmpdir ?? os.tmpdir;
  }

  resolve(workflowDefinition: WorkflowDefinition, options: ResolveOptions = {}): EffectiveConfig {
    const config = asRecord(workflowDefinition.config);

    const tracker = asRecord(config.tracker);
    const polling = asRecord(config.polling);
    const workspace = asRecord(config.workspace);
    const provisioner = asRecord(workspace.provisioner);
    const copyIgnored = asRecord(workspace.copy_ignored);
    const hooks = asRecord(config.hooks);
    const agent = asRecord(config.agent);
    const codex = asRecord(config.codex);
    const persistence = asRecord(config.persistence);
    const observability = asRecord(config.observability);
    const validation = asRecord(config.validation);
    const logging = asRecord(config.logging);
    const worker = asRecord(config.worker);
    const server = asRecord(config.server);

    const trackerKind = readString(tracker.kind, '');
    const trackerEndpoint =
      resolveEnvToken(readString(tracker.endpoint, ''), this.env) ||
      (trackerKind === 'linear'
        ? 'https://api.linear.app/graphql'
        : trackerKind === 'github'
          ? 'https://api.github.com/graphql'
          : trackerKind === 'memory'
            ? 'memory://local'
          : '');

    const trackerApiKeySource =
      typeof tracker.api_key === 'string'
        ? tracker.api_key
        : trackerKind === 'linear'
          ? '$LINEAR_API_KEY'
          : trackerKind === 'github'
            ? '$GITHUB_TOKEN'
            : trackerKind === 'memory'
              ? ''
            : '';
    const trackerApiKey = resolveEnvToken(trackerApiKeySource, this.env);

    const trackerProjectSlug = resolveEnvToken(readString(tracker.project_slug, ''), this.env);
    const trackerAssignee = resolveEnvToken(readString(tracker.assignee, ''), this.env);
    const trackerOwner = resolveEnvToken(readString(tracker.owner, ''), this.env);
    const trackerRepo = resolveEnvToken(readString(tracker.repo, ''), this.env);
    const trackerGithubLinking = asRecord(tracker.github_linking);
    const trackerGithubLinkingMode = readString(trackerGithubLinking.mode, 'off').trim() || 'off';

    const workflowResolvedPath =
      typeof options.workflowPath === 'string' && options.workflowPath.trim().length > 0
        ? path.resolve(options.workflowPath)
        : null;
    const workflowDir = workflowResolvedPath ? path.dirname(workflowResolvedPath) : this.homedir();
    const workspaceRoot = resolvePathLikeValue(
      workspace.root,
      this.env,
      this.homedir(),
      path.join(this.tmpdir(), 'symphony_workspaces'),
      {
        relativeBaseDir: workflowResolvedPath ? workflowDir : undefined
      }
    );
    const workspaceRootSource =
      typeof workspace.root === 'string' && workspace.root.trim().length > 0 && workspaceRoot.trim().length > 0
        ? 'workflow'
        : 'default';
    const provisionerType = readString(provisioner.type, 'none').trim() || 'none';
    const provisionerRepoRootCandidate = resolvePathLikeValue(
      provisioner.repo_root,
      this.env,
      this.homedir(),
      '',
      {
        relativeBaseDir: workflowResolvedPath ? workflowDir : undefined
      }
    );
    const provisionerRepoRoot = provisionerRepoRootCandidate.trim().length > 0 ? provisionerRepoRootCandidate : undefined;
    const provisionerBaseRef = readString(provisioner.base_ref, 'origin/main').trim() || 'origin/main';
    const provisionerBranchTemplate =
      readString(provisioner.branch_template, 'feature/{{ issue.identifier }}').trim() || 'feature/{{ issue.identifier }}';
    const provisionerTeardownMode = readString(provisioner.teardown_mode, 'remove_worktree').trim() || 'remove_worktree';
    const provisionerAllowDirtyRepo = readBoolean(provisioner.allow_dirty_repo, false);
    const provisionerFallbackToCloneOnWorktreeFailure = readBoolean(
      provisioner.fallback_to_clone_on_worktree_failure,
      false
    );
    const copyIgnoredEnabled = readBoolean(copyIgnored.enabled, false);
    const copyIgnoredIncludeFileRaw = readString(copyIgnored.include_file, '.worktreeinclude').trim() || '.worktreeinclude';
    const copyIgnoredIncludeFile = path.isAbsolute(copyIgnoredIncludeFileRaw)
      ? copyIgnoredIncludeFileRaw
      : path.resolve(workflowDir, copyIgnoredIncludeFileRaw);
    const copyIgnoredFrom = readString(copyIgnored.from, 'primary_worktree').trim() || 'primary_worktree';
    const copyIgnoredConflictPolicy = readString(copyIgnored.conflict_policy, 'skip').trim() || 'skip';
    const copyIgnoredRequireGitignored = readBoolean(copyIgnored.require_gitignored, true);
    const copyIgnoredMaxFiles = readInt(copyIgnored.max_files, 10_000);
    const copyIgnoredMaxTotalBytes = readInt(copyIgnored.max_total_bytes, 5 * 1024 * 1024 * 1024);
    const copyIgnoredAllowPatterns = readStringList(copyIgnored.allow_patterns, []);
    const copyIgnoredDenyPatterns = readStringList(copyIgnored.deny_patterns, []);
    if (copyIgnoredEnabled && !isContainedPath(workflowDir, copyIgnoredIncludeFile)) {
      throw new WorkflowConfigError(
        'invalid_workspace_copy_ignored_include_file',
        'workspace.copy_ignored.include_file must be contained in the workflow directory'
      );
    }

    const hooksTimeoutMs = readIntStrict(hooks.timeout_ms, 60000);

    const codexCommand = readString(codex.command, 'codex app-server');
    const workflowScopedPersistencePath =
      workflowResolvedPath !== null
        ? path.join(workflowDir, '.symphony', 'runtime.sqlite')
        : path.join(this.homedir(), '.symphony', 'runtime.sqlite');

    const persistenceDbPath = resolvePathLikeValue(
      persistence.db_path,
      this.env,
      this.homedir(),
      workflowScopedPersistencePath
    );
    const defaultLoggingRoot = path.join(workflowDir, '.symphony', 'log');
    const resolvedLoggingRootCandidate = resolvePathLikeValue(logging.root, this.env, this.homedir(), defaultLoggingRoot);
    const loggingRootSource =
      typeof logging.root === 'string' && logging.root.trim().length > 0 && resolvedLoggingRootCandidate.trim().length > 0
        ? 'workflow'
        : 'default';
    const loggingRoot =
      resolvedLoggingRootCandidate.trim().length > 0 ? resolvedLoggingRootCandidate : defaultLoggingRoot;
    const loggingMaxBytes = readInt(logging.max_bytes, DEFAULT_LOG_ROTATION_MAX_BYTES);
    const loggingMaxFiles = readInt(logging.max_files, DEFAULT_LOG_ROTATION_MAX_FILES);
    const uiEvidenceProfile = readString(validation.ui_evidence_profile, 'baseline').trim().toLowerCase() || 'baseline';

    const resolved: EffectiveConfig = {
      tracker: {
        kind: trackerKind,
        endpoint: trackerEndpoint,
        api_key: trackerApiKey,
        project_slug: trackerProjectSlug,
        assignee: trackerAssignee || undefined,
        owner: trackerOwner,
        repo: trackerRepo,
        github_linking: {
          mode: trackerGithubLinkingMode
        },
        active_states: readStringList(tracker.active_states, getDefaultActiveStates(trackerKind)),
        terminal_states: readStringList(tracker.terminal_states, getDefaultTerminalStates(trackerKind))
      },
      polling: {
        interval_ms: readIntStrict(polling.interval_ms, 30000)
      },
      workspace: {
        root: workspaceRoot,
        root_source: workspaceRootSource,
        provisioner: {
          type: provisionerType,
          ...(provisionerRepoRoot ? { repo_root: provisionerRepoRoot } : {}),
          base_ref: provisionerBaseRef,
          branch_template: provisionerBranchTemplate,
          teardown_mode: provisionerTeardownMode,
          allow_dirty_repo: provisionerAllowDirtyRepo,
          fallback_to_clone_on_worktree_failure: provisionerFallbackToCloneOnWorktreeFailure
        },
        copy_ignored: {
          enabled: copyIgnoredEnabled,
          include_file: copyIgnoredIncludeFile,
          from: copyIgnoredFrom,
          conflict_policy: copyIgnoredConflictPolicy,
          require_gitignored: copyIgnoredRequireGitignored,
          max_files: copyIgnoredMaxFiles,
          max_total_bytes: copyIgnoredMaxTotalBytes,
          allow_patterns: copyIgnoredAllowPatterns,
          deny_patterns: copyIgnoredDenyPatterns
        }
      },
      hooks: {
        after_create: readString(hooks.after_create, '') || undefined,
        before_run: readString(hooks.before_run, '') || undefined,
        after_run: readString(hooks.after_run, '') || undefined,
        before_remove: readString(hooks.before_remove, '') || undefined,
        timeout_ms: hooksTimeoutMs
      },
      agent: {
        max_concurrent_agents: readIntStrict(agent.max_concurrent_agents, 10),
        max_retry_backoff_ms: readIntStrict(agent.max_retry_backoff_ms, 300000),
        max_turns: readIntStrict(agent.max_turns, 20),
        max_concurrent_agents_by_state: normalizePerStateMap(agent.max_concurrent_agents_by_state)
      },
      codex: {
        command: codexCommand,
        security_profile: readString(codex.security_profile, '') || undefined,
        approval_policy: parseApprovalPolicy(codex.approval_policy),
        thread_sandbox: readString(codex.thread_sandbox, '') || undefined,
        turn_sandbox_policy: readString(codex.turn_sandbox_policy, '') || undefined,
        user_input_policy: readString(codex.user_input_policy, '') || undefined,
        turn_timeout_ms: readIntStrict(codex.turn_timeout_ms, 3600000),
        read_timeout_ms: readIntStrict(codex.read_timeout_ms, 5000),
        stall_timeout_ms: readIntStrict(codex.stall_timeout_ms, 300000)
      },
      persistence: {
        enabled: readBoolean(persistence.enabled, true),
        db_path: persistenceDbPath,
        retention_days: Math.max(1, readInt(persistence.retention_days, 14))
      },
      observability: {
        dashboard_enabled: readBoolean(observability.dashboard_enabled, true),
        refresh_ms: Math.max(500, readInt(observability.refresh_ms, 4000)),
        render_interval_ms: Math.max(250, readInt(observability.render_interval_ms, 1000)),
        phase_markers_enabled: readBoolean(observability.phase_markers_enabled, true),
        phase_timeline_limit: Math.max(1, readInt(observability.phase_timeline_limit, 30)),
        phase_stale_warn_ms: Math.max(1000, readInt(observability.phase_stale_warn_ms, 45000))
      },
      validation: {
        ui_evidence_profile: uiEvidenceProfile
      },
      logging: {
        root: loggingRoot,
        root_source: loggingRootSource,
        max_bytes: loggingMaxBytes,
        max_files: loggingMaxFiles
      }
    };

    const sshHosts = readStringList(worker.ssh_hosts, []).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    const maxConcurrentAgentsPerHost = readInt(worker.max_concurrent_agents_per_host, NaN);
    if (sshHosts.length > 0 || Number.isFinite(maxConcurrentAgentsPerHost)) {
      resolved.worker = {
        ...(sshHosts.length > 0 ? { ssh_hosts: sshHosts } : {}),
        ...(Number.isFinite(maxConcurrentAgentsPerHost)
          ? { max_concurrent_agents_per_host: maxConcurrentAgentsPerHost }
          : {})
      };
    }

    const serverPort = readInt(server.port, NaN);
    if (Number.isFinite(serverPort)) {
      resolved.server = {
        port: serverPort,
        host: readString(server.host, '') || undefined
      };
    }

    return resolved;
  }
}
