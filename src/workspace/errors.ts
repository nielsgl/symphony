export class WorkspaceError extends Error {
  readonly code:
    | 'workspace_not_contained'
    | 'workspace_non_directory_collision'
    | 'workspace_cwd_mismatch'
    | 'workspace_hook_failed'
    | 'workspace_hook_timeout'
    | 'workspace_provision_failed'
    | 'workspace_unprovisioned_conflict';

  constructor(
    code:
      | 'workspace_not_contained'
      | 'workspace_non_directory_collision'
      | 'workspace_cwd_mismatch'
      | 'workspace_hook_failed'
      | 'workspace_hook_timeout'
      | 'workspace_provision_failed'
      | 'workspace_unprovisioned_conflict',
    message: string
  ) {
    super(message);
    this.code = code;
  }
}
