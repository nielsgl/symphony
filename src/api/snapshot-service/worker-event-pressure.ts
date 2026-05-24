import type { RunningEntry } from '../../orchestrator';
import { CANONICAL_EVENT, REASON_CODES } from '../../observability';
import type { ApiWorkerEventPressure } from '../types';
import { asIsoDate } from './time';

function isPlanningEvent(event: RunningEntry['recent_events'][number]): boolean {
  return event.event === CANONICAL_EVENT.codex.phasePlanning || `${event.event} ${event.message ?? ''}`.toLowerCase().includes('planning');
}

function isWaitingEvent(event: RunningEntry['recent_events'][number]): boolean {
  const normalized = `${event.event} ${event.message ?? ''}`.toLowerCase();
  return event.event === CANONICAL_EVENT.codex.turnWaiting || normalized.includes('waiting') || normalized.includes('heartbeat');
}

function isRateLimitEvent(event: RunningEntry['recent_events'][number]): boolean {
  const normalized = `${event.event} ${event.message ?? ''}`.toLowerCase();
  return event.event === CANONICAL_EVENT.codex.rateLimitsUpdated || normalized.includes('rate_limit') || normalized.includes('rate limit');
}

export function projectWorkerEventPressure(entries: Iterable<RunningEntry>): ApiWorkerEventPressure {
  const runningEntries = Array.from(entries);
  let recentWorkerEventCount = 0;
  let recentPlanningEventCount = 0;
  let recentWaitingEventCount = 0;
  let recentRateLimitEventCount = 0;
  let waitingWorkerCount = 0;
  let stalledWaitingWorkerCount = 0;
  let rateLimitedWorkerCount = 0;
  let lastWorkerEventAtMs: number | null = null;

  for (const entry of runningEntries) {
    let entryWaitingEventCount = 0;
    let entryRateLimitEventCount = 0;

    for (const event of entry.recent_events) {
      recentWorkerEventCount += 1;
      lastWorkerEventAtMs = Math.max(lastWorkerEventAtMs ?? event.at_ms, event.at_ms);

      if (isPlanningEvent(event)) {
        recentPlanningEventCount += 1;
      }
      if (isWaitingEvent(event)) {
        recentWaitingEventCount += 1;
        entryWaitingEventCount += 1;
      }
      if (isRateLimitEvent(event)) {
        recentRateLimitEventCount += 1;
        entryRateLimitEventCount += 1;
      }
    }

    if (entryWaitingEventCount > 0 || entry.last_heartbeat_at_ms || entry.running_waiting_started_at_ms) {
      waitingWorkerCount += 1;
    }
    if (entry.stalled_waiting_since_ms && entry.stalled_waiting_reason) {
      stalledWaitingWorkerCount += 1;
    }
    if (entryRateLimitEventCount > 0 || entry.rate_limits) {
      rateLimitedWorkerCount += 1;
    }
  }

  const degraded = runningEntries.length >= 2 && (waitingWorkerCount > 0 || rateLimitedWorkerCount > 0);

  return {
    active_worker_count: runningEntries.length,
    waiting_worker_count: waitingWorkerCount,
    stalled_waiting_worker_count: stalledWaitingWorkerCount,
    rate_limited_worker_count: rateLimitedWorkerCount,
    recent_worker_event_count: recentWorkerEventCount,
    recent_planning_event_count: recentPlanningEventCount,
    recent_waiting_event_count: recentWaitingEventCount,
    recent_rate_limit_event_count: recentRateLimitEventCount,
    last_worker_event_at: lastWorkerEventAtMs === null ? null : asIsoDate(lastWorkerEventAtMs),
    last_worker_event_at_ms: lastWorkerEventAtMs,
    degraded,
    reason_code: degraded ? REASON_CODES.workerEventPressure : null
  };
}
