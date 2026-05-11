import { describe, expect, it, vi } from 'vitest';

import { createDefaultDynamicToolExecutor } from '../../src/codex/dynamic-tools';

function parseOutput(result: { output: string }): Record<string, unknown> {
  return JSON.parse(result.output) as Record<string, unknown>;
}

describe('default dynamic tool executor', () => {
  it('advertises only the linear_graphql dynamic tool', () => {
    const executor = createDefaultDynamicToolExecutor({
      trackerEndpoint: 'https://api.linear.app/graphql',
      trackerApiKey: 'linear-key'
    });

    expect(executor.toolSpecs().map((tool) => tool.name)).toEqual(['linear_graphql']);
  });

  it('executes supported Linear GraphQL calls with configured auth', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: { viewer: { id: 'user-1' } } })));
    const executor = createDefaultDynamicToolExecutor({
      trackerEndpoint: 'https://api.linear.app/graphql',
      trackerApiKey: 'linear-key',
      fetchFn
    });

    const result = await executor.execute('linear_graphql', {
      query: 'query Viewer { viewer { id } }',
      variables: { includeArchived: false }
    });

    expect(result.success).toBe(true);
    expect(parseOutput(result)).toEqual({ data: { viewer: { id: 'user-1' } } });
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.linear.app/graphql',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'linear-key'
        },
        body: JSON.stringify({
          query: 'query Viewer { viewer { id } }',
          variables: { includeArchived: false }
        })
      })
    );
  });

  it('returns structured failure for malformed Linear GraphQL arguments', async () => {
    const fetchFn = vi.fn();
    const executor = createDefaultDynamicToolExecutor({
      trackerEndpoint: 'https://api.linear.app/graphql',
      trackerApiKey: 'linear-key',
      fetchFn
    });

    const result = await executor.execute('linear_graphql', { query: '   ', variables: [] });

    expect(result.success).toBe(false);
    expect(parseOutput(result)).toEqual({
      error: {
        code: 'invalid_linear_graphql_arguments',
        message: '`linear_graphql` expects either a GraphQL query string or an object with `query` and optional `variables`.',
        attemptedToolName: 'linear_graphql'
      }
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns structured failure when Linear auth is missing', async () => {
    const fetchFn = vi.fn();
    const executor = createDefaultDynamicToolExecutor({
      trackerEndpoint: 'https://api.linear.app/graphql',
      trackerApiKey: '   ',
      fetchFn
    });

    const result = await executor.execute('linear_graphql', { query: 'query Viewer { viewer { id } }' });

    expect(result.success).toBe(false);
    expect(parseOutput(result)).toEqual({
      error: {
        code: 'missing_linear_auth',
        message: 'Symphony is missing Linear auth. Set tracker.api_key or export LINEAR_API_KEY.',
        attemptedToolName: 'linear_graphql'
      }
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns structured failure when the Linear endpoint is missing', async () => {
    const fetchFn = vi.fn();
    const executor = createDefaultDynamicToolExecutor({
      trackerEndpoint: '   ',
      trackerApiKey: 'linear-key',
      fetchFn
    });

    const result = await executor.execute('linear_graphql', { query: 'query Viewer { viewer { id } }' });

    expect(result.success).toBe(false);
    expect(parseOutput(result)).toEqual({
      error: {
        code: 'missing_tracker_endpoint',
        message: 'Symphony is missing tracker endpoint for dynamic tool execution.',
        attemptedToolName: 'linear_graphql'
      }
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns supported tool names and attempted tool name for unsupported dynamic tools', async () => {
    const fetchFn = vi.fn();
    const executor = createDefaultDynamicToolExecutor({
      trackerEndpoint: 'https://api.linear.app/graphql',
      trackerApiKey: 'linear-key',
      fetchFn
    });

    const result = await executor.execute('filesystem.read', { path: '/tmp/example' });

    expect(result.success).toBe(false);
    expect(parseOutput(result)).toEqual({
      error: {
        code: 'unsupported_dynamic_tool',
        message: 'Unsupported dynamic tool: "filesystem.read".',
        attemptedToolName: 'filesystem.read',
        supportedTools: ['linear_graphql']
      }
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
