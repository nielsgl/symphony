export type RunTerminalStatus = 'succeeded' | 'failed' | 'timed_out' | 'stalled' | 'cancelled';
export type ExecutionGraphEntityStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'retrying';

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
  started_at: string;
  ended_at: string | null;
  terminal_status: RunTerminalStatus | null;
  error_code: string | null;
  session_ids: string[];
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
