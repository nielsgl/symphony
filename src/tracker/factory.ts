import { TrackerAdapterError } from './errors';
import { LinearTrackerAdapter } from './linear-adapter';
import type { TrackerAdapter, TrackerRuntimeConfig } from './types';

export function createTrackerAdapter(config: TrackerRuntimeConfig, fetchFn?: typeof fetch): TrackerAdapter {
  if (config.kind !== 'linear') {
    throw new TrackerAdapterError('unsupported_tracker_kind', `tracker.kind '${config.kind}' is not supported`);
  }

  if (!config.api_key.trim()) {
    throw new TrackerAdapterError('missing_tracker_api_key', 'tracker.api_key is required after env resolution');
  }

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
