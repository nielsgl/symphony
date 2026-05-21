import { redactUnknown } from '../security/redaction';
import { AppServerLedgerStore } from './app-server-ledger-store';
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
import { IdentityProjectionStore, parseDurableIdentity } from './identity-projection-store';
import { ProjectHistoryReader } from './project-history-reader';
import { RetentionHealthStore } from './retention-health-store';
import { RuntimeStateStore } from './runtime-state-store';
import { RunHistoryStore, type RunHistoryIdentityProjection } from './run-history-store';
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
  private readonly runtimeStateStore: RuntimeStateStore;
  private readonly appServerLedgerStore: AppServerLedgerStore;
  private readonly retentionHealthStore: RetentionHealthStore;
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
    const runHistoryIdentityProjection: RunHistoryIdentityProjection = {
      upsertHistoryIdentity: (identity) => this.identityProjectionStore.upsertHistoryIdentity(identity),
      recordIdentityProjection: (record) => this.identityProjectionStore.recordIdentityProjection(record),
      lookupIssueRunIdForRun: (runId) => this.identityProjectionStore.lookupIssueRunIdForRun(runId),
      readHistoryIdentityProjection: (statement, sourceId) =>
        this.identityProjectionStore.readHistoryIdentityProjection(statement, sourceId)
    };
    this.runHistoryStore = new RunHistoryStore({
      db: this.db,
      nowMs: this.nowMs,
      transaction: (fn) => this.transaction(fn),
      identityProjection: runHistoryIdentityProjection,
      executionGraphWriter: this.executionGraphWriter
    });
    this.runtimeStateStore = new RuntimeStateStore({
      db: this.db,
      nowMs: this.nowMs
    });
    this.appServerLedgerStore = new AppServerLedgerStore({
      db: this.db,
      nowMs: this.nowMs
    });
    this.retentionHealthStore = new RetentionHealthStore({
      db: this.db,
      dbPath: this.dbPath,
      retentionDays: this.retentionDays,
      nowMs: this.nowMs,
      transaction: (fn) => this.transaction(fn),
      readHistorySchemaHealth: () => this.readHistorySchemaHealth(),
      recordHistoryHealthMetadata: (status, reasonCode, detail) => this.recordHistoryHealthMetadata(status, reasonCode, detail),
      listHistoryWriteFailures: (limit) => this.listHistoryWriteFailures(limit),
      pruneFailureForTest: this.pruneFailureForTest
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
    return this.appServerLedgerStore.appendAppServerEvent(params);
  }

  listAppServerEventLedger(issueRunId: string): AppServerEventLedgerRecord[] {
    return this.appServerLedgerStore.listAppServerEventLedger(issueRunId);
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
    this.runtimeStateStore.saveUiState(state);
  }

  loadUiState(): UiContinuityState | null {
    return this.runtimeStateStore.loadUiState();
  }

  upsertBreaker(record: BreakerMetadataRecord): void {
    this.runtimeStateStore.upsertBreaker(record);
  }

  deleteBreaker(issueId: string): void {
    this.runtimeStateStore.deleteBreaker(issueId);
  }

  listBreakers(): BreakerMetadataRecord[] {
    return this.runtimeStateStore.listBreakers();
  }

  upsertBlockedInput(issueId: string, payload: string): void {
    this.runtimeStateStore.upsertBlockedInput(issueId, payload);
  }

  deleteBlockedInput(issueId: string): void {
    this.runtimeStateStore.deleteBlockedInput(issueId);
  }

  listBlockedInputs(): PersistedBlockedInputRecord[] {
    return this.runtimeStateStore.listBlockedInputs();
  }

  upsertOperatorActions(issueId: string, payload: string): void {
    this.runtimeStateStore.upsertOperatorActions(issueId, payload);
  }

  listOperatorActions(): PersistedOperatorActionsRecord[] {
    return this.runtimeStateStore.listOperatorActions();
  }

  pruneExpiredRuns(): number {
    return this.retentionHealthStore.pruneExpiredRuns();
  }

  health(): PersistenceHealth {
    return this.retentionHealthStore.health();
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
