import { REASON_CODES } from '../observability/reason-codes';

export interface CodexRunnerStartInput {
  command: string;
  commandArgs?: string[];
  commandEnv?: Record<string, string>;
  workspaceCwd: string;
  workerHost?: string;
  prompt: string;
  continuationPrompt?: string;
  title: string;
  maxTurns?: number;
  approvalPolicy?:
    | string
    | {
        reject?: {
          sandbox_approval?: boolean;
          rules?: boolean;
          mcp_elicitations?: boolean;
        };
      };
  threadSandbox?: string;
  turnSandboxPolicy?: Record<string, unknown>;
  onEvent?: (event: CodexRunnerEvent) => void;
  cancellationSignal?: AbortSignal;
  readTimeoutMs: number;
  turnTimeoutMs: number;
}

export interface CodexRunnerRecoveryInput extends CodexRunnerStartInput {
  previousThreadId: string;
  previousTurnId: string;
  previousSessionId?: string | null;
}

export type CodexTurnStatus = 'completed' | 'failed';

export type CodexTurnErrorCode =
  | 'codex_not_found'
  | 'invalid_workspace_cwd'
  | 'invalid_remote_workspace_cwd'
  | typeof REASON_CODES.unsafeWorkspaceRoot
  | 'response_timeout'
  | 'turn_timeout'
  | 'port_exit'
  | 'response_error'
  | 'turn_failed'
  | 'turn_cancelled'
  | typeof REASON_CODES.turnInputRequired;

export interface CodexUsageTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
  model_context_window?: number;
}

export type TokenTelemetryStatus = 'unavailable' | 'pending' | 'available';

export interface TokenTelemetrySnapshot {
  token_telemetry_status: TokenTelemetryStatus;
  token_telemetry_last_source: string | null;
  token_telemetry_last_at_ms: number | null;
}

export interface CodexInputRequestOption {
  label: string;
  value?: string;
}

export interface CodexInputQuestion {
  id: string;
  prompt?: string;
  options?: CodexInputRequestOption[];
}

export interface CodexInputRequestPayload {
  request_id: string;
  request_method: string;
  prompt_text: string | null;
  questions: CodexInputQuestion[];
  options: string[];
  input_schema_type: 'options' | 'text' | 'unknown';
  input_required_at: string;
}

export interface CodexTurnResult {
  status: CodexTurnStatus;
  thread_id: string;
  turn_id: string;
  session_id: string;
  last_event: string;
  terminal_source?: 'app_server_protocol' | 'session_transcript';
  last_agent_message?: string;
  completed_at_ms?: number;
  duration_ms?: number;
  time_to_first_token_ms?: number;
  error_code?: CodexTurnErrorCode;
  error_detail?: string;
  input_required_payload?: CodexInputRequestPayload;
  turns_completed: number;
  usage?: CodexUsageTotals;
  token_telemetry_status?: TokenTelemetryStatus;
  token_telemetry_last_source?: string | null;
  token_telemetry_last_at_ms?: number | null;
  rate_limits?: Record<string, unknown> | null;
}

export interface CodexRunnerEvent {
  event: string;
  timestamp: string;
  codex_app_server_pid: number | null;
  thread_id?: string;
  turn_id?: string;
  session_id?: string;
  usage?: CodexUsageTotals;
  token_telemetry_status?: TokenTelemetryStatus;
  token_telemetry_last_source?: string | null;
  token_telemetry_last_at_ms?: number | null;
  rate_limits?: Record<string, unknown> | null;
  detail?: string;
  tool_call_id?: string;
  tool_name?: string;
  tool_call_evidence_source?: 'worker_event' | 'app_server_protocol' | 'session_transcript';
  terminal_source?: 'app_server_protocol' | 'session_transcript';
}
