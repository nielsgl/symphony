import { redactUnknown } from '../security/redaction';
import { buildProjectIdentity } from './identity';
import type { PersistenceDatabase } from './store-context';
import type { DurableIdentity, HistoryIdentityProjectionRecord, ProjectIdentity } from './types';

export interface IdentityProjectionStoreDependencies {
  db: PersistenceDatabase;
  nowMs: () => number;
  isHistorySchemaHealthy: () => boolean;
  recordHistoryHealthMetadata: (status: 'healthy' | 'degraded', reasonCode: string | null, detail: string | null) => void;
}

function asIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function hasTable(db: PersistenceDatabase, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as { name: string } | undefined;
  return Boolean(row);
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

export function parseDurableIdentity(value: string | null): DurableIdentity | null {
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

export function serializeDurableIdentity(identity: DurableIdentity): string {
  return JSON.stringify(redactUnknown(identity));
}

function normalizeProjectIdentityKey(identity: DurableIdentity): DurableIdentity {
  return {
    ...identity,
    project: buildProjectIdentity({
      projectRoot: identity.project.project_root,
      workflowPath: identity.project.workflow_path,
      workflowHash: identity.project.workflow_hash,
      repositoryRemote: identity.project.repository_remote
    })
  };
}

export class IdentityProjectionStore {
  private readonly db: PersistenceDatabase;
  private readonly nowMs: () => number;
  private readonly isHistorySchemaHealthy: () => boolean;
  private readonly recordHistoryHealthMetadata: IdentityProjectionStoreDependencies['recordHistoryHealthMetadata'];

  constructor(dependencies: IdentityProjectionStoreDependencies) {
    this.db = dependencies.db;
    this.nowMs = dependencies.nowMs;
    this.isHistorySchemaHealthy = dependencies.isHistorySchemaHealthy;
    this.recordHistoryHealthMetadata = dependencies.recordHistoryHealthMetadata;
  }

  createHistoryIdentityProjectionTable(): void {
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

  backfillExistingHistoryIdentities(): void {
    this.backfillRunHistoryIdentities();
    this.backfillIssueRunHistoryIdentities();
    this.recordHistoryHealthMetadata('healthy', null, null);
  }

  normalizeExistingProjectIdentityKeys(): void {
    this.normalizeRunProjectIdentityKeys();
    this.normalizeIssueRunProjectIdentityKeys();
    this.collapseStaleProjectIdentityRows();
    this.recordHistoryHealthMetadata('healthy', null, null);
  }

  ensureProjectScopedTicketIdentityTable(): void {
    const scopedPrimaryKey = (): boolean => {
      if (!hasTable(this.db, 'history_ticket_identity')) {
        return false;
      }
      const primaryKeyColumns = (this.db.prepare('PRAGMA table_info(history_ticket_identity)').all() as Array<{ name: string; pk: number }>)
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name);
      return primaryKeyColumns.join(',') === 'project_key,ticket_key';
    };

    if (!scopedPrimaryKey()) {
      this.db.exec(`
        ALTER TABLE history_ticket_identity RENAME TO history_ticket_identity_legacy_global;
        CREATE TABLE history_ticket_identity (
          project_key TEXT NOT NULL,
          ticket_key TEXT NOT NULL,
          tracker_kind TEXT NOT NULL,
          tracker_scope_status TEXT NOT NULL,
          tracker_scope_value TEXT,
          tracker_scope_reason TEXT,
          remote_issue_id TEXT NOT NULL,
          human_issue_identifier TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (project_key, ticket_key),
          FOREIGN KEY (project_key) REFERENCES history_project_identity(project_key) ON DELETE RESTRICT
        );
        INSERT OR REPLACE INTO history_ticket_identity
          (project_key, ticket_key, tracker_kind, tracker_scope_status, tracker_scope_value, tracker_scope_reason,
           remote_issue_id, human_issue_identifier, created_at, updated_at)
        SELECT project_key, ticket_key, tracker_kind, tracker_scope_status, tracker_scope_value, tracker_scope_reason,
          remote_issue_id, human_issue_identifier, created_at, updated_at
        FROM history_ticket_identity_legacy_global;
        DROP TABLE history_ticket_identity_legacy_global;
      `);
    }

    this.backfillTicketIdentitiesFromDurableSnapshots();
    this.recordHistoryHealthMetadata('healthy', null, null);
  }

  ensureIssueRunIdentityColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(issue_run)').all() as Array<{ name: string }>;
    const existing = new Set(columns.map((column) => column.name));
    if (!existing.has('identity')) {
      this.db.exec('ALTER TABLE issue_run ADD COLUMN identity TEXT;');
    }
  }

  ensureIssueRunIdentityKeyColumns(): void {
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

  upsertProjectIdentity(project: ProjectIdentity, options: { bypassHealthCheck?: boolean } = {}): void {
    if (!options.bypassHealthCheck && !this.isHistorySchemaHealthy()) {
      return;
    }
    const now = asIso(this.nowMs());
    const workflowHash = project.workflow_hash;
    const repositoryRemote = project.repository_remote;
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
        project.key,
        project.project_root,
        project.workflow_path,
        workflowHash.status,
        workflowHash.status === 'present' ? workflowHash.value : null,
        workflowHash.status === 'missing' ? workflowHash.reason : null,
        repositoryRemote.status,
        repositoryRemote.status === 'present' ? repositoryRemote.value : null,
        repositoryRemote.status === 'missing' ? repositoryRemote.reason : null,
        now,
        now
      );
  }

  upsertHistoryIdentity(identity: DurableIdentity, options: { bypassHealthCheck?: boolean } = {}): void {
    this.upsertProjectIdentity(identity.project, options);
    if (!options.bypassHealthCheck && !this.isHistorySchemaHealthy()) {
      return;
    }
    const now = asIso(this.nowMs());
    const trackerScope = identity.ticket.tracker_scope;
    this.db
      .prepare(
        `INSERT INTO history_ticket_identity
          (project_key, ticket_key, tracker_kind, tracker_scope_status, tracker_scope_value, tracker_scope_reason,
           remote_issue_id, human_issue_identifier, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_key, ticket_key) DO UPDATE SET
          tracker_kind = excluded.tracker_kind,
          tracker_scope_status = excluded.tracker_scope_status,
          tracker_scope_value = excluded.tracker_scope_value,
          tracker_scope_reason = excluded.tracker_scope_reason,
          remote_issue_id = excluded.remote_issue_id,
          human_issue_identifier = excluded.human_issue_identifier,
          updated_at = excluded.updated_at`
      )
      .run(
        identity.project.key,
        identity.ticket.key,
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

  recordIdentityProjection(record: Omit<HistoryIdentityProjectionRecord, 'updated_at'>): void {
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

  readHistoryIdentityProjection(statement: { get(...args: unknown[]): unknown } | null, sourceId: string): HistoryIdentityProjectionRecord | null {
    if (!statement) {
      return null;
    }
    return (statement.get(sourceId) as HistoryIdentityProjectionRecord | undefined) ?? null;
  }

  readIssueRunIdentity(issueRunId: string | null): DurableIdentity | null {
    if (!issueRunId) {
      return null;
    }
    const row = this.db.prepare('SELECT identity FROM issue_run WHERE issue_run_id = ?').get(issueRunId) as
      | { identity: string | null }
      | undefined;
    return parseDurableIdentity(row?.identity ?? null);
  }

  lookupIssueRunIdForRun(runId: string): string | null {
    const projection = this.db
      .prepare(
        `SELECT issue_run_id
         FROM history_identity_projection
         WHERE source_table = 'runs'
          AND source_id = ?
          AND issue_run_id IS NOT NULL
         LIMIT 1`
      )
      .get(runId) as { issue_run_id: string | null } | undefined;
    return projection?.issue_run_id ?? null;
  }

  private collapseStaleProjectIdentityRows(): void {
    const rows = this.db
      .prepare(
        `SELECT project_key, project_root, workflow_path, workflow_hash_status, workflow_hash_value, workflow_hash_reason,
                repository_remote_status, repository_remote_value, repository_remote_reason, created_at, updated_at
         FROM history_project_identity
         ORDER BY updated_at ASC, project_key ASC`
      )
      .all() as Array<{
      project_key: string;
      project_root: string;
      workflow_path: string;
      workflow_hash_status: 'present' | 'missing';
      workflow_hash_value: string | null;
      workflow_hash_reason: string | null;
      repository_remote_status: 'present' | 'missing';
      repository_remote_value: string | null;
      repository_remote_reason: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const upsertNormalizedProject = this.db.prepare(
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
    );
    const deleteProject = this.db.prepare('DELETE FROM history_project_identity WHERE project_key = ?');

    for (const row of rows) {
      const normalizedProject = buildProjectIdentity({
        projectRoot: row.project_root,
        workflowPath: row.workflow_path,
        workflowHash:
          row.workflow_hash_status === 'present'
            ? { status: 'present', value: row.workflow_hash_value ?? '' }
            : { status: 'missing', reason: row.workflow_hash_reason ?? 'workflow_file_unreadable' },
        repositoryRemote:
          row.repository_remote_status === 'present'
            ? { status: 'present', value: row.repository_remote_value ?? '' }
            : { status: 'missing', reason: row.repository_remote_reason ?? 'repository_remote_unavailable' }
      });
      const normalizedProjectKey = normalizedProject.key;
      upsertNormalizedProject.run(
        normalizedProjectKey,
        row.project_root,
        row.workflow_path,
        row.workflow_hash_status,
        row.workflow_hash_status === 'present' ? row.workflow_hash_value : null,
        row.workflow_hash_status === 'missing' ? row.workflow_hash_reason : null,
        row.repository_remote_status,
        row.repository_remote_status === 'present' ? row.repository_remote_value : null,
        row.repository_remote_status === 'missing' ? row.repository_remote_reason : null,
        row.created_at,
        row.updated_at
      );
      if (row.project_key === normalizedProjectKey) {
        continue;
      }
      this.rewriteProjectIdentityReferences(row.project_key, normalizedProjectKey);
      deleteProject.run(row.project_key);
    }
  }

  private rewriteProjectIdentityReferences(oldProjectKey: string, normalizedProjectKey: string): void {
    const projectKeyTables = [
      'history_ticket_identity',
      'issue_run',
      'history_identity_projection',
      'history_tracker_ticket_snapshot',
      'history_ticket_reference',
      'history_operator_action',
      'history_drain_audit_event',
      'history_blocked_input_event',
      'history_retention_prune_record'
    ];
    for (const table of projectKeyTables) {
      if (!hasTable(this.db, table)) {
        continue;
      }
      this.db.prepare(`UPDATE ${table} SET project_key = ? WHERE project_key = ?`).run(normalizedProjectKey, oldProjectKey);
    }
  }

  private backfillTicketIdentitiesFromDurableSnapshots(): void {
    const rows = [
      ...(this.db.prepare('SELECT identity FROM runs WHERE identity IS NOT NULL ORDER BY started_at ASC, run_id ASC').all() as Array<{
        identity: string | null;
      }>),
      ...(this.db
        .prepare('SELECT identity FROM issue_run WHERE identity IS NOT NULL ORDER BY started_at ASC, issue_run_id ASC')
        .all() as Array<{ identity: string | null }>)
    ];
    for (const row of rows) {
      const identity = parseDurableIdentity(row.identity);
      if (identity) {
        this.upsertHistoryIdentity(identity, { bypassHealthCheck: true });
      }
    }
  }

  private normalizeRunProjectIdentityKeys(): void {
    const rows = this.db
      .prepare('SELECT run_id, issue_id, issue_identifier, identity FROM runs WHERE identity IS NOT NULL ORDER BY started_at ASC, run_id ASC')
      .all() as Array<{ run_id: string; issue_id: string; issue_identifier: string; identity: string | null }>;
    const updateIdentity = this.db.prepare('UPDATE runs SET identity = ? WHERE run_id = ?');
    for (const row of rows) {
      const identity = parseDurableIdentity(row.identity);
      if (!identity) {
        continue;
      }
      const normalizedIdentity = normalizeProjectIdentityKey(identity);
      this.upsertHistoryIdentity(normalizedIdentity, { bypassHealthCheck: true });
      updateIdentity.run(serializeDurableIdentity(normalizedIdentity), row.run_id);
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
        project_key: normalizedIdentity.project.key,
        ticket_key: normalizedIdentity.ticket.key
      });
    }
  }

  private normalizeIssueRunProjectIdentityKeys(): void {
    const rows = this.db
      .prepare('SELECT issue_run_id, issue_id, issue_identifier, identity FROM issue_run WHERE identity IS NOT NULL ORDER BY started_at ASC, issue_run_id ASC')
      .all() as Array<{ issue_run_id: string; issue_id: string; issue_identifier: string; identity: string | null }>;
    const updateIdentity = this.db.prepare('UPDATE issue_run SET identity = ?, project_key = ?, ticket_key = ? WHERE issue_run_id = ?');
    const projectKeyFacts = [
      'history_tracker_ticket_snapshot',
      'history_ticket_reference',
      'history_operator_action',
      'history_drain_audit_event',
      'history_blocked_input_event'
    ];
    const factUpdates = projectKeyFacts
      .filter((table) => hasTable(this.db, table))
      .map((table) => this.db.prepare(`UPDATE ${table} SET project_key = ?, ticket_key = ? WHERE issue_run_id = ?`));

    for (const row of rows) {
      const identity = parseDurableIdentity(row.identity);
      if (!identity) {
        continue;
      }
      const normalizedIdentity = normalizeProjectIdentityKey(identity);
      this.upsertHistoryIdentity(normalizedIdentity, { bypassHealthCheck: true });
      updateIdentity.run(
        serializeDurableIdentity(normalizedIdentity),
        normalizedIdentity.project.key,
        normalizedIdentity.ticket.key,
        row.issue_run_id
      );
      for (const updateFact of factUpdates) {
        updateFact.run(normalizedIdentity.project.key, normalizedIdentity.ticket.key, row.issue_run_id);
      }
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
        project_key: normalizedIdentity.project.key,
        ticket_key: normalizedIdentity.ticket.key
      });
    }
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
}
