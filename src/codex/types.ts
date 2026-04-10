export interface CodexRunnerStartInput {
  command: string;
  workspaceCwd: string;
  prompt: string;
  continuationPrompt?: string;
  title: string;
  maxTurns?: number;
  approvalPolicy?: string;
  threadSandbox?: string;
  turnSandboxPolicy?: Record<string, unknown>;
  onEvent?: (event: CodexRunnerEvent) => void;
  readTimeoutMs: number;
  turnTimeoutMs: number;
}

export type CodexTurnStatus = 'completed' | 'failed';

export type CodexTurnErrorCode =
  | 'codex_not_found'
  | 'invalid_workspace_cwd'
  | 'response_timeout'
  | 'turn_timeout'
  | 'port_exit'
  | 'response_error'
  | 'turn_failed'
  | 'turn_cancelled'
  | 'turn_input_required';

export interface CodexUsageTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface CodexTurnResult {
  status: CodexTurnStatus;
  thread_id: string;
  turn_id: string;
  session_id: string;
  last_event: string;
  error_code?: CodexTurnErrorCode;
  turns_completed: number;
  usage?: CodexUsageTotals;
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
  rate_limits?: Record<string, unknown> | null;
  detail?: string;
}
