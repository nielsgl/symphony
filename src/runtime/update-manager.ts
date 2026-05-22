import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { REASON_CODES } from '../observability';
import type {
  ApiRuntimeBuildIdentityProjection,
  ApiRuntimeUpdateActionResponse,
  ApiRuntimeUpdateGithubEligibility,
  ApiRuntimeUpdateReadiness,
  LocalApiServerOptions
} from '../api/types';

const DEFAULT_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 4_000;
const PACKAGE_METADATA_FILES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']);

type CommandStatus = 'succeeded' | 'failed' | 'timeout' | 'skipped';

interface CommandResult {
  step: 'fetch' | 'pull' | 'install' | 'build';
  command: string[];
  cwd: string;
  status: CommandStatus;
  exit_code: number | null;
  duration_ms: number;
  stdout_excerpt: string;
  stderr_excerpt: string;
  reason_code: string | null;
}

export interface LocalRuntimeUpdateManagerOptions {
  repoRoot: string | null;
  baseRef: string | null;
  remote?: string;
  githubEligibilityMode?: ApiRuntimeUpdateGithubEligibility['mode'];
  githubEligibilityResolver?: (params: {
    repoRoot: string;
    remote: string;
    remoteUrl: string;
    baseRef: string;
    candidateSha: string | null;
    mode: ApiRuntimeUpdateGithubEligibility['mode'];
    nowMs: () => number;
    timeoutMs: number;
  }) => ApiRuntimeUpdateGithubEligibility;
  nowMs?: () => number;
  commandTimeoutMs?: number;
  discoveryFetchIntervalMs?: number;
  runtimeIdentity: () => ApiRuntimeBuildIdentityProjection | null;
  auditSink?: LocalApiServerOptions['drainAuditSink'];
  restartCommand?: string[];
}

interface GitProbe {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
  timedOut: boolean;
}

interface GitHubRemote {
  owner: string;
  repo: string;
}

function truncate(value: string): string {
  if (value.length <= OUTPUT_LIMIT) {
    return value;
  }
  return `${value.slice(0, OUTPUT_LIMIT)}\n[truncated ${value.length - OUTPUT_LIMIT} bytes]`;
}

function isSafeRepoRoot(repoRoot: string | null): repoRoot is string {
  return !!repoRoot && path.isAbsolute(repoRoot);
}

function normalizeBaseRef(baseRef: string | null | undefined, remote: string): string {
  const ref = (baseRef || 'main').trim();
  const remotePrefix = `${remote}/`;
  if (ref.startsWith(remotePrefix)) {
    return ref.slice(remotePrefix.length);
  }
  if (ref.startsWith('refs/heads/')) {
    return ref.slice('refs/heads/'.length);
  }
  return ref || 'main';
}

function git(repoRoot: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): GitProbe {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 256 * 1024,
    shell: false
  });
  const timedOut = result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  return {
    ok: result.status === 0 && !timedOut,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    status: result.status,
    timedOut: !!timedOut
  };
}

function command(repoRoot: string, step: CommandResult['step'], argv: string[], timeoutMs: number): CommandResult {
  const startedAt = Date.now();
  const result = spawnSync(argv[0]!, argv.slice(1), {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 512 * 1024,
    shell: false
  });
  const timedOut = result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  const status: CommandStatus = timedOut ? 'timeout' : result.status === 0 ? 'succeeded' : 'failed';
  return {
    step,
    command: argv,
    cwd: repoRoot,
    status,
    exit_code: result.status,
    duration_ms: Math.max(0, Date.now() - startedAt),
    stdout_excerpt: truncate(result.stdout || ''),
    stderr_excerpt: truncate(result.stderr || ''),
    reason_code: status === 'succeeded' ? null : timedOut ? `${step}_timeout` : `${step}_failed`
  };
}

function parseGitHubRemote(remoteUrl: string): GitHubRemote | null {
  const normalized = remoteUrl.trim().replace(/\.git$/i, '');
  const httpsMatch = normalized.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (httpsMatch) {
    return { owner: httpsMatch[1]!, repo: httpsMatch[2]! };
  }
  const sshMatch = normalized.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (sshMatch) {
    return { owner: sshMatch[1]!, repo: sshMatch[2]! };
  }
  return null;
}

function emptyCheckSummary(): ApiRuntimeUpdateGithubEligibility['check_summary'] {
  return { total: null, succeeded: null, pending: null, failed: null, skipped: null };
}

