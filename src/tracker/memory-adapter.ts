import type { Issue, TrackerAdapter } from './types';

interface MemoryAdapterOptions {
  activeStates: string[];
  seedIssues?: Issue[];
}

function cloneIssue(issue: Issue): Issue {
  return {
    ...issue,
    labels: [...issue.labels],
    blocked_by: issue.blocked_by.map((blocker) => ({
      id: blocker.id,
      identifier: blocker.identifier,
      state: blocker.state
    })),
    tracker_meta: issue.tracker_meta
      ? {
          ...issue.tracker_meta,
          pr_links: issue.tracker_meta.pr_links.map((link) => ({ ...link }))
        }
      : undefined,
    created_at: issue.created_at ? new Date(issue.created_at.getTime()) : null,
    updated_at: issue.updated_at ? new Date(issue.updated_at.getTime()) : null
  };
}

export class MemoryTrackerAdapter implements TrackerAdapter {
  private readonly activeStates: Set<string>;
  private readonly issues: Map<string, Issue>;
  private readonly comments: Map<string, string[]>;

  constructor(options: MemoryAdapterOptions) {
    this.activeStates = new Set(options.activeStates.map((value) => value.trim().toLowerCase()).filter(Boolean));
    this.issues = new Map(
      (options.seedIssues ?? []).map((issue) => [issue.id, cloneIssue(issue)])
    );
    this.comments = new Map();
  }

  async fetch_candidate_issues(): Promise<Issue[]> {
    return this.filterByStates(this.activeStates);
  }

  async fetch_issues_by_states(state_names: string[]): Promise<Issue[]> {
    if (state_names.length === 0) {
      return [];
    }
    const normalized = new Set(state_names.map((value) => value.trim().toLowerCase()).filter(Boolean));
    return this.filterByStates(normalized);
  }

  async fetch_issue_states_by_ids(issue_ids: string[]): Promise<Issue[]> {
    const issues: Issue[] = [];
    for (const issueId of issue_ids) {
      const issue = this.issues.get(issueId);
      if (issue) {
        issues.push(cloneIssue(issue));
      }
    }
    return issues;
  }

  async create_comment(issue_id: string, body: string): Promise<void> {
    const existing = this.comments.get(issue_id) ?? [];
    existing.push(body);
    this.comments.set(issue_id, existing);
  }

  async update_issue_state(issue_id: string, state_name: string): Promise<void> {
    const issue = this.issues.get(issue_id);
    if (!issue) {
      return;
    }
    issue.state = state_name;
    issue.updated_at = new Date();
  }

  private filterByStates(states: Set<string>): Issue[] {
    const issues: Issue[] = [];
    for (const issue of this.issues.values()) {
      if (!states.has(issue.state.trim().toLowerCase())) {
        continue;
      }
      issues.push(cloneIssue(issue));
    }
    return issues;
  }
}
