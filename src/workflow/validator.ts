import { nowIso } from './errors';
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

    if (effectiveConfig.tracker.kind !== 'linear') {
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

    if (!effectiveConfig.tracker.project_slug.trim()) {
      return {
        ok: false,
        error_code: 'missing_tracker_project_slug',
        message: 'tracker.project_slug is required for tracker.kind=linear',
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