function githubEligibility(params: Partial<ApiRuntimeUpdateGithubEligibility>): ApiRuntimeUpdateGithubEligibility {
  return {
    mode: params.mode ?? 'required',
    state: params.state ?? 'github_candidate_unknown',
    provider: params.provider ?? 'none',
    owner: params.owner ?? null,
    repo: params.repo ?? null,
    base_ref: params.base_ref ?? null,
    candidate_sha: params.candidate_sha ?? null,
    checked_at: params.checked_at ?? null,
    reason_code: params.reason_code ?? null,
    check_summary: params.check_summary ?? emptyCheckSummary()
  };
}

function defaultGithubEligibilityResolver(params: {
  repoRoot: string;
  remoteUrl: string;
  baseRef: string;
  candidateSha: string | null;
  mode: ApiRuntimeUpdateGithubEligibility['mode'];
  nowMs: () => number;
  timeoutMs: number;
}): ApiRuntimeUpdateGithubEligibility {
  const remote = parseGitHubRemote(params.remoteUrl);
  if (!remote) {
    return githubEligibility({
      mode: params.mode,
      state: params.mode === 'trust_raw_git' ? 'github_trusted_raw_git' : 'github_not_configured',
      provider: 'none',
      base_ref: params.baseRef,
      candidate_sha: params.candidateSha,
      reason_code: params.mode === 'trust_raw_git' ? null : REASON_CODES.runtimeUpdateGithubEligibilityRequired
    });
  }
  if (params.mode === 'trust_raw_git') {
    return githubEligibility({
      mode: params.mode,
      state: 'github_trusted_raw_git',
      provider: 'github',
      owner: remote.owner,
      repo: remote.repo,
      base_ref: params.baseRef,
      candidate_sha: params.candidateSha,
      checked_at: new Date(params.nowMs()).toISOString()
    });
  }
  if (!params.candidateSha) {
    return githubEligibility({
      mode: params.mode,
      state: 'github_candidate_unknown',
      provider: 'github',
      owner: remote.owner,
      repo: remote.repo,
      base_ref: params.baseRef,
      checked_at: new Date(params.nowMs()).toISOString(),
      reason_code: REASON_CODES.runtimeUpdateGithubEligibilityRequired
    });
  }

  const result = spawnSync('gh', [
    'api',
    `repos/${remote.owner}/${remote.repo}/commits/${params.candidateSha}/check-runs`,
    '--jq',
    '[.check_runs[] | {status, conclusion}]'
  ], {
    cwd: params.repoRoot,
    encoding: 'utf8',
    timeout: params.timeoutMs,
    maxBuffer: 256 * 1024,
    shell: false
  });
  const timedOut = result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  if (timedOut || result.status !== 0) {
    return githubEligibility({
      mode: params.mode,
      state: 'github_unavailable',
      provider: 'github',
      owner: remote.owner,
      repo: remote.repo,
      base_ref: params.baseRef,
      candidate_sha: params.candidateSha,
      checked_at: new Date(params.nowMs()).toISOString(),
      reason_code: REASON_CODES.runtimeUpdateGithubEligibilityRequired
    });
  }

  let checks: Array<{ status?: string | null; conclusion?: string | null }>;
  try {
    checks = JSON.parse(result.stdout || '[]');
  } catch {
    return githubEligibility({
      mode: params.mode,
      state: 'github_unavailable',
      provider: 'github',
      owner: remote.owner,
      repo: remote.repo,
      base_ref: params.baseRef,
      candidate_sha: params.candidateSha,
      checked_at: new Date(params.nowMs()).toISOString(),
      reason_code: REASON_CODES.runtimeUpdateGithubEligibilityRequired
    });
  }
  const summary = checks.reduce(
    (acc, check) => {
      acc.total += 1;
      if (check.status !== 'completed') {
        acc.pending += 1;
      } else if (check.conclusion === 'success' || check.conclusion === 'neutral') {
        acc.succeeded += 1;
      } else if (check.conclusion === 'skipped') {
        acc.skipped += 1;
      } else {
        acc.failed += 1;
      }
      return acc;
    },
    { total: 0, succeeded: 0, pending: 0, failed: 0, skipped: 0 }
  );
  const state = summary.failed > 0
    ? 'github_checks_failed'
    : summary.pending > 0
      ? 'github_checks_pending'
      : summary.total === 0
        ? params.mode === 'allow_absent_checks'
          ? 'github_checks_absent_allowed'
          : 'github_candidate_unknown'
        : 'github_verified';
  return githubEligibility({
    mode: params.mode,
    state,
    provider: 'github',
    owner: remote.owner,
    repo: remote.repo,
    base_ref: params.baseRef,
    candidate_sha: params.candidateSha,
    checked_at: new Date(params.nowMs()).toISOString(),
    reason_code: state === 'github_verified' || state === 'github_checks_absent_allowed'
      ? null
      : REASON_CODES.runtimeUpdateGithubEligibilityRequired,
    check_summary: summary
  });
}

