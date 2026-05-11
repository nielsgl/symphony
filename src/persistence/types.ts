export type RunTerminalStatus = 'succeeded' | 'failed' | 'timed_out' | 'stalled' | 'cancelled';
export type ExecutionGraphEntityStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'retrying';

export type IdentityEvidence<T extends string = string> =
  | { status: 'present'; value: T }
  | { status: 'missing'; reason: string };

export interface ProjectIdentity {
  key: string;
  project_root: string;
  workflow_path: string;
  workflow_hash: IdentityEvidence;
  repository_remote: IdentityEvidence;
}

export interface TicketIdentity {
  key: string;
  tracker_kind: string;
  tracker_scope: IdentityEvidence;
  remote_issue_id: string;
  human_issue_identifier: string;
}

export interface DurableIdentity {
  project: ProjectIdentity;
  ticket: TicketIdentity;
}

export interface ExecutionGraphReasonFields {
  status: ExecutionGraphEntityStatus;
  reason_code: string | null;
  reason_detail: string | null;
}

export interface ExecutionGraphTimestampFields extends ExecutionGraphReasonFields {
  started_at: string;
  ended_at: string | null;
}

export interface IssueRunRecord extends ExecutionGraphTimestampFields {
  issue_run_id: string;
  issue_id: string;
  issue_identifier: string;
  identity?: DurableIdentity | null;
}

export interface AttemptRecord extends ExecutionGraphTimestampFields {
  attempt_id: string;
  issue_run_id: string;
  attempt_number: number;
}

export interface ThreadRecord extends ExecutionGraphTimestampFields {
  thread_id: string;
  attempt_id: string;
}

export interface TurnRecord extends ExecutionGraphTimestampFields {
  turn_id: string;
  thread_id: string;
  turn_index: number;
}

export interface PhaseSpanRecord extends ExecutionGraphTimestampFields {
  phase_span_id: string;
  turn_id: string;
  phase: string;
}

export interface ToolSpanRecord extends ExecutionGraphTimestampFields {
  tool_span_id: string;
  turn_id: string;
  tool_name: string;
}

export interface StateTransitionRecord extends ExecutionGraphReasonFields {
  state_transition_id: string;
  issue_run_id: string;
  attempt_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  from_status: string | null;
  to_status: string;
  transitioned_at: string;
}

export interface ExecutionGraphThreadLineage {
  issue_run: IssueRunRecord;
  attempt: AttemptRecord;
  thread: ThreadRecord;
  turns: Array<
    TurnRecord & {
      phase_spans: PhaseSpanRecord[];
      tool_spans: ToolSpanRecord[];
      state_transitions: StateTransitionRecord[];
    }
  >;
  state_transitions: StateTransitionRecord[];
}

export interface DurableRunHistoryRecord {
  run_id: string;
  issue_id: string;
  issue_identifier: string;
  identity?: DurableIdentity | null;
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
  session_ids: string[];
  missing_tool_output_recovery?: Record<string, unknown> | null;
}

export interface UiContinuityState {
  selected_issue: string | null;
  filters: {
    status: 'all' | 'running' | 'retrying' | 'blocked';
    query: string;
  };
  event_feed_filter?: 'all' | 'warn' | 'error';
  panels?: {
    throughput_open?: boolean;
    runtime_events_open?: boolean;
  };
  panel_state: {
    issue_detail_open: boolean;
  };
}

export interface PersistenceHealth {
  enabled: boolean;
  db_path: string | null;
  retention_days: number;
  run_count: number;
  last_pruned_at: string | null;
  integrity_ok: boolean;
  history_schema?: HistorySchemaHealth;
}

export type HistorySchemaStatus = 'healthy' | 'degraded';

export interface HistorySchemaMigrationRecord {
  version: number;
  name: string;
  status: 'applied' | 'failed';
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
}

export interface HistorySchemaHealth {
  schema_name: 'project_execution_history';
  target_version: number;
  applied_version: number;
  status: HistorySchemaStatus;
  degraded_reason_code: string | null;
  degraded_detail: string | null;
  updated_at: string;
  migrations: HistorySchemaMigrationRecord[];
}

export interface BreakerMetadataRecord {
  issue_id: string;
  issue_identifier: string;
  breaker_active: boolean;
  breaker_hit_count: number;
  breaker_window_minutes: number;
  breaker_first_hit_at: string | null;
  breaker_last_hit_at: string | null;
}

export interface PersistedBlockedInputRecord {
  issue_id: string;
  payload: string;
  updated_at: string;
}

export interface PersistedOperatorActionsRecord {
  issue_id: string;
  payload: string;
  updated_at: string;
}
