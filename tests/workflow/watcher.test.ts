import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CANONICAL_EVENT } from '../../src/observability/events';
import { ConfigResolver } from '../../src/workflow/resolver';
import { EffectiveConfigStore } from '../../src/workflow/store';
import type { WorkflowEvent } from '../../src/workflow/types';
import { WorkflowWatcher } from '../../src/workflow/watcher';
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
    watcher.stop();

    expect(store.getSnapshot()?.versionHash).toBe(baselineHash);
    expect(store.getSnapshot()?.lastReloadStatus.ok).toBe(false);
    expect(store.getSnapshot()?.lastReloadStatus.error_code).toBe('missing_tracker_api_key');
    expect(events.some((event) => event.event === CANONICAL_EVENT.workflow.reloadFailed)).toBe(true);
  });

  it('reloads on atomic save rename of workflow file', async () => {
    const dir = createTempDir('wf-watcher-atomic-');
    const workflowPath = writeWorkflowFile(dir, validWorkflowContent());
    const tempPath = `${workflowPath}.tmp`;
    const store = new EffectiveConfigStore();

    const watcher = new WorkflowWatcher({
      explicitPath: workflowPath,
      debounceMs: 50,
      store,
      resolver: new ConfigResolver({ env: { LINEAR_API_KEY: 'token' } })
    });

    watcher.start();
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

    await waitFor(() => store.getSnapshot()?.versionHash !== baselineHash);
    watcher.stop();

    expect(store.getSnapshot()?.effectiveConfig.polling.interval_ms).toBe(12345);
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
