export interface CodexRunnerStartInput {
  command: string;
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
  readTimeoutMs: number;
  turnTimeoutMs: number;
}

export type CodexTurnStatus = 'completed' | 'failed';

export type CodexTurnErrorCode =
  | 'codex_not_found'
  | 'invalid_workspace_cwd'
  | 'invalid_remote_workspace_cwd'
  | 'unsafe_workspace_root'
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
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
  model_context_window?: number;
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