function isGithubEligible(eligibility: ApiRuntimeUpdateGithubEligibility): boolean {
  return [
    'github_verified',
    'github_checks_absent_allowed',
    'github_trusted_raw_git'
  ].includes(eligibility.state);
}

function githubEligibilityRefusal(eligibility: ApiRuntimeUpdateGithubEligibility): string | null {
  return isGithubEligible(eligibility) ? null : eligibility.reason_code ?? REASON_CODES.runtimeUpdateGithubEligibilityRequired;
}

function skipped(repoRoot: string, step: CommandResult['step'], argv: string[], reasonCode: string): CommandResult {
  return {
    step,
    command: argv,
    cwd: repoRoot,
    status: 'skipped',
    exit_code: null,
    duration_ms: 0,
    stdout_excerpt: '',
    stderr_excerpt: '',
    reason_code: reasonCode
  };
}

function stateForReadiness(params: {
  repoRoot: string | null;
  branch: string | null;
  baseRef: string | null;
  dirty: boolean | null;
  detached: boolean;
  remoteConfigured: boolean;
  remoteSha: string | null;
  localSha: string | null;
  ahead: number | null;
  behind: number | null;
  runtimeIdentity: ApiRuntimeBuildIdentityProjection | null;
  fetchFailed?: boolean;
}): Pick<ApiRuntimeUpdateReadiness, 'state' | 'attention_required' | 'drain_required' | 'build_status' | 'recommended_action' | 'refusal_reasons'> {
  if (!isSafeRepoRoot(params.repoRoot) || !params.localSha) {
    return {
      state: 'unknown',
      attention_required: false,
      drain_required: false,
      build_status: 'unknown',
      recommended_action: 'inspect_status',
      refusal_reasons: [REASON_CODES.runtimeUpdateRepositoryUnavailable]
    };
  }
  if (!params.remoteConfigured) {
    return {
      state: 'no_remote_configured',
      attention_required: false,
      drain_required: false,
      build_status: 'unknown',
      recommended_action: 'inspect_status',
      refusal_reasons: ['no_remote_configured']
    };
  }
  if (params.fetchFailed) {
    return {
      state: 'fetch_unavailable',
      attention_required: false,
      drain_required: false,
      build_status: 'unknown',
      recommended_action: 'retry_fetch',
      refusal_reasons: ['fetch_unavailable']
    };
  }
  if (params.dirty) {
    return {
      state: 'dirty_worktree',
      attention_required: false,
      drain_required: false,
      build_status: 'unknown',
      recommended_action: 'inspect_worktree',
      refusal_reasons: ['dirty_worktree']
    };
  }
  if (params.detached || (params.branch && params.baseRef && params.branch !== params.baseRef)) {
    return {
      state: 'branch_mismatch',
      attention_required: false,
      drain_required: false,
      build_status: 'unknown',
      recommended_action: 'resolve_branch',
      refusal_reasons: ['branch_mismatch']
    };
  }
  if (params.ahead && params.ahead > 0 && params.behind && params.behind > 0) {
    return {
      state: 'non_fast_forward_required',
      attention_required: false,
      drain_required: false,
      build_status: 'unknown',
      recommended_action: 'resolve_history',
      refusal_reasons: ['non_fast_forward_required']
    };
  }
  if (params.behind && params.behind > 0) {
    return {
      state: 'local_checkout_behind',
      attention_required: true,
      drain_required: true,
      build_status: 'current',
      recommended_action: 'prepare_update',
      refusal_reasons: []
    };
  }
  if (params.remoteSha && params.remoteSha !== params.localSha) {
    return {
      state: 'remote_update_available',
      attention_required: true,
      drain_required: true,
      build_status: 'current',
      recommended_action: 'prepare_update',
      refusal_reasons: []
    };
  }
  if (params.runtimeIdentity?.status === 'stale') {
    return {
      state: 'runtime_stale',
      attention_required: true,
      drain_required: true,
      build_status: 'runtime_stale',
      recommended_action: 'prepare_update',
      refusal_reasons: []
    };
  }
  if (
    params.runtimeIdentity?.current_build.status === 'available' &&
    params.runtimeIdentity.current_build.commit_sha &&
    params.runtimeIdentity.current_build.commit_sha !== params.localSha
  ) {
    return {
      state: 'source_changed_build_not_updated',
      attention_required: true,
      drain_required: true,
      build_status: 'source_changed_build_not_updated',
      recommended_action: 'rebuild',
      refusal_reasons: []
    };
  }
  return {
    state: 'build_current',
    attention_required: false,
    drain_required: false,
    build_status: 'current',
    recommended_action: 'none',
    refusal_reasons: []
  };
}

