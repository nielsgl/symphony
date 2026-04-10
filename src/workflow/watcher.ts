import fs from 'node:fs';
import path from 'node:path';

import { nowIso, WorkflowConfigError } from './errors';
import { WorkflowLoader } from './loader';
import { ConfigResolver } from './resolver';
import { EffectiveConfigStore } from './store';
import type { ReloadStatus, ValidationErrorCode, WorkflowErrorCode, WorkflowEvent } from './types';
import { ConfigValidator } from './validator';

type ReloadSource = 'startup' | 'watch' | 'preflight';

interface WorkflowWatcherOptions {
  explicitPath?: string;
  cwd?: string;
  debounceMs?: number;
  onEvent?: (event: WorkflowEvent) => void;
  clock?: () => Date;
  loader?: WorkflowLoader;
  resolver?: ConfigResolver;
  validator?: ConfigValidator;
  store?: EffectiveConfigStore;
}

export class WorkflowWatcher {
  private readonly explicitPath?: string;
  private readonly cwd?: string;
  private readonly debounceMs: number;
  private readonly onEvent?: (event: WorkflowEvent) => void;
  private readonly clock: () => Date;
  private readonly loader: WorkflowLoader;
  private readonly resolver: ConfigResolver;
  private readonly validator: ConfigValidator;
  private readonly store: EffectiveConfigStore;

  private watcher?: fs.FSWatcher;
  private timer?: NodeJS.Timeout;

  constructor(options: WorkflowWatcherOptions = {}) {
    this.explicitPath = options.explicitPath;
    this.cwd = options.cwd;
    this.debounceMs = options.debounceMs ?? 250;
    this.onEvent = options.onEvent;
    this.clock = options.clock ?? (() => new Date());
    this.loader = options.loader ?? new WorkflowLoader();
    this.resolver = options.resolver ?? new ConfigResolver();
    this.validator = options.validator ?? new ConfigValidator({ clock: this.clock });
    this.store = options.store ?? new EffectiveConfigStore();
  }

  getStore(): EffectiveConfigStore {
    return this.store;
  }

  start(): void {
    const startupResult = this.reloadTransaction('startup', true);
    if (!startupResult.ok) {
      throw new WorkflowConfigError(startupResult.error_code!, startupResult.message!);
    }

    const watchedPath = this.loader.resolvePath({ explicitPath: this.explicitPath, cwd: this.cwd });
    const watchedDir = path.dirname(watchedPath);
    const watchedFile = path.basename(watchedPath);

    this.watcher = fs.watch(watchedDir, (_eventType, filename) => {
      if (filename != null) {
        const changedName = filename.toString();
        if (changedName !== watchedFile) {
          return;
        }
      }

      if (this.timer) {
        clearTimeout(this.timer);
      }

      this.timer = setTimeout(() => {
        this.reloadTransaction('watch', false);
      }, this.debounceMs);
    });
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
  }

  validateForDispatch(): ReturnType<ConfigValidator['evaluateDispatchPreflight']> {
    const loadResult = this.reloadTransaction('preflight', false);

    if (!loadResult.ok) {
      return {
        dispatch_allowed: false,
        reconciliation_allowed: true,
        validation: {
          ok: false,
          error_code: loadResult.error_code!,
          message: loadResult.message!,
          at: loadResult.at
        }
      };
    }

    return this.validator.evaluateDispatchPreflight(loadResult.effectiveConfig);
  }

  private reloadTransaction(source: ReloadSource, throwOnFailure: boolean):
    | ({ ok: true; at: string; effectiveConfig: ReturnType<ConfigResolver['resolve']> } & { error_code?: never; message?: never })
    | ({
        ok: false;
        at: string;
        error_code: WorkflowErrorCode | ValidationErrorCode;
        message: string;
        effectiveConfig?: never;
      }) {
    const at = nowIso(this.clock);

    try {
      const workflowDefinition = this.loader.load({ explicitPath: this.explicitPath, cwd: this.cwd });
      const effectiveConfig = this.resolver.resolve(workflowDefinition);
      const validation = this.validator.validate(effectiveConfig);

      if (!validation.ok) {
        if (throwOnFailure) {
          throw new WorkflowConfigError(validation.error_code, validation.message);
        }

        this.store.setLastReloadStatus({
          ok: false,
          at,
          source,
          error_code: validation.error_code,
          message: validation.message
        });
        this.emitFailure(source, validation.error_code, validation.message, at);
        return {
          ok: false,
          at,
          error_code: validation.error_code,
          message: validation.message
        };
      }

      const status: ReloadStatus = { ok: true, at, source };
      const snapshot = this.store.setSnapshot({
        workflowDefinition,
        effectiveConfig,
        promptTemplate: workflowDefinition.prompt_template,
        lastReloadStatus: status
      });

      this.onEvent?.({
        event: 'workflow_reload_succeeded',
        at,
        source,
        version_hash: snapshot.versionHash
      });

      return { ok: true, at, effectiveConfig };
    } catch (error) {
      const configError =
        error instanceof WorkflowConfigError
          ? error
          : new WorkflowConfigError('workflow_parse_error', error instanceof Error ? error.message : 'workflow reload failed');

      this.store.setLastReloadStatus({
        ok: false,
        at,
        source,
        error_code: configError.code,
        message: configError.message
      });
      this.emitFailure(source, configError.code, configError.message, at);

      if (throwOnFailure) {
        throw configError;
      }

      return {
        ok: false,
        at,
        error_code: configError.code,
        message: configError.message
      };
    }
  }

  private emitFailure(
    source: ReloadSource,
    errorCode: WorkflowErrorCode | ValidationErrorCode,
    message: string,
    at: string
  ): void {
    this.onEvent?.({
      event: 'workflow_reload_failed',
      at,
      source,
      error_code: errorCode,
      message
    });
  }
}
