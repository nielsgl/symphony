import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDurableIdentity,
  createStoreTestHarness,
  fs,
  os,
  path,
  SqlitePersistenceStore
} from './store-test-harness';

describe('SqlitePersistenceStore app server ledger', () => {
  const { dirs, stores, identity, openDatabase, tableNames, withLegacyProjectKey, cleanup } = createStoreTestHarness();

  afterEach(cleanup);
  it('stores App Server Event Ledger Lite records with bounded policy details across reopen', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-app-server-ledger-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeA);
    const issueRunId = storeA.appendIssueRun({
      issue_id: 'issue-1',
      issue_identifier: 'ABC-1',
      identity: identity(),
      started_at: '2026-04-11T10:00:00.000Z',
      status: 'running'
    });
    const attemptId = storeA.appendAttempt({
      issue_run_id: issueRunId,
      attempt_number: 0,
      started_at: '2026-04-11T10:00:01.000Z',
      status: 'running'
    });
    const threadId = storeA.appendThread({
      attempt_id: attemptId,
      thread_id: 'thread-ledger',
      started_at: '2026-04-11T10:00:02.000Z',
      status: 'running'
    });
    const turnId = storeA.appendTurn({
      thread_id: threadId,
      turn_index: 0,
      turn_id: 'turn-ledger',
      started_at: '2026-04-11T10:00:03.000Z',
      status: 'running'
    });
    storeA.appendAppServerEvent({
      issue_run_id: issueRunId,
      attempt_id: attemptId,
      thread_id: threadId,
      turn_id: turnId,
      observed_at: '2026-04-11T10:00:04.000Z',
      source_event_id: 'evt-response-1',
      source_event_name: 'rawResponseItem/completed',
      payload_class: 'protocol_request_response',
      raw_payload: {
        path: '/Users/alice/project/secret.txt',
        authorization: 'Bearer raw-secret-token',
        response: `token=abcd ${'diagnostic '.repeat(120)}`
      },
      summary: 'raw response item completed',
      summary_fields: {
        method: 'turn/start',
        account_id: 'acct_secret'
      }
    });
    storeA.appendAppServerEvent({
      issue_run_id: issueRunId,
      attempt_id: attemptId,
      thread_id: threadId,
      turn_id: turnId,
      observed_at: '2026-04-11T10:00:05.000Z',
      source_event_id: 'evt-tool-1',
      source_event_name: 'item/mcpToolCall/progress',
      payload_class: 'tool_payload',
      raw_payload: {
        tool_name: 'linear_graphql',
        variables: { token: 'raw-tool-token' }
      },
      summary: 'tool progress observed',
      summary_fields: { tool_name: 'linear_graphql' }
    });
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    const ledger = storeB.listAppServerEventLedger(issueRunId);

    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toMatchObject({
      issue_run_id: issueRunId,
      attempt_id: attemptId,
      thread_id: threadId,
      turn_id: turnId,
      source_event_id: 'evt-response-1',
      payload_class: 'protocol_request_response',
      detail_status: 'redacted_truncated_excerpt',
      redaction_status: 'redacted',
      full_payload_stored: false
    });
    expect(ledger[0].summary_fields).toMatchObject({
      method: 'turn/start',
      account_id: '***REDACTED_ACCOUNT***'
    });
    expect(ledger[0].redacted_excerpt).not.toContain('/Users/alice');
    expect(ledger[0].redacted_excerpt).not.toContain('raw-secret-token');
    expect(ledger[0].redacted_excerpt).not.toContain('abcd');
    expect(ledger[0].truncation.truncated).toBe(true);
    expect(ledger[1]).toMatchObject({
      source_event_id: 'evt-tool-1',
      payload_class: 'tool_payload',
      detail_status: 'unavailable_policy',
      redaction_status: 'unavailable_policy',
      redacted_excerpt: null,
      unavailable_reason_code: 'tool_payload_payload_not_stored',
      full_payload_stored: false
    });
    expect(JSON.stringify(ledger)).not.toContain('raw-tool-token');
  });

  it('projects bounded App Server Event Ledger Lite excerpts through run history', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-app-server-history-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeA);
    const started = storeA.recordRunStarted({
      issue_id: 'issue-history-ledger',
      issue_identifier: 'ABC-HISTORY-LEDGER',
      identity: identity({ issue_id: 'issue-history-ledger', issue_identifier: 'ABC-HISTORY-LEDGER' }),
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });
    const threadId = storeA.appendThread({
      attempt_id: started.attempt_id,
      thread_id: 'thread-history-ledger',
      started_at: '2026-04-11T10:00:01.000Z',
      status: 'running'
    });
    const turnId = storeA.appendTurn({
      thread_id: threadId,
      turn_index: 0,
      turn_id: 'turn-history-ledger',
      started_at: '2026-04-11T10:00:02.000Z',
      status: 'running'
    });
    storeA.appendAppServerEvent({
      issue_run_id: started.issue_run_id,
      attempt_id: started.attempt_id,
      thread_id: threadId,
      turn_id: turnId,
      observed_at: '2026-04-11T10:00:03.000Z',
      source_event_id: 'evt-history-warning',
      source_event_name: 'codex.protocol.warning',
      payload_class: 'protocol_lifecycle',
      summary: 'guardian warning',
      summary_fields: {
        protocol_event_category: 'warning',
        message: 'do not persist transcript token=history-secret'
      }
    });
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    const run = storeB.listRunHistory().find((entry) => entry.run_id === started.run_id);

    expect(run?.identity_projection).toMatchObject({
      run_id: started.run_id,
      issue_run_id: started.issue_run_id,
      projection_status: 'projected'
    });
    expect(run?.app_server_events).toEqual([
      expect.objectContaining({
        issue_run_id: started.issue_run_id,
        attempt_id: started.attempt_id,
        thread_id: 'thread-history-ledger',
        turn_id: 'turn-history-ledger',
        source_event_name: 'codex.protocol.warning',
        detail_status: 'summary_only',
        full_payload_stored: false,
        redacted_excerpt: null,
        summary_fields: expect.objectContaining({
          protocol_event_category: 'warning',
          message: 'do not persist transcript token=***REDACTED***'
        })
      })
    ]);
    expect(JSON.stringify(run)).not.toContain('history-secret');
  });

  it('keeps retained app-server-lite redaction and truncation metadata across repeated retention pruning', async () => {
    const base = Date.parse('2026-04-11T12:00:00.000Z');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-retention-ledger-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 1, nowMs: () => base });
    stores.push(store);
    const retainedIssueRunId = store.appendIssueRun({
      issue_id: 'retained-ledger',
      issue_identifier: 'RETAIN-1',
      identity: identity({ issue_id: 'retained-ledger', issue_identifier: 'RETAIN-1' }),
      started_at: '2026-04-12T18:00:00.000Z',
      ended_at: '2026-04-12T18:30:00.000Z',
      status: 'succeeded'
    });
    const retainedAttemptId = store.appendAttempt({
      issue_run_id: retainedIssueRunId,
      attempt_number: 0,
      started_at: '2026-04-12T18:00:01.000Z',
      ended_at: '2026-04-12T18:30:00.000Z',
      status: 'succeeded'
    });
    const retainedThreadId = store.appendThread({
      attempt_id: retainedAttemptId,
      thread_id: 'retained-thread-ledger',
      started_at: '2026-04-12T18:00:02.000Z',
      ended_at: '2026-04-12T18:30:00.000Z',
      status: 'succeeded'
    });
    const retainedTurnId = store.appendTurn({
      thread_id: retainedThreadId,
      turn_id: 'retained-turn-ledger',
      turn_index: 0,
      started_at: '2026-04-12T18:00:03.000Z',
      ended_at: '2026-04-12T18:30:00.000Z',
      status: 'succeeded'
    });
    store.appendAppServerEvent({
      issue_run_id: retainedIssueRunId,
      attempt_id: retainedAttemptId,
      thread_id: retainedThreadId,
      turn_id: retainedTurnId,
      observed_at: '2026-04-12T18:00:04.000Z',
      source_event_id: 'retained-app-event',
      source_event_name: 'rawResponseItem/completed',
      payload_class: 'protocol_request_response',
      raw_payload: {
        path: '/Users/alice/project/secret.txt',
        authorization: 'Bearer raw-secret-token',
        response: `token=abcd ${'diagnostic '.repeat(120)}`
      },
      summary: 'retained protocol evidence',
      summary_fields: { account_id: 'acct_secret' }
    });

    const firstPrune = new SqlitePersistenceStore({ dbPath, retentionDays: 1, nowMs: () => base + 2 * 24 * 60 * 60 * 1000 });
    stores.push(firstPrune);
    expect(firstPrune.pruneExpiredRuns()).toBe(0);
    const firstLedger = firstPrune.listAppServerEventLedger(retainedIssueRunId);
    expect(firstLedger[0]).toMatchObject({
      detail_status: 'redacted_truncated_excerpt',
      redaction_status: 'redacted',
      full_payload_stored: false
    });
    expect(firstLedger[0].summary_fields).toEqual({ account_id: '***REDACTED_ACCOUNT***' });
    expect(firstLedger[0].truncation.truncated).toBe(true);

    const secondPrune = new SqlitePersistenceStore({ dbPath, retentionDays: 1, nowMs: () => base + 2 * 24 * 60 * 60 * 1000 + 60_000 });
    stores.push(secondPrune);
    expect(secondPrune.pruneExpiredRuns()).toBe(0);
    expect(secondPrune.listAppServerEventLedger(retainedIssueRunId)).toEqual(firstLedger);
    expect(secondPrune.health().last_pruned_at).toBe('2026-04-13T12:01:00.000Z');
  });

  it('prunes all terminal expired app-server-lite history with retention tombstone metadata', async () => {
    const base = Date.parse('2026-04-11T12:00:00.000Z');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-retention-app-server-prune-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 1, nowMs: () => base });
    stores.push(store);

    const terminalStatuses = ['succeeded', 'failed', 'cancelled', 'timed_out', 'stalled'] as const;
    const activeStatuses = ['pending', 'running', 'retrying', 'blocked'] as const;
    const issueRunIdsByStatus = new Map<string, string>();
    const threadIdsByStatus = new Map<string, string>();

    const appendIssueRunHistory = (status: (typeof terminalStatuses)[number] | (typeof activeStatuses)[number], ended: boolean): string => {
      const issueRunId = store.appendIssueRun({
        issue_id: `expired-app-server-lite-${status}`,
        issue_identifier: `EXP-${status.toUpperCase()}`,
        identity: identity({
          issue_id: `expired-app-server-lite-${status}`,
          issue_identifier: `EXP-${status.toUpperCase()}`
        }),
        started_at: '2026-04-10T10:00:00.000Z',
        ended_at: ended ? '2026-04-10T10:30:00.000Z' : null,
        status
      });
      const attemptId = store.appendAttempt({
        issue_run_id: issueRunId,
        attempt_number: 0,
        started_at: '2026-04-10T10:00:01.000Z',
        ended_at: ended ? '2026-04-10T10:30:00.000Z' : null,
        status
      });
      const threadId = store.appendThread({
        attempt_id: attemptId,
        thread_id: `expired-app-server-thread-${status}`,
        started_at: '2026-04-10T10:00:02.000Z',
        ended_at: ended ? '2026-04-10T10:30:00.000Z' : null,
        status
      });
      const turnId = store.appendTurn({
        thread_id: threadId,
        turn_id: `expired-app-server-turn-${status}`,
        turn_index: 0,
        started_at: '2026-04-10T10:00:03.000Z',
        ended_at: ended ? '2026-04-10T10:30:00.000Z' : null,
        status
      });
      store.appendAppServerEvent({
        issue_run_id: issueRunId,
        attempt_id: attemptId,
        thread_id: threadId,
        turn_id: turnId,
        observed_at: '2026-04-10T10:00:04.000Z',
        source_event_id: `expired-app-server-event-${status}`,
        source_event_name: 'rawResponseItem/completed',
        payload_class: 'protocol_request_response',
        raw_payload: { message: `expired protocol evidence ${status}` },
        summary: `expired protocol evidence ${status}`
      });
      store.appendTrackerTicketSnapshot({
        issue_run_id: issueRunId,
        attempt_id: attemptId,
        thread_id: threadId,
        turn_id: turnId,
        tracker_kind: 'linear',
        remote_issue_id: `expired-app-server-lite-${status}`,
        human_issue_identifier: `EXP-${status.toUpperCase()}`,
        title: `Expired history ticket ${status}`,
        tracker_status: ended ? 'Done' : 'In Progress',
        observed_at: '2026-04-10T10:00:05.000Z'
      });
      store.appendTicketReference({
        issue_run_id: issueRunId,
        attempt_id: attemptId,
        thread_id: threadId,
        turn_id: turnId,
        reference_kind: 'pull_request',
        availability: 'available',
        uri: `https://github.com/nielsgl/symphony/pull/${900 + issueRunIdsByStatus.size}`,
        observed_at: '2026-04-10T10:00:06.000Z'
      });
      store.appendOperatorActionHistory({
        issue_run_id: issueRunId,
        attempt_id: attemptId,
        thread_id: threadId,
        turn_id: turnId,
        action: 'resume_blocked_input',
        result: 'accepted',
        requested_at: '2026-04-10T10:00:07.000Z',
        observed_at: '2026-04-10T10:00:07.000Z'
      });
      store.appendBlockedInputEvent({
        issue_run_id: issueRunId,
        attempt_id: attemptId,
        thread_id: threadId,
        turn_id: turnId,
        issue_id: `expired-app-server-lite-${status}`,
        issue_identifier: `EXP-${status.toUpperCase()}`,
        runtime_state: 'blocked',
        reason_code: 'operator_input_required',
        blocked_at: '2026-04-10T10:00:08.000Z'
      });
      issueRunIdsByStatus.set(status, issueRunId);
      threadIdsByStatus.set(status, threadId);
      return issueRunId;
    };

    for (const status of terminalStatuses) {
      appendIssueRunHistory(status, true);
    }
    for (const status of activeStatuses) {
      appendIssueRunHistory(status, false);
    }

    const lateStore = new SqlitePersistenceStore({ dbPath, retentionDays: 1, nowMs: () => base + 2 * 24 * 60 * 60 * 1000 });
    stores.push(lateStore);
    for (const status of terminalStatuses) {
      expect(lateStore.listAppServerEventLedger(issueRunIdsByStatus.get(status)!)).toHaveLength(1);
    }

    expect(lateStore.pruneExpiredRuns()).toBe(terminalStatuses.length);

    for (const status of terminalStatuses) {
      expect(lateStore.listAppServerEventLedger(issueRunIdsByStatus.get(status)!)).toEqual([]);
      expect(lateStore.reconstructThreadLineage(threadIdsByStatus.get(status)!)).toBeNull();
    }
    for (const status of activeStatuses) {
      expect(lateStore.listAppServerEventLedger(issueRunIdsByStatus.get(status)!)).toHaveLength(1);
      expect(lateStore.reconstructThreadLineage(threadIdsByStatus.get(status)!)?.issue_run.issue_run_id).toBe(issueRunIdsByStatus.get(status));
    }
    const db = openDatabase(dbPath);
    try {
      for (const status of terminalStatuses) {
        const issueRunId = issueRunIdsByStatus.get(status)!;
        const appServerRows = db
          .prepare('SELECT COUNT(*) AS count FROM history_app_server_event WHERE issue_run_id = ?')
          .get(issueRunId) as { count: number };
        expect(appServerRows.count).toBe(0);
        for (const table of [
          'history_tracker_ticket_snapshot',
          'history_ticket_reference',
          'history_operator_action',
          'history_blocked_input_event'
        ]) {
          const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE issue_run_id = ?`).get(issueRunId) as { count: number };
          expect(row.count).toBe(0);
        }
      }
      const tombstones = db
        .prepare(
          `SELECT source_table, source_id, reason_code, pruned_record_count, metadata
           FROM history_retention_prune_record
           WHERE source_table = 'issue_run'
           ORDER BY source_id ASC`
        )
        .all() as Array<{
        source_table: string;
        source_id: string;
        reason_code: string;
        pruned_record_count: number;
        metadata: string;
      }>;
      expect(tombstones).toHaveLength(terminalStatuses.length);
      for (const status of terminalStatuses) {
        const issueRunId = issueRunIdsByStatus.get(status)!;
        const tombstone = tombstones.find((record) => record.source_id === issueRunId);
        expect(tombstone).toMatchObject({
          source_table: 'issue_run',
          source_id: issueRunId,
          reason_code: 'retention_policy_expired_completed_history',
          pruned_record_count: 9
        });
        expect(JSON.parse(tombstone?.metadata ?? '{}')).toMatchObject({
          status,
          pruned_tables: expect.arrayContaining([
            'history_app_server_event',
            'history_tracker_ticket_snapshot',
            'history_ticket_reference',
            'history_operator_action',
            'history_blocked_input_event',
            'turn',
            'thread',
            'attempt',
            'issue_run'
          ])
        });
      }
    } finally {
      db.close();
    }
  });


});