function isActionableReadiness(readiness: ApiRuntimeUpdateReadiness | null): boolean {
  return !!readiness && [
    'local_checkout_behind',
    'remote_update_available',
    'runtime_stale',
    'source_changed_build_not_updated'
  ].includes(readiness.state);
}

function shouldRunDiscoveryFetch(
  previousFetch: ApiRuntimeUpdateReadiness['last_fetch'] | undefined,
  nowMs: number,
  intervalMs: number
): boolean {
  if (!previousFetch || previousFetch.result === 'not_attempted' || !previousFetch.completed_at) {
    return true;
  }
  const completedAtMs = Date.parse(previousFetch.completed_at);
  if (!Number.isFinite(completedAtMs)) {
    return true;
  }
  return nowMs - completedAtMs >= intervalMs;
}

export function detectRuntimeUpdateReadiness(options: {
  repoRoot: string | null;
  baseRef: string | null;
  remote?: string;
  githubEligibilityMode?: ApiRuntimeUpdateGithubEligibility['mode'];
  githubEligibilityResolver?: LocalRuntimeUpdateManagerOptions['githubEligibilityResolver'];
  runtimeIdentity: ApiRuntimeBuildIdentityProjection | null;
  nowMs?: () => number;
  fetch?: boolean;
  timeoutMs?: number;
  previousFetch?: ApiRuntimeUpdateReadiness['last_fetch'];
}): ApiRuntimeUpdateReadiness {
  const nowMs = options.nowMs ?? (() => Date.now());
  const repoRoot = options.repoRoot;
  const remote = options.remote ?? 'origin';
  const githubEligibilityMode = options.githubEligibilityMode ?? 'required';
  const baseRef = normalizeBaseRef(options.baseRef, remote);
  const unresolvedGithubEligibility = githubEligibility({
    mode: githubEligibilityMode,
    state: 'github_candidate_unknown',
    base_ref: baseRef,
    reason_code: REASON_CODES.runtimeUpdateGithubEligibilityRequired
  });
  const fallbackFetch = options.previousFetch ?? {
    attempted_at: null,
    completed_at: null,
    result: 'not_attempted' as const,
    reason_code: null
  };
  if (!isSafeRepoRoot(repoRoot)) {
    const decision = stateForReadiness({
      repoRoot,
      branch: null,
      baseRef,
      dirty: null,
      detached: false,
      remoteConfigured: false,
      remoteSha: null,
      localSha: null,
      ahead: null,
      behind: null,
      runtimeIdentity: options.runtimeIdentity
    });
    return {
      ...decision,
      running_runtime_identity: options.runtimeIdentity,
      local_checkout: { branch: null, commit_sha: null, dirty: null, detached: false },
      fetched_remote: { remote, base_ref: baseRef, commit_sha: null },
      ahead_behind: { ahead: null, behind: null },
      last_fetch: fallbackFetch,
      github_eligibility: unresolvedGithubEligibility,
      prepared: false,
      apply_ready: false
    };
  }

  let lastFetch = fallbackFetch;
  if (options.fetch) {
    const attemptedAt = new Date(nowMs()).toISOString();
    const fetchResult = git(repoRoot, ['fetch', '--no-tags', '--prune', remote, baseRef], options.timeoutMs);
    lastFetch = {
      attempted_at: attemptedAt,
      completed_at: new Date(nowMs()).toISOString(),
      result: fetchResult.timedOut ? 'timeout' : fetchResult.ok ? 'succeeded' : 'failed',
      reason_code: fetchResult.ok ? null : fetchResult.timedOut ? 'fetch_timeout' : 'fetch_failed'
    };
  }

  const remoteUrl = git(repoRoot, ['remote', 'get-url', remote], options.timeoutMs);
  const branchProbe = git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], options.timeoutMs);
  const localProbe = git(repoRoot, ['rev-parse', 'HEAD'], options.timeoutMs);
  const statusProbe = git(repoRoot, ['status', '--porcelain=v1'], options.timeoutMs);
  const remoteProbe = git(repoRoot, ['rev-parse', '--verify', `refs/remotes/${remote}/${baseRef}`], options.timeoutMs);
  const branch = branchProbe.ok ? branchProbe.stdout : null;
  const detached = branch === 'HEAD';
  const localSha = localProbe.ok ? localProbe.stdout : null;
  const remoteSha = remoteProbe.ok ? remoteProbe.stdout : null;
  let ahead: number | null = null;
  let behind: number | null = null;
  if (localSha && remoteSha) {
    const counts = git(repoRoot, ['rev-list', '--left-right', '--count', `${localSha}...${remoteSha}`], options.timeoutMs);
    if (counts.ok) {
      const [aheadRaw, behindRaw] = counts.stdout.split(/\s+/).map((value) => Number(value));
      ahead = Number.isFinite(aheadRaw) ? aheadRaw : null;
      behind = Number.isFinite(behindRaw) ? behindRaw : null;
    }
  }
  const decision = stateForReadiness({
    repoRoot,
    branch,
    baseRef,
    dirty: statusProbe.ok ? statusProbe.stdout.length > 0 : null,
    detached,
    remoteConfigured: remoteUrl.ok,
    remoteSha,
    localSha,
    ahead,
    behind,
    runtimeIdentity: options.runtimeIdentity,
    fetchFailed: options.fetch && lastFetch.result !== 'succeeded'
  });
  const baseReadiness = {
    ...decision,
    running_runtime_identity: options.runtimeIdentity,
    local_checkout: {
      branch,
      commit_sha: localSha,
      dirty: statusProbe.ok ? statusProbe.stdout.length > 0 : null,
      detached
    },
    fetched_remote: {
      remote: remoteUrl.ok ? remote : null,
      base_ref: baseRef,
      commit_sha: remoteSha
    },
    ahead_behind: { ahead, behind },
    last_fetch: lastFetch,
    github_eligibility: unresolvedGithubEligibility,
    prepared: false,
    apply_ready: false
  } satisfies ApiRuntimeUpdateReadiness;
  const candidateSha = remoteSha ?? localSha;
  const githubResult = remoteUrl.ok && isActionableReadiness(baseReadiness)
    ? (options.githubEligibilityResolver ?? defaultGithubEligibilityResolver)({
        repoRoot,
        remote,
        remoteUrl: remoteUrl.stdout,
        baseRef,
        candidateSha,
        mode: githubEligibilityMode,
        nowMs,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      })
    : githubEligibility({
        mode: githubEligibilityMode,
        state: githubEligibilityMode === 'trust_raw_git' ? 'github_trusted_raw_git' : 'github_candidate_unknown',
        provider: remoteUrl.ok && parseGitHubRemote(remoteUrl.stdout) ? 'github' : 'none',
        ...(remoteUrl.ok && parseGitHubRemote(remoteUrl.stdout) ? parseGitHubRemote(remoteUrl.stdout)! : {}),
        base_ref: baseRef,
        candidate_sha: candidateSha,
        reason_code: isActionableReadiness(baseReadiness) ? REASON_CODES.runtimeUpdateGithubEligibilityRequired : null
      });
  const githubRefusal = isActionableReadiness(baseReadiness) ? githubEligibilityRefusal(githubResult) : null;
  return {
    ...baseReadiness,
    refusal_reasons: githubRefusal
      ? [...baseReadiness.refusal_reasons, REASON_CODES.runtimeUpdateGithubEligibilityRequired, githubRefusal]
      : baseReadiness.refusal_reasons,
    github_eligibility: githubResult
  };
}

