import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { CANONICAL_EVENT } from '../../src/observability/events';
import { ConfigResolver } from '../../src/workflow/resolver';
import { EffectiveConfigStore } from '../../src/workflow/store';
import type { WorkflowEvent } from '../../src/workflow/types';
import { WorkflowWatcher, type WorkflowWatchFileSystem, type WorkflowWatchListener } from '../../src/workflow/watcher';
import { createTempDir, sleep, writeWorkflowFile } from './helpers';

function validWorkflowContent(apiKeyToken = '$LINEAR_API_KEY'): string {
  return `---
tracker:
  kind: linear
  api_key: ${apiKeyToken}
  project_slug: ABC
polling:
  interval_ms: 30000
codex:
  command: codex app-server
---
Hello {{ issue.identifier }}`;
}

class FakeWatchHandle {
  closed = false;

  constructor(
    readonly targetPath: string,
    private readonly listener: WorkflowWatchListener
  ) {}

  close(): void {
    this.closed = true;
  }

  emit(eventType: fs.WatchEventType, filename: string | Buffer | null = null): void {
    if (!this.closed) {
      this.listener(eventType, filename);
    }
  }
}

class FakeWatchFileSystem {
  private readonly handles = new Map<string, FakeWatchHandle[]>();

  readonly watch: WorkflowWatchFileSystem = (targetPath, listener) => {
    const handle = new FakeWatchHandle(targetPath, listener);
    this.handles.set(targetPath, [...this.handlesFor(targetPath), handle]);
    return handle;
  };

  handlesFor(targetPath: string): FakeWatchHandle[] {
    return this.handles.get(targetPath) ?? [];
  }

  latestHandleFor(targetPath: string): FakeWatchHandle {
    const handles = this.handlesFor(targetPath);
    const latest = handles.at(-1);
    if (!latest) {
      throw new Error(`no watch handle registered for ${targetPath}`);
    }

    return latest;
  }
}

