import net from 'node:net';

import { nowIso } from './errors';
import {
  isSupportedApprovalPolicy,
  isSupportedThreadSandbox,
  isSupportedTurnSandbox
} from '../security/profiles';
import type { DispatchPreflightOutcome, EffectiveConfig, ValidationResult } from './types';

export interface ConfigValidatorOptions {
  clock?: () => Date;
}

function mapGitHubStateNamesToEnums(stateNames: string[]): string[] {
  const mapped = new Set<string>();

  for (const stateName of stateNames) {
    const normalized = stateName.trim().toLowerCase();
    if (normalized === 'open') {
      mapped.add('OPEN');
      continue;
    }

    if (normalized === 'closed') {
      mapped.add('CLOSED');
    }
  }

  return Array.from(mapped);
}

function isValidServerHost(host: string): boolean {
  const trimmed = host.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed === 'localhost') {
    return true;
  }
  if (net.isIP(trimmed) !== 0) {
    return true;
  }

  // Allow resolvable DNS hostnames; resolvability is validated at runtime startup.
  return /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)$/.test(
    trimmed
  );
}

export class ConfigValidator {
  private readonly clock: () => Date;

  constructor(options: ConfigValidatorOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
  }

  validate(effectiveConfig: EffectiveConfig): ValidationResult {
    const at = nowIso(this.clock);

    if (!effectiveConfig.tracker.kind.trim()) {
      return {
        ok: false,
        error_code: 'missing_tracker_kind',
        message: 'tracker.kind is required',
        at
      };
    }

    if (
      effectiveConfig.tracker.kind !== 'linear' &&
      effectiveConfig.tracker.kind !== 'github' &&
      effectiveConfig.tracker.kind !== 'memory'
    ) {
      return {
        ok: false,
        error_code: 'unsupported_tracker_kind',
        message: `tracker.kind '${effectiveConfig.tracker.kind}' is not supported`,
        at
      };
    }

    if (effectiveConfig.tracker.kind !== 'memory' && !effectiveConfig.tracker.api_key.trim()) {
      return {
        ok: false,
        error_code: 'missing_tracker_api_key',
        message: 'tracker.api_key is required after env resolution',
        at
      };
    }

    if (effectiveConfig.tracker.kind === 'linear' && !effectiveConfig.tracker.project_slug.trim()) {
      return {
        ok: false,
        error_code: 'missing_tracker_project_slug',
        message: 'tracker.project_slug is required for tracker.kind=linear',
        at
      };
    }

    if (effectiveConfig.tracker.kind === 'github' && !effectiveConfig.tracker.owner?.trim()) {
      return {
        ok: false,
        error_code: 'missing_tracker_owner',
        message: 'tracker.owner is required for tracker.kind=github',
        at
      };
    }

    if (effectiveConfig.tracker.kind === 'github' && !effectiveConfig.tracker.repo?.trim()) {
      return {
        ok: false,
        error_code: 'missing_tracker_repo',
        message: 'tracker.repo is required for tracker.kind=github',
        at
      };
    }

    if (effectiveConfig.tracker.kind === 'github') {
      const mappedActiveStates = mapGitHubStateNamesToEnums(effectiveConfig.tracker.active_states);
      if (mappedActiveStates.length === 0) {
        return {
          ok: false,
          error_code: 'invalid_tracker_active_states_for_github',
          message: 'tracker.active_states must include at least one of: Open, Closed for tracker.kind=github',
          at
        };
      }
    }

    if (!effectiveConfig.codex.command.trim()) {
      return {
        ok: false,
        error_code: 'missing_codex_command',
        message: 'codex.command is required and must be non-empty',
        at
      };
    }

    if (!Number.isFinite(effectiveConfig.polling.interval_ms) || effectiveConfig.polling.interval_ms <= 0) {
      return {
        ok: false,
        error_code: 'invalid_polling_interval_ms',
        message: 'polling.interval_ms must be a positive integer',
        at
      };
    }

    if (!Number.isFinite(effectiveConfig.hooks.timeout_ms) || effectiveConfig.hooks.timeout_ms <= 0) {
      return {
        ok: false,
        error_code: 'invalid_hooks_timeout_ms',
        message: 'hooks.timeout_ms must be a positive integer when provided',
        at
      };
    }

    if (!Number.isFinite(effectiveConfig.agent.max_concurrent_agents) || effectiveConfig.agent.max_concurrent_agents <= 0) {
      return {
        ok: false,
        error_code: 'invalid_agent_max_concurrent_agents',
        message: 'agent.max_concurrent_agents must be a positive integer',
        at
      };
    }

    if (!Number.isFinite(effectiveConfig.agent.max_turns) || effectiveConfig.agent.max_turns <= 0) {
      return {
        ok: false,
        error_code: 'invalid_agent_max_turns',
        message: 'agent.max_turns must be a positive integer',
        at
      };
    }

    if (!Number.isFinite(effectiveConfig.agent.max_retry_backoff_ms) || effectiveConfig.agent.max_retry_backoff_ms <= 0) {
      return {
        ok: false,
        error_code: 'invalid_agent_max_retry_backoff_ms',
        message: 'agent.max_retry_backoff_ms must be a positive integer',
        at
      };
    }

    for (const [stateName, limit] of Object.entries(effectiveConfig.agent.max_concurrent_agents_by_state)) {
      if (!Number.isFinite(limit) || limit <= 0) {
        return {
          ok: false,
          error_code: 'invalid_agent_max_concurrent_agents_by_state',
          message: `agent.max_concurrent_agents_by_state['${stateName}'] must be a positive integer`,
          at
        };
      }
    }

    if (!Number.isFinite(effectiveConfig.codex.turn_timeout_ms) || effectiveConfig.codex.turn_timeout_ms <= 0) {
      return {
        ok: false,
        error_code: 'invalid_codex_turn_timeout_ms',
        message: 'codex.turn_timeout_ms must be a positive integer',
        at
      };
    }

    if (!Number.isFinite(effectiveConfig.codex.read_timeout_ms) || effectiveConfig.codex.read_timeout_ms <= 0) {
      return {
        ok: false,
        error_code: 'invalid_codex_read_timeout_ms',
        message: 'codex.read_timeout_ms must be a positive integer',
        at
      };
    }

    if (!Number.isFinite(effectiveConfig.codex.stall_timeout_ms) || effectiveConfig.codex.stall_timeout_ms <= 0) {
      return {
        ok: false,
        error_code: 'invalid_codex_stall_timeout_ms',
        message: 'codex.stall_timeout_ms must be a positive integer',
        at
      };
    }

    const provisionerType = effectiveConfig.workspace.provisioner.type;
    if (provisionerType !== 'none' && provisionerType !== 'worktree' && provisionerType !== 'clone') {
      return {
        ok: false,
        error_code: 'invalid_workspace_provisioner_type',
        message: `workspace.provisioner.type '${provisionerType}' is not supported`,
        at
      };
    }

    const teardownMode = effectiveConfig.workspace.provisioner.teardown_mode;
    if (teardownMode !== 'remove_worktree' && teardownMode !== 'keep') {
      return {
        ok: false,
        error_code: 'invalid_workspace_provisioner_teardown_mode',
        message: `workspace.provisioner.teardown_mode '${teardownMode}' is not supported`,
        at
      };
    }

    if (provisionerType === 'worktree' && !effectiveConfig.workspace.provisioner.repo_root?.trim()) {
      return {
        ok: false,
        error_code: 'invalid_workspace_provisioner_repo_root',
        message: 'workspace.provisioner.repo_root is required when workspace.provisioner.type=worktree',
        at
      };
    }

    if (
      provisionerType === 'worktree' &&
      !effectiveConfig.workspace.provisioner.branch_template.includes('{{ issue.identifier }}')
    ) {
      return {
        ok: false,
        error_code: 'invalid_workspace_provisioner_branch_template',
        message:
          'workspace.provisioner.branch_template must include {{ issue.identifier }} when workspace.provisioner.type=worktree',
        at
      };
    }

    const approvalPolicyValue = effectiveConfig.codex.approval_policy;
    const approvalPolicyLooksLikeObject =
      approvalPolicyValue !== undefined &&
      typeof approvalPolicyValue === 'object' &&
      approvalPolicyValue !== null;
    if (!isSupportedApprovalPolicy(approvalPolicyValue)) {
      return {
        ok: false,
        error_code: approvalPolicyLooksLikeObject
          ? 'invalid_codex_approval_policy_shape'
          : 'invalid_codex_approval_policy',
        message: approvalPolicyLooksLikeObject
          ? 'codex.approval_policy object shape is invalid'
          : `codex.approval_policy '${String(approvalPolicyValue)}' is not supported`,
        at
      };
    }

    if (!isSupportedThreadSandbox(effectiveConfig.codex.thread_sandbox)) {
      return {
        ok: false,
        error_code: 'invalid_codex_thread_sandbox',
        message: `codex.thread_sandbox '${effectiveConfig.codex.thread_sandbox}' is not supported`,
        at
      };
    }

    if (!isSupportedTurnSandbox(effectiveConfig.codex.turn_sandbox_policy)) {
      return {
        ok: false,
        error_code: 'invalid_codex_turn_sandbox_policy',
        message: `codex.turn_sandbox_policy '${effectiveConfig.codex.turn_sandbox_policy}' is not supported`,
        at
      };
    }

    if (
      provisionerType === 'worktree' &&
      (effectiveConfig.codex.thread_sandbox !== 'danger-full-access' ||
        effectiveConfig.codex.turn_sandbox_policy !== 'danger-full-access')
    ) {
      return {
        ok: false,
        error_code: 'invalid_worktree_sandbox_policy',
        message:
          'workspace.provisioner.type=worktree requires codex.thread_sandbox=danger-full-access and codex.turn_sandbox_policy=danger-full-access',
        at
      };
    }

    if (
      effectiveConfig.codex.user_input_policy !== undefined &&
      effectiveConfig.codex.user_input_policy !== 'fail_attempt'
    ) {
      return {
        ok: false,
        error_code: 'invalid_codex_user_input_policy',
        message: `codex.user_input_policy '${effectiveConfig.codex.user_input_policy}' is not supported`,
        at
      };
    }

    if (
      effectiveConfig.worker?.max_concurrent_agents_per_host !== undefined &&
      (!Number.isFinite(effectiveConfig.worker.max_concurrent_agents_per_host) ||
        effectiveConfig.worker.max_concurrent_agents_per_host <= 0)
    ) {
      return {
        ok: false,
        error_code: 'invalid_worker_max_concurrent_agents_per_host',
        message: 'worker.max_concurrent_agents_per_host must be a positive integer when provided',
        at
      };
    }

    if (effectiveConfig.server?.host !== undefined && !isValidServerHost(effectiveConfig.server.host)) {
      return {
        ok: false,
        error_code: 'invalid_server_host',
        message: `server.host '${effectiveConfig.server.host}' is not a valid bind host`,
        at
      };
    }

    if (!Number.isFinite(effectiveConfig.logging.max_bytes) || effectiveConfig.logging.max_bytes <= 0) {
      return {
        ok: false,
        error_code: 'invalid_logging_max_bytes',
        message: 'logging.max_bytes must be a positive integer',
        at
      };
    }

    if (!Number.isFinite(effectiveConfig.logging.max_files) || effectiveConfig.logging.max_files <= 0) {
      return {
        ok: false,
        error_code: 'invalid_logging_max_files',
        message: 'logging.max_files must be a positive integer',
        at
      };
    }

    return { ok: true, at };
  }

  evaluateDispatchPreflight(effectiveConfig: EffectiveConfig): DispatchPreflightOutcome {
    const validation = this.validate(effectiveConfig);

    if (!validation.ok) {
      return {
        dispatch_allowed: false,
        reconciliation_allowed: true,
        validation
      };
    }

    return {
      dispatch_allowed: true,
      reconciliation_allowed: true,
      validation
    };
  }
}