export class LocalRuntimeUpdateManager {
  private readonly options: LocalRuntimeUpdateManagerOptions;
  private readiness: ApiRuntimeUpdateReadiness | null;
  private prepareStarted = false;
  private prepareAccepted = false;
  private applyInFlight: Promise<ApiRuntimeUpdateActionResponse> | null = null;
  private completedApplyResult: ApiRuntimeUpdateActionResponse | null = null;

  constructor(options: LocalRuntimeUpdateManagerOptions) {
    this.options = options;
    this.readiness = null;
  }

  readUpdateReadiness(): ApiRuntimeUpdateReadiness | null {
    const nowMs = this.options.nowMs ?? (() => Date.now());
    const discoveryFetchIntervalMs = this.options.discoveryFetchIntervalMs ?? 60_000;
    this.readiness = this.withPreparedState(detectRuntimeUpdateReadiness({
      repoRoot: this.options.repoRoot,
      baseRef: this.options.baseRef,
      remote: this.options.remote,
      githubEligibilityMode: this.options.githubEligibilityMode,
      githubEligibilityResolver: this.options.githubEligibilityResolver,
      runtimeIdentity: this.options.runtimeIdentity(),
      nowMs,
      timeoutMs: this.options.commandTimeoutMs,
      fetch: shouldRunDiscoveryFetch(this.readiness?.last_fetch, nowMs(), discoveryFetchIntervalMs),
      previousFetch: this.readiness?.last_fetch
    }));
    return this.readiness;
  }

