import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { redactUnknown } from '../security/redaction';
import type {
  BreakerMetadataRecord,
  DurableRunHistoryRecord,
  AttemptRecord,
  ExecutionGraphEntityStatus,
  ExecutionGraphThreadLineage,
  IssueRunRecord,
  PhaseSpanRecord,
  PersistedBlockedInputRecord,
  PersistedOperatorActionsRecord,
  PersistenceHealth,
  RunTerminalStatus,
  StateTransitionRecord,
  ThreadRecord,
  ToolSpanRecord,
  TurnRecord,
  UiContinuityState
} from './types';

interface PersistenceStoreOptions {
  dbPath: string;
  retentionDays: number;
  nowMs?: () => number;
}

function asIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function asExecutionGraphId(kind: string, parts: Array<string | number | null | undefined>): string {
  const hash = createHash('sha256')
    .update(kind)
    .update('\0')
    .update(parts.map((part) => String(part ?? '')).join('\0'))
    .digest('hex')
    .slice(0, 32);
  return `${kind}_${hash}`;
}

function parseNullableJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function ensureMonotonicTimestamp(next: string, previous: string | null | undefined, label: string): void {
  if (previous && next < previous) {
    throw new Error(`${label} timestamp must be monotonic`);
  }
}

function ensureEndedAfterStarted(startedAt: string, endedAt: string | null | undefined, label: string): void {
  if (endedAt && endedAt < startedAt) {
    throw new Error(`${label} ended_at must be greater than or equal to started_at`);
  }
}

export class SqlitePersistenceStore {
  private readonly dbPath: string;
  private readonly retentionDays: number;
  private readonly nowMs: () => number;
  private readonly db: {
    exec(sql: string): void;
    close(): void;
    prepare(sql: string): {
      run(...args: unknown[]): void;
      all(...args: unknown[]): unknown[];
      get(...args: unknown[]): unknown;
    };
  };

  constructor(options: PersistenceStoreOptions) {
    this.dbPath = options.dbPath;
    this.retentionDays = options.retentionDays;
    this.nowMs = options.nowMs ?? (() => Date.now());

    const parent = path.dirname(this.dbPath);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(parent, 0o700);
    } catch {
      // Best effort only.
    }

