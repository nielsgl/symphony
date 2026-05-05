export type RunTerminalStatus = 'succeeded' | 'failed' | 'timed_out' | 'stalled' | 'cancelled';

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
