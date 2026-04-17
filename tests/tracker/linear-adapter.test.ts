import { describe, expect, it } from 'vitest';

import { LinearTrackerAdapter } from '../../src/tracker/linear-adapter';

interface FakeRequest {
  query: string;
  variables: Record<string, unknown>;
}

function makeIssueNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'issue-1',
    identifier: 'ABC-1',
    title: 'Test issue',
    description: 'desc',
    priority: 1,
    url: 'https://linear.app/issue/ABC-1',
    branchName: 'feature/abc-1',
    createdAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-01T11:00:00.000Z',
    state: { name: 'Todo' },
    labels: { nodes: [{ name: 'Backend' }, { name: 'P0' }] },
    inverseRelations: {
      nodes: [
        {
          type: 'blocks',
          issue: {
            id: 'issue-0',
            identifier: 'ABC-0',
            state: { name: 'Done' }
          }
        },
        {
          type: 'relates_to',
          issue: {
            id: 'issue-x',
            identifier: 'ABC-X',
            state: { name: 'Todo' }
          }
        }
      ]
    },
    ...overrides
  };
}

function createAdapterWithQueuedResponses(responses: Array<Response | Error>, requests: FakeRequest[]) {
  const fetchFn: typeof fetch = async (_input, init) => {
    if (!init || typeof init.body !== 'string') {
      throw new Error('missing request body');
    }

    requests.push(JSON.parse(init.body) as FakeRequest);

    const next = responses.shift();
    if (!next) {
      throw new Error('unexpected fetch invocation');
    }

    if (next instanceof Error) {
      throw next;
    }

    return next;
  };

  return new LinearTrackerAdapter({
    endpoint: 'https://api.linear.app/graphql',
    apiKey: 'token',
    projectSlug: 'PRJ',
    activeStates: ['Todo', 'In Progress'],
    fetchFn
  });
}

describe('LinearTrackerAdapter', () => {
  it('[SPEC-11.2-1][SPEC-17.3-1] uses project slugId + active-state filter and preserves pagination order', async () => {
    const requests: FakeRequest[] = [];
    const adapter = createAdapterWithQueuedResponses(
      [
        new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [makeIssueNode({ id: 'i1', identifier: 'ABC-1' })],
                pageInfo: { hasNextPage: true, endCursor: 'cursor-1' }
              }
            }
          }),
          { status: 200 }
        ),
        new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [makeIssueNode({ id: 'i2', identifier: 'ABC-2' })],
                pageInfo: { hasNextPage: false, endCursor: null }
              }
            }
          }),
          { status: 200 }
        )
      ],
      requests
    );

    const issues = await adapter.fetch_candidate_issues();

    expect(issues.map((issue) => issue.id)).toEqual(['i1', 'i2']);
    expect(requests).toHaveLength(2);
    expect(requests[0].query).toContain('project: { slugId: { eq: $projectSlug } }');
    expect(requests[0].query).toContain('state: { name: { in: $stateNames } }');
    expect(requests[0].variables).toMatchObject({
      projectSlug: 'PRJ',
      stateNames: ['Todo', 'In Progress'],
      after: null,
      first: 50
    });
    expect(requests[1].variables.after).toBe('cursor-1');
  });

  it('returns empty for fetch_issues_by_states([]) without issuing API calls', async () => {
    const requests: FakeRequest[] = [];
    const adapter = createAdapterWithQueuedResponses([], requests);

    const issues = await adapter.fetch_issues_by_states([]);

    expect(issues).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it('normalizes blockers, labels, priority and dates per contract', async () => {
    const requests: FakeRequest[] = [];
    const adapter = createAdapterWithQueuedResponses(
      [
        new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [
                  makeIssueNode({
                    priority: 2.4,
                    createdAt: 'invalid-date',
                    updatedAt: '2026-03-01T00:00:00.000Z'
                  })
                ],
                pageInfo: { hasNextPage: false, endCursor: null }
              }
            }
          }),
          { status: 200 }
        )
      ],
      requests
    );

    const [issue] = await adapter.fetch_candidate_issues();

    expect(issue.labels).toEqual(['backend', 'p0']);
    expect(issue.blocked_by).toEqual([
      {
        id: 'issue-0',
        identifier: 'ABC-0',
        state: 'Done'
      }
    ]);
    expect(issue.priority).toBeNull();
    expect(issue.created_at).toBeNull();
    expect(issue.updated_at?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('issues state-refresh query with GraphQL [ID!] variable typing', async () => {
    const requests: FakeRequest[] = [];
    const adapter = createAdapterWithQueuedResponses(
      [
        new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [makeIssueNode({ id: 'i-refresh', identifier: 'ABC-55', state: { name: 'In Progress' } })]
              }
            }
          }),
          { status: 200 }
        )
      ],
      requests
    );

    const issues = await adapter.fetch_issue_states_by_ids(['i-refresh']);

    expect(issues[0].id).toBe('i-refresh');
    expect(requests[0].query).toContain('query IssuesByIds($issueIds: [ID!]!)');
    expect(requests[0].variables).toEqual({ issueIds: ['i-refresh'] });
  });

  it('maps request/status/graphql/payload errors to typed categories', async () => {
    const requestErrAdapter = createAdapterWithQueuedResponses([new Error('network down')], []);
    await expect(requestErrAdapter.fetch_candidate_issues()).rejects.toMatchObject({
      code: 'linear_api_request'
    });

    const statusErrAdapter = createAdapterWithQueuedResponses([new Response('oops', { status: 502 })], []);
    await expect(statusErrAdapter.fetch_candidate_issues()).rejects.toMatchObject({
      code: 'linear_api_status'
    });

    const graphqlErrAdapter = createAdapterWithQueuedResponses(
      [new Response(JSON.stringify({ errors: [{ message: 'bad query' }] }), { status: 200 })],
      []
    );
    await expect(graphqlErrAdapter.fetch_candidate_issues()).rejects.toMatchObject({
      code: 'linear_graphql_errors'
    });

    const payloadErrAdapter = createAdapterWithQueuedResponses(
      [new Response(JSON.stringify({ data: { issues: { pageInfo: { hasNextPage: false } } } }), { status: 200 })],
      []
    );
    await expect(payloadErrAdapter.fetch_candidate_issues()).rejects.toMatchObject({
      code: 'linear_unknown_payload'
    });
  });

  it('throws linear_missing_end_cursor when pagination marker is incomplete', async () => {
    const adapter = createAdapterWithQueuedResponses(
      [
        new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [makeIssueNode()],
                pageInfo: { hasNextPage: true, endCursor: null }
              }
            }
          }),
          { status: 200 }
        )
      ],
      []
    );

    await expect(adapter.fetch_candidate_issues()).rejects.toMatchObject({
      code: 'linear_missing_end_cursor'
    });
  });
});