  async prepareUpdate(_params?: { drain_mode: unknown }): Promise<ApiRuntimeUpdateActionResponse> {
    const idempotentReplay = this.prepareStarted;
    this.prepareStarted = true;
    await this.record('update-fetch-started', 'observed', 'fetch_started', {});
    this.readiness = detectRuntimeUpdateReadiness({
      repoRoot: this.options.repoRoot,
      baseRef: this.options.baseRef,
      remote: this.options.remote,
      githubEligibilityMode: this.options.githubEligibilityMode,
      githubEligibilityResolver: this.options.githubEligibilityResolver,
      runtimeIdentity: this.options.runtimeIdentity(),
      nowMs: this.options.nowMs,
      timeoutMs: this.options.commandTimeoutMs,
      fetch: true,
      previousFetch: this.readiness?.last_fetch
    });
    await this.record(
      this.readiness.last_fetch.result === 'succeeded' ? 'update-fetch-succeeded' : 'update-fetch-failed',
      this.readiness.last_fetch.result === 'succeeded' ? 'accepted' : 'failed',
      this.readiness.last_fetch.reason_code ?? 'fetch_succeeded',
      { fetch_result: this.readiness.last_fetch.result }
    );
    await this.record('update-detected', this.readiness.attention_required ? 'accepted' : 'observed', this.readiness.state, {
      state: this.readiness.state,
      recommended_action: this.readiness.recommended_action,
      fetch_result: this.readiness.last_fetch.result,
      github_eligibility: this.readiness.github_eligibility
    });
    const actionable = isActionableReadiness(this.readiness) && this.readiness.refusal_reasons.length === 0;
    this.prepareAccepted = actionable;
    this.readiness = this.withPreparedState(this.readiness);
    return {
      success: actionable,
      status: actionable ? 'draining' : 'refused',
      step: 'prepare',
      reason_code: this.readiness.refusal_reasons[0] ?? (actionable ? null : REASON_CODES.runtimeUpdateNotActionable),
      recommended_action: actionable ? 'wait_for_quiescence' : this.readiness.recommended_action,
      idempotent_replay: idempotentReplay,
      readiness: this.readiness,
      message: actionable
        ? 'Drain Mode entered; wait for quiescence before applying the update.'
        : 'Runtime update prepare refused by readiness checks.'
    };
  }

  async applyUpdate(_params?: { quiescence: unknown }): Promise<ApiRuntimeUpdateActionResponse> {
    if (!isSafeRepoRoot(this.options.repoRoot)) {
      return {
        success: false,
        status: 'refused',
        step: 'apply',
        reason_code: REASON_CODES.runtimeUpdateRepositoryUnavailable,
        recommended_action: 'inspect_status',
        idempotent_replay: false,
        readiness: this.readiness,
        message: 'Runtime update repository is unavailable.'
      };
    }

    if (this.completedApplyResult) {
      return {
        ...this.completedApplyResult,
        idempotent_replay: true
      };
    }
    const readiness = this.readiness ?? this.readUpdateReadiness();
    if (!this.prepareAccepted || !isActionableReadiness(readiness) || (readiness?.refusal_reasons.length ?? 0) > 0) {
      return {
        success: false,
        status: 'refused',
        step: 'apply',
        reason_code: !this.prepareAccepted ? REASON_CODES.runtimeUpdateNotPrepared : readiness?.refusal_reasons[0] ?? REASON_CODES.runtimeUpdateNotActionable,
        recommended_action: readiness?.recommended_action ?? 'inspect_status',
        idempotent_replay: false,
        readiness,
        command_results: [],
        message: 'Runtime update apply refused because no actionable prepared update is available.'
      };
    }
    if (this.applyInFlight) {
      return this.applyInFlight.then((result) => ({
        ...result,
        idempotent_replay: true
      }));
    }

    this.applyInFlight = this.runApplyUpdate(false)
      .then((result) => {
        if (result.success && result.status === 'manual_restart_required') {
          this.completedApplyResult = result;
        }
        return result;
      })
      .finally(() => {
        this.applyInFlight = null;
      });
    return this.applyInFlight;
  }

