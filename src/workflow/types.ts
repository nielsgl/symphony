export type WorkflowErrorCode =
  | 'missing_workflow_file'
  | 'workflow_parse_error'
  | 'workflow_front_matter_not_a_map'
  | 'template_parse_error'
  | 'template_render_error';

export type ValidationErrorCode =
  | 'missing_tracker_kind'
  | 'unsupported_tracker_kind'
  | 'missing_tracker_api_key'
  | 'missing_tracker_project_slug'
  | 'missing_tracker_owner'
  | 'missing_tracker_repo'
  | 'invalid_tracker_active_states_for_github'
  | 'missing_codex_command'
  | 'invalid_codex_approval_policy'
  | 'invalid_codex_thread_sandbox'
  | 'invalid_codex_turn_sandbox_policy'
  | 'invalid_codex_user_input_policy';

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  prompt_template: string;
}

export interface TrackerConfig {
  kind: string;
  endpoint: string;
  api_key: string;
  project_slug: string;
  owner?: string;
  repo?: string;
  active_states: string[];
  terminal_states: string[];
}

export interface HooksConfig {
  after_create?: string;
  before_run?: string;
  after_run?: string;
  before_remove?: string;
  timeout_ms: number;
}

export interface AgentConfig {
  max_concurrent_agents: number;
  max_retry_backoff_ms: number;
  max_turns: number;
  max_concurrent_agents_by_state: Record<string, number>;
}

export interface CodexConfig {
  command: string;
  security_profile?: string;
  approval_policy?: string;
  thread_sandbox?: string;
  turn_sandbox_policy?: string;
  user_input_policy?: string;
  turn_timeout_ms: number;
  read_timeout_ms: number;
  stall_timeout_ms: number;
}

export interface PersistenceConfig {
  enabled: boolean;
  db_path: string;
  retention_days: number;
}

export interface EffectiveConfig {
  tracker: TrackerConfig;
  polling: { interval_ms: number };
  workspace: { root: string };
  hooks: HooksConfig;
  agent: AgentConfig;
  codex: CodexConfig;
  persistence: PersistenceConfig;
  server?: { port: number };
}

export type ValidationResult =
  | { ok: true; at: string }
  | {
      ok: false;
      error_code: WorkflowErrorCode | ValidationErrorCode;
      message: string;
      at: string;
    };

export interface DispatchPreflightOutcome {
  dispatch_allowed: boolean;
  reconciliation_allowed: true;
  validation: ValidationResult;
}

export interface ReloadStatus {
  ok: boolean;
  at: string;
  source: 'startup' | 'watch' | 'preflight';
  error_code?: WorkflowErrorCode | ValidationErrorCode;
  message?: string;
}

export interface EffectiveConfigSnapshot {
  workflowDefinition: WorkflowDefinition;
  effectiveConfig: EffectiveConfig;
  promptTemplate: string;
  versionHash: string;
  lastReloadStatus: ReloadStatus;
}

export interface WorkflowEvent {
  event: 'workflow_reload_succeeded' | 'workflow_reload_failed';
  at: string;
  source: 'startup' | 'watch' | 'preflight';
  version_hash?: string;
  error_code?: WorkflowErrorCode | ValidationErrorCode;
  message?: string;
}
