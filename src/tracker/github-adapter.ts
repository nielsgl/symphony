import { TrackerAdapterError } from './errors';
import type { Issue, IssuePullRequestLink, TrackerAdapter } from './types';

interface GitHubAdapterOptions {
  endpoint: string;
  apiKey: string;
  owner: string;
  repo: string;
  activeStates: string[];
  pageSize?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

interface GraphqlSuccess {
  data: unknown;
  errors?: Array<{ message?: string }>;
}

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_TIMEOUT_MS = 30000;

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return null;
}

function readNodes(value: unknown): Record<string, unknown>[] {
  const objectValue = readObject(value);
  if (!objectValue) {
    return [];
  }

  const nodes = objectValue.nodes;
  if (!Array.isArray(nodes)) {
    return [];
  }

  return nodes.map((entry) => readObject(entry)).filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

function normalizeIssueState(value: unknown): string {
  const raw = readString(value).toUpperCase();
  if (raw === 'OPEN') {
    return 'Open';
  }

  if (raw === 'CLOSED') {
    return 'Closed';
  }

  return readString(value);
}

function mapStateNamesToEnums(stateNames: string[]): string[] {
  const mapped = new Set<string>();

  for (const stateName of stateNames) {
    const normalized = stateName.trim().toLowerCase();
    if (normalized === 'open') {
      mapped.add('OPEN');
      continue;
    }

    if (normalized === 'closed') {
      mapped.add('CLOSED');
    }
  }

  return Array.from(mapped);
}

function normalizeLabels(rawIssue: Record<string, unknown>): string[] {
  const labels = readNodes(rawIssue.labels);
  return labels
    .map((label) => readString(label.name).toLowerCase())
    .filter((name) => Boolean(name));
}

function normalizePrLinks(rawIssue: Record<string, unknown>): IssuePullRequestLink[] {
  const timelineItems = readNodes(rawIssue.timelineItems);
  const links: IssuePullRequestLink[] = [];

  for (const item of timelineItems) {
    const source = readObject(item.source);
    if (!source || readString(source.__typename) !== 'PullRequest') {
      continue;
    }

    const number = source.number;
    const url = readNullableString(source.url);
    if (typeof number !== 'number' || !Number.isInteger(number) || !url) {
      continue;
    }

    links.push({
      number,
      url,
      state: readString(source.state).toLowerCase(),
      merged: readBoolean(source.merged)
    });
  }

  return links;
}

function normalizeIssue(rawIssue: Record<string, unknown>, repository: string): Issue {
  const number = rawIssue.number;
  const issueNumber = typeof number === 'number' && Number.isInteger(number) ? number : null;

  return {
    id: readString(rawIssue.id),
    identifier: issueNumber === null ? '' : `${repository}#${issueNumber}`,
    title: readString(rawIssue.title),
    description: readNullableString(rawIssue.body),
    priority: null,
    state: normalizeIssueState(rawIssue.state),
    branch_name: null,
    url: readNullableString(rawIssue.url),
    labels: normalizeLabels(rawIssue),
    blocked_by: [],
    tracker_meta: {
      tracker_kind: 'github',
      repository,
      pr_links: normalizePrLinks(rawIssue)
    },
    created_at: parseIsoDate(rawIssue.createdAt),
    updated_at: parseIsoDate(rawIssue.updatedAt)
  };
}

function isMinimalStateIssue(issue: Issue): boolean {
  return Boolean(issue.id && issue.identifier && issue.state);
}

export function buildGitHubIssuesQuery(): string {
  return `
query Issues($owner: String!, $repo: String!, $states: [IssueState!], $after: String, $first: Int!) {
  repository(owner: $owner, name: $repo) {
    issues(states: $states, orderBy: {field: CREATED_AT, direction: ASC}, after: $after, first: $first) {
      nodes {
        id
        number
        title
        body
        state
        url
        createdAt
        updatedAt
        labels(first: 20) {
          nodes {
            name
          }
        }
        timelineItems(first: 20, itemTypes: [CROSS_REFERENCED_EVENT]) {
          nodes {
            ... on CrossReferencedEvent {
              source {
                __typename
                ... on PullRequest {
                  number
                  url
                  state
                  merged
                }
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`;
}

export function buildGitHubIssueStatesByIdsQuery(): string {
  return `
query IssuesByIds($issueIds: [ID!]!) {
  nodes(ids: $issueIds) {
    ... on Issue {
      id
      number
      title
      body
      state
      url
      createdAt
      updatedAt
      labels(first: 20) {
        nodes {
          name
        }
      }
      timelineItems(first: 20, itemTypes: [CROSS_REFERENCED_EVENT]) {
        nodes {
          ... on CrossReferencedEvent {
            source {
              __typename
              ... on PullRequest {
                number
                url
                state
                merged
              }
            }
          }
        }
      }
    }
  }
}`;
}

export function buildGitHubCreateCommentMutation(): string {
  return `
mutation AddComment($issueId: ID!, $body: String!) {
  addComment(input: { subjectId: $issueId, body: $body }) {
    clientMutationId
  }
}`;
}

export function buildGitHubCloseIssueMutation(): string {
  return `
mutation CloseIssue($issueId: ID!) {
  closeIssue(input: { issueId: $issueId }) {
    issue {
      id
    }
  }
}`;
}

export function buildGitHubReopenIssueMutation(): string {
  return `
mutation ReopenIssue($issueId: ID!) {
  reopenIssue(input: { issueId: $issueId }) {
    issue {
      id
    }
  }
}`;
}

export class GitHubIssuesAdapter implements TrackerAdapter {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly repository: string;
  private readonly activeStates: string[];
  private readonly pageSize: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: GitHubAdapterOptions) {
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.owner = options.owner;
    this.repo = options.repo;
    this.repository = `${options.owner}/${options.repo}`;
    this.activeStates = [...options.activeStates];
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async fetch_candidate_issues(): Promise<Issue[]> {
    return this.fetchIssuesByStateFilter(this.activeStates);
  }

  async fetch_issues_by_states(state_names: string[]): Promise<Issue[]> {
    if (state_names.length === 0) {
      return [];
    }

    return this.fetchIssuesByStateFilter(state_names);
  }

  async fetch_issue_states_by_ids(issue_ids: string[]): Promise<Issue[]> {
    if (issue_ids.length === 0) {
      return [];
    }

    const payload = await this.graphqlRequest(buildGitHubIssueStatesByIdsQuery(), { issueIds: issue_ids });
    const nodes = this.extractIssueNodesByIds(payload);
    return nodes.map((node) => normalizeIssue(node, this.repository)).filter(isMinimalStateIssue);
  }

  async create_comment(issue_id: string, body: string): Promise<void> {
    const payload = await this.graphqlRequest(buildGitHubCreateCommentMutation(), {
      issueId: issue_id,
      body
    });
    const data = readObject(payload.data);
    const addComment = data ? readObject(data.addComment) : null;
    if (!addComment) {
      throw new TrackerAdapterError('github_unknown_payload', 'GitHub payload missing data.addComment');
    }
  }

  async update_issue_state(issue_id: string, state_name: string): Promise<void> {
    const normalized = state_name.trim().toLowerCase();
    if (normalized === 'open') {
      const payload = await this.graphqlRequest(buildGitHubReopenIssueMutation(), {
        issueId: issue_id
      });
      this.ensureIssueMutationPayload(payload, 'reopenIssue');
      return;
    }

    if (normalized === 'closed') {
      const payload = await this.graphqlRequest(buildGitHubCloseIssueMutation(), {
        issueId: issue_id
      });
      this.ensureIssueMutationPayload(payload, 'closeIssue');
      return;
    }

    throw new TrackerAdapterError(
      'github_invalid_state_transition',
      `GitHub issue state '${state_name}' is not supported. Use Open or Closed.`
    );
  }

  private async fetchIssuesByStateFilter(stateNames: string[]): Promise<Issue[]> {
    const stateEnums = mapStateNamesToEnums(stateNames);
    if (stateEnums.length === 0) {
      throw new TrackerAdapterError(
        'github_invalid_state_filter',
        'GitHub state filter resolved to no supported values. Use Open and/or Closed.'
      );
    }

    const issues: Issue[] = [];
    let cursor: string | null = null;

    while (true) {
      const payload = await this.graphqlRequest(buildGitHubIssuesQuery(), {
        owner: this.owner,
        repo: this.repo,
        states: stateEnums,
        after: cursor,
        first: this.pageSize
      });

      const issuesObj = this.extractIssuesObject(payload);
      const nodes = this.extractIssueNodesFromIssuesObject(issuesObj);

      for (const node of nodes) {
        const normalized = normalizeIssue(node, this.repository);
        if (isMinimalStateIssue(normalized)) {
          issues.push(normalized);
        }
      }

      const pageInfo = readObject(issuesObj.pageInfo);
      const hasNextPage = Boolean(pageInfo?.hasNextPage);
      if (!hasNextPage) {
        break;
      }

      const endCursor = readNullableString(pageInfo?.endCursor);
      if (!endCursor) {
        throw new TrackerAdapterError(
          'github_missing_end_cursor',
          'GitHub payload indicated next page but pageInfo.endCursor is missing'
        );
      }

      cursor = endCursor;
    }

    return issues;
  }

  private async graphqlRequest(query: string, variables: Record<string, unknown>): Promise<GraphqlSuccess> {
    let response: Response;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.timeoutMs);

    try {
      response = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({ query, variables }),
        signal: abortController.signal
      });
    } catch (error) {
      throw new TrackerAdapterError('github_api_request', `GitHub request failed: ${String(error)}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new TrackerAdapterError('github_api_status', `GitHub API returned status ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new TrackerAdapterError('github_unknown_payload', `GitHub payload is not valid JSON: ${String(error)}`);
    }

    const objectPayload = readObject(payload);
    if (!objectPayload) {
      throw new TrackerAdapterError('github_unknown_payload', 'GitHub payload is not an object');
    }

    const errors = Array.isArray(objectPayload.errors) ? objectPayload.errors : [];
    if (errors.length > 0) {
      throw new TrackerAdapterError('github_graphql_errors', 'GitHub GraphQL response contains errors');
    }

    if (!Object.prototype.hasOwnProperty.call(objectPayload, 'data')) {
      throw new TrackerAdapterError('github_unknown_payload', 'GitHub payload missing data');
    }

    return objectPayload as unknown as GraphqlSuccess;
  }

  private extractIssuesObject(payload: GraphqlSuccess): Record<string, unknown> {
    const data = readObject(payload.data);
    const repository = data ? readObject(data.repository) : null;
    const issues = repository ? readObject(repository.issues) : null;

    if (!issues) {
      throw new TrackerAdapterError('github_unknown_payload', 'GitHub payload missing data.repository.issues');
    }

    return issues;
  }

  private extractIssueNodesFromIssuesObject(issuesObj: Record<string, unknown>): Record<string, unknown>[] {
    if (!Array.isArray(issuesObj.nodes)) {
      throw new TrackerAdapterError('github_unknown_payload', 'GitHub payload missing issues.nodes array');
    }

    return issuesObj.nodes
      .map((node) => readObject(node))
      .filter((node): node is Record<string, unknown> => Boolean(node));
  }

  private extractIssueNodesByIds(payload: GraphqlSuccess): Record<string, unknown>[] {
    const data = readObject(payload.data);
    const nodes = data?.nodes;

    if (!Array.isArray(nodes)) {
      throw new TrackerAdapterError('github_unknown_payload', 'GitHub payload missing data.nodes array');
    }

    return nodes
      .map((node) => readObject(node))
      .filter((node): node is Record<string, unknown> => Boolean(node));
  }

  private ensureIssueMutationPayload(payload: GraphqlSuccess, mutationName: 'closeIssue' | 'reopenIssue'): void {
    const data = readObject(payload.data);
    const mutationObject = data ? readObject(data[mutationName]) : null;
    const issue = mutationObject ? readObject(mutationObject.issue) : null;
    const issueId = issue ? readString(issue.id, '') : '';
    if (!issueId) {
      throw new TrackerAdapterError('github_unknown_payload', `GitHub payload missing data.${mutationName}.issue.id`);
    }
  }
}