    const sqlite = require('node:sqlite') as { DatabaseSync: new (path: string) => SqlitePersistenceStore['db'] };
    this.db = new sqlite.DatabaseSync(this.dbPath);
    try {
      fs.chmodSync(this.dbPath, 0o600);
    } catch {
      // Best effort only.
    }

    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issue_run (
        issue_run_id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        issue_identifier TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL,
        reason_code TEXT,
        reason_detail TEXT,
        CHECK (ended_at IS NULL OR ended_at >= started_at)
      );
      CREATE TABLE IF NOT EXISTS attempt (
        attempt_id TEXT PRIMARY KEY,
        issue_run_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL,
        reason_code TEXT,
        reason_detail TEXT,
        UNIQUE (issue_run_id, attempt_number),
        CHECK (attempt_number >= 0),
        CHECK (ended_at IS NULL OR ended_at >= started_at),
        FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS thread (
        thread_id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL,
        reason_code TEXT,
        reason_detail TEXT,
        CHECK (ended_at IS NULL OR ended_at >= started_at),
        FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS turn (
        turn_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL,
        reason_code TEXT,
        reason_detail TEXT,
        UNIQUE (thread_id, turn_index),
        CHECK (turn_index >= 0),
        CHECK (ended_at IS NULL OR ended_at >= started_at),
        FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS phase_span (
        phase_span_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL,
        reason_code TEXT,
        reason_detail TEXT,
        CHECK (ended_at IS NULL OR ended_at >= started_at),
        FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS tool_span (
        tool_span_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL,
        reason_code TEXT,
        reason_detail TEXT,
        CHECK (ended_at IS NULL OR ended_at >= started_at),
        FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS state_transition (
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
        reason_detail TEXT,
        FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT,
        FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT,
        FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT,
        FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        issue_identifier TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        completed_at TEXT,
        terminal_status TEXT,
        error_code TEXT,
        terminal_reason_code TEXT,
        terminal_reason_detail TEXT,
        root_cause_status TEXT,
        root_cause_reason_code TEXT,
        root_cause_reason_detail TEXT,
        root_cause_at TEXT,
        session_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        missing_tool_output_recovery TEXT
      );
      CREATE TABLE IF NOT EXISTS run_sessions (
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        PRIMARY KEY (run_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS run_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        at TEXT NOT NULL,
        event TEXT NOT NULL,
        message TEXT
      );
      CREATE TABLE IF NOT EXISTS ui_state (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS issue_breakers (
        issue_id TEXT PRIMARY KEY,
        issue_identifier TEXT NOT NULL,
        breaker_active INTEGER NOT NULL,
        breaker_hit_count INTEGER NOT NULL,
        breaker_window_minutes INTEGER NOT NULL,
        breaker_first_hit_at TEXT,
        breaker_last_hit_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blocked_inputs (
        issue_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operator_actions (
        issue_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.ensureRunDiagnosticColumns();
  }

  close(): void {
    this.db.close();
  }

  startRun(params: { issue_id: string; issue_identifier: string }): string {
    const runId = randomUUID();
    this.db
      .prepare(
        'INSERT INTO runs (run_id, issue_id, issue_identifier, started_at, ended_at, terminal_status, error_code) VALUES (?, ?, ?, ?, NULL, NULL, NULL)'
      )
      .run(runId, params.issue_id, params.issue_identifier, asIso(this.nowMs()));
    return runId;
  }

  recordSession(runId: string, sessionId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO run_sessions (run_id, session_id) VALUES (?, ?)')
      .run(runId, sessionId);
  }

  recordEvent(params: { run_id: string; event: string; message: string | null; timestamp_ms: number }): void {
    const redactedMessage = redactUnknown(params.message) as string | null;
    this.db
      .prepare('INSERT INTO run_events (run_id, at, event, message) VALUES (?, ?, ?, ?)')
      .run(params.run_id, asIso(params.timestamp_ms), params.event, redactedMessage);
  }

  appendIssueRun(params: {
    issue_id: string;
    issue_identifier: string;
    started_at: string;
    ended_at?: string | null;
    status: ExecutionGraphEntityStatus;
    reason_code?: string | null;
    reason_detail?: string | null;
    issue_run_id?: string;
  }): string {
    ensureEndedAfterStarted(params.started_at, params.ended_at, 'issue_run');
    const issueRunId = params.issue_run_id ?? asExecutionGraphId('issue_run', [params.issue_id, params.issue_identifier, params.started_at]);
    this.db
      .prepare(
        `INSERT INTO issue_run
        (issue_run_id, issue_id, issue_identifier, started_at, ended_at, status, reason_code, reason_detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        issueRunId,
        params.issue_id,
        params.issue_identifier,
        params.started_at,
        params.ended_at ?? null,
        params.status,
        params.reason_code ?? null,
        redactUnknown(params.reason_detail ?? null)
      );
    return issueRunId;
  }

  appendAttempt(params: {
    issue_run_id: string;
    attempt_number: number;
    started_at: string;
    ended_at?: string | null;
    status: ExecutionGraphEntityStatus;
    reason_code?: string | null;
    reason_detail?: string | null;
    attempt_id?: string;
  }): string {
    ensureEndedAfterStarted(params.started_at, params.ended_at, 'attempt');
    const parent = this.db.prepare('SELECT started_at FROM issue_run WHERE issue_run_id = ?').get(params.issue_run_id) as
      | { started_at: string }
      | undefined;
    if (!parent) {
      throw new Error(`issue_run ${params.issue_run_id} does not exist`);
    }
    ensureMonotonicTimestamp(params.started_at, parent.started_at, 'attempt');
    const attemptId = params.attempt_id ?? asExecutionGraphId('attempt', [params.issue_run_id, params.attempt_number]);
    this.db
      .prepare(
        `INSERT INTO attempt
        (attempt_id, issue_run_id, attempt_number, started_at, ended_at, status, reason_code, reason_detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        attemptId,
        params.issue_run_id,
        params.attempt_number,
        params.started_at,
        params.ended_at ?? null,
        params.status,
        params.reason_code ?? null,
        redactUnknown(params.reason_detail ?? null)
      );
    return attemptId;
  }

  appendThread(params: {
    attempt_id: string;
    started_at: string;
    ended_at?: string | null;
    status: ExecutionGraphEntityStatus;
    reason_code?: string | null;
    reason_detail?: string | null;
    thread_id?: string;
  }): string {
    ensureEndedAfterStarted(params.started_at, params.ended_at, 'thread');
    const parent = this.db.prepare('SELECT started_at FROM attempt WHERE attempt_id = ?').get(params.attempt_id) as
      | { started_at: string }
      | undefined;
    if (!parent) {
      throw new Error(`attempt ${params.attempt_id} does not exist`);
    }
    ensureMonotonicTimestamp(params.started_at, parent.started_at, 'thread');
    const threadId = params.thread_id ?? asExecutionGraphId('thread', [params.attempt_id, params.started_at]);
    this.db
      .prepare(
        `INSERT INTO thread
        (thread_id, attempt_id, started_at, ended_at, status, reason_code, reason_detail)
        VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        threadId,
        params.attempt_id,
        params.started_at,
        params.ended_at ?? null,
        params.status,
        params.reason_code ?? null,
        redactUnknown(params.reason_detail ?? null)
      );
    return threadId;
  }

  appendTurn(params: {
    thread_id: string;
    turn_index: number;
    started_at: string;
    ended_at?: string | null;
    status: ExecutionGraphEntityStatus;
    reason_code?: string | null;
    reason_detail?: string | null;
    turn_id?: string;
  }): string {
    ensureEndedAfterStarted(params.started_at, params.ended_at, 'turn');
    const parent = this.db.prepare('SELECT started_at FROM thread WHERE thread_id = ?').get(params.thread_id) as
      | { started_at: string }
      | undefined;
    if (!parent) {
      throw new Error(`thread ${params.thread_id} does not exist`);
    }
    ensureMonotonicTimestamp(params.started_at, parent.started_at, 'turn');
    const turnId = params.turn_id ?? asExecutionGraphId('turn', [params.thread_id, params.turn_index]);
    this.db
      .prepare(
        `INSERT INTO turn
        (turn_id, thread_id, turn_index, started_at, ended_at, status, reason_code, reason_detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        turnId,
        params.thread_id,
        params.turn_index,
        params.started_at,
        params.ended_at ?? null,
        params.status,
        params.reason_code ?? null,
        redactUnknown(params.reason_detail ?? null)
      );
    return turnId;
  }

  appendPhaseSpan(params: {
    turn_id: string;
    phase: string;
    started_at: string;
    ended_at?: string | null;
    status: ExecutionGraphEntityStatus;
    reason_code?: string | null;
    reason_detail?: string | null;
    phase_span_id?: string;
  }): string {
    ensureEndedAfterStarted(params.started_at, params.ended_at, 'phase_span');
    this.ensureTurnTimestamp(params.turn_id, params.started_at, 'phase_span');
    const phaseSpanId = params.phase_span_id ?? asExecutionGraphId('phase_span', [params.turn_id, params.phase, params.started_at]);
    this.db
      .prepare(
        `INSERT INTO phase_span
        (phase_span_id, turn_id, phase, started_at, ended_at, status, reason_code, reason_detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        phaseSpanId,
        params.turn_id,
        params.phase,
        params.started_at,
        params.ended_at ?? null,
        params.status,
        params.reason_code ?? null,
        redactUnknown(params.reason_detail ?? null)
      );
    return phaseSpanId;
  }

  appendToolSpan(params: {
    turn_id: string;
    tool_name: string;
    started_at: string;
    ended_at?: string | null;
    status: ExecutionGraphEntityStatus;
    reason_code?: string | null;
    reason_detail?: string | null;
    tool_span_id?: string;
  }): string {
    ensureEndedAfterStarted(params.started_at, params.ended_at, 'tool_span');
    this.ensureTurnTimestamp(params.turn_id, params.started_at, 'tool_span');
    const toolSpanId = params.tool_span_id ?? asExecutionGraphId('tool_span', [params.turn_id, params.tool_name, params.started_at]);
    this.db
      .prepare(
        `INSERT INTO tool_span
        (tool_span_id, turn_id, tool_name, started_at, ended_at, status, reason_code, reason_detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        toolSpanId,
        params.turn_id,
        params.tool_name,
        params.started_at,
        params.ended_at ?? null,
        params.status,
        params.reason_code ?? null,
        redactUnknown(params.reason_detail ?? null)
      );
    return toolSpanId;
  }

  appendStateTransition(params: {
    issue_run_id: string;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    from_status?: string | null;
    to_status: string;
    transitioned_at: string;
    status: ExecutionGraphEntityStatus;
    reason_code?: string | null;
    reason_detail?: string | null;
    state_transition_id?: string;
  }): string {
    this.ensureStateTransitionReferences(params);
    const latest = this.db
      .prepare('SELECT transitioned_at FROM state_transition WHERE issue_run_id = ? ORDER BY transitioned_at DESC LIMIT 1')
      .get(params.issue_run_id) as { transitioned_at: string } | undefined;
    ensureMonotonicTimestamp(params.transitioned_at, latest?.transitioned_at, 'state_transition');
    const stateTransitionId =
      params.state_transition_id ??
      asExecutionGraphId('state_transition', [
        params.issue_run_id,
        params.attempt_id,
        params.thread_id,
        params.turn_id,
        params.from_status,
        params.to_status,
        params.transitioned_at,
        params.reason_code
      ]);
    this.db
      .prepare(
        `INSERT INTO state_transition
        (state_transition_id, issue_run_id, attempt_id, thread_id, turn_id, from_status, to_status, transitioned_at, status, reason_code, reason_detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        stateTransitionId,
        params.issue_run_id,
        params.attempt_id ?? null,
        params.thread_id ?? null,
        params.turn_id ?? null,
        params.from_status ?? null,
        params.to_status,
        params.transitioned_at,
        params.status,
        params.reason_code ?? null,
        redactUnknown(params.reason_detail ?? null)
      );
    return stateTransitionId;
  }

  reconstructThreadLineage(threadId: string): ExecutionGraphThreadLineage | null {
    const thread = this.db.prepare('SELECT * FROM thread WHERE thread_id = ?').get(threadId) as ThreadRecord | undefined;
    if (!thread) {
      return null;
    }
    const attempt = this.db.prepare('SELECT * FROM attempt WHERE attempt_id = ?').get(thread.attempt_id) as AttemptRecord;
    const issueRun = this.db.prepare('SELECT * FROM issue_run WHERE issue_run_id = ?').get(attempt.issue_run_id) as IssueRunRecord;
    const transitions = this.db
      .prepare('SELECT * FROM state_transition WHERE issue_run_id = ? ORDER BY transitioned_at ASC, state_transition_id ASC')
      .all(issueRun.issue_run_id) as StateTransitionRecord[];
    const turns = this.db
      .prepare('SELECT * FROM turn WHERE thread_id = ? ORDER BY turn_index ASC, started_at ASC')
      .all(threadId) as TurnRecord[];

    return {
      issue_run: issueRun,
      attempt,
      thread,
      turns: turns.map((turn) => ({
        ...turn,
        phase_spans: this.db
          .prepare('SELECT * FROM phase_span WHERE turn_id = ? ORDER BY started_at ASC, phase_span_id ASC')
          .all(turn.turn_id) as PhaseSpanRecord[],
        tool_spans: this.db
          .prepare('SELECT * FROM tool_span WHERE turn_id = ? ORDER BY started_at ASC, tool_span_id ASC')
          .all(turn.turn_id) as ToolSpanRecord[],
        state_transitions: transitions.filter((transition) => transition.turn_id === turn.turn_id)
      })),
      state_transitions: transitions
    };
  }

  reconstructLatestThreadLineageByIssueIdentifier(issueIdentifier: string): ExecutionGraphThreadLineage | null {
    const row = this.db
      .prepare(
        `SELECT thread.thread_id
        FROM issue_run
        JOIN attempt ON attempt.issue_run_id = issue_run.issue_run_id
        JOIN thread ON thread.attempt_id = attempt.attempt_id
        WHERE issue_run.issue_identifier = ?
        ORDER BY issue_run.started_at DESC, attempt.attempt_number DESC, thread.started_at DESC, thread.thread_id DESC
        LIMIT 1`
      )
      .get(issueIdentifier) as { thread_id: string } | undefined;
    return row ? this.reconstructThreadLineage(row.thread_id) : null;
  }

  completeRun(params: {
    run_id: string;
    terminal_status: RunTerminalStatus;
    error_code?: string | null;
    terminal_reason_code?: string | null;
    terminal_reason_detail?: string | null;
    root_cause_status?: ExecutionGraphEntityStatus | null;
    root_cause_reason_code?: string | null;
    root_cause_reason_detail?: string | null;
    root_cause_at?: string | null;
    session_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    missing_tool_output_recovery?: Record<string, unknown> | null;
  }): void {
    const redactedError = redactUnknown(params.error_code ?? null) as string | null;
    const redactedTerminalDetail = redactUnknown(params.terminal_reason_detail ?? null) as string | null;
    const redactedRootCauseDetail = redactUnknown(params.root_cause_reason_detail ?? null) as string | null;
    const redactedRecovery = params.missing_tool_output_recovery
      ? JSON.stringify(redactUnknown(params.missing_tool_output_recovery))
      : null;
    const terminalReasonCode = params.terminal_reason_code ?? params.error_code ?? null;
    const completedAt = asIso(this.nowMs());
    this.db
      .prepare(
        `UPDATE runs SET
          ended_at = ?,
          completed_at = ?,
          terminal_status = ?,
          error_code = ?,
          terminal_reason_code = ?,
          terminal_reason_detail = ?,
          root_cause_status = ?,
          root_cause_reason_code = ?,
          root_cause_reason_detail = ?,
          root_cause_at = ?,
          session_id = ?,
          thread_id = ?,
          turn_id = ?,
          missing_tool_output_recovery = ?
        WHERE run_id = ?`
      )
      .run(
        completedAt,
        completedAt,
        params.terminal_status,
        redactedError,
        terminalReasonCode,
        redactedTerminalDetail,
        params.root_cause_status ?? null,
        params.root_cause_reason_code ?? null,
        redactedRootCauseDetail,
        params.root_cause_at ?? null,
        params.session_id ?? null,
        params.thread_id ?? null,
        params.turn_id ?? null,
        redactedRecovery,
        params.run_id
      );
  }

  listRunHistory(limit = 50): DurableRunHistoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT run_id, issue_id, issue_identifier, started_at, ended_at, completed_at, terminal_status, error_code,
          terminal_reason_code, terminal_reason_detail, root_cause_status, root_cause_reason_code,
          root_cause_reason_detail, root_cause_at, session_id, thread_id, turn_id, missing_tool_output_recovery
        FROM runs ORDER BY started_at DESC LIMIT ?`
      )
      .all(limit) as Array<{
      run_id: string;
      issue_id: string;
      issue_identifier: string;
      started_at: string;
      ended_at: string | null;
      completed_at: string | null;
      terminal_status: RunTerminalStatus | null;
      error_code: string | null;
      terminal_reason_code: string | null;
      terminal_reason_detail: string | null;
      root_cause_status: ExecutionGraphEntityStatus | null;
      root_cause_reason_code: string | null;
      root_cause_reason_detail: string | null;
      root_cause_at: string | null;
      session_id: string | null;
      thread_id: string | null;
      turn_id: string | null;
      missing_tool_output_recovery: string | null;
    }>;

    const sessionStmt = this.db.prepare('SELECT session_id FROM run_sessions WHERE run_id = ? ORDER BY session_id ASC');

    return rows.map((row) => {
      const sessions = sessionStmt.all(row.run_id) as Array<{ session_id: string }>;
      const record: DurableRunHistoryRecord = {
        run_id: row.run_id,
        issue_id: row.issue_id,
        issue_identifier: row.issue_identifier,
        started_at: row.started_at,
        ended_at: row.ended_at,
        completed_at: row.completed_at,
        terminal_status: row.terminal_status,
        error_code: row.error_code,
        terminal_reason_code: row.terminal_reason_code ?? row.error_code,
        terminal_reason_detail: row.terminal_reason_detail,
        root_cause_status: row.root_cause_status,
        root_cause_reason_code: row.root_cause_reason_code,
        root_cause_reason_detail: row.root_cause_reason_detail,
        root_cause_at: row.root_cause_at,
        session_id: row.session_id,
        thread_id: row.thread_id,
        turn_id: row.turn_id,
        session_ids: sessions.map((entry) => entry.session_id),
        missing_tool_output_recovery: parseNullableJsonObject(row.missing_tool_output_recovery)
      };

      return redactUnknown(record) as DurableRunHistoryRecord;
    });
  }

  private ensureRunDiagnosticColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>;
    const existing = new Set(columns.map((column) => column.name));
    const migrations: Array<[string, string]> = [
      ['terminal_reason_code', 'ALTER TABLE runs ADD COLUMN terminal_reason_code TEXT'],
      ['completed_at', 'ALTER TABLE runs ADD COLUMN completed_at TEXT'],
      ['terminal_reason_detail', 'ALTER TABLE runs ADD COLUMN terminal_reason_detail TEXT'],
      ['root_cause_status', 'ALTER TABLE runs ADD COLUMN root_cause_status TEXT'],
      ['root_cause_reason_code', 'ALTER TABLE runs ADD COLUMN root_cause_reason_code TEXT'],
      ['root_cause_reason_detail', 'ALTER TABLE runs ADD COLUMN root_cause_reason_detail TEXT'],
      ['root_cause_at', 'ALTER TABLE runs ADD COLUMN root_cause_at TEXT'],
      ['session_id', 'ALTER TABLE runs ADD COLUMN session_id TEXT'],
      ['thread_id', 'ALTER TABLE runs ADD COLUMN thread_id TEXT'],
      ['turn_id', 'ALTER TABLE runs ADD COLUMN turn_id TEXT'],
      ['missing_tool_output_recovery', 'ALTER TABLE runs ADD COLUMN missing_tool_output_recovery TEXT']
    ];
    for (const [column, sql] of migrations) {
      if (!existing.has(column)) {
        this.db.exec(`${sql};`);
      }
    }
    this.db.exec('UPDATE runs SET terminal_reason_code = error_code WHERE terminal_reason_code IS NULL AND error_code IS NOT NULL;');
    this.db.exec(
      'UPDATE runs SET completed_at = ended_at WHERE completed_at IS NULL AND terminal_status IS NOT NULL AND ended_at IS NOT NULL;'
    );
  }

  saveUiState(state: UiContinuityState): void {
    const payload = JSON.stringify(redactUnknown(state));
    this.db
      .prepare(
        'INSERT INTO ui_state (singleton_id, payload, updated_at) VALUES (1, ?, ?) ON CONFLICT(singleton_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at'
      )
      .run(payload, asIso(this.nowMs()));
  }

  loadUiState(): UiContinuityState | null {
    const row = this.db.prepare('SELECT payload FROM ui_state WHERE singleton_id = 1').get() as { payload: string } | undefined;
    if (!row) {
      return null;
    }

    return JSON.parse(row.payload) as UiContinuityState;
  }

  upsertBreaker(record: BreakerMetadataRecord): void {
    this.db
      .prepare(
        `INSERT INTO issue_breakers
        (issue_id, issue_identifier, breaker_active, breaker_hit_count, breaker_window_minutes, breaker_first_hit_at, breaker_last_hit_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(issue_id) DO UPDATE SET
          issue_identifier = excluded.issue_identifier,
          breaker_active = excluded.breaker_active,
          breaker_hit_count = excluded.breaker_hit_count,
          breaker_window_minutes = excluded.breaker_window_minutes,
          breaker_first_hit_at = excluded.breaker_first_hit_at,
          breaker_last_hit_at = excluded.breaker_last_hit_at,
          updated_at = excluded.updated_at`
      )
      .run(
        record.issue_id,
        record.issue_identifier,
        record.breaker_active ? 1 : 0,
        record.breaker_hit_count,
        record.breaker_window_minutes,
        record.breaker_first_hit_at,
        record.breaker_last_hit_at,
        asIso(this.nowMs())
      );
  }

  deleteBreaker(issueId: string): void {
    this.db.prepare('DELETE FROM issue_breakers WHERE issue_id = ?').run(issueId);
  }

  listBreakers(): BreakerMetadataRecord[] {
    const rows = this.db
      .prepare(
        'SELECT issue_id, issue_identifier, breaker_active, breaker_hit_count, breaker_window_minutes, breaker_first_hit_at, breaker_last_hit_at FROM issue_breakers ORDER BY issue_identifier ASC'
      )
      .all() as Array<{
      issue_id: string;
      issue_identifier: string;
      breaker_active: number;
      breaker_hit_count: number;
      breaker_window_minutes: number;
      breaker_first_hit_at: string | null;
      breaker_last_hit_at: string | null;
    }>;
    return rows.map((row) => ({
      issue_id: row.issue_id,
      issue_identifier: row.issue_identifier,
      breaker_active: row.breaker_active === 1,
      breaker_hit_count: row.breaker_hit_count,
      breaker_window_minutes: row.breaker_window_minutes,
      breaker_first_hit_at: row.breaker_first_hit_at,
      breaker_last_hit_at: row.breaker_last_hit_at
    }));
  }

  upsertBlockedInput(issueId: string, payload: string): void {
    this.db
      .prepare(
        `INSERT INTO blocked_inputs (issue_id, payload, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(issue_id) DO UPDATE SET
           payload = excluded.payload,
           updated_at = excluded.updated_at`
      )
      .run(issueId, payload, asIso(this.nowMs()));
  }

  deleteBlockedInput(issueId: string): void {
    this.db.prepare('DELETE FROM blocked_inputs WHERE issue_id = ?').run(issueId);
  }

  listBlockedInputs(): PersistedBlockedInputRecord[] {
    return this.db
      .prepare('SELECT issue_id, payload, updated_at FROM blocked_inputs ORDER BY updated_at DESC')
      .all() as PersistedBlockedInputRecord[];
  }

  upsertOperatorActions(issueId: string, payload: string): void {
    this.db
      .prepare(
        `INSERT INTO operator_actions (issue_id, payload, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(issue_id) DO UPDATE SET
           payload = excluded.payload,
           updated_at = excluded.updated_at`
      )
      .run(issueId, payload, asIso(this.nowMs()));
  }

  listOperatorActions(): PersistedOperatorActionsRecord[] {
    return this.db
      .prepare('SELECT issue_id, payload, updated_at FROM operator_actions ORDER BY updated_at DESC')
      .all() as PersistedOperatorActionsRecord[];
  }

  private ensureTurnTimestamp(turnId: string, timestamp: string, label: string): void {
    const parent = this.db.prepare('SELECT started_at FROM turn WHERE turn_id = ?').get(turnId) as { started_at: string } | undefined;
    if (!parent) {
      throw new Error(`turn ${turnId} does not exist`);
    }
    ensureMonotonicTimestamp(timestamp, parent.started_at, label);
  }

  private ensureStateTransitionReferences(params: {
    issue_run_id: string;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    transitioned_at: string;
  }): void {
    const issueRun = this.db.prepare('SELECT started_at FROM issue_run WHERE issue_run_id = ?').get(params.issue_run_id) as
      | { started_at: string }
      | undefined;
    if (!issueRun) {
      throw new Error(`issue_run ${params.issue_run_id} does not exist`);
    }
    ensureMonotonicTimestamp(params.transitioned_at, issueRun.started_at, 'state_transition');

    if (params.attempt_id) {
      const attempt = this.db.prepare('SELECT issue_run_id, started_at FROM attempt WHERE attempt_id = ?').get(params.attempt_id) as
        | { issue_run_id: string; started_at: string }
        | undefined;
      if (!attempt || attempt.issue_run_id !== params.issue_run_id) {
        throw new Error(`attempt ${params.attempt_id} does not belong to issue_run ${params.issue_run_id}`);
      }
      ensureMonotonicTimestamp(params.transitioned_at, attempt.started_at, 'state_transition');
    }

    if (params.thread_id) {
      const thread = this.db
        .prepare(
          `SELECT thread.started_at, thread.attempt_id, attempt.issue_run_id
           FROM thread
           JOIN attempt ON attempt.attempt_id = thread.attempt_id
           WHERE thread.thread_id = ?`
        )
        .get(params.thread_id) as { started_at: string; attempt_id: string; issue_run_id: string } | undefined;
      if (!thread || thread.issue_run_id !== params.issue_run_id) {
        throw new Error(`thread ${params.thread_id} does not belong to issue_run ${params.issue_run_id}`);
      }
      if (params.attempt_id && thread.attempt_id !== params.attempt_id) {
        throw new Error(`thread ${params.thread_id} does not belong to attempt ${params.attempt_id}`);
      }
      ensureMonotonicTimestamp(params.transitioned_at, thread.started_at, 'state_transition');
    }

    if (params.turn_id) {
      const turn = this.db
        .prepare(
          `SELECT turn.started_at, turn.thread_id, thread.attempt_id, attempt.issue_run_id
           FROM turn
           JOIN thread ON thread.thread_id = turn.thread_id
           JOIN attempt ON attempt.attempt_id = thread.attempt_id
           WHERE turn.turn_id = ?`
        )
        .get(params.turn_id) as { started_at: string; thread_id: string; attempt_id: string; issue_run_id: string } | undefined;
      if (!turn || turn.issue_run_id !== params.issue_run_id) {
        throw new Error(`turn ${params.turn_id} does not belong to issue_run ${params.issue_run_id}`);
      }
      if (params.attempt_id && turn.attempt_id !== params.attempt_id) {
        throw new Error(`turn ${params.turn_id} does not belong to attempt ${params.attempt_id}`);
      }
      if (params.thread_id && turn.thread_id !== params.thread_id) {
        throw new Error(`turn ${params.turn_id} does not belong to thread ${params.thread_id}`);
      }
      ensureMonotonicTimestamp(params.transitioned_at, turn.started_at, 'state_transition');
    }
  }

  pruneExpiredRuns(): number {
    const cutoffMs = this.nowMs() - this.retentionDays * 24 * 60 * 60 * 1000;
    const cutoff = asIso(cutoffMs);
    const expired = this.db.prepare('SELECT run_id FROM runs WHERE started_at < ?').all(cutoff) as Array<{ run_id: string }>;

    if (expired.length === 0) {
      this.db
        .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('last_pruned_at', asIso(this.nowMs()));
      return 0;
    }

    const deleteRun = this.db.prepare('DELETE FROM runs WHERE run_id = ?');
    const deleteSessions = this.db.prepare('DELETE FROM run_sessions WHERE run_id = ?');
    const deleteEvents = this.db.prepare('DELETE FROM run_events WHERE run_id = ?');

    for (const item of expired) {
      deleteSessions.run(item.run_id);
      deleteEvents.run(item.run_id);
      deleteRun.run(item.run_id);
    }

    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('last_pruned_at', asIso(this.nowMs()));

    return expired.length;
  }

  health(): PersistenceHealth {
    const runCountRow = this.db.prepare('SELECT COUNT(*) AS count FROM runs').get() as { count: number };
    const integrityRow = this.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    const pruneRow = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('last_pruned_at') as
      | { value: string }
      | undefined;

    return {
      enabled: true,
      db_path: this.dbPath,
      retention_days: this.retentionDays,
      run_count: runCountRow.count,
      last_pruned_at: pruneRow?.value ?? null,
      integrity_ok: integrityRow.integrity_check === 'ok'
    };
  }
}
