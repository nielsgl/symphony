import { createHash } from 'node:crypto';

import { buildHistoryPayloadDetails } from './history-payload-policy';
import type { PersistenceDatabase } from './store-context';
import type { AppServerEventLedgerRecord, HistoryPayloadClass } from './types';

export interface AppServerLedgerStoreDependencies {
  db: PersistenceDatabase;
  nowMs: () => number;
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

export class AppServerLedgerStore {
  private readonly db: PersistenceDatabase;
  private readonly nowMs: () => number;

  constructor(dependencies: AppServerLedgerStoreDependencies) {
    this.db = dependencies.db;
    this.nowMs = dependencies.nowMs;
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
}