describe('WorkflowWatcher', () => {
  async function waitFor(
    predicate: () => boolean,
    timeoutMs = 2000,
    intervalMs = 50
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) {
        return;
      }

      await sleep(intervalMs);
    }

    throw new Error('condition not met within timeout');
  }

  it('loads startup config and emits version hash', () => {
    const dir = createTempDir('wf-watcher-start-');
    const workflowPath = writeWorkflowFile(dir, validWorkflowContent('$LINEAR_API_KEY'));
    const events: WorkflowEvent[] = [];

    const watcher = new WorkflowWatcher({
      explicitPath: workflowPath,
      debounceMs: 50,
      onEvent: (event) => events.push(event),
      resolver: new ConfigResolver({ env: { LINEAR_API_KEY: 'token' } })
    });

    watcher.start();
    watcher.stop();

    const store = watcher.getStore();
    const snapshot = store.getSnapshot();

    expect(snapshot).toBeDefined();
    expect(snapshot?.versionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(events[0]).toMatchObject({
      event: CANONICAL_EVENT.workflow.reloadSucceeded,
      source: 'startup',
      version_hash: expect.any(String)
    });
  });

  it('[SPEC-6.2-1][SPEC-6.4-1][SPEC-12.1-1] keeps last known good config on invalid reload', async () => {
    const dir = createTempDir('wf-watcher-invalid-');
    const workflowPath = writeWorkflowFile(dir, validWorkflowContent());
    const events: WorkflowEvent[] = [];

    const store = new EffectiveConfigStore();
    const watcher = new WorkflowWatcher({
      explicitPath: workflowPath,
      debounceMs: 50,
      onEvent: (event) => events.push(event),
      store,
      resolver: new ConfigResolver({ env: { LINEAR_API_KEY: 'token' } })
    });

    watcher.start();

    try {
      const baselineHash = store.getSnapshot()?.versionHash;

      fs.writeFileSync(
        workflowPath,
        `---
tracker:
  kind: linear
  api_key: ''
  project_slug: ABC
codex:
  command: codex app-server
---
Body`,
        'utf8'
      );

      const preflight = watcher.validateForDispatch();
      expect(preflight.dispatch_allowed).toBe(false);
      await sleep(350);

      expect(store.getSnapshot()?.versionHash).toBe(baselineHash);
      expect(store.getSnapshot()?.lastReloadStatus.ok).toBe(false);
      expect(store.getSnapshot()?.lastReloadStatus.error_code).toBe('missing_tracker_api_key');
      expect(events.some((event) => event.event === CANONICAL_EVENT.workflow.reloadFailed)).toBe(true);
    } finally {
      watcher.stop();
    }
  });

  it('reloads when directory watcher observes atomic save rename of workflow file', async () => {
    const dir = createTempDir('wf-watcher-atomic-');
    const workflowPath = writeWorkflowFile(dir, validWorkflowContent());
    const tempPath = `${workflowPath}.tmp`;
    const store = new EffectiveConfigStore();
    const watchFileSystem = new FakeWatchFileSystem();

    const watcher = new WorkflowWatcher({
      explicitPath: workflowPath,
      debounceMs: 50,
      store,
      watchFileSystem: watchFileSystem.watch,
      resolver: new ConfigResolver({ env: { LINEAR_API_KEY: 'token' } })
    });

    watcher.start();

    try {
      const baselineHash = store.getSnapshot()?.versionHash;

      fs.writeFileSync(
        tempPath,
        `---
tracker:
  kind: linear
  api_key: '$LINEAR_API_KEY'
  project_slug: ABC
polling:
  interval_ms: 12345
codex:
  command: codex app-server
---
Body`,
        'utf8'
      );
      fs.renameSync(tempPath, workflowPath);
      watchFileSystem.latestHandleFor(path.dirname(workflowPath)).emit('rename', path.basename(tempPath));

      await waitFor(() => store.getSnapshot()?.versionHash !== baselineHash);

      expect(store.getSnapshot()?.effectiveConfig.polling.interval_ms).toBe(12345);
    } finally {
      watcher.stop();
    }
  });

  it('reloads when file watcher observes a content change', async () => {
    const dir = createTempDir('wf-watcher-file-change-');
    const workflowPath = writeWorkflowFile(dir, validWorkflowContent());
    const store = new EffectiveConfigStore();
    const watchFileSystem = new FakeWatchFileSystem();

    const watcher = new WorkflowWatcher({
      explicitPath: workflowPath,
      debounceMs: 10,
      store,
      watchFileSystem: watchFileSystem.watch,
      resolver: new ConfigResolver({ env: { LINEAR_API_KEY: 'token' } })
    });

    watcher.start();

    try {
      const baselineHash = store.getSnapshot()?.versionHash;

      fs.writeFileSync(
        workflowPath,
        `---
tracker:
  kind: linear
  api_key: '$LINEAR_API_KEY'
  project_slug: ABC
polling:
  interval_ms: 12346
codex:
  command: codex app-server
---
Body`,
        'utf8'
      );
      watchFileSystem.latestHandleFor(workflowPath).emit('change', path.basename(workflowPath));

      await waitFor(() => store.getSnapshot()?.versionHash !== baselineHash);

      expect(store.getSnapshot()?.effectiveConfig.polling.interval_ms).toBe(12346);
    } finally {
      watcher.stop();
    }
  });

  it('re-arms file watcher after file rename event', async () => {
    const dir = createTempDir('wf-watcher-file-rename-');
    const workflowPath = writeWorkflowFile(dir, validWorkflowContent());
    const store = new EffectiveConfigStore();
    const watchFileSystem = new FakeWatchFileSystem();

    const watcher = new WorkflowWatcher({
      explicitPath: workflowPath,
      debounceMs: 10,
      store,
      watchFileSystem: watchFileSystem.watch,
      resolver: new ConfigResolver({ env: { LINEAR_API_KEY: 'token' } })
    });

    watcher.start();

    try {
      const firstFileHandle = watchFileSystem.latestHandleFor(workflowPath);
      const baselineHash = store.getSnapshot()?.versionHash;

      fs.writeFileSync(
        workflowPath,
        `---
tracker:
  kind: linear
  api_key: '$LINEAR_API_KEY'
  project_slug: ABC
polling:
  interval_ms: 12347
codex:
  command: codex app-server
---
Body`,
        'utf8'
      );
      firstFileHandle.emit('rename', path.basename(workflowPath));

      await waitFor(() => store.getSnapshot()?.versionHash !== baselineHash);
      await waitFor(() => watchFileSystem.handlesFor(workflowPath).length === 2);

      expect(firstFileHandle.closed).toBe(true);
      expect(watchFileSystem.latestHandleFor(workflowPath).closed).toBe(false);
      expect(store.getSnapshot()?.effectiveConfig.polling.interval_ms).toBe(12347);
    } finally {
      watcher.stop();
    }
  });

  it('filters non-rename directory events to the watched filename', async () => {
    vi.useFakeTimers();

    const dir = createTempDir('wf-watcher-dir-filter-');
    const workflowPath = writeWorkflowFile(dir, validWorkflowContent());
    const store = new EffectiveConfigStore();
    const watchFileSystem = new FakeWatchFileSystem();

    const watcher = new WorkflowWatcher({
      explicitPath: workflowPath,
      debounceMs: 10,
      store,
      watchFileSystem: watchFileSystem.watch,
      resolver: new ConfigResolver({ env: { LINEAR_API_KEY: 'token' } })
    });

    watcher.start();

    try {
      const baselineHash = store.getSnapshot()?.versionHash;
      const directoryHandle = watchFileSystem.latestHandleFor(path.dirname(workflowPath));

      fs.writeFileSync(
        workflowPath,
        `---
tracker:
  kind: linear
  api_key: '$LINEAR_API_KEY'
  project_slug: ABC
polling:
  interval_ms: 12348
codex:
  command: codex app-server
---
Body`,
        'utf8'
      );
      directoryHandle.emit('change', `${path.basename(workflowPath)}.tmp`);
      await vi.advanceTimersByTimeAsync(11);
      expect(store.getSnapshot()?.versionHash).toBe(baselineHash);

      directoryHandle.emit('change', path.basename(workflowPath));
      await vi.advanceTimersByTimeAsync(11);
      expect(store.getSnapshot()?.versionHash).not.toBe(baselineHash);

      expect(store.getSnapshot()?.effectiveConfig.polling.interval_ms).toBe(12348);
    } finally {
      watcher.stop();
      vi.useRealTimers();
    }
  });

  it('smoke tests real fs.watch atomic save reload defensively', async () => {
    const dir = createTempDir('wf-watcher-real-atomic-');
    const workflowPath = writeWorkflowFile(dir, validWorkflowContent());
    const store = new EffectiveConfigStore();

    const watcher = new WorkflowWatcher({
      explicitPath: workflowPath,
      debounceMs: 50,
      store,
      resolver: new ConfigResolver({ env: { LINEAR_API_KEY: 'token' } })
    });

    watcher.start();

    try {
      for (const intervalMs of [22341, 22342, 22343]) {
        const tempPath = `${workflowPath}.${intervalMs}.tmp`;
        const baselineHash = store.getSnapshot()?.versionHash;

        fs.writeFileSync(
          tempPath,
          `---
tracker:
  kind: linear
  api_key: '$LINEAR_API_KEY'
  project_slug: ABC
polling:
  interval_ms: ${intervalMs}
codex:
  command: codex app-server
---
Body`,
          'utf8'
        );
        fs.renameSync(tempPath, workflowPath);

        try {
          await waitFor(() => store.getSnapshot()?.versionHash !== baselineHash, 1000, 25);
          expect(store.getSnapshot()?.effectiveConfig.polling.interval_ms).toBe(intervalMs);
          return;
        } catch (error) {
          if (intervalMs === 22343) {
            throw error;
          }
        }
      }
    } finally {
      watcher.stop();
    }
  });

  it('preflight blocks dispatch but keeps reconciliation when workflow becomes invalid', () => {
    const dir = createTempDir('wf-watcher-preflight-');
    const workflowPath = writeWorkflowFile(dir, validWorkflowContent());

    const watcher = new WorkflowWatcher({
      explicitPath: workflowPath,
      resolver: new ConfigResolver({ env: { LINEAR_API_KEY: 'token' } })
    });

    watcher.start();

    fs.writeFileSync(
      workflowPath,
      `---
tracker:
  kind: linear
  api_key: '$LINEAR_API_KEY'
  project_slug: ''
codex:
  command: codex app-server
---
Body`,
      'utf8'
    );

    const outcome = watcher.validateForDispatch();
    watcher.stop();

    expect(outcome.dispatch_allowed).toBe(false);
    expect(outcome.reconciliation_allowed).toBe(true);
    expect(outcome.validation.ok).toBe(false);
  });

  it('emits startup failure event only once on invalid startup config', () => {
    const dir = createTempDir('wf-watcher-startup-fail-');
    const workflowPath = writeWorkflowFile(
      dir,
      `---
tracker:
  kind: linear
  api_key: '$LINEAR_API_KEY'
  project_slug: ''
codex:
  command: codex app-server
---
Body`
    );
    const events: WorkflowEvent[] = [];

    const watcher = new WorkflowWatcher({
      explicitPath: workflowPath,
      onEvent: (event) => events.push(event),
      resolver: new ConfigResolver({ env: { LINEAR_API_KEY: 'token' } })
    });

    expect(() => watcher.start()).toThrowError();

    const failedEvents = events.filter((event) => event.event === CANONICAL_EVENT.workflow.reloadFailed);
    expect(failedEvents).toHaveLength(1);
  });
});
