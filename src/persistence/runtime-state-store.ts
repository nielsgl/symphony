import { redactUnknown } from '../security/redaction';
import type { PersistenceDatabase } from './store-context';
import type {
  BreakerMetadataRecord,
  PersistedBlockedInputRecord,
  PersistedOperatorActionsRecord,
  UiContinuityState
} from './types';

export interface RuntimeStateStoreDependencies {
  db: PersistenceDatabase;
  nowMs: () => number;
}

function asIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

export class RuntimeStateStore {
  private readonly db: PersistenceDatabase;
  private readonly nowMs: () => number;

  constructor(dependencies: RuntimeStateStoreDependencies) {
    this.db = dependencies.db;
    this.nowMs = dependencies.nowMs;
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
}
