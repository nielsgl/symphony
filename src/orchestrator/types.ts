import type { Issue, TrackerAdapter } from '../tracker';
import type { CodexUsageTotals } from '../codex';
import type { StructuredLogger } from '../observability';

export type TickReason = 'startup' | 'interval' | 'manual_refresh' | 'retry_timer';
export type WorkerExitReason = 'normal' | 'abnormal';
export type RetryDelayType = 'continuation' | 'failure';

export interface RunningEntry {
  issue: Issue;
  identifier: string;
  worker_handle: unknown;
  monitor_handle: unknown;
  retry_attempt: number;
  workspace_path: string | null;
  session_id: string | null;
  turn_count: number;
  last_event: string | null;
  last_message: string | null;
  tokens: CodexUsageTotals;
  last_reported_tokens: CodexUsageTotals;
  recent_events: Array<{
    at_ms: number;
    event: string;
    message: string | null;
  }>;
  started_at_ms: number;
  last_codex_timestamp_ms: number | null;
}

export interface RetryEntry {
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at_ms: number;
  error: string | null;
  timer_handle: unknown;
}

export interface OrchestratorState {
  poll_interval_ms: number;
  max_concurrent_agents: number;
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retry_attempts: Map<string, RetryEntry>;
  completed: Set<string>;
  codex_totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    seconds_running: number;
  };
  codex_rate_limits: Record<string, unknown> | null;
  health: {
    dispatch_validation: 'ok' | 'failed';
    last_error: string | null;
  };
}

export interface DispatchPreflightResult {
  dispatch_allowed: boolean;
  reason?: string;
}

export interface SpawnWorkerResultSuccess {
  ok: true;
  worker_handle: unknown;
  monitor_handle: unknown;
  workspace_path?: string | null;
}

export interface SpawnWorkerResultFailure {
  ok: false;
  error: string;
}

export type SpawnWorkerResult = SpawnWorkerResultSuccess | SpawnWorkerResultFailure;

export interface OrchestratorPorts {
  tracker: TrackerAdapter;
  dispatchPreflight: () => DispatchPreflightResult;
  spawnWorker: (params: { issue: Issue; attempt: number | null }) => Promise<SpawnWorkerResult>;
  terminateWorker: (params: {
    issue_id: string;
    worker_handle: unknown;
    cleanup_workspace: boolean;
    reason: string;
  }) => Promise<void>;
  scheduleRetryTimer: (params: {
    issue_id: string;
    due_at_ms: number;
    callback: () => Promise<void>;
  }) => unknown;
  cancelRetryTimer: (timer_handle: unknown) => void;
  notifyObservers?: () => void;
}

export interface WorkerObservabilityEvent {
  timestamp_ms: number;
  event: string;
  session_id?: string;
  detail?: string;
  usage?: CodexUsageTotals;
  rate_limits?: Record<string, unknown> | null;
}

export interface OrchestratorConfig {
  poll_interval_ms: number;
  max_concurrent_agents: number;
  max_concurrent_agents_by_state: Record<string, number>;
  max_retry_backoff_ms: number;
  active_states: string[];
  terminal_states: string[];
  stall_timeout_ms: number;
}

export interface OrchestratorOptions {
  config: OrchestratorConfig;
  ports: OrchestratorPorts;
  nowMs?: () => number;
  logger?: StructuredLogger;
}
