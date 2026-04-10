export interface CodexRunnerStartInput {
  command: string;
  workspaceCwd: string;
  prompt: string;
  title: string;
  approvalPolicy?: string;
  threadSandbox?: string;
  turnSandboxPolicy?: Record<string, unknown>;
  readTimeoutMs: number;
  turnTimeoutMs: number;
}

export type CodexTurnStatus = 'completed' | 'failed';

export type CodexTurnErrorCode =
  | 'response_timeout'
  | 'turn_timeout'
  | 'response_error'
  | 'turn_failed'
  | 'turn_cancelled'
  | 'turn_input_required';

export interface CodexTurnResult {
  status: CodexTurnStatus;
  thread_id: string;
  turn_id: string;
  session_id: string;
  last_event: string;
  error_code?: CodexTurnErrorCode;
}

export interface CodexRunnerEvent {
  event: string;
  timestamp: string;
  codex_app_server_pid: number | null;
}
