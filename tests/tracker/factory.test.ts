import { describe, expect, it } from 'vitest';

import { TrackerAdapterError } from '../../src/tracker/errors';
import { createTrackerAdapter } from '../../src/tracker/factory';

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
});
