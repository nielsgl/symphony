import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { buildDurableIdentity } from '../../src/persistence/identity';
import { SqlitePersistenceStore } from '../../src/persistence/store';

describe('SqlitePersistenceStore', () => {
  const dirs: string[] = [];
  const stores: SqlitePersistenceStore[] = [];
  type TestDatabase = {
    exec(sql: string): void;
    close(): void;
    prepare(sql: string): {
      all(...args: unknown[]): unknown[];
      get(...args: unknown[]): unknown;
      run(...args: unknown[]): unknown;
    };
  };
  const identity = (params: { issue_id?: string; issue_identifier?: string; projectRoot?: string; workflowPath?: string; trackerScope?: string | null } = {}) =>
    buildDurableIdentity({
      projectRoot: params.projectRoot ?? '/repo/main',
      workflowPath: params.workflowPath ?? '/repo/main/WORKFLOW.md',
      workflowHash: { status: 'present', value: 'workflow-hash' },
      repositoryRemote: { status: 'present', value: 'git@github.com:nielsgl/symphony.git' },
      trackerKind: 'linear',
      trackerScope: 'trackerScope' in params ? params.trackerScope : 'symphony',
      remoteIssueId: params.issue_id ?? 'issue-1',
      humanIssueIdentifier: params.issue_identifier ?? 'ABC-1'
    });
  const openDatabase = (dbPath: string): TestDatabase => {
    const sqlite = require('node:sqlite') as { DatabaseSync: new (path: string) => TestDatabase };
    return new sqlite.DatabaseSync(dbPath);
  };
  const tableNames = (dbPath: string): string[] => {
    const db = openDatabase(dbPath);
    try {
      return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map(
        (row) => row.name
      );
    } finally {
      db.close();
    }
  };

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

  it('persists durable project and ticket identity across run and execution graph reopen', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-identity-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({
      issue_id: 'linear-remote-1',
      issue_identifier: 'NIE-139',
      projectRoot: path.join(dir, 'same-name'),
      workflowPath: path.join(dir, 'same-name', 'WORKFLOW.md')
    });

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeA);
    const runId = storeA.startRun({
      issue_id: 'linear-remote-1',
      issue_identifier: 'NIE-139',
      identity: durableIdentity
    });
    const issueRunId = storeA.appendIssueRun({
      issue_id: 'linear-remote-1',
      issue_identifier: 'NIE-139',
      identity: durableIdentity,
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
      thread_id: 'thread-identity',
      started_at: '2026-04-11T10:00:02.000Z',
      status: 'running'
    });
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);

    expect(storeB.listRunHistory()[0]).toMatchObject({
      run_id: runId,
      identity: durableIdentity
    });
    expect(storeB.reconstructThreadLineage(threadId)?.issue_run.identity).toEqual(durableIdentity);
  });

  it('creates a versioned Project Execution History schema on clean databases', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-history-schema-clean-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 30, nowMs: () => Date.parse('2026-04-11T10:00:00.000Z') });
    stores.push(store);
    const durableIdentity = identity({ issue_id: 'history-clean-1', issue_identifier: 'HIST-1' });
    store.startRun({ issue_id: 'history-clean-1', issue_identifier: 'HIST-1', identity: durableIdentity });

    expect(tableNames(dbPath)).toEqual(
      expect.arrayContaining([
        'history_schema_state',
        'history_schema_migrations',
        'history_project_identity',
        'history_ticket_identity',
        'history_identity_projection',
        'history_protocol_summary',
        'history_app_server_event',
        'history_token_model_fact',
        'history_ticket_terminal_outcome',
        'history_ticket_blocker',
        'history_ticket_evidence_reference',
        'history_tracker_ticket_snapshot',
        'history_ticket_reference',
        'history_operator_action',
        'history_blocked_input_event',
        'history_write_failure',
        'history_retention_metadata',
        'history_retention_prune_record',
        'history_health_metadata',
        'issue_run',
        'attempt',
        'thread',
        'turn',
        'phase_span',
        'tool_span',
        'state_transition'
      ])
    );
    expect(store.historySchemaHealth()).toMatchObject({
      schema_name: 'project_execution_history',
      target_version: 7,
      applied_version: 7,
      status: 'healthy',
      degraded_reason_code: null
    });
    expect(store.historySchemaHealth().migrations).toEqual([
      expect.objectContaining({ version: 1, name: 'project_execution_history_v1', status: 'applied' }),
      expect.objectContaining({ version: 2, name: 'ticket_orchestration_ledger_v1', status: 'applied' }),
      expect.objectContaining({ version: 3, name: 'app_server_event_ledger_lite_policy', status: 'applied' }),
      expect.objectContaining({ version: 4, name: 'existing_run_history_identity_backfill_v1', status: 'applied' }),
      expect.objectContaining({ version: 5, name: 'token_model_fact_dimensions_v1', status: 'applied' }),
      expect.objectContaining({ version: 6, name: 'operational_history_facts_v1', status: 'applied' }),
      expect.objectContaining({ version: 7, name: 'history_retention_prune_evidence_v1', status: 'applied' })
    ]);
  });

  it('persists history identity rows in the versioned schema', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-history-identity-schema-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(store);
    const durableIdentity = identity({ issue_id: 'remote-history-1', issue_identifier: 'HIST-2' });
    store.startRun({ issue_id: 'remote-history-1', issue_identifier: 'HIST-2', identity: durableIdentity });

    const db = openDatabase(dbPath);
    try {
      expect(db.prepare('SELECT project_key FROM history_project_identity').all()).toEqual([
        { project_key: durableIdentity.project.key }
      ]);
      expect(db.prepare('SELECT ticket_key, project_key, remote_issue_id FROM history_ticket_identity').all()).toEqual([
        {
          ticket_key: durableIdentity.ticket.key,
          project_key: durableIdentity.project.key,
          remote_issue_id: 'remote-history-1'
        }
      ]);
    } finally {
      db.close();
    }
  });

  it('keeps project and ticket identity collision inputs distinct', () => {
    const rootA = identity({
      issue_id: 'remote-1',
      issue_identifier: 'TASK-1',
      projectRoot: '/work/a/service',
      workflowPath: '/work/a/service/WORKFLOW.md'
    });
    const rootB = identity({
      issue_id: 'remote-1',
      issue_identifier: 'TASK-1',
      projectRoot: '/work/b/service',
      workflowPath: '/work/b/service/WORKFLOW.md'
    });
    const workflowChanged = identity({
      issue_id: 'remote-1',
      issue_identifier: 'TASK-1',
      projectRoot: '/work/a/service',
      workflowPath: '/work/a/service/alternate/WORKFLOW.md'
    });
    const renamedTicket = identity({
      issue_id: 'remote-1',
      issue_identifier: 'TASK-99',
      projectRoot: '/work/a/service',
      workflowPath: '/work/a/service/WORKFLOW.md'
    });
    const reusedHumanIdOtherScope = identity({
      issue_id: 'remote-2',
      issue_identifier: 'TASK-1',
      projectRoot: '/work/a/service',
      workflowPath: '/work/a/service/WORKFLOW.md',
      trackerScope: 'other-project'
    });

    expect(rootA.project.key).not.toBe(rootB.project.key);
    expect(rootA.project.key).not.toBe(workflowChanged.project.key);
    expect(rootA.ticket.key).toBe(renamedTicket.ticket.key);
    expect(rootA.ticket.human_issue_identifier).not.toBe(renamedTicket.ticket.human_issue_identifier);
    expect(rootA.ticket.key).not.toBe(reusedHumanIdOtherScope.ticket.key);
  });

  it('represents missing optional identity evidence explicitly', () => {
    const missingEvidence = buildDurableIdentity({
      projectRoot: '/repo',
      workflowPath: '/repo/WORKFLOW.md',
      workflowHash: { status: 'missing', reason: 'workflow_file_unreadable' },
      repositoryRemote: { status: 'missing', reason: 'repository_remote_unavailable' },
      trackerKind: 'linear',
      trackerScope: null,
      remoteIssueId: 'issue-1',
      humanIssueIdentifier: 'ABC-1'
    });

    expect(missingEvidence.project.workflow_hash).toEqual({ status: 'missing', reason: 'workflow_file_unreadable' });
    expect(missingEvidence.project.repository_remote).toEqual({ status: 'missing', reason: 'repository_remote_unavailable' });
    expect(missingEvidence.ticket.tracker_scope).toEqual({ status: 'missing', reason: 'tracker_scope_unavailable' });
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

  it('persists normalized execution graph lineage across restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-execution-graph-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeA);
    const issueRunId = storeA.appendIssueRun({
      issue_id: 'issue-1',
      issue_identifier: 'ABC-1',
      identity: identity(),
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
    const lineageByIssue = storeB.reconstructLatestThreadLineageByIssueIdentifier('ABC-1');

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
    expect(lineageByIssue?.thread.thread_id).toBe(threadId);
    expect(storeB.reconstructLatestThreadLineageByIssueIdentifier('ABC-404')).toBeNull();
  });

  it('reconstructs a ticket timeline across multiple attempts and restart by durable identity', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-ticket-ledger-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({ issue_id: 'remote-ticket-1', issue_identifier: 'TICKET-1' });
    const renamedIdentity = identity({ issue_id: 'remote-ticket-1', issue_identifier: 'TICKET-99' });
    const reusedHumanIdentifier = identity({ issue_id: 'remote-ticket-2', issue_identifier: 'TICKET-1', trackerScope: 'other-scope' });

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeA);
    const issueRunId = storeA.appendIssueRun({
      issue_id: 'remote-ticket-1',
      issue_identifier: 'TICKET-1',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      ended_at: '2026-04-11T10:20:00.000Z',
      status: 'succeeded'
    });
    const attemptZeroId = storeA.appendAttempt({
      issue_run_id: issueRunId,
      attempt_number: 0,
      started_at: '2026-04-11T10:00:01.000Z',
      ended_at: '2026-04-11T10:05:00.000Z',
      status: 'blocked',
      reason_code: 'missing_tool_output'
    });
    const threadZeroId = storeA.appendThread({
      attempt_id: attemptZeroId,
      thread_id: 'thread-ticket-0',
      started_at: '2026-04-11T10:00:02.000Z',
      ended_at: '2026-04-11T10:05:00.000Z',
      status: 'blocked'
    });
    const turnZeroId = storeA.appendTurn({
      thread_id: threadZeroId,
      turn_id: 'turn-ticket-0',
      turn_index: 0,
      started_at: '2026-04-11T10:00:03.000Z',
      ended_at: '2026-04-11T10:05:00.000Z',
      status: 'blocked'
    });
    storeA.appendPhaseSpan({
      turn_id: turnZeroId,
      phase: 'dispatch',
      started_at: '2026-04-11T10:00:04.000Z',
      ended_at: '2026-04-11T10:01:00.000Z',
      status: 'succeeded',
      reason_code: 'phase_completed'
    });
    storeA.appendTicketBlocker({
      issue_run_id: issueRunId,
      attempt_id: attemptZeroId,
      thread_id: threadZeroId,
      turn_id: turnZeroId,
      blocker_type: 'tool_output',
      status: 'resolved',
      reason_code: 'missing_tool_output',
      reason_detail: 'token=abcd1234',
      blocked_at: '2026-04-11T10:05:00.000Z',
      resolved_at: '2026-04-11T10:10:00.000Z'
    });
    storeA.appendStateTransition({
      issue_run_id: issueRunId,
      attempt_id: attemptZeroId,
      thread_id: threadZeroId,
      turn_id: turnZeroId,
      from_status: 'running',
      to_status: 'blocked',
      transitioned_at: '2026-04-11T10:05:01.000Z',
      status: 'blocked',
      reason_code: 'missing_tool_output'
    });
    const attemptOneId = storeA.appendAttempt({
      issue_run_id: issueRunId,
      attempt_number: 1,
      started_at: '2026-04-11T10:10:00.000Z',
      ended_at: '2026-04-11T10:20:00.000Z',
      status: 'succeeded',
      reason_code: 'retry_completed'
    });
    const threadOneId = storeA.appendThread({
      attempt_id: attemptOneId,
      thread_id: 'thread-ticket-1',
      started_at: '2026-04-11T10:10:01.000Z',
      ended_at: '2026-04-11T10:20:00.000Z',
      status: 'succeeded'
    });
    const turnOneId = storeA.appendTurn({
      thread_id: threadOneId,
      turn_id: 'turn-ticket-1',
      turn_index: 0,
      started_at: '2026-04-11T10:10:02.000Z',
      ended_at: '2026-04-11T10:20:00.000Z',
      status: 'succeeded'
    });
    storeA.appendPhaseSpan({
      turn_id: turnOneId,
      phase: 'implementation',
      started_at: '2026-04-11T10:10:03.000Z',
      ended_at: '2026-04-11T10:19:00.000Z',
      status: 'succeeded',
      reason_code: 'phase_completed'
    });
    storeA.appendTicketEvidenceReference({
      issue_run_id: issueRunId,
      attempt_id: attemptOneId,
      thread_id: threadOneId,
      turn_id: turnOneId,
      evidence_kind: 'test_output',
      uri: 'file://validation/persistence.txt',
      title: 'persistence restart proof',
      metadata: { command: 'npm test -- tests/persistence/store.test.ts', token: 'abcd1234' },
      recorded_at: '2026-04-11T10:19:30.000Z'
    });
    storeA.appendTicketTerminalOutcome({
      issue_run_id: issueRunId,
      attempt_id: attemptOneId,
      thread_id: threadOneId,
      turn_id: turnOneId,
      outcome: 'succeeded',
      reason_code: 'agent_review_ready',
      reason_detail: 'ticket timeline complete',
      recorded_at: '2026-04-11T10:20:00.000Z'
    });
    storeA.appendIssueRun({
      issue_id: 'remote-ticket-2',
      issue_identifier: 'TICKET-1',
      identity: reusedHumanIdentifier,
      started_at: '2026-04-11T11:00:00.000Z',
      status: 'running'
    });
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    const timeline = storeB.reconstructTicketTimeline(renamedIdentity);
    const otherTimeline = storeB.reconstructTicketTimeline(reusedHumanIdentifier);

    expect(timeline.issue_runs.map((run) => run.issue_run_id)).toEqual([issueRunId]);
    expect(timeline.issue_runs[0].identity?.ticket.human_issue_identifier).toBe('TICKET-1');
    expect(timeline.attempts.map((attempt) => attempt.attempt_number)).toEqual([0, 1]);
    expect(timeline.threads.map((thread) => thread.thread_id)).toEqual(['thread-ticket-0', 'thread-ticket-1']);
    expect(timeline.phase_spans.map((phase) => phase.phase)).toEqual(['dispatch', 'implementation']);
    expect(timeline.state_transitions).toEqual([expect.objectContaining({ to_status: 'blocked', reason_code: 'missing_tool_output' })]);
    expect(timeline.blockers).toEqual([
      expect.objectContaining({
        blocker_type: 'tool_output',
        status: 'resolved',
        reason_detail: 'token=***REDACTED***'
      })
    ]);
    expect(timeline.evidence_references).toEqual([
      expect.objectContaining({
        evidence_kind: 'test_output',
        title: 'persistence restart proof',
        metadata: { command: 'npm test -- tests/persistence/store.test.ts', token: '***REDACTED***' }
      })
    ]);
    expect(timeline.terminal_outcomes).toEqual([
      expect.objectContaining({ outcome: 'succeeded', reason_code: 'agent_review_ready' })
    ]);
    expect(otherTimeline.issue_runs).toHaveLength(1);
    expect(otherTimeline.attempts).toHaveLength(0);
  });

  it('persists operational tracker facts, references, and operator actions across restart with duplicate coalescing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-operational-history-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({ issue_id: 'remote-operational-1', issue_identifier: 'OPS-1' });

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeA);
    const issueRunId = storeA.appendIssueRun({
      issue_id: 'remote-operational-1',
      issue_identifier: 'OPS-1',
      identity: durableIdentity,
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
      thread_id: 'thread-ops',
      started_at: '2026-04-11T10:00:02.000Z',
      status: 'running'
    });
    const turnId = storeA.appendTurn({
      thread_id: threadId,
      turn_id: 'turn-ops',
      turn_index: 0,
      started_at: '2026-04-11T10:00:03.000Z',
      status: 'running'
    });

    storeA.appendTrackerTicketSnapshot({
      identity: durableIdentity,
      issue_run_id: issueRunId,
      attempt_id: attemptId,
      thread_id: threadId,
      turn_id: turnId,
      tracker_kind: 'linear',
      remote_issue_id: 'remote-operational-1',
      human_issue_identifier: 'OPS-1',
      title: 'Record tracker facts token=secret',
      tracker_status: 'In Progress',
      labels: ['ready-for-agent', 'history'],
      assignee_status: 'unknown',
      assignee_reason: 'tracker_assignee_unobserved',
      project_status: 'available',
      project_identifier: 'symphony',
      team_status: 'unavailable',
      team_reason: 'tracker_team_unavailable',
      observed_at: '2026-04-11T10:00:04.000Z'
    });
    storeA.appendTrackerTicketSnapshot({
      identity: durableIdentity,
      issue_run_id: issueRunId,
      attempt_id: attemptId,
      thread_id: threadId,
      turn_id: turnId,
      tracker_kind: 'linear',
      remote_issue_id: 'remote-operational-1',
      human_issue_identifier: 'OPS-1',
      title: 'Record tracker facts token=secret',
      tracker_status: 'In Progress',
      labels: ['history', 'ready-for-agent'],
      assignee_status: 'unknown',
      assignee_reason: 'tracker_assignee_unobserved',
      project_status: 'available',
      project_identifier: 'symphony',
      team_status: 'unavailable',
      team_reason: 'tracker_team_unavailable',
      observed_at: '2026-04-11T10:01:04.000Z'
    });
    storeA.appendTicketReference({
      issue_run_id: issueRunId,
      attempt_id: attemptId,
      thread_id: threadId,
      turn_id: turnId,
      reference_kind: 'pull_request',
      availability: 'available',
      uri: 'https://github.com/nielsgl/symphony/pull/242',
      label: 'PR #242',
      external_id: '242',
      state: 'open',
      metadata: { review_state: 'pending', token: 'abcd1234' },
      observed_at: '2026-04-11T10:02:00.000Z'
    });
    storeA.appendTicketReference({
      issue_run_id: issueRunId,
      attempt_id: attemptId,
      reference_kind: 'review',
      availability: 'unknown',
      metadata: { reason: 'review_state_unobserved' },
      observed_at: '2026-04-11T10:02:01.000Z'
    });
    storeA.appendOperatorActionHistory({
      issue_run_id: issueRunId,
      attempt_id: attemptId,
      thread_id: threadId,
      turn_id: turnId,
      action: 'submit_input',
      actor: 'operator',
      result: 'accepted',
      result_code: 'native_applied',
      message: 'operator answer accepted',
      reason_note: 'continue after clarification token=abcd1234',
      phase: 'implementation',
      state_context: { pre_state: 'blocked', post_state: 'running', token: 'abcd1234' },
      requested_at: '2026-04-11T10:03:00.000Z',
      observed_at: '2026-04-11T10:03:01.000Z'
    });
    storeA.appendBlockedInputEvent({
      issue_run_id: issueRunId,
      attempt_id: attemptId,
      thread_id: threadId,
      turn_id: turnId,
      issue_id: 'remote-operational-1',
      issue_identifier: 'OPS-1',
      phase: 'implementation',
      runtime_state: 'blocked',
      reason_code: 'operator_input_required',
      reason_detail: 'Need operator answer token=abcd1234',
      request_id: 'request-1',
      request_method: 'input/request',
      input_schema_type: 'options',
      prompt_text: 'Choose deployment mode token=abcd1234',
      pending_input: {
        request_id: 'request-1',
        questions: [{ id: 'mode', prompt: 'Mode?', options: [{ label: 'Fast', value: 'fast' }] }],
        token: 'abcd1234'
      },
      state_context: {
        branch_name: 'feature/OPS-1',
        previous_session_id: 'session-1',
        token: 'abcd1234'
      },
      blocked_at: '2026-04-11T10:03:10.000Z'
    });
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    const timeline = storeB.reconstructTicketTimeline(durableIdentity);

    expect(timeline.tracker_snapshots).toEqual([
      expect.objectContaining({
        project_key: durableIdentity.project.key,
        ticket_key: durableIdentity.ticket.key,
        issue_run_id: issueRunId,
        labels: ['history', 'ready-for-agent'],
        title: 'Record tracker facts token=***REDACTED***',
        assignee_status: 'unknown',
        project_identifier: 'symphony',
        duplicate_count: 2,
        observed_at: '2026-04-11T10:00:04.000Z',
        last_observed_at: '2026-04-11T10:01:04.000Z'
      })
    ]);
    expect(timeline.ticket_references).toEqual([
      expect.objectContaining({
        reference_kind: 'pull_request',
        availability: 'available',
        uri: 'https://github.com/nielsgl/symphony/pull/242',
        metadata: { review_state: 'pending', token: '***REDACTED***' }
      }),
      expect.objectContaining({
        reference_kind: 'review',
        availability: 'unknown',
        metadata: { reason: 'review_state_unobserved' }
      })
    ]);
    expect(timeline.operator_actions).toEqual([
      expect.objectContaining({
        action: 'submit_input',
        result: 'accepted',
        reason_note: 'continue after clarification token=***REDACTED***',
        phase: 'implementation',
        state_context: { pre_state: 'blocked', post_state: 'running', token: '***REDACTED***' }
      })
    ]);
    expect(timeline.blocked_input_events).toEqual([
      expect.objectContaining({
        issue_id: 'remote-operational-1',
        issue_identifier: 'OPS-1',
        phase: 'implementation',
        runtime_state: 'blocked',
        reason_code: 'operator_input_required',
        reason_detail: 'Need operator answer token=***REDACTED***',
        request_id: 'request-1',
        request_method: 'input/request',
        input_schema_type: 'options',
        prompt_text: 'Choose deployment mode token=***REDACTED***',
        pending_input: expect.objectContaining({ request_id: 'request-1', token: '***REDACTED***' }),
        state_context: expect.objectContaining({ branch_name: 'feature/OPS-1', token: '***REDACTED***' })
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
      identity: identity(),
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

  it('runs history schema migrations idempotently across repeated opens', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-history-idempotent-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14, nowMs: () => Date.parse('2026-04-11T10:00:00.000Z') });
    stores.push(storeA);
    expect(storeA.historySchemaHealth().migrations).toHaveLength(7);
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14, nowMs: () => Date.parse('2026-04-11T10:10:00.000Z') });
    stores.push(storeB);

    expect(storeB.historySchemaHealth()).toMatchObject({ applied_version: 7, status: 'healthy' });
    expect(storeB.historySchemaHealth().migrations).toEqual([
      expect.objectContaining({ version: 1, status: 'applied' }),
      expect.objectContaining({ version: 2, status: 'applied' }),
      expect.objectContaining({ version: 3, status: 'applied' }),
      expect.objectContaining({ version: 4, status: 'applied' }),
      expect.objectContaining({ version: 5, status: 'applied' }),
      expect.objectContaining({ version: 6, status: 'applied' }),
      expect.objectContaining({ version: 7, status: 'applied' })
    ]);
  });

  it('upgrades partial legacy history tables and records applied migration state', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-history-partial-legacy-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const db = openDatabase(dbPath);
    try {
      db.exec(`
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY,
          issue_id TEXT NOT NULL,
          issue_identifier TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          terminal_status TEXT,
          error_code TEXT
        );
        CREATE TABLE run_sessions (
          run_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          PRIMARY KEY (run_id, session_id)
        );
        CREATE TABLE run_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          at TEXT NOT NULL,
          event TEXT NOT NULL,
          message TEXT
        );
        CREATE TABLE issue_run (
          issue_run_id TEXT PRIMARY KEY,
          issue_id TEXT NOT NULL,
          issue_identifier TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        CREATE TABLE attempt (
          attempt_id TEXT PRIMARY KEY,
          issue_run_id TEXT NOT NULL,
          attempt_number INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        CREATE TABLE thread (
          thread_id TEXT PRIMARY KEY,
          attempt_id TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        CREATE TABLE turn (
          turn_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_index INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        CREATE TABLE phase_span (
          phase_span_id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL,
          phase TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        CREATE TABLE tool_span (
          tool_span_id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        CREATE TABLE state_transition (
          state_transition_id TEXT PRIMARY KEY,
          issue_run_id TEXT NOT NULL,
          attempt_id TEXT,
          thread_id TEXT,
          turn_id TEXT,
          from_status TEXT,
          to_status TEXT NOT NULL,
          transitioned_at TEXT NOT NULL,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        INSERT INTO runs (run_id, issue_id, issue_identifier, started_at, ended_at, terminal_status, error_code)
        VALUES ('legacy-run-1', 'legacy-issue-1', 'LEG-1', '2026-04-11T10:00:00.000Z', '2026-04-11T10:05:00.000Z', 'failed', 'legacy_error');
      `);
    } finally {
      db.close();
    }

    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(store);

    expect(store.listRunHistory()).toEqual([
      expect.objectContaining({
        run_id: 'legacy-run-1',
        issue_identifier: 'LEG-1',
        completed_at: '2026-04-11T10:05:00.000Z',
        terminal_reason_code: 'legacy_error'
      })
    ]);
    expect(store.historySchemaHealth()).toMatchObject({ applied_version: 7, status: 'healthy' });
    expect(tableNames(dbPath)).toEqual(
      expect.arrayContaining([
        'history_token_model_fact',
        'history_protocol_summary',
        'history_ticket_evidence_reference',
        'history_app_server_event'
      ])
    );
  });

  it('backfills existing run history identity projections and degraded evidence idempotently', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-history-backfill-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const projectedIdentity = identity({
      issue_id: 'legacy-remote-1',
      issue_identifier: 'LEG-1',
      trackerScope: null
    });
    const issueRunIdentity = identity({
      issue_id: 'legacy-remote-2',
      issue_identifier: 'LEG-2'
    });
    const db = openDatabase(dbPath);
    try {
      db.exec(`
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY,
          issue_id TEXT NOT NULL,
          issue_identifier TEXT NOT NULL,
          identity TEXT,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          terminal_status TEXT,
          error_code TEXT
        );
        CREATE TABLE run_sessions (
          run_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          PRIMARY KEY (run_id, session_id)
        );
        CREATE TABLE run_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          at TEXT NOT NULL,
          event TEXT NOT NULL,
          message TEXT
        );
        CREATE TABLE issue_run (
          issue_run_id TEXT PRIMARY KEY,
          issue_id TEXT NOT NULL,
          issue_identifier TEXT NOT NULL,
          identity TEXT,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        CREATE TABLE attempt (
          attempt_id TEXT PRIMARY KEY,
          issue_run_id TEXT NOT NULL,
          attempt_number INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        CREATE TABLE thread (
          thread_id TEXT PRIMARY KEY,
          attempt_id TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        CREATE TABLE turn (
          turn_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_index INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        CREATE TABLE phase_span (
          phase_span_id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL,
          phase TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        CREATE TABLE tool_span (
          tool_span_id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
        CREATE TABLE state_transition (
          state_transition_id TEXT PRIMARY KEY,
          issue_run_id TEXT NOT NULL,
          attempt_id TEXT,
          thread_id TEXT,
          turn_id TEXT,
          from_status TEXT,
          to_status TEXT NOT NULL,
          transitioned_at TEXT NOT NULL,
          status TEXT NOT NULL,
          reason_code TEXT,
          reason_detail TEXT
        );
      `);
      db.prepare(
        `INSERT INTO runs (run_id, issue_id, issue_identifier, identity, started_at, ended_at, terminal_status, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'legacy-run-projectable',
        'legacy-remote-1',
        'LEG-1',
        JSON.stringify(projectedIdentity),
        '2026-04-11T10:00:00.000Z',
        '2026-04-11T10:05:00.000Z',
        'failed',
        'legacy_error'
      );
      db.prepare(
        `INSERT INTO runs (run_id, issue_id, issue_identifier, identity, started_at, ended_at, terminal_status, error_code)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`
      ).run(
        'legacy-run-degraded',
        'legacy-remote-missing',
        'LEG-MISSING',
        '2026-04-11T10:10:00.000Z',
        '2026-04-11T10:15:00.000Z',
        'failed',
        'legacy_missing_identity'
      );
      db.prepare(
        `INSERT INTO issue_run (issue_run_id, issue_id, issue_identifier, identity, started_at, ended_at, status, reason_code, reason_detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'legacy-issue-run-projectable',
        'legacy-remote-2',
        'LEG-2',
        JSON.stringify(issueRunIdentity),
        '2026-04-11T11:00:00.000Z',
        null,
        'running',
        null,
        null
      );
    } finally {
      db.close();
    }

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14, nowMs: () => Date.parse('2026-04-11T12:00:00.000Z') });
    stores.push(storeA);
    const history = storeA.listRunHistory(10);

    expect(history.find((run) => run.run_id === 'legacy-run-projectable')).toMatchObject({
      issue_identifier: 'LEG-1',
      identity: projectedIdentity,
      identity_projection: {
        source_table: 'runs',
        source_id: 'legacy-run-projectable',
        projection_status: 'projected',
        reason_code: null,
        project_key: projectedIdentity.project.key,
        ticket_key: projectedIdentity.ticket.key
      }
    });
    expect(history.find((run) => run.run_id === 'legacy-run-projectable')?.identity?.ticket.tracker_scope).toEqual({
      status: 'missing',
      reason: 'tracker_scope_unavailable'
    });
    expect(history.find((run) => run.run_id === 'legacy-run-degraded')).toMatchObject({
      issue_identifier: 'LEG-MISSING',
      identity: null,
      identity_projection: {
        source_table: 'runs',
        source_id: 'legacy-run-degraded',
        projection_status: 'degraded',
        reason_code: 'missing_durable_identity',
        project_key: null,
        ticket_key: null
      }
    });
    const backfillDbA = openDatabase(dbPath);
    try {
      expect(backfillDbA.prepare('SELECT project_key FROM history_project_identity ORDER BY project_key').all()).toEqual(
        expect.arrayContaining([{ project_key: projectedIdentity.project.key }, { project_key: issueRunIdentity.project.key }])
      );
      expect(
        backfillDbA
          .prepare('SELECT issue_run_id, project_key, ticket_key FROM issue_run WHERE issue_run_id = ?')
          .get('legacy-issue-run-projectable')
      ).toEqual({
        issue_run_id: 'legacy-issue-run-projectable',
        project_key: issueRunIdentity.project.key,
        ticket_key: issueRunIdentity.ticket.key
      });
      expect(backfillDbA.prepare('SELECT COUNT(*) AS count FROM history_identity_projection').get()).toEqual({ count: 3 });
    } finally {
      backfillDbA.close();
    }
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14, nowMs: () => Date.parse('2026-04-11T12:05:00.000Z') });
    stores.push(storeB);
    const backfillDbB = openDatabase(dbPath);
    try {
      expect(storeB.historySchemaHealth()).toMatchObject({ applied_version: 7, status: 'healthy' });
      expect(backfillDbB.prepare('SELECT COUNT(*) AS count FROM history_identity_projection').get()).toEqual({ count: 3 });
    } finally {
      backfillDbB.close();
    }
  });

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

  it('persists token and effective model facts across restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-token-model-fact-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({ issue_id: 'remote-token-model-1', issue_identifier: 'TOK-1' });

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeA);
    const started = storeA.recordRunStarted({
      issue_id: 'remote-token-model-1',
      issue_identifier: 'TOK-1',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });
    const threadId = storeA.appendThread({
      attempt_id: started.attempt_id,
      thread_id: 'thread-token-model',
      started_at: '2026-04-11T10:00:02.000Z',
      status: 'running'
    });
    const turnId = storeA.appendTurn({
      thread_id: threadId,
      turn_id: 'turn-token-model',
      turn_index: 0,
      started_at: '2026-04-11T10:00:03.000Z',
      status: 'running'
    });
    storeA.appendTokenModelFact({
      issue_run_id: started.issue_run_id,
      attempt_id: started.attempt_id,
      thread_id: threadId,
      turn_id: turnId,
      requested_model: 'gpt-requested',
      effective_model: 'gpt-effective',
      model_source: 'thread/tokenUsage/updated.params.tokenUsage.total',
      input_tokens: 10,
      output_tokens: 4,
      cached_input_tokens: 3,
      reasoning_output_tokens: 2,
      total_tokens: 14,
      model_context_window: 128000,
      telemetry_confidence: 'observed_live',
      observed_at: '2026-04-11T10:00:04.000Z'
    });
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);

    expect(storeB.reconstructThreadLineage(threadId)?.token_model_facts).toEqual([
      expect.objectContaining({
        issue_run_id: started.issue_run_id,
        attempt_id: started.attempt_id,
        thread_id: threadId,
        turn_id: turnId,
        requested_model: 'gpt-requested',
        effective_model: 'gpt-effective',
        model_source: 'thread/tokenUsage/updated.params.tokenUsage.total',
        input_tokens: 10,
        output_tokens: 4,
        cached_input_tokens: 3,
        reasoning_output_tokens: 2,
        total_tokens: 14,
        model_context_window: 128000,
        telemetry_confidence: 'observed_live',
        observed_at: '2026-04-11T10:00:04.000Z'
      })
    ]);
    expect(storeB.reconstructThreadLineage(threadId)?.turns[0]?.token_model_facts).toHaveLength(1);
    expect(storeB.reconstructTicketTimeline(durableIdentity).token_model_facts).toHaveLength(1);
    expect(storeB.listRunHistory().find((run) => run.run_id === started.run_id)?.token_model_facts).toEqual([
      expect.objectContaining({
        requested_model: 'gpt-requested',
        effective_model: 'gpt-effective',
        total_tokens: 14
      })
    ]);
  });

  it('scopes run history token model facts to each issue run across repeated ticket runs', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-token-model-run-scope-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({ issue_id: 'remote-token-model-repeat', issue_identifier: 'TOK-REPEAT' });

    const storeA = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeA);
    const first = storeA.recordRunStarted({
      issue_id: 'remote-token-model-repeat',
      issue_identifier: 'TOK-REPEAT',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });
    const firstThreadId = storeA.appendThread({
      attempt_id: first.attempt_id,
      thread_id: 'thread-token-model-first',
      started_at: '2026-04-11T10:00:01.000Z',
      status: 'running'
    });
    storeA.appendTokenModelFact({
      issue_run_id: first.issue_run_id,
      attempt_id: first.attempt_id,
      thread_id: firstThreadId,
      requested_model: 'gpt-first-requested',
      effective_model: 'gpt-first-effective',
      total_tokens: 11,
      telemetry_confidence: 'observed_live',
      observed_at: '2026-04-11T10:00:02.000Z'
    });

    const second = storeA.recordRunStarted({
      issue_id: 'remote-token-model-repeat',
      issue_identifier: 'TOK-REPEAT',
      identity: durableIdentity,
      started_at: '2026-04-11T11:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });
    const secondThreadId = storeA.appendThread({
      attempt_id: second.attempt_id,
      thread_id: 'thread-token-model-second',
      started_at: '2026-04-11T11:00:01.000Z',
      status: 'running'
    });
    storeA.appendTokenModelFact({
      issue_run_id: second.issue_run_id,
      attempt_id: second.attempt_id,
      thread_id: secondThreadId,
      requested_model: 'gpt-second-requested',
      effective_model: 'gpt-second-effective',
      total_tokens: 22,
      telemetry_confidence: 'observed_live',
      observed_at: '2026-04-11T11:00:02.000Z'
    });
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(storeB);
    const firstRun = storeB.listRunHistory(10).find((run) => run.run_id === first.run_id);
    const secondRun = storeB.listRunHistory(10).find((run) => run.run_id === second.run_id);

    expect(firstRun?.identity_projection?.issue_run_id).toBe(first.issue_run_id);
    expect(secondRun?.identity_projection?.issue_run_id).toBe(second.issue_run_id);
    expect(firstRun?.token_model_facts).toEqual([
      expect.objectContaining({
        issue_run_id: first.issue_run_id,
        requested_model: 'gpt-first-requested',
        effective_model: 'gpt-first-effective',
        total_tokens: 11
      })
    ]);
    expect(secondRun?.token_model_facts).toEqual([
      expect.objectContaining({
        issue_run_id: second.issue_run_id,
        requested_model: 'gpt-second-requested',
        effective_model: 'gpt-second-effective',
        total_tokens: 22
      })
    ]);
  });

  it('rejects malformed token telemetry without writing a partial fact', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-token-model-invalid-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const durableIdentity = identity({ issue_id: 'remote-token-model-2', issue_identifier: 'TOK-2' });

    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(store);
    const issueRunId = store.appendIssueRun({
      issue_id: 'remote-token-model-2',
      issue_identifier: 'TOK-2',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      status: 'running'
    });

    expect(() =>
      store.appendTokenModelFact({
        issue_run_id: issueRunId,
        input_tokens: -1,
        telemetry_confidence: 'observed_live',
        observed_at: '2026-04-11T10:00:01.000Z'
      })
    ).toThrow('input_tokens must be a non-negative safe integer');
    expect(store.reconstructTicketTimeline(durableIdentity).token_model_facts).toEqual([]);
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

  it('records explicit degraded history state when migration execution fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-history-migration-failure-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const store = new SqlitePersistenceStore({
      dbPath,
      retentionDays: 14,
      nowMs: () => Date.parse('2026-04-11T10:00:00.000Z'),
      migrationFailureForTest: 'project_execution_history_v1'
    });
    stores.push(store);

    expect(store.historySchemaHealth()).toMatchObject({
      applied_version: 0,
      status: 'degraded',
      degraded_reason_code: 'history_schema_migration_failed'
    });
    expect(store.historySchemaHealth().migrations).toEqual([
      expect.objectContaining({
        version: 1,
        name: 'project_execution_history_v1',
        status: 'failed',
        error_message: 'injected migration failure: project_execution_history_v1'
      })
    ]);
    expect(store.health()).toMatchObject({
      integrity_ok: false,
      history_schema: expect.objectContaining({ status: 'degraded' })
    });
  });

  it('records failed history writes as degraded health across restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-history-write-failure-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const storeA = new SqlitePersistenceStore({
      dbPath,
      retentionDays: 14,
      nowMs: () => Date.parse('2026-04-11T10:00:00.000Z')
    });
    stores.push(storeA);
    storeA.recordHistoryWriteFailure({
      operation: 'appendTurn',
      reason_code: 'history_turn_write_failed',
      detail: 'database locked token=secret-value'
    });
    storeA.close();
    stores.pop();

    const storeB = new SqlitePersistenceStore({
      dbPath,
      retentionDays: 14,
      nowMs: () => Date.parse('2026-04-11T10:05:00.000Z')
    });
    stores.push(storeB);

    expect(storeB.historySchemaHealth()).toMatchObject({
      status: 'degraded',
      degraded_reason_code: 'history_write_failed',
      degraded_detail: 'appendTurn: history_turn_write_failed'
    });
    expect(storeB.health()).toMatchObject({
      integrity_ok: false,
      history_schema: expect.objectContaining({
        status: 'degraded',
        degraded_reason_code: 'history_write_failed'
      })
    });
    expect(storeB.listHistoryWriteFailures()).toEqual([
      {
        operation: 'appendTurn',
        reason_code: 'history_turn_write_failed',
        detail: 'database locked token=***REDACTED***',
        recorded_at: '2026-04-11T10:00:00.000Z'
      }
    ]);
  });

  it('restores write-failure diagnostics for already-applied history schemas', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-history-write-failure-upgrade-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const storeA = new SqlitePersistenceStore({
      dbPath,
      retentionDays: 14,
      nowMs: () => Date.parse('2026-04-11T10:00:00.000Z')
    });
    stores.push(storeA);
    expect(storeA.historySchemaHealth()).toMatchObject({ applied_version: 7, status: 'healthy' });
    storeA.close();
    stores.pop();

    const db = openDatabase(dbPath);
    try {
      db.exec('DROP TABLE history_write_failure;');
    } finally {
      db.close();
    }

    const storeB = new SqlitePersistenceStore({
      dbPath,
      retentionDays: 14,
      nowMs: () => Date.parse('2026-04-11T10:05:00.000Z')
    });
    stores.push(storeB);

    storeB.recordHistoryWriteFailure({
      operation: 'appendTicketTerminalOutcome',
      reason_code: 'history_terminal_outcome_write_failed',
      detail: 'no such table before idempotent ensure'
    });

    expect(storeB.historySchemaHealth()).toMatchObject({
      applied_version: 7,
      status: 'degraded',
      degraded_reason_code: 'history_write_failed',
      degraded_detail: 'appendTicketTerminalOutcome: history_terminal_outcome_write_failed'
    });
    expect(storeB.listHistoryWriteFailures()).toEqual([
      expect.objectContaining({
        operation: 'appendTicketTerminalOutcome',
        reason_code: 'history_terminal_outcome_write_failed',
        detail: 'no such table before idempotent ensure',
        recorded_at: '2026-04-11T10:05:00.000Z'
      })
    ]);
  });

  it('uses an explicit transaction for run start history facts', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-history-run-start-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');
    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 14 });
    stores.push(store);
    const durableIdentity = identity({ issue_id: 'run-start-1', issue_identifier: 'RUN-START-1' });

    const started = store.recordRunStarted({
      issue_id: 'run-start-1',
      issue_identifier: 'RUN-START-1',
      identity: durableIdentity,
      started_at: '2026-04-11T10:00:00.000Z',
      attempt_number: 0,
      status: 'running',
      reason_code: 'dispatch_started',
      reason_detail: 'worker spawned'
    });
    expect(() =>
      store.recordRunStarted({
        issue_id: 'run-start-1',
        issue_identifier: 'RUN-START-1',
        identity: durableIdentity,
        started_at: '2026-04-11T10:00:00.000Z',
        attempt_number: 0,
        status: 'running',
        reason_code: 'dispatch_started',
        reason_detail: 'duplicate'
      })
    ).toThrow();

    const reopened = store.reconstructTicketTimeline(durableIdentity);
    expect(reopened.issue_runs.map((run) => run.issue_run_id)).toEqual([started.issue_run_id]);
    expect(reopened.attempts.map((attempt) => attempt.attempt_id)).toEqual([started.attempt_id]);
    expect(store.listRunHistory().filter((run) => run.issue_id === 'run-start-1')).toHaveLength(1);
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

    const runId = store.startRun({
      issue_id: 'i-old',
      issue_identifier: 'OLD-1',
      identity: identity({ issue_id: 'i-old', issue_identifier: 'OLD-1' })
    });
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

  it('applies retention to completed operational history and preserves active evidence', async () => {
    const base = Date.parse('2026-04-11T12:00:00.000Z');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-retention-operational-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 1, nowMs: () => base });
    stores.push(store);

    const expiredRunId = store.startRun({
      issue_id: 'expired-run',
      issue_identifier: 'EXP-1',
      identity: identity({ issue_id: 'expired-run', issue_identifier: 'EXP-1' }),
      started_at: '2026-04-10T10:00:00.000Z'
    });
    store.recordSession(expiredRunId, 'expired-session');
    store.recordEvent({
      run_id: expiredRunId,
      event: 'completed',
      message: 'expired run event',
      timestamp_ms: Date.parse('2026-04-10T10:05:00.000Z')
    });
    store.completeRun({ run_id: expiredRunId, terminal_status: 'succeeded' });

    const activeRunId = store.startRun({
      issue_id: 'active-run',
      issue_identifier: 'ACTIVE-RETENTION-1',
      identity: identity({ issue_id: 'active-run', issue_identifier: 'ACTIVE-RETENTION-1' }),
      started_at: '2026-04-10T09:00:00.000Z'
    });

    const expiredGraph = store.recordRunStarted({
      issue_id: 'expired-issue-run',
      issue_identifier: 'EXP-ISSUE-1',
      identity: identity({ issue_id: 'expired-issue-run', issue_identifier: 'EXP-ISSUE-1' }),
      started_at: '2026-04-10T10:00:00.000Z',
      attempt_number: 0,
      status: 'running'
    });
    const expiredThreadId = store.appendThread({
      attempt_id: expiredGraph.attempt_id,
      thread_id: 'expired-thread-retention',
      started_at: '2026-04-10T10:00:02.000Z',
      status: 'running'
    });
    const expiredTurnId = store.appendTurn({
      thread_id: expiredThreadId,
      turn_id: 'expired-turn-retention',
      turn_index: 0,
      started_at: '2026-04-10T10:00:03.000Z',
      status: 'running'
    });
    store.appendAppServerEvent({
      issue_run_id: expiredGraph.issue_run_id,
      attempt_id: expiredGraph.attempt_id,
      thread_id: expiredThreadId,
      turn_id: expiredTurnId,
      observed_at: '2026-04-10T10:00:04.000Z',
      source_event_id: 'expired-app-event',
      source_event_name: 'rawResponseItem/completed',
      payload_class: 'protocol_request_response',
      raw_payload: { message: 'old protocol evidence' },
      summary: 'old protocol evidence'
    });
    store.completeRun({ run_id: expiredGraph.run_id, terminal_status: 'succeeded' });

    const activeIssueRunId = store.appendIssueRun({
      issue_id: 'active-issue-run',
      issue_identifier: 'ACTIVE-ISSUE-1',
      identity: identity({ issue_id: 'active-issue-run', issue_identifier: 'ACTIVE-ISSUE-1' }),
      started_at: '2026-04-10T09:00:00.000Z',
      status: 'running'
    });
    const activeAttemptId = store.appendAttempt({
      issue_run_id: activeIssueRunId,
      attempt_number: 0,
      started_at: '2026-04-10T09:00:01.000Z',
      status: 'running'
    });
    const activeThreadId = store.appendThread({
      attempt_id: activeAttemptId,
      thread_id: 'active-thread-retention',
      started_at: '2026-04-10T09:00:02.000Z',
      status: 'running'
    });
    const activeTurnId = store.appendTurn({
      thread_id: activeThreadId,
      turn_id: 'active-turn-retention',
      turn_index: 0,
      started_at: '2026-04-10T09:00:03.000Z',
      status: 'running'
    });
    store.appendAppServerEvent({
      issue_run_id: activeIssueRunId,
      attempt_id: activeAttemptId,
      thread_id: activeThreadId,
      turn_id: activeTurnId,
      observed_at: '2026-04-10T09:00:04.000Z',
      source_event_id: 'active-app-event',
      source_event_name: 'rawResponseItem/completed',
      payload_class: 'protocol_request_response',
      raw_payload: { message: 'active protocol evidence' },
      summary: 'active protocol evidence'
    });

    const lateStore = new SqlitePersistenceStore({ dbPath, retentionDays: 1, nowMs: () => base + 2 * 24 * 60 * 60 * 1000 });
    stores.push(lateStore);
    expect(lateStore.pruneExpiredRuns()).toBe(2);

    expect(lateStore.listRunHistory(10).map((run) => run.run_id)).toContain(activeRunId);
    expect(lateStore.listRunHistory(10).map((run) => run.run_id)).not.toContain(expiredRunId);
    expect(lateStore.reconstructThreadLineage(activeThreadId)?.issue_run.issue_run_id).toBe(activeIssueRunId);
    expect(lateStore.reconstructThreadLineage(expiredThreadId)?.issue_run.issue_run_id).toBe(expiredGraph.issue_run_id);
    expect(lateStore.listAppServerEventLedger(activeIssueRunId)).toHaveLength(1);
    expect(lateStore.listAppServerEventLedger(expiredGraph.issue_run_id)).toHaveLength(1);

    const db = openDatabase(dbPath);
    try {
      const records = db.prepare('SELECT source_table, source_id, reason_code FROM history_retention_prune_record ORDER BY source_table, source_id').all();
      expect(records).toHaveLength(2);
      expect(records).toEqual(
        expect.arrayContaining([
          {
            source_table: 'runs',
            source_id: expiredRunId,
            reason_code: 'retention_policy_expired_completed_history'
          },
          {
            source_table: 'runs',
            source_id: expiredGraph.run_id,
            reason_code: 'retention_policy_expired_completed_history'
          }
        ])
      );
    } finally {
      db.close();
    }
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

  it('records retention prune failures in persistence health evidence', async () => {
    const base = Date.parse('2026-04-11T12:00:00.000Z');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-retention-failure-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'runtime.sqlite');

    const store = new SqlitePersistenceStore({ dbPath, retentionDays: 1, nowMs: () => base, pruneFailureForTest: 'token=abcd prune exploded' });
    stores.push(store);

    expect(() => store.pruneExpiredRuns()).toThrow(/prune exploded/);
    expect(store.health()).toMatchObject({
      last_pruned_at: null,
      last_prune_failure_at: '2026-04-11T12:00:00.000Z',
      last_prune_failure_reason: 'retention_prune_failed',
      last_prune_failure_detail: 'token=***REDACTED*** prune exploded'
    });
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