  private async runApplyUpdate(idempotentReplay: boolean): Promise<ApiRuntimeUpdateActionResponse> {
    const repoRoot = this.options.repoRoot;
    if (!isSafeRepoRoot(repoRoot)) {
      return {
        success: false,
        status: 'refused',
        step: 'apply',
        reason_code: REASON_CODES.runtimeUpdateRepositoryUnavailable,
        recommended_action: 'inspect_status',
        idempotent_replay: idempotentReplay,
        readiness: this.readiness,
        message: 'Runtime update repository is unavailable.'
      };
    }
    const timeoutMs = this.options.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const results: CommandResult[] = [];
    await this.record('update-fetch-started', 'observed', 'fetch_started', {});
    this.readiness = detectRuntimeUpdateReadiness({
      repoRoot,
      baseRef: this.options.baseRef,
      remote: this.options.remote,
      githubEligibilityMode: this.options.githubEligibilityMode,
      githubEligibilityResolver: this.options.githubEligibilityResolver,
      runtimeIdentity: this.options.runtimeIdentity(),
      nowMs: this.options.nowMs,
      timeoutMs,
      fetch: true,
      previousFetch: this.readiness?.last_fetch
    });
    await this.record(
      this.readiness.last_fetch.result === 'succeeded' ? 'update-fetch-succeeded' : 'update-fetch-failed',
      this.readiness.last_fetch.result === 'succeeded' ? 'accepted' : 'failed',
      this.readiness.last_fetch.reason_code ?? 'fetch_succeeded',
      { fetch_result: this.readiness.last_fetch.result }
    );
    if (this.readiness.refusal_reasons.length > 0) {
      await this.record('update-pull-refused', 'rejected', this.readiness.refusal_reasons[0] ?? 'readiness_refused', {
        state: this.readiness.state,
        github_eligibility: this.readiness.github_eligibility
      });
      return {
        success: false,
        status: 'refused',
        step: 'apply',
        reason_code: this.readiness.refusal_reasons[0] ?? 'readiness_refused',
        recommended_action: this.readiness.recommended_action,
        idempotent_replay: idempotentReplay,
        readiness: this.readiness,
        message: 'Runtime update apply refused by readiness checks.'
      };
    }
    if (!isActionableReadiness(this.readiness)) {
      await this.record('update-pull-refused', 'rejected', REASON_CODES.runtimeUpdateNotActionable, {
        state: this.readiness.state
      });
      return {
        success: false,
        status: 'refused',
        step: 'apply',
        reason_code: REASON_CODES.runtimeUpdateNotActionable,
        recommended_action: this.readiness.recommended_action,
        idempotent_replay: idempotentReplay,
        readiness: this.readiness,
        command_results: [],
        message: 'Runtime update apply refused because no actionable update is available.'
      };
    }

    const beforeSha = this.readiness.local_checkout.commit_sha;
    await this.record('update-pull-started', 'observed', 'pull_started', { remote: this.options.remote ?? 'origin' });
    const remote = this.options.remote ?? 'origin';
    const baseRef = normalizeBaseRef(this.options.baseRef, remote);
    const pull = command(repoRoot, 'pull', ['git', 'pull', '--ff-only', remote, baseRef], timeoutMs);
    results.push(pull);
    await this.record(pull.status === 'succeeded' ? 'update-pull-succeeded' : 'update-pull-failed', pull.status === 'succeeded' ? 'accepted' : 'failed', pull.reason_code ?? 'pull_succeeded', {
      exit_code: pull.exit_code,
      stdout_excerpt: pull.stdout_excerpt,
      stderr_excerpt: pull.stderr_excerpt
    });
    if (pull.status !== 'succeeded') {
      return this.failed('pull', pull.reason_code ?? 'pull_failed', idempotentReplay, results);
    }

    const afterSha = git(repoRoot, ['rev-parse', 'HEAD'], timeoutMs).stdout || beforeSha;
    const changedFiles = beforeSha && afterSha && beforeSha !== afterSha
      ? git(repoRoot, ['diff', '--name-only', `${beforeSha}..${afterSha}`], timeoutMs).stdout.split('\n').filter(Boolean)
      : [];
    const installNeeded = changedFiles.some((file) => PACKAGE_METADATA_FILES.has(path.basename(file)));
    if (installNeeded) {
      await this.record('update-install-started', 'observed', 'install_started', { changed_package_metadata: true });
      const install = command(repoRoot, 'install', ['npm', 'install'], timeoutMs);
      results.push(install);
      await this.record(install.status === 'succeeded' ? 'update-install-succeeded' : 'update-install-failed', install.status === 'succeeded' ? 'accepted' : 'failed', install.reason_code ?? 'install_succeeded', {
        exit_code: install.exit_code,
        stdout_excerpt: install.stdout_excerpt,
        stderr_excerpt: install.stderr_excerpt
      });
      if (install.status !== 'succeeded') {
        return this.failed('install', install.reason_code ?? 'install_failed', idempotentReplay, results);
      }
    } else {
      const install = skipped(repoRoot, 'install', ['npm', 'install'], 'package_metadata_unchanged');
      results.push(install);
      await this.record('update-install-skipped', 'observed', 'package_metadata_unchanged', {});
    }

    await this.record('update-build-started', 'observed', 'build_started', {});
    const build = command(repoRoot, 'build', ['npm', 'run', 'build'], timeoutMs);
    results.push(build);
    await this.record(build.status === 'succeeded' ? 'update-build-succeeded' : 'update-build-failed', build.status === 'succeeded' ? 'accepted' : 'failed', build.reason_code ?? 'build_succeeded', {
      exit_code: build.exit_code,
      stdout_excerpt: build.stdout_excerpt,
      stderr_excerpt: build.stderr_excerpt
    });
    if (build.status !== 'succeeded') {
      return this.failed('build', build.reason_code ?? 'build_failed', idempotentReplay, results);
    }

    const restart = {
      mode: 'manual' as const,
      status: 'manual_restart_required' as const,
      command: this.options.restartCommand ?? ['npm', 'run', 'start:dashboard'],
      reason_code: REASON_CODES.runtimeUpdateRestartWrapperUnavailable
    };
    await this.record('update-manual-restart-required', 'accepted', restart.reason_code, {
      restart_command: restart.command
    });
    await this.record('update-restart-ready', 'accepted', 'ready_to_restart', {
      restart_mode: restart.mode
    });
    this.readiness = this.withPreparedState(detectRuntimeUpdateReadiness({
      repoRoot,
      baseRef: this.options.baseRef,
      remote: this.options.remote,
      githubEligibilityMode: this.options.githubEligibilityMode,
      githubEligibilityResolver: this.options.githubEligibilityResolver,
      runtimeIdentity: this.options.runtimeIdentity(),
      nowMs: this.options.nowMs,
      timeoutMs,
      previousFetch: this.readiness.last_fetch
    }));
    return {
      success: true,
      status: 'manual_restart_required',
      step: 'manual_restart',
      recommended_action: 'manual_restart',
      idempotent_replay: idempotentReplay,
      readiness: this.readiness,
      command_results: results,
      restart,
      message: 'Update prepared and built. Restart Symphony with the explicit command to run the new runtime.'
    };
  }

