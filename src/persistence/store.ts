import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { redactUnknown } from '../security/redaction';
import { buildHistoryPayloadDetails } from './history-payload-policy';
import type {
  AppServerEventLedgerRecord,
  BreakerMetadataRecord,
  DurableRunHistoryRecord,
  DurableIdentity,
  AttemptRecord,
  ExecutionGraphEntityStatus,
  HistoryPayloadClass,
  ExecutionGraphThreadLineage,
  HistorySchemaHealth,
  HistoryIdentityProjectionRecord,
  HistoryWriteFailureRecord,
  IssueRunRecord,
  PhaseSpanRecord,
  PersistedBlockedInputRecord,
  PersistedOperatorActionsRecord,
  PersistenceHealth,
  RunTerminalStatus,
  StateTransitionRecord,
  TicketBlockerRecord,
  TicketEvidenceReferenceRecord,
  TicketTerminalOutcomeRecord,
  TicketTimelineRecord,
  ThreadRecord,
  ToolSpanRecord,
  TurnRecord,
  UiContinuityState
} from './types';

interface PersistenceStoreOptions {
  dbPath: string;
  retentionDays: number;
  nowMs?: () => number;
  migrationFailureForTest?: string;
  pruneFailureForTest?: string;
}

const HISTORY_SCHEMA_NAME = 'project_execution_history';
const HISTORY_SCHEMA_VERSION = 5;

