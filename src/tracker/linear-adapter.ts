import { TrackerAdapterError } from './errors';
import type { Issue, IssueBlockerRef, TrackerAdapter } from './types';

interface LinearAdapterOptions {
  endpoint: string;
  apiKey: string;
  projectSlug: string;
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

function parsePriority(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
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

function normalizeLabels(rawIssue: Record<string, unknown>): string[] {
  const labels = readNodes(rawIssue.labels);
  return labels
    .map((label) => readString(label.name).toLowerCase())
    .filter((name) => Boolean(name));
}

function normalizeBlockers(rawIssue: Record<string, unknown>): IssueBlockerRef[] {
  const inverseRelations = readNodes(rawIssue.inverseRelations);
  return inverseRelations
    .filter((relation) => readString(relation.type).toLowerCase() === 'blocks')
    .map((relation) => {
      const issue = readObject(relation.issue);
      const issueState = issue ? readObject(issue.state) : null;

      return {
        id: issue ? readNullableString(issue.id) : null,
        identifier: issue ? readNullableString(issue.identifier) : null,
        state: issueState ? readNullableString(issueState.name) : null
      };
    });
}

function normalizeIssue(rawIssue: Record<string, unknown>): Issue {
  const state = readObject(rawIssue.state);

  return {
    id: readString(rawIssue.id),
    identifier: readString(rawIssue.identifier),
    title: readString(rawIssue.title),
    description: readNullableString(rawIssue.description),
    priority: parsePriority(rawIssue.priority),
    state: readString(state?.name),
    branch_name: readNullableString(rawIssue.branchName),
    url: readNullableString(rawIssue.url),
    labels: normalizeLabels(rawIssue),
    blocked_by: normalizeBlockers(rawIssue),
    created_at: parseIsoDate(rawIssue.createdAt),
    updated_at: parseIsoDate(rawIssue.updatedAt)
  };
}

function isMinimalStateIssue(issue: Issue): boolean {
  return Boolean(issue.id && issue.identifier && issue.state);
}

export function buildIssuesQuery(): string {
  return `
query Issues($projectSlug: String!, $stateNames: [String!], $after: String, $first: Int!) {
  issues(
    filter: {
      project: { slugId: { eq: $projectSlug } }
      state: { name: { in: $stateNames } }
    }
    after: $after
    first: $first
  ) {
    nodes {
      id
      identifier
      title
      description
      priority
      url
      branchName
      createdAt
      updatedAt
      state {
        name
      }
      labels {
        nodes {
          name
        }
      }
      inverseRelations {
        nodes {
          type
          issue {
            id
            identifier
            state {
              name
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
}`;
}

export function buildIssueStatesByIdsQuery(): string {
  return `
query IssuesByIds($issueIds: [ID!]!) {
  issues(filter: { id: { in: $issueIds } }) {
    nodes {
      id
      identifier
      title
      description
      priority
      url
      branchName
      createdAt
      updatedAt
      state {
        name
      }
      labels {
        nodes {
          name
        }
      }
      inverseRelations {
        nodes {
          type
          issue {
            id
            identifier
            state {
              name
            }
          }
        }
      }
    }
  }
}`;
}

export class LinearTrackerAdapter implements TrackerAdapter {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly projectSlug: string;
  private readonly activeStates: string[];
  private readonly pageSize: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: LinearAdapterOptions) {
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.projectSlug = options.projectSlug;
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

    const payload = await this.graphqlRequest(buildIssueStatesByIdsQuery(), { issueIds: issue_ids });
    const nodes = this.extractIssueNodes(payload);
    return nodes.map(normalizeIssue).filter(isMinimalStateIssue);
  }

  private async fetchIssuesByStateFilter(stateNames: string[]): Promise<Issue[]> {
    const issues: Issue[] = [];
    let cursor: string | null = null;

    while (true) {
      const payload = await this.graphqlRequest(buildIssuesQuery(), {
        projectSlug: this.projectSlug,
        stateNames,
        after: cursor,
        first: this.pageSize
      });

      const issuesObj = this.extractIssuesObject(payload);
      const nodes = this.extractIssueNodesFromIssuesObject(issuesObj);

      for (const node of nodes) {
        const normalized = normalizeIssue(node);
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
          'linear_missing_end_cursor',
          'Linear payload indicated next page but pageInfo.endCursor is missing'
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
          Authorization: this.apiKey
        },
        body: JSON.stringify({ query, variables }),
        signal: abortController.signal
      });
    } catch (error) {
      throw new TrackerAdapterError('linear_api_request', `Linear request failed: ${String(error)}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new TrackerAdapterError('linear_api_status', `Linear API returned status ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new TrackerAdapterError('linear_unknown_payload', `Linear payload is not valid JSON: ${String(error)}`);
    }

    const objectPayload = readObject(payload);
    if (!objectPayload) {
      throw new TrackerAdapterError('linear_unknown_payload', 'Linear payload is not an object');
    }

    const errors = Array.isArray(objectPayload.errors) ? objectPayload.errors : [];
    if (errors.length > 0) {
      throw new TrackerAdapterError('linear_graphql_errors', 'Linear GraphQL response contains errors');
    }

    if (!Object.prototype.hasOwnProperty.call(objectPayload, 'data')) {
      throw new TrackerAdapterError('linear_unknown_payload', 'Linear payload missing data');
    }

    return objectPayload as unknown as GraphqlSuccess;
  }

  private extractIssuesObject(payload: GraphqlSuccess): Record<string, unknown> {
    const data = readObject(payload.data);
    const issues = data ? readObject(data.issues) : null;

    if (!issues) {
      throw new TrackerAdapterError('linear_unknown_payload', 'Linear payload missing data.issues');
    }

    return issues;
  }

  private extractIssueNodes(payload: GraphqlSuccess): Record<string, unknown>[] {
    const issuesObj = this.extractIssuesObject(payload);
    return this.extractIssueNodesFromIssuesObject(issuesObj);
  }

  private extractIssueNodesFromIssuesObject(issuesObj: Record<string, unknown>): Record<string, unknown>[] {
    if (!Array.isArray(issuesObj.nodes)) {
      throw new TrackerAdapterError('linear_unknown_payload', 'Linear payload missing issues.nodes array');
    }

    return issuesObj.nodes
      .map((node) => readObject(node))
      .filter((node): node is Record<string, unknown> => Boolean(node));
  }
}
