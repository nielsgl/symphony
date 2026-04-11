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
    status: 'all' | 'running' | 'retrying';
    query: string;
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
