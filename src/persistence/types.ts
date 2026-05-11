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

export interface TicketTerminalOutcomeRecord {
  terminal_outcome_id: string;
  issue_run_id: string;
  attempt_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  outcome: RunTerminalStatus;
  reason_code: string | null;
  reason_detail: string | null;
  recorded_at: string;
}

export interface TicketBlockerRecord {
  blocker_id: string;
  issue_run_id: string;
  attempt_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  blocker_type: string;
  status: 'active' | 'resolved';
  reason_code: string;
  reason_detail: string | null;
  blocked_at: string;
  resolved_at: string | null;
}

export interface TicketEvidenceReferenceRecord {
  evidence_reference_id: string;
  issue_run_id: string;
  attempt_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  evidence_kind: string;
  uri: string;
  title: string | null;
  metadata: Record<string, unknown> | null;
  recorded_at: string;
}

export type OperationalFactAvailability = 'available' | 'unavailable' | 'unknown';

export interface TrackerTicketSnapshotRecord {
  tracker_snapshot_id: string;
  project_key: string | null;
  ticket_key: string | null;
  issue_run_id: string | null;
  attempt_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  tracker_kind: string;
  tracker_scope_status: 'present' | 'missing';
  tracker_scope_value: string | null;
  tracker_scope_reason: string | null;
  remote_issue_id: string;
  human_issue_identifier: string;
  title: string;
  tracker_status: string;
  assignee_status: OperationalFactAvailability;
  assignee_identifier: string | null;
  assignee_reason: string | null;
  labels: string[];
  project_status: OperationalFactAvailability;
  project_identifier: string | null;
  project_reason: string | null;
  team_status: OperationalFactAvailability;
  team_identifier: string | null;
  team_reason: string | null;
  observed_at: string;
  observation_hash: string;
  duplicate_count: number;
  last_observed_at: string;
}

export interface TicketReferenceRecord {
  ticket_reference_id: string;
  project_key: string | null;
  ticket_key: string | null;
  issue_run_id: string | null;
  attempt_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  reference_kind: 'branch' | 'pull_request' | 'review' | 'merge' | 'evidence';
  availability: OperationalFactAvailability;
  uri: string | null;
  label: string | null;
  external_id: string | null;
  state: string | null;
  metadata: Record<string, unknown> | null;
  observed_at: string;
  observation_hash: string;
  duplicate_count: number;
  last_observed_at: string;
}

export interface OperatorActionHistoryRecord {
  operator_action_id: string;
  project_key: string | null;
  ticket_key: string | null;
  issue_run_id: string | null;
  attempt_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  action: string;
  actor: string | null;
  result: 'accepted' | 'rejected' | 'failed';
  result_code: string | null;
  message: string | null;
  reason_note: string | null;
  phase: string | null;
  state_context: Record<string, unknown> | null;
  requested_at: string;
  observed_at: string;
  observation_hash: string;
  duplicate_count: number;
  last_observed_at: string;
}

export interface BlockedInputEventRecord {
  blocked_input_event_id: string;
  project_key: string | null;
  ticket_key: string | null;
  issue_run_id: string | null;
  attempt_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  issue_id: string;
  issue_identifier: string;
  phase: string | null;
  runtime_state: string;
  reason_code: string;
  reason_detail: string | null;
  request_id: string | null;
  request_method: string | null;
  input_schema_type: string | null;
  prompt_text: string | null;
  pending_input: Record<string, unknown> | null;
  state_context: Record<string, unknown> | null;
  blocked_at: string;
  observation_hash: string;
  duplicate_count: number;
  last_observed_at: string;
}

export type TokenModelTelemetryConfidence = 'observed_live' | 'backfilled' | 'missing';

export interface TokenModelFactRecord {
  token_model_fact_id: string;
  issue_run_id: string;
  attempt_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  requested_model: string | null;
  effective_model: string | null;
  model_source: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_output_tokens: number | null;
  total_tokens: number | null;
  model_context_window: number | null;
  telemetry_confidence: TokenModelTelemetryConfidence;
  observed_at: string;
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
      token_model_facts?: TokenModelFactRecord[];
    }
  >;
  state_transitions: StateTransitionRecord[];
  token_model_facts?: TokenModelFactRecord[];
}

export type HistoryPayloadClass =
  | 'protocol_lifecycle'
  | 'protocol_request_response'
  | 'assistant_text'
  | 'tool_payload'
  | 'command_output'
  | 'filesystem_change'
  | 'environment'
  | 'account'
  | 'conversation_transcript'
  | 'unknown';

export type HistoryPayloadDetailStatus =
  | 'absent'
  | 'summary_only'
  | 'redacted_excerpt'
  | 'redacted_truncated_excerpt'
  | 'unavailable_policy'
  | 'unavailable_source';

export type HistoryPayloadRedactionStatus = 'not_required' | 'redacted' | 'unavailable_policy' | 'unavailable_source';

export interface HistoryPayloadTruncation {
  truncated: boolean;
  original_bytes: number;
  excerpt_bytes: number;
  max_excerpt_bytes: number;
}

export interface HistoryPayloadDetails {
  policy_version: number;
  payload_class: HistoryPayloadClass;
  detail_status: HistoryPayloadDetailStatus;
  redaction_status: HistoryPayloadRedactionStatus;
  source_event_id: string;
  source_event_name: string;
  summary: string | null;
  summary_fields: Record<string, unknown>;
  redacted_excerpt: string | null;
  truncation: HistoryPayloadTruncation;
  unavailable_reason_code: string | null;
  full_payload_stored: boolean;
}

export interface AppServerEventLedgerRecord extends HistoryPayloadDetails {
  app_server_event_id: string;
  issue_run_id: string;
  attempt_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  observed_at: string;
}

export type AppServerEventLedgerExcerpt = AppServerEventLedgerRecord;

export interface TicketTimelineRecord {
  identity: DurableIdentity;
  issue_runs: IssueRunRecord[];
  attempts: AttemptRecord[];
  threads: ThreadRecord[];
  turns: TurnRecord[];
  phase_spans: PhaseSpanRecord[];
  state_transitions: StateTransitionRecord[];
  terminal_outcomes: TicketTerminalOutcomeRecord[];
  blockers: TicketBlockerRecord[];
  evidence_references: TicketEvidenceReferenceRecord[];
  tracker_snapshots: TrackerTicketSnapshotRecord[];
  ticket_references: TicketReferenceRecord[];
  operator_actions: OperatorActionHistoryRecord[];
  blocked_input_events: BlockedInputEventRecord[];
  app_server_events: AppServerEventLedgerExcerpt[];
  token_model_facts: TokenModelFactRecord[];
}

export interface DurableRunHistoryRecord {
  run_id: string;
  issue_id: string;
  issue_identifier: string;
  identity?: DurableIdentity | null;
  identity_projection?: HistoryIdentityProjectionRecord | null;
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
  app_server_events?: AppServerEventLedgerExcerpt[];
  missing_tool_output_recovery?: Record<string, unknown> | null;
  token_model_facts?: TokenModelFactRecord[];
}

export interface HistoryIdentityProjectionRecord {
  source_table: 'runs' | 'issue_run';
  source_id: string;
  run_id: string | null;
  issue_run_id: string | null;
  issue_id: string;
  issue_identifier: string;
  projection_status: 'projected' | 'degraded';
  reason_code: string | null;
  reason_detail: string | null;
  project_key: string | null;
  ticket_key: string | null;
  updated_at: string;
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

export interface HistoryWriteFailureRecord {
  operation: string;
  reason_code: string;
  detail: string | null;
  recorded_at: string;
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
