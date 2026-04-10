export class WorkspaceError extends Error {
  readonly code:
    | 'workspace_not_contained'
    | 'workspace_non_directory_collision'
    | 'workspace_cwd_mismatch'
    | 'workspace_hook_failed'
    | 'workspace_hook_timeout';

  constructor(
    code:
      | 'workspace_not_contained'
      | 'workspace_non_directory_collision'
      | 'workspace_cwd_mismatch'
      | 'workspace_hook_failed'
      | 'workspace_hook_timeout',
    message: string
  ) {
    super(message);
    this.code = code;
  }
}