interface HistoryMigration {
  version: number;
  name: string;
  apply(store: SqlitePersistenceStore): void;
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

function isIdentityEvidence(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const evidence = value as { status?: unknown; value?: unknown; reason?: unknown };
  return (
    (evidence.status === 'present' && typeof evidence.value === 'string') ||
    (evidence.status === 'missing' && typeof evidence.reason === 'string')
  );
}

function isDurableIdentity(value: unknown): value is DurableIdentity {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as DurableIdentity;
  return (
    typeof candidate.project?.key === 'string' &&
    typeof candidate.project.project_root === 'string' &&
    typeof candidate.project.workflow_path === 'string' &&
    isIdentityEvidence(candidate.project.workflow_hash) &&
    isIdentityEvidence(candidate.project.repository_remote) &&
    typeof candidate.ticket?.key === 'string' &&
    typeof candidate.ticket.tracker_kind === 'string' &&
    isIdentityEvidence(candidate.ticket.tracker_scope) &&
    typeof candidate.ticket.remote_issue_id === 'string' &&
    typeof candidate.ticket.human_issue_identifier === 'string'
  );
}

function parseDurableIdentity(value: string | null): DurableIdentity | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isDurableIdentity(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseHistoryPayloadTruncation(value: string): AppServerEventLedgerRecord['truncation'] {
  const parsed = JSON.parse(value) as AppServerEventLedgerRecord['truncation'];
  return {
    truncated: Boolean(parsed.truncated),
    original_bytes: Number(parsed.original_bytes),
    excerpt_bytes: Number(parsed.excerpt_bytes),
    max_excerpt_bytes: Number(parsed.max_excerpt_bytes)
  };
}

function serializeDurableIdentity(identity: DurableIdentity): string {
  return JSON.stringify(redactUnknown(identity));
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
  private readonly migrationFailureForTest: string | undefined;
  private readonly pruneFailureForTest: string | undefined;
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
    this.migrationFailureForTest = options.migrationFailureForTest;
    this.pruneFailureForTest = options.pruneFailureForTest;

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
        identity TEXT,
        project_key TEXT,
        ticket_key TEXT,
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
        identity TEXT,
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
        message TEXT,
        reason_code TEXT,
        request_method TEXT,
        request_category TEXT
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
    this.runHistorySchemaMigrations();
  }

  close(): void {
    this.db.close();
  }

  historySchemaHealth(): HistorySchemaHealth {
    return this.readHistorySchemaHealth();
  }

  recordHistoryWriteFailure(params: { operation: string; reason_code: string; detail?: string | null }): void {
    const recordedAt = asIso(this.nowMs());
    const detail = redactUnknown(params.detail ?? null) as string | null;
    this.db
      .prepare(
        `INSERT INTO history_write_failure
          (operation, reason_code, detail, recorded_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(params.operation, params.reason_code, detail, recordedAt);
    this.recordHistorySchemaState({
      appliedVersion: this.readHistorySchemaHealth().applied_version,
      status: 'degraded',
      degradedReasonCode: 'history_write_failed',
      degradedDetail: `${params.operation}: ${params.reason_code}`
    });
    this.recordHistoryHealthMetadata('degraded', 'history_write_failed', `${params.operation}: ${params.reason_code}`);
  }

  listHistoryWriteFailures(limit = 20): HistoryWriteFailureRecord[] {
    return this.db
      .prepare(
        `SELECT operation, reason_code, detail, recorded_at
         FROM history_write_failure
         ORDER BY recorded_at DESC, rowid DESC
         LIMIT ?`
      )
      .all(limit) as HistoryWriteFailureRecord[];
  }

  startRun(params: { issue_id: string; issue_identifier: string; identity: DurableIdentity; started_at?: string }): string {
    const runId = randomUUID();
    this.upsertHistoryIdentity(params.identity);
    this.db
      .prepare(
        'INSERT INTO runs (run_id, issue_id, issue_identifier, identity, started_at, ended_at, terminal_status, error_code) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)'
      )
      .run(runId, params.issue_id, params.issue_identifier, serializeDurableIdentity(params.identity), params.started_at ?? asIso(this.nowMs()));
    this.recordIdentityProjection({
      source_table: 'runs',
      source_id: runId,
      run_id: runId,
      issue_run_id: null,
      issue_id: params.issue_id,
      issue_identifier: params.issue_identifier,
      projection_status: 'projected',
      reason_code: null,
      reason_detail: null,
      project_key: params.identity.project.key,
      ticket_key: params.identity.ticket.key
    });
    return runId;
  }

  recordRunStarted(params: {
    issue_id: string;
    issue_identifier: string;
    identity: DurableIdentity;
    started_at: string;
    attempt_number: number;
    status: ExecutionGraphEntityStatus;
    reason_code?: string | null;
    reason_detail?: string | null;
  }): { run_id: string; issue_run_id: string; attempt_id: string } {
    return this.transaction(() => {
      const runId = this.startRun({
        issue_id: params.issue_id,
        issue_identifier: params.issue_identifier,
        identity: params.identity,
        started_at: params.started_at
      });
      const issueRunId = this.appendIssueRun({
        issue_id: params.issue_id,
        issue_identifier: params.issue_identifier,
        identity: params.identity,
        started_at: params.started_at,
        status: params.status,
        reason_code: params.reason_code,
        reason_detail: params.reason_detail
      });
      const attemptId = this.appendAttempt({
        issue_run_id: issueRunId,
        attempt_number: params.attempt_number,
        started_at: params.started_at,
        status: params.status,
        reason_code: params.reason_code,
        reason_detail: params.reason_detail
      });
      this.appendStateTransition({
        issue_run_id: issueRunId,
        attempt_id: attemptId,
        from_status: null,
        to_status: params.status,
        transitioned_at: params.started_at,
        status: params.status,
        reason_code: params.reason_code,
        reason_detail: params.reason_detail
      });
      this.recordIdentityProjection({
        source_table: 'runs',
        source_id: runId,
        run_id: runId,
        issue_run_id: issueRunId,
        issue_id: params.issue_id,
        issue_identifier: params.issue_identifier,
        projection_status: 'projected',
        reason_code: null,
        reason_detail: null,
        project_key: params.identity.project.key,
        ticket_key: params.identity.ticket.key
      });
      return { run_id: runId, issue_run_id: issueRunId, attempt_id: attemptId };
    });
  }

  recordSession(runId: string, sessionId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO run_sessions (run_id, session_id) VALUES (?, ?)')
      .run(runId, sessionId);
  }

  recordEvent(params: {
    run_id: string;
    event: string;
    message: string | null;
    timestamp_ms: number;
    reason_code?: string | null;
    request_method?: string | null;
    request_category?: string | null;
  }): void {
    const redactedMessage = redactUnknown(params.message) as string | null;
    this.db
      .prepare(
        'INSERT INTO run_events (run_id, at, event, message, reason_code, request_method, request_category) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        params.run_id,
        asIso(params.timestamp_ms),
        params.event,
        redactedMessage,
        params.reason_code ?? null,
        params.request_method ?? null,
        params.request_category ?? null
      );
  }

  appendAppServerEvent(params: {
    issue_run_id: string;
    observed_at: string;
    source_event_id: string;
    source_event_name: string;
    payload_class: HistoryPayloadClass;
    raw_payload?: unknown;
    summary?: string | null;
    summary_fields?: Record<string, unknown>;
    unavailable_reason_code?: string | null;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    app_server_event_id?: string;
  }): string {
    this.ensureAppServerEventReferences({ ...params, observed_at: params.observed_at });
    const payloadDetails = buildHistoryPayloadDetails({
      payloadClass: params.payload_class,
      sourceEventId: params.source_event_id,
      sourceEventName: params.source_event_name,
      rawPayload: params.raw_payload,
      summary: params.summary,
      summaryFields: params.summary_fields,
      unavailableReasonCode: params.unavailable_reason_code
    });
    const appServerEventId =
      params.app_server_event_id ??
      asExecutionGraphId('app_server_event', [
        params.issue_run_id,
        params.attempt_id,
        params.thread_id,
        params.turn_id,
        params.source_event_id,
        params.observed_at
      ]);

    this.db
      .prepare(
        `INSERT INTO history_app_server_event
          (app_server_event_id, issue_run_id, attempt_id, thread_id, turn_id, observed_at,
           source_event_id, source_event_name, payload_class, detail_status, redaction_status,
           summary, summary_fields, redacted_excerpt, truncation, unavailable_reason_code,
           full_payload_stored, policy_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        appServerEventId,
        params.issue_run_id,
        params.attempt_id ?? null,
        params.thread_id ?? null,
        params.turn_id ?? null,
        params.observed_at,
        payloadDetails.source_event_id,
        payloadDetails.source_event_name,
        payloadDetails.payload_class,
        payloadDetails.detail_status,
        payloadDetails.redaction_status,
        payloadDetails.summary,
        JSON.stringify(payloadDetails.summary_fields),
        payloadDetails.redacted_excerpt,
        JSON.stringify(payloadDetails.truncation),
        payloadDetails.unavailable_reason_code,
        payloadDetails.full_payload_stored ? 1 : 0,
        payloadDetails.policy_version
      );
    return appServerEventId;
  }

  listAppServerEventLedger(issueRunId: string): AppServerEventLedgerRecord[] {
    const rows = this.db
      .prepare(
        `SELECT app_server_event_id, issue_run_id, attempt_id, thread_id, turn_id, observed_at,
          source_event_id, source_event_name, payload_class, detail_status, redaction_status,
          summary, summary_fields, redacted_excerpt, truncation, unavailable_reason_code,
          full_payload_stored, policy_version
         FROM history_app_server_event
         WHERE issue_run_id = ?
         ORDER BY observed_at ASC, app_server_event_id ASC`
      )
      .all(issueRunId) as Array<
      Omit<AppServerEventLedgerRecord, 'summary_fields' | 'truncation' | 'full_payload_stored'> & {
        summary_fields: string;
        truncation: string;
        full_payload_stored: 0 | 1;
      }
    >;

    return rows.map((row) => ({
      ...row,
      summary_fields: parseNullableJsonObject(row.summary_fields) ?? {},
      truncation: parseHistoryPayloadTruncation(row.truncation),
      full_payload_stored: row.full_payload_stored === 1
    }));
  }

  appendIssueRun(params: {
    issue_id: string;
    issue_identifier: string;
    identity: DurableIdentity;
    started_at: string;
    ended_at?: string | null;
    status: ExecutionGraphEntityStatus;
    reason_code?: string | null;
    reason_detail?: string | null;
    issue_run_id?: string;
  }): string {
    ensureEndedAfterStarted(params.started_at, params.ended_at, 'issue_run');
    const issueRunId = params.issue_run_id ?? asExecutionGraphId('issue_run', [params.issue_id, params.issue_identifier, params.started_at]);
    this.upsertHistoryIdentity(params.identity);
    this.db
      .prepare(
        `INSERT INTO issue_run
        (issue_run_id, issue_id, issue_identifier, identity, project_key, ticket_key, started_at, ended_at, status, reason_code, reason_detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        issueRunId,
        params.issue_id,
        params.issue_identifier,
        serializeDurableIdentity(params.identity),
        params.identity.project.key,
        params.identity.ticket.key,
        params.started_at,
        params.ended_at ?? null,
        params.status,
        params.reason_code ?? null,
        redactUnknown(params.reason_detail ?? null)
      );
    this.recordIdentityProjection({
      source_table: 'issue_run',
      source_id: issueRunId,
      run_id: null,
      issue_run_id: issueRunId,
      issue_id: params.issue_id,
      issue_identifier: params.issue_identifier,
      projection_status: 'projected',
      reason_code: null,
      reason_detail: null,
      project_key: params.identity.project.key,
      ticket_key: params.identity.ticket.key
    });
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

  appendTicketTerminalOutcome(params: {
    issue_run_id: string;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    outcome: RunTerminalStatus;
    reason_code?: string | null;
    reason_detail?: string | null;
    recorded_at: string;
    terminal_outcome_id?: string;
  }): string {
    this.ensureTimelineFactReferences({
      issue_run_id: params.issue_run_id,
      attempt_id: params.attempt_id,
      thread_id: params.thread_id,
      turn_id: params.turn_id,
      timestamp: params.recorded_at,
      label: 'ticket_terminal_outcome'
    });
    const terminalOutcomeId =
      params.terminal_outcome_id ??
      asExecutionGraphId('ticket_terminal_outcome', [
        params.issue_run_id,
        params.attempt_id,
        params.thread_id,
        params.turn_id,
        params.outcome,
        params.recorded_at,
        params.reason_code
      ]);
    this.db
      .prepare(
        `INSERT INTO history_ticket_terminal_outcome
        (terminal_outcome_id, issue_run_id, attempt_id, thread_id, turn_id, outcome, reason_code, reason_detail, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        terminalOutcomeId,
        params.issue_run_id,
        params.attempt_id ?? null,
        params.thread_id ?? null,
        params.turn_id ?? null,
        params.outcome,
        params.reason_code ?? null,
        redactUnknown(params.reason_detail ?? null),
        params.recorded_at
      );
    return terminalOutcomeId;
  }

  appendTicketBlocker(params: {
    issue_run_id: string;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    blocker_type: string;
    status?: 'active' | 'resolved';
    reason_code: string;
    reason_detail?: string | null;
    blocked_at: string;
    resolved_at?: string | null;
    blocker_id?: string;
  }): string {
    ensureEndedAfterStarted(params.blocked_at, params.resolved_at, 'ticket_blocker');
    this.ensureTimelineFactReferences({
      issue_run_id: params.issue_run_id,
      attempt_id: params.attempt_id,
      thread_id: params.thread_id,
      turn_id: params.turn_id,
      timestamp: params.blocked_at,
      label: 'ticket_blocker'
    });
    const blockerId =
      params.blocker_id ??
      asExecutionGraphId('ticket_blocker', [
        params.issue_run_id,
        params.attempt_id,
        params.thread_id,
        params.turn_id,
        params.blocker_type,
        params.reason_code,
        params.blocked_at
      ]);
    this.db
      .prepare(
        `INSERT INTO history_ticket_blocker
        (blocker_id, issue_run_id, attempt_id, thread_id, turn_id, blocker_type, status, reason_code, reason_detail, blocked_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        blockerId,
        params.issue_run_id,
        params.attempt_id ?? null,
        params.thread_id ?? null,
        params.turn_id ?? null,
        params.blocker_type,
        params.status ?? 'active',
        params.reason_code,
        redactUnknown(params.reason_detail ?? null),
        params.blocked_at,
        params.resolved_at ?? null
      );
    return blockerId;
  }

  appendTicketEvidenceReference(params: {
    issue_run_id: string;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    evidence_kind: string;
    uri: string;
    title?: string | null;
    metadata?: Record<string, unknown> | null;
    recorded_at: string;
    evidence_reference_id?: string;
  }): string {
    this.ensureTimelineFactReferences({
      issue_run_id: params.issue_run_id,
      attempt_id: params.attempt_id,
      thread_id: params.thread_id,
      turn_id: params.turn_id,
      timestamp: params.recorded_at,
      label: 'ticket_evidence_reference'
    });
    const evidenceReferenceId =
      params.evidence_reference_id ??
      asExecutionGraphId('ticket_evidence_reference', [
        params.issue_run_id,
        params.attempt_id,
        params.thread_id,
        params.turn_id,
        params.evidence_kind,
        params.uri,
        params.recorded_at
      ]);
    this.db
      .prepare(
        `INSERT INTO history_ticket_evidence_reference
        (evidence_reference_id, issue_run_id, attempt_id, thread_id, turn_id, evidence_kind, uri, title, metadata, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        evidenceReferenceId,
        params.issue_run_id,
        params.attempt_id ?? null,
        params.thread_id ?? null,
        params.turn_id ?? null,
        params.evidence_kind,
        params.uri,
        redactUnknown(params.title ?? null),
        params.metadata ? JSON.stringify(redactUnknown(params.metadata)) : null,
        params.recorded_at
      );
    return evidenceReferenceId;
  }

  reconstructThreadLineage(threadId: string): ExecutionGraphThreadLineage | null {
    const thread = this.db.prepare('SELECT * FROM thread WHERE thread_id = ?').get(threadId) as ThreadRecord | undefined;
    if (!thread) {
      return null;
    }
    const attempt = this.db.prepare('SELECT * FROM attempt WHERE attempt_id = ?').get(thread.attempt_id) as AttemptRecord;
    const issueRunRow = this.db.prepare('SELECT * FROM issue_run WHERE issue_run_id = ?').get(attempt.issue_run_id) as
      | (Omit<IssueRunRecord, 'identity'> & { identity: string | null })
      | undefined;
    if (!issueRunRow) {
      throw new Error(`issue_run ${attempt.issue_run_id} does not exist`);
    }
    const issueRun: IssueRunRecord = {
      ...issueRunRow,
      identity: parseDurableIdentity(issueRunRow.identity)
    };
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

  reconstructTicketTimeline(identity: DurableIdentity): TicketTimelineRecord {
    const issueRunRows = this.db
      .prepare(
        `SELECT * FROM issue_run
         WHERE project_key = ? AND ticket_key = ?
         ORDER BY started_at ASC, issue_run_id ASC`
      )
      .all(identity.project.key, identity.ticket.key) as Array<Omit<IssueRunRecord, 'identity'> & { identity: string | null }>;
    const issueRuns = issueRunRows.map((row) => ({
      ...row,
      identity: parseDurableIdentity(row.identity)
    }));
    const issueRunIds = issueRuns.map((run) => run.issue_run_id);
    if (issueRunIds.length === 0) {
      return {
        identity,
        issue_runs: [],
        attempts: [],
        threads: [],
        turns: [],
        phase_spans: [],
        state_transitions: [],
        terminal_outcomes: [],
        blockers: [],
        evidence_references: []
      };
    }

    const attempts = this.selectByIssueRunIds<AttemptRecord>(
      `SELECT attempt.* FROM attempt
       JOIN issue_run ON issue_run.issue_run_id = attempt.issue_run_id
       WHERE issue_run.issue_run_id IN (${this.placeholders(issueRunIds)})
       ORDER BY issue_run.started_at ASC, attempt.attempt_number ASC, attempt.started_at ASC`,
      issueRunIds
    );
    const threads = this.selectByIssueRunIds<ThreadRecord>(
      `SELECT thread.* FROM thread
       JOIN attempt ON attempt.attempt_id = thread.attempt_id
       JOIN issue_run ON issue_run.issue_run_id = attempt.issue_run_id
       WHERE issue_run.issue_run_id IN (${this.placeholders(issueRunIds)})
       ORDER BY issue_run.started_at ASC, attempt.attempt_number ASC, thread.started_at ASC, thread.thread_id ASC`,
      issueRunIds
    );
    const turns = this.selectByIssueRunIds<TurnRecord>(
      `SELECT turn.* FROM turn
       JOIN thread ON thread.thread_id = turn.thread_id
       JOIN attempt ON attempt.attempt_id = thread.attempt_id
       JOIN issue_run ON issue_run.issue_run_id = attempt.issue_run_id
       WHERE issue_run.issue_run_id IN (${this.placeholders(issueRunIds)})
       ORDER BY issue_run.started_at ASC, attempt.attempt_number ASC, thread.started_at ASC, turn.turn_index ASC`,
      issueRunIds
    );
    const phaseSpans = this.selectByIssueRunIds<PhaseSpanRecord>(
      `SELECT phase_span.* FROM phase_span
       JOIN turn ON turn.turn_id = phase_span.turn_id
       JOIN thread ON thread.thread_id = turn.thread_id
       JOIN attempt ON attempt.attempt_id = thread.attempt_id
       JOIN issue_run ON issue_run.issue_run_id = attempt.issue_run_id
       WHERE issue_run.issue_run_id IN (${this.placeholders(issueRunIds)})
       ORDER BY phase_span.started_at ASC, phase_span.phase_span_id ASC`,
      issueRunIds
    );
    const stateTransitions = this.selectByIssueRunIds<StateTransitionRecord>(
      `SELECT * FROM state_transition
       WHERE issue_run_id IN (${this.placeholders(issueRunIds)})
       ORDER BY transitioned_at ASC, state_transition_id ASC`,
      issueRunIds
    );
    const terminalOutcomes = this.selectByIssueRunIds<TicketTerminalOutcomeRecord>(
      `SELECT * FROM history_ticket_terminal_outcome
       WHERE issue_run_id IN (${this.placeholders(issueRunIds)})
       ORDER BY recorded_at ASC, terminal_outcome_id ASC`,
      issueRunIds
    );
    const blockers = this.selectByIssueRunIds<TicketBlockerRecord>(
      `SELECT * FROM history_ticket_blocker
       WHERE issue_run_id IN (${this.placeholders(issueRunIds)})
       ORDER BY blocked_at ASC, blocker_id ASC`,
      issueRunIds
    );
    const evidenceRows = this.selectByIssueRunIds<Omit<TicketEvidenceReferenceRecord, 'metadata'> & { metadata: string | null }>(
      `SELECT * FROM history_ticket_evidence_reference
       WHERE issue_run_id IN (${this.placeholders(issueRunIds)})
       ORDER BY recorded_at ASC, evidence_reference_id ASC`,
      issueRunIds
    );

    return {
      identity,
      issue_runs: issueRuns,
      attempts,
      threads,
      turns,
      phase_spans: phaseSpans,
      state_transitions: stateTransitions,
      terminal_outcomes: terminalOutcomes,
      blockers,
      evidence_references: evidenceRows.map((row) => ({
        ...row,
        metadata: parseNullableJsonObject(row.metadata)
      }))
    };
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
        `SELECT run_id, issue_id, issue_identifier, identity, started_at, ended_at, completed_at, terminal_status, error_code,
          terminal_reason_code, terminal_reason_detail, root_cause_status, root_cause_reason_code,
          root_cause_reason_detail, root_cause_at, session_id, thread_id, turn_id, missing_tool_output_recovery
        FROM runs ORDER BY started_at DESC LIMIT ?`
      )
      .all(limit) as Array<{
      run_id: string;
      issue_id: string;
      issue_identifier: string;
      identity: string | null;
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
    const appServerEventStmt = this.hasTable('history_app_server_event')
      ? this.db.prepare(
          `SELECT app_server_event_id, issue_run_id, attempt_id, thread_id, turn_id, observed_at,
            source_event_id, source_event_name, payload_class, detail_status, redaction_status,
            summary, summary_fields, redacted_excerpt, truncation, unavailable_reason_code,
            full_payload_stored, policy_version
           FROM history_app_server_event
           WHERE issue_run_id = ?
           ORDER BY observed_at ASC, app_server_event_id ASC
           LIMIT 25`
        )
      : null;
    const identityProjectionStmt = this.hasTable('history_identity_projection')
      ? this.db.prepare(
          `SELECT source_table, source_id, run_id, issue_run_id, issue_id, issue_identifier, projection_status,
            reason_code, reason_detail, project_key, ticket_key, updated_at
           FROM history_identity_projection
           WHERE source_table = 'runs' AND source_id = ?`
        )
      : null;

    return rows.map((row) => {
      const sessions = sessionStmt.all(row.run_id) as Array<{ session_id: string }>;
      const identityProjection = this.readHistoryIdentityProjection(identityProjectionStmt, row.run_id);
      const appServerEvents =
        appServerEventStmt && identityProjection?.issue_run_id
          ? (appServerEventStmt.all(identityProjection.issue_run_id) as Array<
              Omit<AppServerEventLedgerRecord, 'summary_fields' | 'truncation' | 'full_payload_stored'> & {
                summary_fields: string;
                truncation: string;
                full_payload_stored: 0 | 1;
              }
            >).map((event) => ({
              ...event,
              summary_fields: parseNullableJsonObject(event.summary_fields) ?? {},
              truncation: parseHistoryPayloadTruncation(event.truncation),
              full_payload_stored: event.full_payload_stored === 1
            }))
          : [];
      const record: DurableRunHistoryRecord = {
        run_id: row.run_id,
        issue_id: row.issue_id,
        issue_identifier: row.issue_identifier,
        identity: parseDurableIdentity(row.identity),
        identity_projection: identityProjection,
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
        app_server_events: appServerEvents,
        missing_tool_output_recovery: parseNullableJsonObject(row.missing_tool_output_recovery)
      };

      return redactUnknown(record) as DurableRunHistoryRecord;
    });
  }

  private runHistorySchemaMigrations(): void {
    this.ensureHistoryMigrationTables();

    const migrations: HistoryMigration[] = [
      {
        version: 1,
        name: 'project_execution_history_v1',
        apply: (store) => {
          store.ensureRunDiagnosticColumns();
          store.ensureIssueRunIdentityColumn();
          store.ensureRunEventDiagnosticColumns();
          store.createProjectExecutionHistoryTables();
        }
      },
      {
        version: 2,
        name: 'ticket_orchestration_ledger_v1',
        apply: (store) => {
          store.ensureIssueRunIdentityKeyColumns();
          store.createTicketOrchestrationLedgerTables();
        }
      },
      {
        version: 3,
        name: 'app_server_event_ledger_lite_policy',
        apply: (store) => {
          store.createAppServerEventLedgerTables();
        }
      },
      {
        version: 4,
        name: 'existing_run_history_identity_backfill_v1',
        apply: (store) => {
          store.createHistoryIdentityProjectionTable();
          store.backfillExistingHistoryIdentities();
        }
      },
      {
        version: 5,
        name: 'history_retention_prune_evidence_v1',
        apply: (store) => {
          store.createHistoryRetentionPruneRecordTable();
        }
      }
    ];

    for (const migration of migrations) {
      const existing = this.db
        .prepare('SELECT status FROM history_schema_migrations WHERE schema_name = ? AND version = ?')
        .get(HISTORY_SCHEMA_NAME, migration.version) as { status: string } | undefined;
      if (existing?.status === 'applied') {
        continue;
      }

      const startedAt = asIso(this.nowMs());
      try {
        this.db.exec('BEGIN;');
        if (this.migrationFailureForTest === migration.name) {
          throw new Error(`injected migration failure: ${migration.name}`);
        }
        migration.apply(this);
        const finishedAt = asIso(this.nowMs());
        this.db
          .prepare(
            `INSERT INTO history_schema_migrations
              (schema_name, version, name, status, started_at, finished_at, error_message)
             VALUES (?, ?, ?, 'applied', ?, ?, NULL)
             ON CONFLICT(schema_name, version) DO UPDATE SET
              name = excluded.name,
              status = excluded.status,
              started_at = excluded.started_at,
              finished_at = excluded.finished_at,
              error_message = excluded.error_message`
          )
          .run(HISTORY_SCHEMA_NAME, migration.version, migration.name, startedAt, finishedAt);
        this.recordHistorySchemaState({
          appliedVersion: migration.version,
          status: 'healthy',
          degradedReasonCode: null,
          degradedDetail: null
        });
        this.db.exec('COMMIT;');
      } catch (error) {
        try {
          this.db.exec('ROLLBACK;');
        } catch {
          // The migration may have failed before BEGIN was accepted.
        }
        const detail = error instanceof Error ? error.message : String(error);
        this.recordHistoryMigrationFailure(migration, startedAt, detail);
        break;
      }
    }

    this.ensureHistoryWriteFailureTable();

    const state = this.db
      .prepare('SELECT status FROM history_schema_state WHERE schema_name = ?')
      .get(HISTORY_SCHEMA_NAME) as { status: string } | undefined;
    if (!state) {
      this.recordHistorySchemaState({
        appliedVersion: 0,
        status: 'degraded',
        degradedReasonCode: 'history_schema_not_applied',
        degradedDetail: 'No Project Execution History migration completed.'
      });
    }
  }

  private ensureHistoryMigrationTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history_schema_state (
        schema_name TEXT PRIMARY KEY,
        target_version INTEGER NOT NULL,
        applied_version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded')),
        degraded_reason_code TEXT,
        degraded_detail TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history_schema_migrations (
        schema_name TEXT NOT NULL,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('applied', 'failed')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error_message TEXT,
        PRIMARY KEY (schema_name, version)
      );
    `);
  }

  private recordHistorySchemaState(params: {
    appliedVersion: number;
    status: 'healthy' | 'degraded';
    degradedReasonCode: string | null;
    degradedDetail: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO history_schema_state
          (schema_name, target_version, applied_version, status, degraded_reason_code, degraded_detail, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(schema_name) DO UPDATE SET
          target_version = excluded.target_version,
          applied_version = excluded.applied_version,
          status = excluded.status,
          degraded_reason_code = excluded.degraded_reason_code,
          degraded_detail = excluded.degraded_detail,
          updated_at = excluded.updated_at`
      )
      .run(
        HISTORY_SCHEMA_NAME,
        HISTORY_SCHEMA_VERSION,
        params.appliedVersion,
        params.status,
        params.degradedReasonCode,
        redactUnknown(params.degradedDetail),
        asIso(this.nowMs())
      );
  }

  private recordHistoryMigrationFailure(migration: HistoryMigration, startedAt: string, detail: string): void {
    const finishedAt = asIso(this.nowMs());
    const redactedDetail = redactUnknown(detail) as string;
    this.db
      .prepare(
        `INSERT INTO history_schema_migrations
          (schema_name, version, name, status, started_at, finished_at, error_message)
         VALUES (?, ?, ?, 'failed', ?, ?, ?)
         ON CONFLICT(schema_name, version) DO UPDATE SET
          name = excluded.name,
          status = excluded.status,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          error_message = excluded.error_message`
      )
      .run(HISTORY_SCHEMA_NAME, migration.version, migration.name, startedAt, finishedAt, redactedDetail);
    this.recordHistorySchemaState({
      appliedVersion: migration.version - 1,
      status: 'degraded',
      degradedReasonCode: 'history_schema_migration_failed',
      degradedDetail: redactedDetail
    });
  }

  private createProjectExecutionHistoryTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history_project_identity (
        project_key TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        workflow_path TEXT NOT NULL,
        workflow_hash_status TEXT NOT NULL,
        workflow_hash_value TEXT,
        workflow_hash_reason TEXT,
        repository_remote_status TEXT NOT NULL,
        repository_remote_value TEXT,
        repository_remote_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history_ticket_identity (
        ticket_key TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        tracker_kind TEXT NOT NULL,
        tracker_scope_status TEXT NOT NULL,
        tracker_scope_value TEXT,
        tracker_scope_reason TEXT,
        remote_issue_id TEXT NOT NULL,
        human_issue_identifier TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_key) REFERENCES history_project_identity(project_key) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS history_protocol_summary (
        protocol_summary_id TEXT PRIMARY KEY,
        issue_run_id TEXT NOT NULL,
        attempt_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        protocol_name TEXT NOT NULL,
        protocol_version TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        warning_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        summary TEXT,
        recorded_at TEXT NOT NULL,
        FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT,
        FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT,
        FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT,
        FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS history_token_model_fact (
        token_model_fact_id TEXT PRIMARY KEY,
        issue_run_id TEXT NOT NULL,
        attempt_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        effective_model TEXT,
        model_source TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cached_input_tokens INTEGER,
        reasoning_output_tokens INTEGER,
        total_tokens INTEGER,
        telemetry_confidence TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT,
        FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT,
        FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT,
        FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS history_retention_metadata (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        retention_days INTEGER NOT NULL,
        last_pruned_at TEXT,
        policy_version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history_health_metadata (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded')),
        reason_code TEXT,
        detail TEXT,
        checked_at TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        applied_migration_version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history_write_failure (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        detail TEXT,
        recorded_at TEXT NOT NULL
      );
    `);
    this.db
      .prepare(
        `INSERT INTO history_retention_metadata
          (singleton_id, retention_days, last_pruned_at, policy_version, updated_at)
         VALUES (1, ?, (SELECT value FROM meta WHERE key = 'last_pruned_at'), 1, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET
          retention_days = excluded.retention_days,
          last_pruned_at = excluded.last_pruned_at,
          policy_version = excluded.policy_version,
          updated_at = excluded.updated_at`
      )
      .run(this.retentionDays, asIso(this.nowMs()));
    this.db
      .prepare(
        `INSERT INTO history_health_metadata
          (singleton_id, status, reason_code, detail, checked_at, schema_version, applied_migration_version)
         VALUES (1, 'healthy', NULL, NULL, ?, ?, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET
          status = excluded.status,
          reason_code = excluded.reason_code,
          detail = excluded.detail,
          checked_at = excluded.checked_at,
          schema_version = excluded.schema_version,
          applied_migration_version = excluded.applied_migration_version`
      )
      .run(asIso(this.nowMs()), 1, 1);
  }

  private createHistoryRetentionPruneRecordTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history_retention_prune_record (
        prune_record_id TEXT PRIMARY KEY,
        source_table TEXT NOT NULL CHECK (source_table IN ('runs', 'issue_run')),
        source_id TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        issue_identifier TEXT NOT NULL,
        project_key TEXT,
        ticket_key TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        pruned_at TEXT NOT NULL,
        retention_days INTEGER NOT NULL,
        cutoff_at TEXT NOT NULL,
        pruned_record_count INTEGER NOT NULL,
        reason_code TEXT NOT NULL,
        metadata TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS history_retention_prune_record_source_idx
        ON history_retention_prune_record(source_table, source_id);
      CREATE INDEX IF NOT EXISTS history_retention_prune_record_pruned_at_idx
        ON history_retention_prune_record(pruned_at, prune_record_id);
    `);
  }

  private createTicketOrchestrationLedgerTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history_ticket_terminal_outcome (
        terminal_outcome_id TEXT PRIMARY KEY,
        issue_run_id TEXT NOT NULL,
        attempt_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        outcome TEXT NOT NULL,
        reason_code TEXT,
        reason_detail TEXT,
        recorded_at TEXT NOT NULL,
        FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT,
        FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT,
        FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT,
        FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS history_ticket_blocker (
        blocker_id TEXT PRIMARY KEY,
        issue_run_id TEXT NOT NULL,
        attempt_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        blocker_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'resolved')),
        reason_code TEXT NOT NULL,
        reason_detail TEXT,
        blocked_at TEXT NOT NULL,
        resolved_at TEXT,
        CHECK (resolved_at IS NULL OR resolved_at >= blocked_at),
        FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT,
        FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT,
        FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT,
        FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS history_ticket_evidence_reference (
        evidence_reference_id TEXT PRIMARY KEY,
        issue_run_id TEXT NOT NULL,
        attempt_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        evidence_kind TEXT NOT NULL,
        uri TEXT NOT NULL,
        title TEXT,
        metadata TEXT,
        recorded_at TEXT NOT NULL,
        FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT,
        FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT,
        FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT,
        FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
      );
    `);
    this.ensureHistoryWriteFailureTable();
    this.recordHistoryHealthMetadata('healthy', null, null);
  }

  private ensureHistoryWriteFailureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history_write_failure (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        detail TEXT,
        recorded_at TEXT NOT NULL
      );
    `);
  }

  private recordHistoryHealthMetadata(status: 'healthy' | 'degraded', reasonCode: string | null, detail: string | null): void {
    this.db
      .prepare(
        `INSERT INTO history_health_metadata
          (singleton_id, status, reason_code, detail, checked_at, schema_version, applied_migration_version)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET
          status = excluded.status,
          reason_code = excluded.reason_code,
          detail = excluded.detail,
          checked_at = excluded.checked_at,
          schema_version = excluded.schema_version,
          applied_migration_version = excluded.applied_migration_version`
      )
      .run(status, reasonCode, redactUnknown(detail), asIso(this.nowMs()), HISTORY_SCHEMA_VERSION, this.readHistorySchemaHealth().applied_version);
  }

  private createHistoryIdentityProjectionTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history_identity_projection (
        source_table TEXT NOT NULL CHECK (source_table IN ('runs', 'issue_run')),
        source_id TEXT NOT NULL,
        run_id TEXT,
        issue_run_id TEXT,
        issue_id TEXT NOT NULL,
        issue_identifier TEXT NOT NULL,
        projection_status TEXT NOT NULL CHECK (projection_status IN ('projected', 'degraded')),
        reason_code TEXT,
        reason_detail TEXT,
        project_key TEXT,
        ticket_key TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source_table, source_id)
      );
    `);
  }

  private backfillExistingHistoryIdentities(): void {
    this.backfillRunHistoryIdentities();
    this.backfillIssueRunHistoryIdentities();
    this.recordHistoryHealthMetadata('healthy', null, null);
  }

  private backfillRunHistoryIdentities(): void {
    const rows = this.db
      .prepare('SELECT run_id, issue_id, issue_identifier, identity FROM runs ORDER BY started_at ASC, run_id ASC')
      .all() as Array<{ run_id: string; issue_id: string; issue_identifier: string; identity: string | null }>;
    for (const row of rows) {
      const identity = parseDurableIdentity(row.identity);
      if (identity) {
        this.upsertHistoryIdentity(identity);
        this.recordIdentityProjection({
          source_table: 'runs',
          source_id: row.run_id,
          run_id: row.run_id,
          issue_run_id: null,
          issue_id: row.issue_id,
          issue_identifier: row.issue_identifier,
          projection_status: 'projected',
          reason_code: null,
          reason_detail: null,
          project_key: identity.project.key,
          ticket_key: identity.ticket.key
        });
        continue;
      }

      this.recordIdentityProjection({
        source_table: 'runs',
        source_id: row.run_id,
        run_id: row.run_id,
        issue_run_id: null,
        issue_id: row.issue_id,
        issue_identifier: row.issue_identifier,
        projection_status: 'degraded',
        reason_code: row.identity ? 'invalid_durable_identity' : 'missing_durable_identity',
        reason_detail: row.identity
          ? 'Existing run history row contains unusable durable identity JSON; tracker/project facts were not invented.'
          : 'Existing run history row has no durable identity evidence; tracker/project facts were not invented.',
        project_key: null,
        ticket_key: null
      });
    }
  }

  private backfillIssueRunHistoryIdentities(): void {
    const rows = this.db
      .prepare('SELECT issue_run_id, issue_id, issue_identifier, identity FROM issue_run ORDER BY started_at ASC, issue_run_id ASC')
      .all() as Array<{ issue_run_id: string; issue_id: string; issue_identifier: string; identity: string | null }>;
    const updateKeys = this.db.prepare('UPDATE issue_run SET project_key = ?, ticket_key = ? WHERE issue_run_id = ?');
    for (const row of rows) {
      const identity = parseDurableIdentity(row.identity);
      if (identity) {
        this.upsertHistoryIdentity(identity);
        updateKeys.run(identity.project.key, identity.ticket.key, row.issue_run_id);
        this.recordIdentityProjection({
          source_table: 'issue_run',
          source_id: row.issue_run_id,
          run_id: null,
          issue_run_id: row.issue_run_id,
          issue_id: row.issue_id,
          issue_identifier: row.issue_identifier,
          projection_status: 'projected',
          reason_code: null,
          reason_detail: null,
          project_key: identity.project.key,
          ticket_key: identity.ticket.key
        });
        continue;
      }

      this.recordIdentityProjection({
        source_table: 'issue_run',
        source_id: row.issue_run_id,
        run_id: null,
        issue_run_id: row.issue_run_id,
        issue_id: row.issue_id,
        issue_identifier: row.issue_identifier,
        projection_status: 'degraded',
        reason_code: row.identity ? 'invalid_durable_identity' : 'missing_durable_identity',
        reason_detail: row.identity
          ? 'Existing issue_run row contains unusable durable identity JSON; tracker/project facts were not invented.'
          : 'Existing issue_run row has no durable identity evidence; tracker/project facts were not invented.',
        project_key: null,
        ticket_key: null
      });
    }
  }

  private recordIdentityProjection(
    record: Omit<HistoryIdentityProjectionRecord, 'updated_at'>
  ): void {
    this.db
      .prepare(
        `INSERT INTO history_identity_projection
          (source_table, source_id, run_id, issue_run_id, issue_id, issue_identifier, projection_status,
           reason_code, reason_detail, project_key, ticket_key, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_table, source_id) DO UPDATE SET
          run_id = excluded.run_id,
          issue_run_id = excluded.issue_run_id,
          issue_id = excluded.issue_id,
          issue_identifier = excluded.issue_identifier,
          projection_status = excluded.projection_status,
          reason_code = excluded.reason_code,
          reason_detail = excluded.reason_detail,
          project_key = excluded.project_key,
          ticket_key = excluded.ticket_key,
          updated_at = excluded.updated_at`
      )
      .run(
        record.source_table,
        record.source_id,
        record.run_id,
        record.issue_run_id,
        record.issue_id,
        record.issue_identifier,
        record.projection_status,
        record.reason_code,
        redactUnknown(record.reason_detail ?? null),
        record.project_key,
        record.ticket_key,
        asIso(this.nowMs())
      );
  }

  private readHistoryIdentityProjection(
    statement: { get(...args: unknown[]): unknown } | null,
    sourceId: string
  ): HistoryIdentityProjectionRecord | null {
    if (!statement) {
      return null;
    }
    return (statement.get(sourceId) as HistoryIdentityProjectionRecord | undefined) ?? null;
  }

  private createAppServerEventLedgerTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history_app_server_event (
        app_server_event_id TEXT PRIMARY KEY,
        issue_run_id TEXT NOT NULL,
        attempt_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        observed_at TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        source_event_name TEXT NOT NULL,
        payload_class TEXT NOT NULL,
        detail_status TEXT NOT NULL CHECK (detail_status IN (
          'absent',
          'summary_only',
          'redacted_excerpt',
          'redacted_truncated_excerpt',
          'unavailable_policy',
          'unavailable_source'
        )),
        redaction_status TEXT NOT NULL CHECK (redaction_status IN (
          'not_required',
          'redacted',
          'unavailable_policy',
          'unavailable_source'
        )),
        summary TEXT,
        summary_fields TEXT NOT NULL,
        redacted_excerpt TEXT,
        truncation TEXT NOT NULL,
        unavailable_reason_code TEXT,
        full_payload_stored INTEGER NOT NULL DEFAULT 0 CHECK (full_payload_stored IN (0, 1)),
        policy_version INTEGER NOT NULL,
        CHECK (full_payload_stored = 0),
        FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT,
        FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT,
        FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT,
        FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS history_app_server_event_issue_run_observed_idx
        ON history_app_server_event(issue_run_id, observed_at, app_server_event_id);
    `);
  }

  private hasTable(name: string): boolean {
    const row = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
      | { name: string }
      | undefined;
    return Boolean(row);
  }

  private readHistorySchemaHealth(): HistorySchemaHealth {
    this.ensureHistoryMigrationTables();
    const row = this.db.prepare('SELECT * FROM history_schema_state WHERE schema_name = ?').get(HISTORY_SCHEMA_NAME) as
      | {
          schema_name: 'project_execution_history';
          target_version: number;
          applied_version: number;
          status: 'healthy' | 'degraded';
          degraded_reason_code: string | null;
          degraded_detail: string | null;
          updated_at: string;
        }
      | undefined;
    const migrations = this.db
      .prepare(
        `SELECT version, name, status, started_at, finished_at, error_message
         FROM history_schema_migrations
         WHERE schema_name = ?
         ORDER BY version ASC`
      )
      .all(HISTORY_SCHEMA_NAME) as HistorySchemaHealth['migrations'];

    return {
      schema_name: HISTORY_SCHEMA_NAME,
      target_version: HISTORY_SCHEMA_VERSION,
      applied_version: row?.applied_version ?? 0,
      status: row?.status ?? 'degraded',
      degraded_reason_code: row ? row.degraded_reason_code : 'history_schema_state_missing',
      degraded_detail: row ? row.degraded_detail : 'Project Execution History schema state has not been recorded.',
      updated_at: row?.updated_at ?? asIso(this.nowMs()),
      migrations
    };
  }

  private upsertHistoryIdentity(identity: DurableIdentity): void {
    if (this.readHistorySchemaHealth().status !== 'healthy') {
      return;
    }
    const now = asIso(this.nowMs());
    const workflowHash = identity.project.workflow_hash;
    const repositoryRemote = identity.project.repository_remote;
    const trackerScope = identity.ticket.tracker_scope;
    this.db
      .prepare(
        `INSERT INTO history_project_identity
          (project_key, project_root, workflow_path, workflow_hash_status, workflow_hash_value, workflow_hash_reason,
           repository_remote_status, repository_remote_value, repository_remote_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_key) DO UPDATE SET
          project_root = excluded.project_root,
          workflow_path = excluded.workflow_path,
          workflow_hash_status = excluded.workflow_hash_status,
          workflow_hash_value = excluded.workflow_hash_value,
          workflow_hash_reason = excluded.workflow_hash_reason,
          repository_remote_status = excluded.repository_remote_status,
          repository_remote_value = excluded.repository_remote_value,
          repository_remote_reason = excluded.repository_remote_reason,
          updated_at = excluded.updated_at`
      )
      .run(
        identity.project.key,
        identity.project.project_root,
        identity.project.workflow_path,
        workflowHash.status,
        workflowHash.status === 'present' ? workflowHash.value : null,
        workflowHash.status === 'missing' ? workflowHash.reason : null,
        repositoryRemote.status,
        repositoryRemote.status === 'present' ? repositoryRemote.value : null,
        repositoryRemote.status === 'missing' ? repositoryRemote.reason : null,
        now,
        now
      );
    this.db
      .prepare(
        `INSERT INTO history_ticket_identity
          (ticket_key, project_key, tracker_kind, tracker_scope_status, tracker_scope_value, tracker_scope_reason,
           remote_issue_id, human_issue_identifier, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ticket_key) DO UPDATE SET
          project_key = excluded.project_key,
          tracker_kind = excluded.tracker_kind,
          tracker_scope_status = excluded.tracker_scope_status,
          tracker_scope_value = excluded.tracker_scope_value,
          tracker_scope_reason = excluded.tracker_scope_reason,
          remote_issue_id = excluded.remote_issue_id,
          human_issue_identifier = excluded.human_issue_identifier,
          updated_at = excluded.updated_at`
      )
      .run(
        identity.ticket.key,
        identity.project.key,
        identity.ticket.tracker_kind,
        trackerScope.status,
        trackerScope.status === 'present' ? trackerScope.value : null,
        trackerScope.status === 'missing' ? trackerScope.reason : null,
        identity.ticket.remote_issue_id,
        identity.ticket.human_issue_identifier,
        now,
        now
      );
  }

  private ensureAppServerEventReferences(params: {
    issue_run_id: string;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    observed_at?: string;
  }): void {
    this.ensureStateTransitionReferences({
      issue_run_id: params.issue_run_id,
      attempt_id: params.attempt_id,
      thread_id: params.thread_id,
      turn_id: params.turn_id,
      transitioned_at: params.observed_at ?? asIso(this.nowMs())
    });
  }

  private ensureRunDiagnosticColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>;
    const existing = new Set(columns.map((column) => column.name));
    const migrations: Array<[string, string]> = [
      ['identity', 'ALTER TABLE runs ADD COLUMN identity TEXT'],
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

  private ensureIssueRunIdentityColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(issue_run)').all() as Array<{ name: string }>;
    const existing = new Set(columns.map((column) => column.name));
    if (!existing.has('identity')) {
      this.db.exec('ALTER TABLE issue_run ADD COLUMN identity TEXT;');
    }
  }

  private ensureIssueRunIdentityKeyColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(issue_run)').all() as Array<{ name: string }>;
    const existing = new Set(columns.map((column) => column.name));
    if (!existing.has('project_key')) {
      this.db.exec('ALTER TABLE issue_run ADD COLUMN project_key TEXT;');
    }
    if (!existing.has('ticket_key')) {
      this.db.exec('ALTER TABLE issue_run ADD COLUMN ticket_key TEXT;');
    }

    const rows = this.db
      .prepare('SELECT issue_run_id, identity FROM issue_run WHERE (project_key IS NULL OR ticket_key IS NULL) AND identity IS NOT NULL')
      .all() as Array<{ issue_run_id: string; identity: string | null }>;
    const update = this.db.prepare('UPDATE issue_run SET project_key = ?, ticket_key = ? WHERE issue_run_id = ?');
    for (const row of rows) {
      const identity = parseDurableIdentity(row.identity);
      if (identity) {
        update.run(identity.project.key, identity.ticket.key, row.issue_run_id);
      }
    }
  }

  private ensureRunEventDiagnosticColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(run_events)').all() as Array<{ name: string }>;
    const existing = new Set(columns.map((column) => column.name));
    const migrations: Array<[string, string]> = [
      ['reason_code', 'ALTER TABLE run_events ADD COLUMN reason_code TEXT'],
      ['request_method', 'ALTER TABLE run_events ADD COLUMN request_method TEXT'],
      ['request_category', 'ALTER TABLE run_events ADD COLUMN request_category TEXT']
    ];
    for (const [column, sql] of migrations) {
      if (!existing.has(column)) {
        this.db.exec(`${sql};`);
      }
    }
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

  private placeholders(values: unknown[]): string {
    return values.map(() => '?').join(', ');
  }

  private selectByIssueRunIds<T>(sql: string, issueRunIds: string[]): T[] {
    return this.db.prepare(sql).all(...issueRunIds) as T[];
  }

  private ensureTimelineFactReferences(params: {
    issue_run_id: string;
    attempt_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    timestamp: string;
    label: string;
  }): void {
    const issueRun = this.db.prepare('SELECT started_at FROM issue_run WHERE issue_run_id = ?').get(params.issue_run_id) as
      | { started_at: string }
      | undefined;
    if (!issueRun) {
      throw new Error(`issue_run ${params.issue_run_id} does not exist`);
    }
    ensureMonotonicTimestamp(params.timestamp, issueRun.started_at, params.label);

    if (params.attempt_id) {
      const attempt = this.db.prepare('SELECT issue_run_id, started_at FROM attempt WHERE attempt_id = ?').get(params.attempt_id) as
        | { issue_run_id: string; started_at: string }
        | undefined;
      if (!attempt || attempt.issue_run_id !== params.issue_run_id) {
        throw new Error(`attempt ${params.attempt_id} does not belong to issue_run ${params.issue_run_id}`);
      }
      ensureMonotonicTimestamp(params.timestamp, attempt.started_at, params.label);
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
      ensureMonotonicTimestamp(params.timestamp, thread.started_at, params.label);
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
      ensureMonotonicTimestamp(params.timestamp, turn.started_at, params.label);
    }
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
    const prunedAt = asIso(this.nowMs());

    try {
      if (this.pruneFailureForTest) {
        throw new Error(this.pruneFailureForTest);
      }

      return this.transaction(() => {
        const expiredRuns = this.expiredCompletedRuns(cutoff);
        const expiredIssueRuns = this.expiredCompletedIssueRuns(cutoff);
        let pruned = 0;

        for (const item of expiredRuns) {
          this.recordRetentionPrune({
            source_table: 'runs',
            source_id: item.run_id,
            issue_id: item.issue_id,
            issue_identifier: item.issue_identifier,
            project_key: item.project_key,
            ticket_key: item.ticket_key,
            started_at: item.started_at,
            completed_at: item.completed_at,
            cutoff_at: cutoff,
            pruned_at: prunedAt,
            pruned_record_count: item.pruned_record_count,
            metadata: {
              terminal_status: item.terminal_status,
              pruned_tables: ['run_sessions', 'run_events', 'runs']
            }
          });
          this.db.prepare('DELETE FROM run_sessions WHERE run_id = ?').run(item.run_id);
          this.db.prepare('DELETE FROM run_events WHERE run_id = ?').run(item.run_id);
          this.db.prepare('DELETE FROM runs WHERE run_id = ?').run(item.run_id);
          pruned += 1;
        }

        for (const item of expiredIssueRuns) {
          this.recordRetentionPrune({
            source_table: 'issue_run',
            source_id: item.issue_run_id,
            issue_id: item.issue_id,
            issue_identifier: item.issue_identifier,
            project_key: item.project_key,
            ticket_key: item.ticket_key,
            started_at: item.started_at,
            completed_at: item.completed_at,
            cutoff_at: cutoff,
            pruned_at: prunedAt,
            pruned_record_count: item.pruned_record_count,
            metadata: {
              status: item.status,
              pruned_tables: [
                'history_app_server_event',
                'history_protocol_summary',
                'history_token_model_fact',
                'history_ticket_evidence_reference',
                'history_ticket_blocker',
                'history_ticket_terminal_outcome',
                'state_transition',
                'tool_span',
                'phase_span',
                'turn',
                'thread',
                'attempt',
                'issue_run'
              ]
            }
          });
          this.deleteIssueRunHistory(item.issue_run_id);
          pruned += 1;
        }

        this.db
          .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run('last_pruned_at', prunedAt);
        this.updateHistoryRetentionMetadata();

        return pruned;
      });
    } catch (error) {
      this.recordPruneFailure(error);
      throw error;
    }
  }

  health(): PersistenceHealth {
    const runCountRow = this.db.prepare('SELECT COUNT(*) AS count FROM runs').get() as { count: number };
    const integrityRow = this.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    const pruneRow = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('last_pruned_at') as
      | { value: string }
      | undefined;
    const pruneFailureAtRow = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('last_prune_failure_at') as
      | { value: string }
      | undefined;
    const pruneFailureReasonRow = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('last_prune_failure_reason') as
      | { value: string }
      | undefined;
    const pruneFailureDetailRow = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('last_prune_failure_detail') as
      | { value: string }
      | undefined;

    const historySchema = this.readHistorySchemaHealth();
    const integrityOk = integrityRow.integrity_check === 'ok' && historySchema.status === 'healthy';
    try {
      this.recordHistoryHealthMetadata(historySchema.status, historySchema.degraded_reason_code, historySchema.degraded_detail);
    } catch {
      // If the history schema is degraded before v1 tables exist, the durable
      // schema_state row remains the source of truth for the degraded status.
    }

    return {
      enabled: true,
      db_path: this.dbPath,
      retention_days: this.retentionDays,
      run_count: runCountRow.count,
      last_pruned_at: pruneRow?.value ?? null,
      last_prune_failure_at: pruneFailureAtRow?.value ?? null,
      last_prune_failure_reason: pruneFailureReasonRow?.value ?? null,
      last_prune_failure_detail: pruneFailureDetailRow?.value ?? null,
      integrity_ok: integrityOk,
      history_schema: historySchema
    };
  }

  private expiredCompletedRuns(cutoff: string): Array<{
    run_id: string;
    issue_id: string;
    issue_identifier: string;
    project_key: string | null;
    ticket_key: string | null;
    started_at: string;
    completed_at: string;
    terminal_status: RunTerminalStatus;
    pruned_record_count: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT runs.run_id, runs.issue_id, runs.issue_identifier,
          history_identity_projection.project_key, history_identity_projection.ticket_key,
          runs.started_at, COALESCE(runs.completed_at, runs.ended_at) AS completed_at, runs.terminal_status,
          (1
            + (SELECT COUNT(*) FROM run_sessions WHERE run_sessions.run_id = runs.run_id)
            + (SELECT COUNT(*) FROM run_events WHERE run_events.run_id = runs.run_id)
          ) AS pruned_record_count
         FROM runs
         LEFT JOIN history_identity_projection
          ON history_identity_projection.source_table = 'runs'
          AND history_identity_projection.source_id = runs.run_id
         WHERE runs.terminal_status IS NOT NULL
          AND COALESCE(runs.completed_at, runs.ended_at) IS NOT NULL
          AND COALESCE(runs.completed_at, runs.ended_at) < ?
         ORDER BY completed_at ASC, runs.run_id ASC`
      )
      .all(cutoff) as Array<{
      run_id: string;
      issue_id: string;
      issue_identifier: string;
      project_key: string | null;
      ticket_key: string | null;
      started_at: string;
      completed_at: string;
      terminal_status: RunTerminalStatus;
      pruned_record_count: number;
    }>;
    return rows;
  }

  private expiredCompletedIssueRuns(cutoff: string): Array<{
    issue_run_id: string;
    issue_id: string;
    issue_identifier: string;
    project_key: string | null;
    ticket_key: string | null;
    started_at: string;
    ended_at: string;
    completed_at: string;
    status: ExecutionGraphEntityStatus;
    pruned_record_count: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT issue_run.issue_run_id, issue_run.issue_id, issue_run.issue_identifier,
          issue_run.project_key, issue_run.ticket_key, issue_run.started_at, issue_run.ended_at, issue_run.status,
          COALESCE(issue_run.ended_at, MIN(COALESCE(linked_run.completed_at, linked_run.ended_at))) AS completed_at,
          (1
            + (SELECT COUNT(*) FROM attempt WHERE attempt.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM thread JOIN attempt ON attempt.attempt_id = thread.attempt_id WHERE attempt.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM turn JOIN thread ON thread.thread_id = turn.thread_id JOIN attempt ON attempt.attempt_id = thread.attempt_id WHERE attempt.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM phase_span JOIN turn ON turn.turn_id = phase_span.turn_id JOIN thread ON thread.thread_id = turn.thread_id JOIN attempt ON attempt.attempt_id = thread.attempt_id WHERE attempt.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM tool_span JOIN turn ON turn.turn_id = tool_span.turn_id JOIN thread ON thread.thread_id = turn.thread_id JOIN attempt ON attempt.attempt_id = thread.attempt_id WHERE attempt.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM state_transition WHERE state_transition.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM history_ticket_terminal_outcome WHERE history_ticket_terminal_outcome.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM history_ticket_blocker WHERE history_ticket_blocker.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM history_ticket_evidence_reference WHERE history_ticket_evidence_reference.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM history_protocol_summary WHERE history_protocol_summary.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM history_token_model_fact WHERE history_token_model_fact.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM history_app_server_event WHERE history_app_server_event.issue_run_id = issue_run.issue_run_id)
          ) AS pruned_record_count
         FROM issue_run
         LEFT JOIN history_identity_projection AS linked_run_projection
          ON linked_run_projection.source_table = 'runs'
          AND linked_run_projection.issue_run_id = issue_run.issue_run_id
         LEFT JOIN runs AS linked_run
          ON linked_run.run_id = linked_run_projection.run_id
         GROUP BY issue_run.issue_run_id
         HAVING COALESCE(issue_run.ended_at, MIN(COALESCE(linked_run.completed_at, linked_run.ended_at))) IS NOT NULL
          AND COALESCE(issue_run.ended_at, MIN(COALESCE(linked_run.completed_at, linked_run.ended_at))) < ?
          AND (
            (issue_run.ended_at IS NOT NULL AND issue_run.status IN ('succeeded', 'failed', 'cancelled'))
            OR SUM(CASE WHEN linked_run.terminal_status IS NOT NULL THEN 1 ELSE 0 END) > 0
          )
         ORDER BY completed_at ASC, issue_run.issue_run_id ASC`
      )
      .all(cutoff) as Array<{
      issue_run_id: string;
      issue_id: string;
      issue_identifier: string;
      project_key: string | null;
      ticket_key: string | null;
      started_at: string;
      ended_at: string;
      completed_at: string;
      status: ExecutionGraphEntityStatus;
      pruned_record_count: number;
    }>;
    return rows;
  }

  private recordRetentionPrune(params: {
    source_table: 'runs' | 'issue_run';
    source_id: string;
    issue_id: string;
    issue_identifier: string;
    project_key: string | null;
    ticket_key: string | null;
    started_at: string;
    completed_at: string;
    cutoff_at: string;
    pruned_at: string;
    pruned_record_count: number;
    metadata: Record<string, unknown>;
  }): void {
    if (!this.hasTable('history_retention_prune_record')) {
      return;
    }
    const pruneRecordId = asExecutionGraphId('retention_prune', [
      params.source_table,
      params.source_id,
      params.cutoff_at,
      params.pruned_at
    ]);
    this.db
      .prepare(
        `INSERT INTO history_retention_prune_record
          (prune_record_id, source_table, source_id, issue_id, issue_identifier, project_key, ticket_key,
           started_at, completed_at, pruned_at, retention_days, cutoff_at, pruned_record_count, reason_code, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        pruneRecordId,
        params.source_table,
        params.source_id,
        params.issue_id,
        params.issue_identifier,
        params.project_key,
        params.ticket_key,
        params.started_at,
        params.completed_at,
        params.pruned_at,
        this.retentionDays,
        params.cutoff_at,
        params.pruned_record_count,
        'retention_policy_expired_completed_history',
        JSON.stringify(redactUnknown(params.metadata))
      );
  }

  private deleteIssueRunHistory(issueRunId: string): void {
    this.db.prepare('DELETE FROM history_app_server_event WHERE issue_run_id = ?').run(issueRunId);
    this.db.prepare('DELETE FROM history_protocol_summary WHERE issue_run_id = ?').run(issueRunId);
    this.db.prepare('DELETE FROM history_token_model_fact WHERE issue_run_id = ?').run(issueRunId);
    this.db.prepare('DELETE FROM history_ticket_evidence_reference WHERE issue_run_id = ?').run(issueRunId);
    this.db.prepare('DELETE FROM history_ticket_blocker WHERE issue_run_id = ?').run(issueRunId);
    this.db.prepare('DELETE FROM history_ticket_terminal_outcome WHERE issue_run_id = ?').run(issueRunId);
    this.db.prepare('DELETE FROM state_transition WHERE issue_run_id = ?').run(issueRunId);
    this.db
      .prepare(
        `DELETE FROM tool_span
         WHERE turn_id IN (
          SELECT turn.turn_id FROM turn
          JOIN thread ON thread.thread_id = turn.thread_id
          JOIN attempt ON attempt.attempt_id = thread.attempt_id
          WHERE attempt.issue_run_id = ?
         )`
      )
      .run(issueRunId);
    this.db
      .prepare(
        `DELETE FROM phase_span
         WHERE turn_id IN (
          SELECT turn.turn_id FROM turn
          JOIN thread ON thread.thread_id = turn.thread_id
          JOIN attempt ON attempt.attempt_id = thread.attempt_id
          WHERE attempt.issue_run_id = ?
         )`
      )
      .run(issueRunId);
    this.db
      .prepare(
        `DELETE FROM turn
         WHERE thread_id IN (
          SELECT thread.thread_id FROM thread
          JOIN attempt ON attempt.attempt_id = thread.attempt_id
          WHERE attempt.issue_run_id = ?
         )`
      )
      .run(issueRunId);
    this.db
      .prepare('DELETE FROM thread WHERE attempt_id IN (SELECT attempt_id FROM attempt WHERE issue_run_id = ?)')
      .run(issueRunId);
    this.db.prepare('DELETE FROM attempt WHERE issue_run_id = ?').run(issueRunId);
    this.db.prepare('DELETE FROM issue_run WHERE issue_run_id = ?').run(issueRunId);
  }

  private recordPruneFailure(error: unknown): void {
    const failedAt = asIso(this.nowMs());
    const detail = error instanceof Error ? error.message : String(error);
    const redactedDetail = redactUnknown(detail) as string;
    const entries: Array<[string, string]> = [
      ['last_prune_failure_at', failedAt],
      ['last_prune_failure_reason', 'retention_prune_failed'],
      ['last_prune_failure_detail', redactedDetail]
    ];
    const upsert = this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [key, value] of entries) {
      upsert.run(key, value);
    }
    try {
      this.recordHistoryHealthMetadata('degraded', 'retention_prune_failed', redactedDetail);
    } catch {
      // Keep meta-level failure evidence even if history health tables are unavailable.
    }
  }

  private updateHistoryRetentionMetadata(): void {
    if (this.readHistorySchemaHealth().status !== 'healthy') {
      return;
    }
    this.db
      .prepare(
        `INSERT INTO history_retention_metadata
          (singleton_id, retention_days, last_pruned_at, policy_version, updated_at)
         VALUES (1, ?, (SELECT value FROM meta WHERE key = 'last_pruned_at'), 1, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET
          retention_days = excluded.retention_days,
          last_pruned_at = excluded.last_pruned_at,
          policy_version = excluded.policy_version,
          updated_at = excluded.updated_at`
      )
      .run(this.retentionDays, asIso(this.nowMs()));
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN;');
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Preserve the original write error for callers.
      }
      throw error;
    }
  }
}
