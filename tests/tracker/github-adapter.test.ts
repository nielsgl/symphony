import { describe, expect, it } from 'vitest';

import { GitHubIssuesAdapter } from '../../src/tracker/github-adapter';

interface FakeRequest {
  query: string;
  variables: Record<string, unknown>;
}

function makeIssueNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'node-1',
    number: 1,
    title: 'Test issue',
    body: 'desc',
    state: 'OPEN',
    url: 'https://github.com/nielsgl/symphony/issues/1',
    createdAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-01T11:00:00.000Z',
    labels: { nodes: [{ name: 'Backend' }, { name: 'P0' }] },
    timelineItems: {
      nodes: [
        {
          source: {
            __typename: 'PullRequest',
            number: 42,
            url: 'https://github.com/nielsgl/symphony/pull/42',
            state: 'OPEN',
            merged: false
          }
        },
        {
          source: {
            __typename: 'Issue',
            number: 99,
            url: 'https://github.com/nielsgl/symphony/issues/99',
            state: 'OPEN',
            merged: false
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

  return new GitHubIssuesAdapter({
    endpoint: 'https://api.github.com/graphql',
    apiKey: 'token',
    owner: 'nielsgl',
    repo: 'symphony',
    activeStates: ['Open'],
    fetchFn
  });
}

describe('GitHubIssuesAdapter', () => {
  it('uses owner/repo + active-state filter and preserves pagination order', async () => {
    const requests: FakeRequest[] = [];
    const adapter = createAdapterWithQueuedResponses(
      [
        new Response(
          JSON.stringify({
            data: {
              repository: {
                issues: {
                  nodes: [makeIssueNode({ id: 'n1', number: 1 })],
                  pageInfo: { hasNextPage: true, endCursor: 'cursor-1' }
                }
              }
            }
          }),
          { status: 200 }
        ),
        new Response(
          JSON.stringify({
            data: {
              repository: {
                issues: {
                  nodes: [makeIssueNode({ id: 'n2', number: 2 })],
                  pageInfo: { hasNextPage: false, endCursor: null }
                }
              }
            }
          }),
          { status: 200 }
        )
      ],
      requests
    );

    const issues = await adapter.fetch_candidate_issues();

    expect(issues.map((issue) => issue.id)).toEqual(['n1', 'n2']);
    expect(requests).toHaveLength(2);
    expect(requests[0].query).toContain('repository(owner: $owner, name: $repo)');
    expect(requests[0].query).toContain('issues(states: $states');
    expect(requests[0].variables).toMatchObject({
      owner: 'nielsgl',
      repo: 'symphony',
      states: ['OPEN'],
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

  it('normalizes identifier, labels, dates, and pr_links metadata', async () => {
    const requests: FakeRequest[] = [];
    const adapter = createAdapterWithQueuedResponses(
      [
        new Response(
          JSON.stringify({
            data: {
              repository: {
                issues: {
                  nodes: [
                    makeIssueNode({
                      number: 17,
                      createdAt: 'invalid-date',
                      updatedAt: '2026-03-01T00:00:00.000Z'
                    })
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null }
                }
              }
            }
          }),
          { status: 200 }
        )
      ],
      requests
    );

    const [issue] = await adapter.fetch_candidate_issues();

    expect(issue.identifier).toBe('nielsgl/symphony#17');
    expect(issue.state).toBe('Open');
    expect(issue.labels).toEqual(['backend', 'p0']);
    expect(issue.priority).toBeNull();
    expect(issue.blocked_by).toEqual([]);
    expect(issue.created_at).toBeNull();
    expect(issue.updated_at?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(issue.tracker_meta).toEqual({
      tracker_kind: 'github',
      repository: 'nielsgl/symphony',
      pr_links: [
        {
          number: 42,
          url: 'https://github.com/nielsgl/symphony/pull/42',
          state: 'open',
          merged: false
        }
      ]
    });
  });

  it('issues state-refresh query with GraphQL [ID!] variable typing', async () => {
    const requests: FakeRequest[] = [];
    const adapter = createAdapterWithQueuedResponses(
      [
        new Response(
          JSON.stringify({
            data: {
              nodes: [makeIssueNode({ id: 'n-refresh', number: 55, state: 'CLOSED' })]
            }
          }),
          { status: 200 }
        )
      ],
      requests
    );

    const issues = await adapter.fetch_issue_states_by_ids(['n-refresh']);

    expect(issues[0].id).toBe('n-refresh');
    expect(issues[0].state).toBe('Closed');
    expect(requests[0].query).toContain('query IssuesByIds($issueIds: [ID!]!)');
    expect(requests[0].variables).toEqual({ issueIds: ['n-refresh'] });
  });

  it('maps request/status/graphql/payload errors to typed categories', async () => {
    const requestErrAdapter = createAdapterWithQueuedResponses([new Error('network down')], []);
    await expect(requestErrAdapter.fetch_candidate_issues()).rejects.toMatchObject({
      code: 'github_api_request'
    });

    const statusErrAdapter = createAdapterWithQueuedResponses([new Response('oops', { status: 502 })], []);
    await expect(statusErrAdapter.fetch_candidate_issues()).rejects.toMatchObject({
      code: 'github_api_status'
    });

    const graphqlErrAdapter = createAdapterWithQueuedResponses(
      [new Response(JSON.stringify({ errors: [{ message: 'bad query' }] }), { status: 200 })],
      []
    );
    await expect(graphqlErrAdapter.fetch_candidate_issues()).rejects.toMatchObject({
      code: 'github_graphql_errors'
    });

    const payloadErrAdapter = createAdapterWithQueuedResponses(
      [
        new Response(
          JSON.stringify({
            data: {
              repository: {
                issues: {
                  pageInfo: { hasNextPage: false }
                }
              }
            }
          }),
          { status: 200 }
        )
      ],
      []
    );
    await expect(payloadErrAdapter.fetch_candidate_issues()).rejects.toMatchObject({
      code: 'github_unknown_payload'
    });
  });

  it('throws github_missing_end_cursor when pagination marker is incomplete', async () => {
    const adapter = createAdapterWithQueuedResponses(
      [
        new Response(
          JSON.stringify({
            data: {
              repository: {
                issues: {
                  nodes: [makeIssueNode()],
                  pageInfo: { hasNextPage: true, endCursor: null }
                }
              }
            }
          }),
          { status: 200 }
        )
      ],
      []
    );

    await expect(adapter.fetch_candidate_issues()).rejects.toMatchObject({
      code: 'github_missing_end_cursor'
    });
  });
});
