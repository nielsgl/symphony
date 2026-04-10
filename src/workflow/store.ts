import crypto from 'node:crypto';

import type { EffectiveConfigSnapshot, ReloadStatus, WorkflowDefinition } from './types';
import type { EffectiveConfig } from './types';

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    const keys = Object.keys(objectValue).sort();
    const serialized = keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(objectValue[key])}`);
    return `{${serialized.join(',')}}`;
  }

  return JSON.stringify(value);
}

function hashVersion(workflowDefinition: WorkflowDefinition, effectiveConfig: EffectiveConfig): string {
  const payload = stableSerialize({ workflowDefinition, effectiveConfig });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export class EffectiveConfigStore {
  private snapshot?: EffectiveConfigSnapshot;

  setSnapshot(params: {
    workflowDefinition: WorkflowDefinition;
    effectiveConfig: EffectiveConfig;
    promptTemplate: string;
    lastReloadStatus: ReloadStatus;
  }): EffectiveConfigSnapshot {
    const versionHash = hashVersion(params.workflowDefinition, params.effectiveConfig);

    const nextSnapshot: EffectiveConfigSnapshot = {
      workflowDefinition: params.workflowDefinition,
      effectiveConfig: params.effectiveConfig,
      promptTemplate: params.promptTemplate,
      versionHash,
      lastReloadStatus: params.lastReloadStatus
    };

    this.snapshot = nextSnapshot;
    return nextSnapshot;
  }

  getSnapshot(): EffectiveConfigSnapshot | undefined {
    return this.snapshot;
  }

  setLastReloadStatus(lastReloadStatus: ReloadStatus): EffectiveConfigSnapshot | undefined {
    if (!this.snapshot) {
      return undefined;
    }

    this.snapshot = {
      ...this.snapshot,
      lastReloadStatus
    };

    return this.snapshot;
  }
}
