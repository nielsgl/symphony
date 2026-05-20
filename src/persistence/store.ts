import { createHash } from 'node:crypto';

import { redactUnknown } from '../security/redaction';
import {
  ExecutionGraphWriter,
  type AppendAttemptParams,
  type AppendBlockedInputEventParams,
  type AppendIssueRunParams,
  type AppendOperatorActionHistoryParams,
  type AppendPhaseSpanParams,
  type AppendStateTransitionParams,
  type AppendThreadParams,
  type AppendTicketBlockerParams,
  type AppendTicketEvidenceReferenceParams,
  type AppendTicketReferenceParams,
  type AppendTicketTerminalOutcomeParams,
  type AppendTokenModelFactParams,
  type AppendToolSpanParams,
  type AppendTrackerTicketSnapshotParams,
  type AppendTurnParams
} from './execution-graph-writer';
import { buildHistoryPayloadDetails } from './history-payload-policy';
import { IdentityProjectionStore, parseDurableIdentity } from './identity-projection-store';
import { ProjectHistoryReader } from './project-history-reader';
import { RunHistoryStore } from './run-history-store';
import {
  createBasePersistenceSchema,
  createHistoryRetentionPruneRecordTable,
  createProjectExecutionHistoryTables,
  ensureHistoryMigrationTables,
  ensureHistoryWriteFailureTable
} from './schema';
import { createPersistenceStoreContext, type PersistenceDatabase, type PersistenceStoreContext } from './store-context';
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
  HistoryWriteFailureRecord,
  IssueRunRecord,
  PhaseSpanRecord,
  PersistedBlockedInputRecord,
  PersistedOperatorActionsRecord,
  PersistenceHealth,
  ProjectHistoryTicketSummaryPage,
  RunTerminalStatus,
  StateTransitionRecord,
  TicketBlockerRecord,
  TicketTerminalOutcomeRecord,
  TicketTimelineRecord,
  ThreadRecord,
  TokenModelFactRecord,
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
const HISTORY_SCHEMA_VERSION = 9;

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

function parseHistoryPayloadTruncation(value: string): AppServerEventLedgerRecord['truncation'] {
  const parsed = JSON.parse(value) as AppServerEventLedgerRecord['truncation'];
  return {
    truncated: Boolean(parsed.truncated),
    original_bytes: Number(parsed.original_bytes),
    excerpt_bytes: Number(parsed.excerpt_bytes),
    max_excerpt_bytes: Number(parsed.max_excerpt_bytes)
  };
}

function ensureMonotonicTimestamp(next: string, previous: string | null | undefined, label: string): void {
  if (previous && next < previous) {
    throw new Error(`${label} timestamp must be monotonic`);
  }
}

export class SqlitePersistenceStore {
  private readonly context: PersistenceStoreContext;
  private readonly dbPath: string;
  private readonly retentionDays: number;
  private readonly nowMs: () => number;
  private readonly migrationFailureForTest: string | undefined;
  private readonly pruneFailureForTest: string | undefined;
  private readonly executionGraphWriter: ExecutionGraphWriter;
  private readonly identityProjectionStore: IdentityProjectionStore;
  private readonly runHistoryStore: RunHistoryStore;
  private readonly projectHistoryReader: ProjectHistoryReader;
  private transactionDepth = 0;
  private readonly db: PersistenceDatabase;

  constructor(options: PersistenceStoreOptions) {
    this.context = createPersistenceStoreContext({
      dbPath: options.dbPath,
      retentionDays: options.retentionDays,
      nowMs: options.nowMs ?? (() => Date.now())
    });
    this.dbPath = this.context.dbPath;
    this.retentionDays = this.context.retentionDays;
    this.nowMs = this.context.nowMs;
    this.migrationFailureForTest = options.migrationFailureForTest;
    this.pruneFailureForTest = options.pruneFailureForTest;

    this.db = this.context.db;
    this.identityProjectionStore = new IdentityProjectionStore({
      db: this.db,
      nowMs: this.nowMs,
      isHistorySchemaHealthy: () => this.readHistorySchemaHealth().status === 'healthy',
      recordHistoryHealthMetadata: (status, reasonCode, detail) => this.recordHistoryHealthMetadata(status, reasonCode, detail)
    });
    this.executionGraphWriter = new ExecutionGraphWriter({
      db: this.db,
      transaction: (fn) => this.transaction(fn),
      upsertHistoryIdentity: (identity) => this.identityProjectionStore.upsertHistoryIdentity(identity),
      recordIdentityProjection: (record) => this.identityProjectionStore.recordIdentityProjection(record),
      readIssueRunIdentity: (issueRunId) => this.identityProjectionStore.readIssueRunIdentity(issueRunId)
    });
    this.runHistoryStore = new RunHistoryStore({
      db: this.db,
      nowMs: this.nowMs,
      transaction: (fn) => this.transaction(fn),
      identityProjectionStore: this.identityProjectionStore,
      executionGraphWriter: this.executionGraphWriter
    });
    this.projectHistoryReader = new ProjectHistoryReader({
      db: this.db
    });
    createBasePersistenceSchema(this.db);
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
    return this.runHistoryStore.startRun(params);
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
    return this.runHistoryStore.recordRunStarted(params);
  }

