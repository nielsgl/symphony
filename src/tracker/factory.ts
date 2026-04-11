import { TrackerAdapterError } from './errors';
import { GitHubIssuesAdapter } from './github-adapter';
import { LinearTrackerAdapter } from './linear-adapter';
import type { TrackerAdapter, TrackerRuntimeConfig } from './types';

export function createTrackerAdapter(config: TrackerRuntimeConfig, fetchFn?: typeof fetch): TrackerAdapter {
  if (config.kind !== 'linear' && config.kind !== 'github') {
    throw new TrackerAdapterError('unsupported_tracker_kind', `tracker.kind '${config.kind}' is not supported`);
  }

  if (!config.api_key.trim()) {
    throw new TrackerAdapterError('missing_tracker_api_key', 'tracker.api_key is required after env resolution');
  }

  if (config.kind === 'linear') {
    if (!config.project_slug.trim()) {
      throw new TrackerAdapterError('missing_tracker_project_slug', 'tracker.project_slug is required for tracker.kind=linear');
    }

    return new LinearTrackerAdapter({
      endpoint: config.endpoint,
      apiKey: config.api_key,
      projectSlug: config.project_slug,
      activeStates: config.active_states,
      pageSize: config.page_size,
      timeoutMs: config.timeout_ms,
      fetchFn
    });
  }

  if (!config.owner?.trim()) {
    throw new TrackerAdapterError('missing_tracker_owner', 'tracker.owner is required for tracker.kind=github');
  }

  if (!config.repo?.trim()) {
    throw new TrackerAdapterError('missing_tracker_repo', 'tracker.repo is required for tracker.kind=github');
  }

  return new GitHubIssuesAdapter({
    endpoint: config.endpoint,
    apiKey: config.api_key,
    owner: config.owner,
    repo: config.repo,
    activeStates: config.active_states,
    pageSize: config.page_size,
    timeoutMs: config.timeout_ms,
    fetchFn
  });
}
