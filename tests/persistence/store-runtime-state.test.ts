import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDurableIdentity,
  createStoreTestHarness,
  fs,
  os,
  path,
  SqlitePersistenceStore
} from './store-test-harness';

describe('SqlitePersistenceStore runtime state', () => {
  const { dirs, stores, identity, openDatabase, tableNames, withLegacyProjectKey, cleanup } = createStoreTestHarness();

  afterEach(cleanup);
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

  it('persists breaker and blocked input records across reopen and supports delete lifecycle', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-breaker-state-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeA);
    storeA.upsertBreaker({
      issue_id: 'i-1',
      issue_identifier: 'ABC-1',
      breaker_active: true,
      breaker_hit_count: 3,
      breaker_window_minutes: 30,
      breaker_first_hit_at: '2026-04-11T10:00:00.000Z',
      breaker_last_hit_at: '2026-04-11T10:02:00.000Z'
    });
    storeA.upsertBlockedInput('i-1', JSON.stringify({ issue_id: 'i-1', issue_identifier: 'ABC-1', stop_reason_code: 'x' }));
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    expect(storeB.listBreakers()).toEqual([
      {
        issue_id: 'i-1',
        issue_identifier: 'ABC-1',
        breaker_active: true,
        breaker_hit_count: 3,
        breaker_window_minutes: 30,
        breaker_first_hit_at: '2026-04-11T10:00:00.000Z',
        breaker_last_hit_at: '2026-04-11T10:02:00.000Z'
      }
    ]);
    expect(storeB.listBlockedInputs()).toHaveLength(1);
    expect(storeB.listBlockedInputs()[0]).toMatchObject({ issue_id: 'i-1' });

    storeB.deleteBreaker('i-1');
    storeB.deleteBlockedInput('i-1');
    expect(storeB.listBreakers()).toEqual([]);
    expect(storeB.listBlockedInputs()).toEqual([]);
  });

  it('persists operator action trails across reopen', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-store-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    storeA.upsertOperatorActions(
      'issue-1',
      JSON.stringify([
        {
          action: 'resume',
          requested_at_ms: Date.parse('2026-04-11T10:00:00.000Z'),
          result: 'accepted',
          result_code: null,
          message: null
        },
        {
          action: 'cancel',
          requested_at_ms: Date.parse('2026-04-11T10:01:00.000Z'),
          result: 'rejected',
          result_code: 'cancel_failed',
          message: 'not blocked'
        }
      ])
    );
    storeA.close();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    expect(storeB.listOperatorActions()).toEqual([
      {
        issue_id: 'issue-1',
        payload: expect.stringContaining('cancel_failed'),
        updated_at: expect.any(String)
      }
    ]);
  });
});
