import { REASON_CODES } from '../observability/reason-codes';

export class CodexRunnerError extends Error {
  readonly code:
    | 'codex_not_found'
    | 'invalid_workspace_cwd'
    | 'invalid_remote_workspace_cwd'
    | typeof REASON_CODES.unsafeWorkspaceRoot
    | 'response_timeout'
    | typeof REASON_CODES.turnTimeout
    | 'port_exit'
    | 'response_error'
    | 'turn_failed'
    | 'turn_cancelled'
    | typeof REASON_CODES.turnInputRequired;

  constructor(
    code:
      | 'codex_not_found'
      | 'invalid_workspace_cwd'
      | 'invalid_remote_workspace_cwd'
      | typeof REASON_CODES.unsafeWorkspaceRoot
      | 'response_timeout'
      | typeof REASON_CODES.turnTimeout
      | 'port_exit'
      | 'response_error'
      | 'turn_failed'
      | 'turn_cancelled'
      | typeof REASON_CODES.turnInputRequired,
    message: string
  ) {
    super(message);
    this.code = code;
  }
}
