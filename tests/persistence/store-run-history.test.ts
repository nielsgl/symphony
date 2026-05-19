import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDurableIdentity,
  createStoreTestHarness,
  fs,
  os,
  path,
  SqlitePersistenceStore
} from './store-test-harness';

describe('SqlitePersistenceStore run history', () => {
  const { dirs, stores, identity, openDatabase, tableNames, withLegacyProjectKey, cleanup } = createStoreTestHarness();

  afterEach(cleanup);
  it('persists append-only run/session history across restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-persistence-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14, nowMs: () => Date.parse('2026-04-11T10:00:00.000Z') });
    stores.push(storeA);

    const runId = storeA.startRun({ issue_id: 'i-1', issue_identifier: 'ABC-1', identity: identity({ issue_id: 'i-1' }) });
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
    expect(history[0].identity?.project.key).toBe(identity({ issue_id: 'i-1' }).project.key);
    expect(history[0].identity?.ticket.remote_issue_id).toBe('i-1');
    expect(history[0].completed_at).toBe('2026-04-11T10:00:00.000Z');
    expect(history[0].session_ids).toEqual(['thread-1-turn-1']);
  });

  it('persists completed_at for terminal statuses and leaves active runs null', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-completed-at-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const terminalStatuses = ['succeeded', 'failed', 'cancelled', 'timed_out', 'stalled'] as const;
    let nowMs = Date.parse('2026-04-11T10:00:00.000Z');

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14, nowMs: () => nowMs });
    stores.push(storeA);

    const activeRunId = storeA.startRun({
      issue_id: 'active-1',
      issue_identifier: 'ACTIVE-1',
      identity: identity({ issue_id: 'active-1', issue_identifier: 'ACTIVE-1' })
    });
    for (const [index, terminal_status] of terminalStatuses.entries()) {
      const runId = storeA.startRun({
        issue_id: `issue-${index}`,
        issue_identifier: `ABC-${index}`,
        identity: identity({ issue_id: `issue-${index}`, issue_identifier: `ABC-${index}` })
      });
      nowMs = Date.parse(`2026-04-11T10:0${index + 1}:00.000Z`);
      storeA.completeRun({
        run_id: runId,
        terminal_status,
        error_code: terminal_status === 'succeeded' ? null : `reason-${terminal_status}`,
        terminal_reason_code: terminal_status === 'succeeded' ? null : `reason-${terminal_status}`,
        session_id: `session-${terminal_status}`,
        thread_id: `thread-${terminal_status}`,
        turn_id: `turn-${terminal_status}`
      });
    }
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    const history = storeB.listRunHistory(10);
    const activeRun = history.find((run) => run.run_id === activeRunId);
    expect(activeRun).toMatchObject({
      terminal_status: null,
      ended_at: null,
      completed_at: null
    });

    for (const terminal_status of terminalStatuses) {
      const run = history.find((entry) => entry.terminal_status === terminal_status);
      expect(run?.completed_at).toBe(run?.ended_at);
      expect(run?.completed_at).toMatch(/^2026-04-11T10:0[1-5]:00.000Z$/);
      expect(run).toMatchObject({
        session_id: `session-${terminal_status}`,
        thread_id: `thread-${terminal_status}`,
        turn_id: `turn-${terminal_status}`
      });
    }
  });

  it('persists terminal reconciliation reason with root-cause diagnostics across restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-terminal-diagnostics-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14, nowMs: () => Date.parse('2026-04-11T10:05:00.000Z') });
    stores.push(storeA);

    const runId = storeA.startRun({ issue_id: 'i-1', issue_identifier: 'ABC-1', identity: identity({ issue_id: 'i-1' }) });
    storeA.recordSession(runId, 'session-linear');
    storeA.completeRun({
      run_id: runId,
      terminal_status: 'cancelled',
      error_code: 'non_active_state_transition',
      terminal_reason_code: 'non_active_state_transition',
      root_cause_status: 'blocked',
      root_cause_reason_code: 'missing_tool_output',
      root_cause_reason_detail: 'tool_name=linear_graphql call_id=call-1',
      root_cause_at: '2026-04-11T10:03:00.000Z',
      session_id: 'session-linear',
      thread_id: 'thread-linear',
      turn_id: 'turn-linear',
      missing_tool_output_recovery: {
        status: 'failed',
        original_tool_name: 'linear_graphql',
        original_call_id: 'call-1',
        final_outcome: {
          detail: 'token=abcd1234'
        }
      }
    });
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    const history = storeB.listRunHistory();

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      run_id: runId,
      issue_id: 'i-1',
      issue_identifier: 'ABC-1',
      terminal_status: 'cancelled',
      completed_at: '2026-04-11T10:05:00.000Z',
      error_code: 'non_active_state_transition',
      terminal_reason_code: 'non_active_state_transition',
      root_cause_status: 'blocked',
      root_cause_reason_code: 'missing_tool_output',
      root_cause_reason_detail: 'tool_name=linear_graphql call_id=call-1',
      root_cause_at: '2026-04-11T10:03:00.000Z',
      session_id: 'session-linear',
      thread_id: 'thread-linear',
      turn_id: 'turn-linear',
      session_ids: ['session-linear'],
      missing_tool_output_recovery: {
        status: 'failed',
        original_tool_name: 'linear_graphql',
        original_call_id: 'call-1',
        final_outcome: {
          detail: 'token=***REDACTED***'
        }
      }
    });
  });

  it('migrates existing persistence databases without breaking run history', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-execution-migration-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const legacyStore = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(legacyStore);
    const legacyRunId = legacyStore.startRun({
      issue_id: 'legacy-1',
      issue_identifier: 'LEG-1',
      identity: identity({ issue_id: 'legacy-1', issue_identifier: 'LEG-1' })
    });
    legacyStore.recordSession(legacyRunId, 'legacy-thread-legacy-turn');
    legacyStore.completeRun({ run_id: legacyRunId, terminal_status: 'succeeded' });
    legacyStore.close();
    stores.pop();

    const migratedStore = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(migratedStore);
    const issueRunId = migratedStore.appendIssueRun({
      issue_id: 'issue-2',
      issue_identifier: 'ABC-2',
      identity: identity({ issue_id: 'issue-2', issue_identifier: 'ABC-2' }),
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


});
