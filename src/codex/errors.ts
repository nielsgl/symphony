export class CodexRunnerError extends Error {
  readonly code:
    | 'codex_not_found'
    | 'invalid_workspace_cwd'
    | 'response_timeout'
    | 'turn_timeout'
    | 'port_exit'
    | 'response_error'
    | 'turn_failed'
    | 'turn_cancelled'
    | 'turn_input_required';

  constructor(
    code:
      | 'codex_not_found'
      | 'invalid_workspace_cwd'
      | 'response_timeout'
      | 'turn_timeout'
      | 'port_exit'
      | 'response_error'
      | 'turn_failed'
      | 'turn_cancelled'
      | 'turn_input_required',
    message: string
  ) {
    super(message);
    this.code = code;
  }
}
