import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { SqlitePersistenceStore } from '../../src/persistence/store';

describe('SqlitePersistenceStore', () => {
  const dirs: string[] = [];
  const stores: SqlitePersistenceStore[] = [];

  afterEach(async () => {
    while (stores.length > 0) {
      stores.pop()?.close();
    }

    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('persists append-only run/session history across restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-persistence-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14, nowMs: () => Date.parse('2026-04-11T10:00:00.000Z') });
    stores.push(storeA);

    const runId = storeA.startRun({ issue_id: 'i-1', issue_identifier: 'ABC-1' });
    storeA.recordSession(runId, 'thread-1-turn-1');
    storeA.recordEvent({ run_id: runId, timestamp_ms: Date.parse('2026-04-11T10:01:00.000Z'), event: 'turn_completed', message: 'ok' });
    storeA.completeRun({ run_id: runId, terminal_status: 'succeeded' });
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14, nowMs: () => Date.parse('2026-04-11T10:05:00.000Z') });
    stores.push(storeB);
    const history = storeB.listRunHistory();

    expect(history).toHaveLength(1);
    expect(history[0].run_id).toBe(runId);
    expect(history[0].terminal_status).toBe('succeeded');
    expect(history[0].session_ids).toEqual(['thread-1-turn-1']);
  });

  it('persists UI continuity state', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-ui-state-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(store);
    store.saveUiState({
      selected_issue: 'ABC-1',
      filters: { status: 'running', query: 'abc' },
      panel_state: { issue_detail_open: true }
    });

    const state = store.loadUiState();
    expect(state?.selected_issue).toBe('ABC-1');
    expect(state?.filters.status).toBe('running');
  });

  it('applies retention pruning and reports integrity', async () => {
    const base = Date.parse('2026-04-11T12:00:00.000Z');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-prune-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 1, nowMs: () => base });
    stores.push(store);

    const runId = store.startRun({ issue_id: 'i-old', issue_identifier: 'OLD-1' });
    store.completeRun({ run_id: runId, terminal_status: 'failed', error_code: 'token=abcd1234' });

    // Move clock forward by 2 days and prune.
    const lateStore = new SqlitePersistenceStore({ dbPath, retentionDays: 1, nowMs: () => base + 2 * 24 * 60 * 60 * 1000 });
    stores.push(lateStore);
    const pruned = lateStore.pruneExpiredRuns();
    expect(pruned).toBeGreaterThanOrEqual(1);

    const health = lateStore.health();
    expect(health.integrity_ok).toBe(true);
    expect(health.last_pruned_at).not.toBeNull();
  });
});