  private withPreparedState(readiness: ApiRuntimeUpdateReadiness): ApiRuntimeUpdateReadiness {
    const prepared = this.prepareAccepted && isActionableReadiness(readiness) && readiness.refusal_reasons.length === 0;
    return {
      ...readiness,
      prepared,
      apply_ready: prepared
    };
  }

  private failed(
    step: ApiRuntimeUpdateActionResponse['step'],
    reasonCode: string,
    idempotentReplay: boolean,
    results: CommandResult[]
  ): ApiRuntimeUpdateActionResponse {
    return {
      success: false,
      status: 'failed',
      step,
      reason_code: reasonCode,
      recommended_action: 'inspect_status',
      idempotent_replay: idempotentReplay,
      readiness: this.readiness,
      command_results: results,
      message: `Runtime update ${step} failed.`
    };
  }

  private async record(
    eventType: Parameters<NonNullable<LocalApiServerOptions['drainAuditSink']>['appendDrainAuditHistory']>[0]['event_type'],
    result: 'accepted' | 'rejected' | 'failed' | 'observed',
    resultCode: string,
    stateContext: Record<string, unknown>
  ): Promise<void> {
    const occurredAt = new Date((this.options.nowMs ?? (() => Date.now()))()).toISOString();
    try {
      await this.options.auditSink?.appendDrainAuditHistory({
        event_type: eventType,
        actor: 'operator',
        source: 'runtime_update',
        result,
        result_code: resultCode,
        state_context: stateContext,
        blocker_summaries: [],
        occurred_at: occurredAt,
        observed_at: occurredAt
      });
    } catch (error) {
      await this.options.auditSink?.recordHistoryWriteFailure?.('appendDrainAuditHistory', resultCode, error);
    }
  }
}
