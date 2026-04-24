import { describe, expect, it } from 'vitest';

import { TrackerAdapterError } from '../../src/tracker/errors';
import { createTrackerAdapter } from '../../src/tracker/factory';
import { GitHubIssuesAdapter } from '../../src/tracker/github-adapter';
import { LinearTrackerAdapter } from '../../src/tracker/linear-adapter';
import { MemoryTrackerAdapter } from '../../src/tracker/memory-adapter';

describe('createTrackerAdapter', () => {
  it('throws typed errors for unsupported tracker kind and missing linear credentials', () => {
    expect(() =>
      createTrackerAdapter({
        kind: 'jira',
        endpoint: 'https://example.com',
        api_key: 'token',
        project_slug: 'PRJ',
        active_states: []
      })
    ).toThrowError(expect.objectContaining<Partial<TrackerAdapterError>>({ code: 'unsupported_tracker_kind' }));

    expect(() =>
      createTrackerAdapter({
        kind: 'linear',
        endpoint: 'https://api.linear.app/graphql',
        api_key: ' ',
        project_slug: 'PRJ',
        active_states: []
      })
    ).toThrowError(expect.objectContaining<Partial<TrackerAdapterError>>({ code: 'missing_tracker_api_key' }));

    expect(() =>
      createTrackerAdapter({
        kind: 'linear',
        endpoint: 'https://api.linear.app/graphql',
        api_key: 'token',
        project_slug: ' ',
        active_states: []
      })
    ).toThrowError(expect.objectContaining<Partial<TrackerAdapterError>>({ code: 'missing_tracker_project_slug' }));
  });

  it('creates a linear adapter for valid linear config', () => {
    const adapter = createTrackerAdapter({
      kind: 'linear',
      endpoint: 'https://api.linear.app/graphql',
      api_key: 'token',
      project_slug: 'PRJ',
      active_states: []
    });

    expect(adapter).toBeInstanceOf(LinearTrackerAdapter);
  });

  it('throws typed errors for missing github owner/repo', () => {
    expect(() =>
      createTrackerAdapter({
        kind: 'github',
        endpoint: 'https://api.github.com/graphql',
        api_key: 'token',
        project_slug: '',
        owner: ' ',
        repo: 'symphony',
        active_states: []
      })
    ).toThrowError(expect.objectContaining<Partial<TrackerAdapterError>>({ code: 'missing_tracker_owner' }));

    expect(() =>
      createTrackerAdapter({
        kind: 'github',
        endpoint: 'https://api.github.com/graphql',
        api_key: 'token',
        project_slug: '',
        owner: 'nielsgl',
        repo: ' ',
        active_states: []
      })
    ).toThrowError(expect.objectContaining<Partial<TrackerAdapterError>>({ code: 'missing_tracker_repo' }));
  });

  it('creates a github adapter for valid github config', () => {
    const adapter = createTrackerAdapter({
      kind: 'github',
      endpoint: 'https://api.github.com/graphql',
      api_key: 'token',
      project_slug: '',
      owner: 'nielsgl',
      repo: 'symphony',
      active_states: ['Open']
    });

    expect(adapter).toBeInstanceOf(GitHubIssuesAdapter);
  });

  it('creates a memory adapter without external credentials', () => {
    const adapter = createTrackerAdapter({
      kind: 'memory',
      endpoint: 'memory://local',
      api_key: '',
      project_slug: '',
      active_states: ['Todo']
    });

    expect(adapter).toBeInstanceOf(MemoryTrackerAdapter);
  });
});
