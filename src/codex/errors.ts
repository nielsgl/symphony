export class CodexRunnerError extends Error {
  readonly code:
    | 'response_timeout'
    | 'turn_timeout'
    | 'response_error'
    | 'turn_failed'
    | 'turn_cancelled'
    | 'turn_input_required';

  constructor(
    code:
      | 'response_timeout'
      | 'turn_timeout'
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
