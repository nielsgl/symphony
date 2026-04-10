export interface IssueBlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: IssueBlockerRef[];
  created_at: Date | null;
  updated_at: Date | null;
}

export interface TrackerAdapter {
  fetch_candidate_issues(): Promise<Issue[]>;
  fetch_issues_by_states(state_names: string[]): Promise<Issue[]>;
  fetch_issue_states_by_ids(issue_ids: string[]): Promise<Issue[]>;
}

export type TrackerErrorCode =
  | 'unsupported_tracker_kind'
  | 'missing_tracker_api_key'
  | 'missing_tracker_project_slug'
  | 'linear_api_request'
  | 'linear_api_status'
  | 'linear_graphql_errors'
  | 'linear_unknown_payload'
  | 'linear_missing_end_cursor';

export interface TrackerRuntimeConfig {
  kind: string;
  endpoint: string;
  api_key: string;
  project_slug: string;
  active_states: string[];
  page_size?: number;
  timeout_ms?: number;
}
