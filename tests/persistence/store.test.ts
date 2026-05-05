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

  it('persists normalized execution graph lineage across restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-execution-graph-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeA);
    const issueRunId = storeA.appendIssueRun({
      issue_id: 'issue-1',
      issue_identifier: 'ABC-1',
      started_at: '2026-04-11T10:00:00.000Z',
      status: 'running',
      reason_code: 'dispatch_started',
      reason_detail: 'initial dispatch'
    });
    const attemptId = storeA.appendAttempt({
      issue_run_id: issueRunId,
      attempt_number: 0,
      started_at: '2026-04-11T10:00:01.000Z',
      status: 'running',
      reason_code: 'attempt_started',
      reason_detail: null
    });
    const threadId = storeA.appendThread({
      attempt_id: attemptId,
      thread_id: 'thread-1',
      started_at: '2026-04-11T10:00:02.000Z',
      status: 'running',
      reason_code: 'codex_session_started',
      reason_detail: null
    });
    const turnId = storeA.appendTurn({
      thread_id: threadId,
      turn_index: 0,
      turn_id: 'turn-1',
      started_at: '2026-04-11T10:00:03.000Z',
      ended_at: '2026-04-11T10:04:00.000Z',
      status: 'succeeded',
      reason_code: 'turn_completed',
      reason_detail: 'ok'
    });
    storeA.appendPhaseSpan({
      turn_id: turnId,
      phase: 'planning',
      started_at: '2026-04-11T10:00:04.000Z',
      ended_at: '2026-04-11T10:01:00.000Z',
      status: 'succeeded',
      reason_code: 'phase_completed',
      reason_detail: null
    });
    storeA.appendToolSpan({
      turn_id: turnId,
      tool_name: 'exec_command',
      started_at: '2026-04-11T10:01:10.000Z',
      ended_at: '2026-04-11T10:01:11.000Z',
      status: 'succeeded',
      reason_code: 'tool_completed',
      reason_detail: 'token=abcd1234'
    });
    storeA.appendStateTransition({
      issue_run_id: issueRunId,
      attempt_id: attemptId,
      thread_id: threadId,
      turn_id: turnId,
      from_status: 'running',
      to_status: 'retrying',
      transitioned_at: '2026-04-11T10:04:01.000Z',
      status: 'retrying',
      reason_code: 'normal_completion',
      reason_detail: 'normal worker completion, continuing while issue is active'
    });
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    const lineage = storeB.reconstructThreadLineage(threadId);

    expect(lineage?.issue_run.issue_run_id).toBe(issueRunId);
    expect(lineage?.attempt.attempt_id).toBe(attemptId);
    expect(lineage?.thread.thread_id).toBe(threadId);
    expect(lineage?.turns).toHaveLength(1);
    expect(lineage?.turns[0].turn_id).toBe(turnId);
    expect(lineage?.turns[0].phase_spans[0]).toMatchObject({ phase: 'planning' });
    expect(lineage?.turns[0].tool_spans[0]).toMatchObject({
      tool_name: 'exec_command',
      reason_detail: 'token=***REDACTED***'
    });
    expect(lineage?.state_transitions).toEqual([
      expect.objectContaining({
        from_status: 'running',
        to_status: 'retrying',
        reason_code: 'normal_completion'
      })
    ]);
  });

  it('enforces execution graph references and monotonic timestamps', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-execution-integrity-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(store);

    const issueRunId = store.appendIssueRun({
      issue_id: 'issue-1',
      issue_identifier: 'ABC-1',
      started_at: '2026-04-11T10:00:00.000Z',
      status: 'running'
    });
    const attemptId = store.appendAttempt({
      issue_run_id: issueRunId,
      attempt_number: 0,
      started_at: '2026-04-11T10:00:01.000Z',
      status: 'running'
    });
    const threadId = store.appendThread({
      attempt_id: attemptId,
      thread_id: 'thread-1',
      started_at: '2026-04-11T10:00:02.000Z',
      status: 'running'
    });
    const turnId = store.appendTurn({
      thread_id: threadId,
      turn_index: 0,
      turn_id: 'turn-1',
      started_at: '2026-04-11T10:00:03.000Z',
      status: 'running'
    });
    const secondAttemptId = store.appendAttempt({
      issue_run_id: issueRunId,
      attempt_number: 1,
      started_at: '2026-04-11T10:00:04.000Z',
      status: 'running'
    });
    const secondThreadId = store.appendThread({
      attempt_id: secondAttemptId,
      thread_id: 'thread-2',
      started_at: '2026-04-11T10:00:05.000Z',
      status: 'running'
    });
    store.appendTurn({
      thread_id: secondThreadId,
      turn_index: 0,
      turn_id: 'turn-2',
      started_at: '2026-04-11T10:00:06.000Z',
      status: 'running'
    });
    const sameAttemptThreadId = store.appendThread({
      attempt_id: attemptId,
      thread_id: 'thread-3',
      started_at: '2026-04-11T10:00:06.500Z',
      status: 'running'
    });
    const sameAttemptTurnId = store.appendTurn({
      thread_id: sameAttemptThreadId,
      turn_index: 0,
      turn_id: 'turn-3',
      started_at: '2026-04-11T10:00:06.600Z',
      status: 'running'
    });

    expect(() =>
      store.appendPhaseSpan({
        turn_id: 'missing-turn',
        phase: 'planning',
        started_at: '2026-04-11T10:00:04.000Z',
        status: 'running'
      })
    ).toThrow(/does not exist/);
    expect(() =>
      store.appendToolSpan({
        turn_id: turnId,
        tool_name: 'exec_command',
        started_at: '2026-04-11T09:59:59.000Z',
        status: 'running'
      })
    ).toThrow(/monotonic/);
    store.appendStateTransition({
      issue_run_id: issueRunId,
      attempt_id: attemptId,
      thread_id: threadId,
      turn_id: turnId,
      to_status: 'running',
      transitioned_at: '2026-04-11T10:00:07.000Z',
      status: 'running',
      reason_code: 'turn_started'
    });
    expect(() =>
      store.appendStateTransition({
        issue_run_id: issueRunId,
        attempt_id: attemptId,
        thread_id: secondThreadId,
        to_status: 'running',
        transitioned_at: '2026-04-11T10:00:08.000Z',
        status: 'running',
        reason_code: 'lineage_mismatch'
      })
    ).toThrow(/does not belong to attempt/);
    expect(() =>
      store.appendStateTransition({
        issue_run_id: issueRunId,
        attempt_id: attemptId,
        thread_id: threadId,
        turn_id: sameAttemptTurnId,
        to_status: 'running',
        transitioned_at: '2026-04-11T10:00:09.000Z',
        status: 'running',
        reason_code: 'lineage_mismatch'
      })
    ).toThrow(/does not belong to thread/);
    expect(() =>
      store.appendStateTransition({
        issue_run_id: issueRunId,
        to_status: 'failed',
        transitioned_at: '2026-04-11T10:00:03.000Z',
        status: 'failed',
        reason_code: 'out_of_order'
      })
    ).toThrow(/monotonic/);
  });

  it('migrates existing persistence databases without breaking run history', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-execution-migration-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const legacyStore = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(legacyStore);
    const legacyRunId = legacyStore.startRun({ issue_id: 'legacy-1', issue_identifier: 'LEG-1' });
    legacyStore.recordSession(legacyRunId, 'legacy-thread-legacy-turn');
    legacyStore.completeRun({ run_id: legacyRunId, terminal_status: 'succeeded' });
    legacyStore.close();
    stores.pop();

    const migratedStore = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(migratedStore);
    const issueRunId = migratedStore.appendIssueRun({
      issue_id: 'issue-2',
      issue_identifier: 'ABC-2',
      started_at: '2026-04-11T11:00:00.000Z',
      status: 'running'
    });
    const attemptId = migratedStore.appendAttempt({
      issue_run_id: issueRunId,
      attempt_number: 0,
      started_at: '2026-04-11T11:00:01.000Z',
      status: 'running'
    });
    const threadId = migratedStore.appendThread({
      attempt_id: attemptId,
      thread_id: 'thread-migrated',
      started_at: '2026-04-11T11:00:02.000Z',
      status: 'running'
    });

    expect(migratedStore.listRunHistory()[0]).toMatchObject({
      run_id: legacyRunId,
      issue_identifier: 'LEG-1',
      terminal_status: 'succeeded'
    });
    expect(migratedStore.reconstructThreadLineage(threadId)?.issue_run.issue_identifier).toBe('ABC-2');
    expect(migratedStore.health().integrity_ok).toBe(true);
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
