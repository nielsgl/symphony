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

    if (effectiveConfig.tracker.kind !== 'linear' && effectiveConfig.tracker.kind !== 'github') {
      return {
        ok: false,
        error_code: 'unsupported_tracker_kind',
        message: `tracker.kind '${effectiveConfig.tracker.kind}' is not supported`,
        at
      };
    }

    if (!effectiveConfig.tracker.api_key.trim()) {
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

    if (!effectiveConfig.codex.command.trim()) {
      return {
        ok: false,
        error_code: 'missing_codex_command',
        message: 'codex.command is required and must be non-empty',
        at
      };
    }

    if (!isSupportedApprovalPolicy(effectiveConfig.codex.approval_policy)) {
      return {
        ok: false,
        error_code: 'invalid_codex_approval_policy',
        message: `codex.approval_policy '${effectiveConfig.codex.approval_policy}' is not supported`,
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