  recordSession(runId: string, sessionId: string): void {
    this.runHistoryStore.recordSession(runId, sessionId);
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
    this.runHistoryStore.recordEvent(params);
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

  appendIssueRun(params: AppendIssueRunParams): string {
    return this.executionGraphWriter.appendIssueRun(params);
  }

  appendAttempt(params: AppendAttemptParams): string {
    return this.executionGraphWriter.appendAttempt(params);
  }

  appendThread(params: AppendThreadParams): string {
    return this.executionGraphWriter.appendThread(params);
  }

  appendTurn(params: AppendTurnParams): string {
    return this.executionGraphWriter.appendTurn(params);
  }

  appendPhaseSpan(params: AppendPhaseSpanParams): string {
    return this.executionGraphWriter.appendPhaseSpan(params);
  }

  appendToolSpan(params: AppendToolSpanParams): string {
    return this.executionGraphWriter.appendToolSpan(params);
  }

  appendStateTransition(params: AppendStateTransitionParams): string {
    return this.executionGraphWriter.appendStateTransition(params);
  }

  appendTicketTerminalOutcome(params: AppendTicketTerminalOutcomeParams): string {
    return this.executionGraphWriter.appendTicketTerminalOutcome(params);
  }

  appendTicketBlocker(params: AppendTicketBlockerParams): string {
    return this.executionGraphWriter.appendTicketBlocker(params);
  }

  appendTicketEvidenceReference(params: AppendTicketEvidenceReferenceParams): string {
    return this.executionGraphWriter.appendTicketEvidenceReference(params);
  }

  appendTrackerTicketSnapshot(params: AppendTrackerTicketSnapshotParams): string {
    return this.executionGraphWriter.appendTrackerTicketSnapshot(params);
  }

  appendTicketReference(params: AppendTicketReferenceParams): string {
    return this.executionGraphWriter.appendTicketReference(params);
  }

  appendOperatorActionHistory(params: AppendOperatorActionHistoryParams): string {
    return this.executionGraphWriter.appendOperatorActionHistory(params);
  }

  appendBlockedInputEvent(params: AppendBlockedInputEventParams): string {
    return this.executionGraphWriter.appendBlockedInputEvent(params);
  }

  appendTokenModelFact(params: AppendTokenModelFactParams): string {
    return this.executionGraphWriter.appendTokenModelFact(params);
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
    const tokenModelFacts = this.db
      .prepare(
        `SELECT * FROM history_token_model_fact
         WHERE issue_run_id = ?
         ORDER BY observed_at ASC, token_model_fact_id ASC`
      )
      .all(issueRun.issue_run_id) as TokenModelFactRecord[];

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
        state_transitions: transitions.filter((transition) => transition.turn_id === turn.turn_id),
        token_model_facts: tokenModelFacts.filter((fact) => fact.turn_id === turn.turn_id)
      })),
      state_transitions: transitions,
      token_model_facts: tokenModelFacts
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

  listProjectTicketIdentities(
    projectKey: string,
    options: { limit?: number; offset?: number } = {}
  ): { items: DurableIdentity[]; limit: number; offset: number; has_more: boolean; total: number } {
    return this.projectHistoryReader.listProjectTicketIdentities(projectKey, options);
  }

  listProjectTicketSummaries(
    projectKey: string,
    options: { limit?: number; offset?: number } = {}
  ): ProjectHistoryTicketSummaryPage {
    return this.projectHistoryReader.listProjectTicketSummaries(projectKey, options);
  }

  getProjectTicketIdentity(projectKey: string, ticketKey: string): DurableIdentity | null {
    return this.projectHistoryReader.getProjectTicketIdentity(projectKey, ticketKey);
  }

  reconstructTicketTimeline(identity: DurableIdentity): TicketTimelineRecord {
    return this.projectHistoryReader.reconstructTicketTimeline(identity);
  }

  completeRun(params: {
    run_id: string;
    issue_run_id?: string | null;
    attempt_id?: string | null;
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
    this.runHistoryStore.completeRun(params);
  }

  listRunHistory(limit = 50): DurableRunHistoryRecord[] {
    return this.runHistoryStore.listRunHistory(limit);
  }

  private runHistorySchemaMigrations(): void {
    ensureHistoryMigrationTables(this.db);

    const migrations: HistoryMigration[] = [
      {
        version: 1,
        name: 'project_execution_history_v1',
        apply: (store) => {
          store.ensureRunDiagnosticColumns();
          store.identityProjectionStore.ensureIssueRunIdentityColumn();
          store.ensureRunEventDiagnosticColumns();
          createProjectExecutionHistoryTables(store.context);
        }
      },
      {
        version: 2,
        name: 'ticket_orchestration_ledger_v1',
        apply: (store) => {
          store.identityProjectionStore.ensureIssueRunIdentityKeyColumns();
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
          store.identityProjectionStore.createHistoryIdentityProjectionTable();
          store.identityProjectionStore.backfillExistingHistoryIdentities();
        }
      },
      {
        version: 5,
        name: 'token_model_fact_dimensions_v1',
        apply: (store) => {
          store.ensureTokenModelFactColumns();
        }
      },
      {
        version: 6,
        name: 'operational_history_facts_v1',
        apply: (store) => {
          store.createOperationalHistoryFactTables();
        }
      },
      {
        version: 7,
        name: 'history_retention_prune_evidence_v1',
        apply: (store) => {
          createHistoryRetentionPruneRecordTable(store.db);
        }
      },
      {
        version: 8,
        name: 'stable_project_identity_key_v1',
        apply: (store) => {
          store.identityProjectionStore.normalizeExistingProjectIdentityKeys();
        }
      },
      {
        version: 9,
        name: 'project_scoped_ticket_identity_v1',
        apply: (store) => {
          store.identityProjectionStore.ensureProjectScopedTicketIdentityTable();
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

    ensureHistoryWriteFailureTable(this.db);

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
    ensureHistoryWriteFailureTable(this.db);
    this.recordHistoryHealthMetadata('healthy', null, null);
  }

  private createOperationalHistoryFactTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history_tracker_ticket_snapshot (
        tracker_snapshot_id TEXT PRIMARY KEY,
        project_key TEXT,
        ticket_key TEXT,
        issue_run_id TEXT,
        attempt_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        tracker_kind TEXT NOT NULL,
        tracker_scope_status TEXT NOT NULL CHECK (tracker_scope_status IN ('present', 'missing')),
        tracker_scope_value TEXT,
        tracker_scope_reason TEXT,
        remote_issue_id TEXT NOT NULL,
        human_issue_identifier TEXT NOT NULL,
        title TEXT NOT NULL,
        tracker_status TEXT NOT NULL,
        assignee_status TEXT NOT NULL CHECK (assignee_status IN ('available', 'unavailable', 'unknown')),
        assignee_identifier TEXT,
        assignee_reason TEXT,
        labels TEXT NOT NULL,
        project_status TEXT NOT NULL CHECK (project_status IN ('available', 'unavailable', 'unknown')),
        project_identifier TEXT,
        project_reason TEXT,
        team_status TEXT NOT NULL CHECK (team_status IN ('available', 'unavailable', 'unknown')),
        team_identifier TEXT,
        team_reason TEXT,
        observed_at TEXT NOT NULL,
        observation_hash TEXT NOT NULL,
        duplicate_count INTEGER NOT NULL DEFAULT 1,
        last_observed_at TEXT NOT NULL,
        UNIQUE (issue_run_id, observation_hash),
        FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT,
        FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT,
        FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT,
        FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS history_ticket_reference (
        ticket_reference_id TEXT PRIMARY KEY,
        project_key TEXT,
        ticket_key TEXT,
        issue_run_id TEXT,
        attempt_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        reference_kind TEXT NOT NULL CHECK (reference_kind IN ('branch', 'pull_request', 'review', 'merge', 'evidence')),
        availability TEXT NOT NULL CHECK (availability IN ('available', 'unavailable', 'unknown')),
        uri TEXT,
        label TEXT,
        external_id TEXT,
        state TEXT,
        metadata TEXT,
        observed_at TEXT NOT NULL,
        observation_hash TEXT NOT NULL,
        duplicate_count INTEGER NOT NULL DEFAULT 1,
        last_observed_at TEXT NOT NULL,
        UNIQUE (issue_run_id, reference_kind, observation_hash),
        FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT,
        FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT,
        FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT,
        FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS history_operator_action (
        operator_action_id TEXT PRIMARY KEY,
        project_key TEXT,
        ticket_key TEXT,
        issue_run_id TEXT,
        attempt_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        action TEXT NOT NULL,
        actor TEXT,
        result TEXT NOT NULL CHECK (result IN ('accepted', 'rejected', 'failed')),
        result_code TEXT,
        message TEXT,
        reason_note TEXT,
        phase TEXT,
        state_context TEXT,
        requested_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        observation_hash TEXT NOT NULL,
        duplicate_count INTEGER NOT NULL DEFAULT 1,
        last_observed_at TEXT NOT NULL,
        UNIQUE (issue_run_id, action, observation_hash),
        FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT,
        FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT,
        FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT,
        FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS history_blocked_input_event (
        blocked_input_event_id TEXT PRIMARY KEY,
        project_key TEXT,
        ticket_key TEXT,
        issue_run_id TEXT,
        attempt_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        issue_id TEXT NOT NULL,
        issue_identifier TEXT NOT NULL,
        phase TEXT,
        runtime_state TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        reason_detail TEXT,
        request_id TEXT,
        request_method TEXT,
        input_schema_type TEXT,
        prompt_text TEXT,
        pending_input TEXT,
        state_context TEXT,
        blocked_at TEXT NOT NULL,
        observation_hash TEXT NOT NULL,
        duplicate_count INTEGER NOT NULL DEFAULT 1,
        last_observed_at TEXT NOT NULL,
        UNIQUE (issue_run_id, observation_hash),
        FOREIGN KEY (issue_run_id) REFERENCES issue_run(issue_run_id) ON DELETE RESTRICT,
        FOREIGN KEY (attempt_id) REFERENCES attempt(attempt_id) ON DELETE RESTRICT,
        FOREIGN KEY (thread_id) REFERENCES thread(thread_id) ON DELETE RESTRICT,
        FOREIGN KEY (turn_id) REFERENCES turn(turn_id) ON DELETE RESTRICT
      );
    `);
    this.recordHistoryHealthMetadata('healthy', null, null);
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
    ensureHistoryMigrationTables(this.db);
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

  private ensureTokenModelFactColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(history_token_model_fact)').all() as Array<{ name: string }>;
    const existing = new Set(columns.map((column) => column.name));
    const migrations: Array<[string, string]> = [
      ['requested_model', 'ALTER TABLE history_token_model_fact ADD COLUMN requested_model TEXT'],
      ['model_context_window', 'ALTER TABLE history_token_model_fact ADD COLUMN model_context_window INTEGER']
    ];
    for (const [column, sql] of migrations) {
      if (!existing.has(column)) {
        this.db.exec(`${sql};`);
      }
    }
    this.recordHistoryHealthMetadata('healthy', null, null);
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
                'history_tracker_ticket_snapshot',
                'history_ticket_reference',
                'history_operator_action',
                'history_blocked_input_event',
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
    const ticketCountRow = this.hasTable('history_identity_projection')
      ? (this.db
          .prepare(
            `SELECT COUNT(DISTINCT COALESCE(ticket_key, issue_identifier, issue_id)) AS count
             FROM history_identity_projection`
          )
          .get() as { count: number })
      : { count: 0 };
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
      ticket_count: ticketCountRow.count,
      last_pruned_at: pruneRow?.value ?? null,
      last_prune_failure_at: pruneFailureAtRow?.value ?? null,
      last_prune_failure_reason: pruneFailureReasonRow?.value ?? null,
      last_prune_failure_detail: pruneFailureDetailRow?.value ?? null,
      integrity_ok: integrityOk,
      history_schema: historySchema,
      recent_write_failures: this.listHistoryWriteFailures(5)
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
          issue_run.ended_at AS completed_at,
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
            + (SELECT COUNT(*) FROM history_tracker_ticket_snapshot WHERE history_tracker_ticket_snapshot.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM history_ticket_reference WHERE history_ticket_reference.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM history_operator_action WHERE history_operator_action.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM history_blocked_input_event WHERE history_blocked_input_event.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM history_protocol_summary WHERE history_protocol_summary.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM history_token_model_fact WHERE history_token_model_fact.issue_run_id = issue_run.issue_run_id)
            + (SELECT COUNT(*) FROM history_app_server_event WHERE history_app_server_event.issue_run_id = issue_run.issue_run_id)
          ) AS pruned_record_count
         FROM issue_run
         WHERE issue_run.ended_at IS NOT NULL
          AND issue_run.ended_at < ?
          AND issue_run.status IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'stalled')
         ORDER BY issue_run.ended_at ASC, issue_run.issue_run_id ASC`
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
    this.db.prepare('DELETE FROM history_tracker_ticket_snapshot WHERE issue_run_id = ?').run(issueRunId);
    this.db.prepare('DELETE FROM history_ticket_reference WHERE issue_run_id = ?').run(issueRunId);
    this.db.prepare('DELETE FROM history_operator_action WHERE issue_run_id = ?').run(issueRunId);
    this.db.prepare('DELETE FROM history_blocked_input_event WHERE issue_run_id = ?').run(issueRunId);
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
    if (this.transactionDepth > 0) {
      return fn();
    }
    this.db.exec('BEGIN;');
    this.transactionDepth += 1;
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      this.transactionDepth -= 1;
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Preserve the original write error for callers.
      }
      this.transactionDepth -= 1;
      throw error;
    }
  }
}
