import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { redactUnknown } from '../security/redaction';
import type {
  BreakerMetadataRecord,
  DurableRunHistoryRecord,
  PersistedBlockedInputRecord,
  PersistenceHealth,
  RunTerminalStatus,
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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        issue_identifier TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        terminal_status TEXT,
        error_code TEXT
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
    `);
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

  completeRun(params: { run_id: string; terminal_status: RunTerminalStatus; error_code?: string | null }): void {
    const redactedError = redactUnknown(params.error_code ?? null) as string | null;
    this.db
      .prepare('UPDATE runs SET ended_at = ?, terminal_status = ?, error_code = ? WHERE run_id = ?')
      .run(asIso(this.nowMs()), params.terminal_status, redactedError, params.run_id);
  }

  listRunHistory(limit = 50): DurableRunHistoryRecord[] {
    const rows = this.db
      .prepare(
        'SELECT run_id, issue_id, issue_identifier, started_at, ended_at, terminal_status, error_code FROM runs ORDER BY started_at DESC LIMIT ?'
      )
      .all(limit) as Array<{
      run_id: string;
      issue_id: string;
      issue_identifier: string;
      started_at: string;
      ended_at: string | null;
      terminal_status: RunTerminalStatus | null;
      error_code: string | null;
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
        terminal_status: row.terminal_status,
        error_code: row.error_code,
        session_ids: sessions.map((entry) => entry.session_id)
      };

      return redactUnknown(record) as DurableRunHistoryRecord;
    });
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
