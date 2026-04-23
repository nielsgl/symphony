import { describe, expect, it, vi } from 'vitest';

import { OrchestratorCore } from '../../src/orchestrator/core';
import type { OrchestratorConfig, OrchestratorPersistencePort, OrchestratorPorts } from '../../src/orchestrator/types';
import type { StructuredLogger } from '../../src/observability';
import { CANONICAL_EVENT } from '../../src/observability/events';
import type { Issue, TrackerAdapter } from '../../src/tracker/types';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'i-1',
    identifier: 'ABC-1',
    title: 'Issue ABC-1',
    description: null,
    priority: 2,
    state: 'Todo',
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides
  };
}

function makeTracker(): TrackerAdapter & {
  fetch_candidate_issues: ReturnType<typeof vi.fn>;
  fetch_issues_by_states: ReturnType<typeof vi.fn>;
  fetch_issue_states_by_ids: ReturnType<typeof vi.fn>;
} {
  return {
    fetch_candidate_issues: vi.fn(async () => []),
    fetch_issues_by_states: vi.fn(async () => []),
    fetch_issue_states_by_ids: vi.fn(async () => [])
  };
}

interface Harness {
  orchestrator: OrchestratorCore;
  tracker: ReturnType<typeof makeTracker>;
  now: { value: number };
  scheduled: Map<string, { callback: () => Promise<void>; due_at_ms: number; handle: object }>;
  terminated: Array<{ issue_id: string; cleanup_workspace: boolean; reason: string }>;
  spawned: Array<{ issue_id: string; attempt: number | null; worker_host?: string | null }>;
}

function createHarness(options: {
  configOverrides?: Partial<OrchestratorConfig>;
  spawnWorker?: OrchestratorPorts['spawnWorker'];
  logger?: StructuredLogger;
  persistence?: OrchestratorPersistencePort;
} = {}): Harness {
  const tracker = makeTracker();
  const now = { value: 1_000_000 };
  const scheduled = new Map<string, { callback: () => Promise<void>; due_at_ms: number; handle: object }>();
  const terminated: Array<{ issue_id: string; cleanup_workspace: boolean; reason: string }> = [];
  const spawned: Array<{ issue_id: string; attempt: number | null; worker_host?: string | null }> = [];

  const config: OrchestratorConfig = {
    poll_interval_ms: 30_000,
    max_concurrent_agents: 2,
    max_concurrent_agents_by_state: {},
    max_retry_backoff_ms: 300_000,
    active_states: ['Todo', 'In Progress'],
    terminal_states: ['Done', 'Canceled', 'Cancelled'],
    stall_timeout_ms: 300_000,
    ...options.configOverrides
  };

  const spawnWorker: OrchestratorPorts['spawnWorker'] =
    options.spawnWorker ??
    (async ({ issue, attempt, worker_host }) => {
      spawned.push({ issue_id: issue.id, attempt, worker_host });
      return {
        ok: true,
        worker_handle: { issue_id: issue.id },
        monitor_handle: { issue_id: issue.id },
        worker_host
      };
    });

  const orchestrator = new OrchestratorCore({
    config,
    ports: {
      tracker,
      dispatchPreflight: () => ({ dispatch_allowed: true }),
      spawnWorker,
      terminateWorker: async ({ issue_id, cleanup_workspace, reason }) => {
        terminated.push({ issue_id, cleanup_workspace, reason });
      },
      scheduleRetryTimer: ({ issue_id, due_at_ms, callback }) => {
        const handle = { issue_id };
        scheduled.set(issue_id, { callback, due_at_ms, handle });
        return handle;
      },
      cancelRetryTimer: (timer_handle) => {
        for (const [issueId, scheduledEntry] of scheduled.entries()) {
          if (scheduledEntry.handle === timer_handle) {
            scheduled.delete(issueId);
          }
        }
      },
      notifyObservers: () => undefined
    },
    nowMs: () => now.value,
    logger: options.logger,
    persistence: options.persistence
  });

  return { orchestrator, tracker, now, scheduled, terminated, spawned };
}

describe('OrchestratorCore', () => {
  it('[SPEC-4.1-1][SPEC-7.1-1][SPEC-8.1-1][SPEC-17.4-1] dispatches in priority->created_at->identifier order', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-c', identifier: 'ABC-3', priority: 2, created_at: new Date('2026-01-03T00:00:00.000Z') }),
      makeIssue({ id: 'i-a', identifier: 'ABC-1', priority: 1, created_at: new Date('2026-01-03T00:00:00.000Z') }),
      makeIssue({ id: 'i-b', identifier: 'ABC-2', priority: 1, created_at: new Date('2026-01-01T00:00:00.000Z') })
    ]);

    await harness.orchestrator.tick('interval');

    expect(harness.spawned.map((entry) => entry.issue_id)).toEqual(['i-b', 'i-a']);
  });

  it('does not dispatch Todo when blocker is non-terminal but dispatches when blocker is terminal', async () => {
    const harness = createHarness({ configOverrides: { max_concurrent_agents: 3 } });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({
        id: 'i-blocked',
        blocked_by: [{ id: 'i-x', identifier: 'ABC-X', state: 'In Progress' }]
      }),
      makeIssue({
        id: 'i-unblocked',
        identifier: 'ABC-2',
        blocked_by: [{ id: 'i-done', identifier: 'ABC-DONE', state: 'Done' }]
      })
    ]);

    await harness.orchestrator.tick('interval');

    expect(harness.spawned.map((entry) => entry.issue_id)).toEqual(['i-unblocked']);
  });

  it('tracks running and claimed bookkeeping on dispatch', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-claim' })]);

    await harness.orchestrator.tick('interval');

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.running.has('i-claim')).toBe(true);
    expect(snapshot.claimed.has('i-claim')).toBe(true);
    expect(snapshot.retry_attempts.has('i-claim')).toBe(false);
  });

  it('assigns worker hosts in deterministic round-robin order when ssh hosts are configured', async () => {
    const harness = createHarness({
      configOverrides: {
        max_concurrent_agents: 2,
        worker_hosts: ['build-1', 'build-2'],
        max_concurrent_agents_per_host: 1
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-host-1', identifier: 'ABC-1' }),
      makeIssue({ id: 'i-host-2', identifier: 'ABC-2' })
    ]);

    await harness.orchestrator.tick('interval');

    expect(harness.spawned).toEqual([
      { issue_id: 'i-host-1', attempt: null, worker_host: 'build-1' },
      { issue_id: 'i-host-2', attempt: null, worker_host: 'build-2' }
    ]);
  });

  it('retries when all configured worker hosts are at capacity', async () => {
    const harness = createHarness({
      configOverrides: {
        max_concurrent_agents: 2,
        worker_hosts: ['build-1'],
        max_concurrent_agents_per_host: 1
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-capacity-1', identifier: 'ABC-1' }),
      makeIssue({ id: 'i-capacity-2', identifier: 'ABC-2' })
    ]);

    await harness.orchestrator.tick('interval');
    const retryEntry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-capacity-2');
    expect(retryEntry?.error).toBe('no available worker host slots');
    expect(harness.spawned).toEqual([{ issue_id: 'i-capacity-1', attempt: null, worker_host: 'build-1' }]);
  });

  it('schedules continuation retry with attempt=1 and 1000ms delay on normal exit', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-normal' })]);
    await harness.orchestrator.tick('interval');

    harness.now.value += 5000;
    await harness.orchestrator.onWorkerExit('i-normal', 'normal');

    const retryEntry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-normal');
    expect(retryEntry?.attempt).toBe(1);
    expect(retryEntry?.error).toBeNull();
    expect(retryEntry?.due_at_ms).toBe(harness.now.value + 1000);
  });

  it('schedules exponential failure retries with cap on abnormal exits', async () => {
    const harness = createHarness({ configOverrides: { max_retry_backoff_ms: 25_000 } });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-abnormal' })]);
    await harness.orchestrator.tick('interval');

    harness.now.value += 1;
    await harness.orchestrator.onWorkerExit('i-abnormal', 'abnormal');

    const firstRetry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-abnormal');
    expect(firstRetry?.attempt).toBe(1);
    expect(firstRetry?.due_at_ms).toBe(harness.now.value + 10_000);

    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-abnormal' })]);
    await harness.orchestrator.onRetryTimer('i-abnormal');
    harness.now.value += 1;
    await harness.orchestrator.onWorkerExit('i-abnormal', 'abnormal');

    const secondRetry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-abnormal');
    expect(secondRetry?.attempt).toBe(2);
    expect(secondRetry?.due_at_ms).toBe(harness.now.value + 20_000);

    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-abnormal' })]);
    await harness.orchestrator.onRetryTimer('i-abnormal');
    harness.now.value += 1;
    await harness.orchestrator.onWorkerExit('i-abnormal', 'abnormal');

    const thirdRetry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-abnormal');
    expect(thirdRetry?.attempt).toBe(3);
    expect(thirdRetry?.due_at_ms).toBe(harness.now.value + 25_000);
  });

  it('requeues retry with explicit slot exhaustion reason when no slots are available', async () => {
    const harness = createHarness({ configOverrides: { max_concurrent_agents: 1 } });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-busy' })]);
    await harness.orchestrator.tick('interval');
    harness.now.value += 1;
    await harness.orchestrator.onWorkerExit('i-busy', 'normal');

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-occupying-slot', identifier: 'ABC-2', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-busy' })]);
    await harness.orchestrator.onRetryTimer('i-busy');

    const retryEntry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-busy');
    expect(retryEntry?.attempt).toBe(2);
    expect(retryEntry?.error).toBe('no available orchestrator slots');
  });

  it('releases claim if retry issue is no longer in candidate set', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-release' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit('i-release', 'normal');

    harness.tracker.fetch_candidate_issues.mockResolvedValue([]);
    await harness.orchestrator.onRetryTimer('i-release');

    expect(harness.orchestrator.getStateSnapshot().claimed.has('i-release')).toBe(false);
  });

  it('updates running issue snapshots for active states during reconciliation', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-active', state: 'Todo' })]);
    await harness.orchestrator.tick('interval');

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-active', identifier: 'ABC-99', state: 'In Progress' })
    ]);

    await harness.orchestrator.reconcileRunningIssues();

    const updated = harness.orchestrator.getStateSnapshot().running.get('i-active');
    expect(updated?.issue.state).toBe('In Progress');
    expect(updated?.identifier).toBe('ABC-99');
  });

  it('stops running worker without cleanup when state becomes non-active and non-terminal', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-nonactive' })]);
    await harness.orchestrator.tick('interval');

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-nonactive', state: 'Backlog' })
    ]);

    await harness.orchestrator.reconcileRunningIssues();

    expect(harness.terminated).toEqual([
      {
        issue_id: 'i-nonactive',
        cleanup_workspace: false,
        reason: 'non_active_state_transition'
      }
    ]);
  });

  it('stops running worker with cleanup when state becomes terminal', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-terminal' })]);
    await harness.orchestrator.tick('interval');
    harness.now.value += 2500;

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-terminal', state: 'Done' })
    ]);

    await harness.orchestrator.reconcileRunningIssues();
    const snapshot = harness.orchestrator.getStateSnapshot();

    expect(harness.terminated).toEqual([
      {
        issue_id: 'i-terminal',
        cleanup_workspace: true,
        reason: 'terminal_state_transition'
      }
    ]);
    expect(snapshot.codex_totals.seconds_running).toBe(2);
  });

  it('is a no-op reconciliation when there are no running issues', async () => {
    const harness = createHarness();
    await harness.orchestrator.reconcileRunningIssues();
    expect(harness.tracker.fetch_issue_states_by_ids).not.toHaveBeenCalled();
  });

  it('keeps workers running when state refresh fails', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-refresh-fail' })]);
    await harness.orchestrator.tick('interval');

    harness.tracker.fetch_issue_states_by_ids.mockRejectedValue(new Error('unavailable'));
    await harness.orchestrator.reconcileRunningIssues();

    expect(harness.orchestrator.getStateSnapshot().running.has('i-refresh-fail')).toBe(true);
    expect(harness.terminated).toHaveLength(0);
  });

  it('kills stalled sessions and schedules retry', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    const harness = createHarness({ configOverrides: { stall_timeout_ms: 10 }, logger });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-stall' })]);
    await harness.orchestrator.tick('interval');

    harness.now.value += 3200;
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([]);
    await harness.orchestrator.reconcileRunningIssues();

    const snapshot = harness.orchestrator.getStateSnapshot();
    const retryEntry = snapshot.retry_attempts.get('i-stall');
    expect(harness.terminated).toEqual([
      {
        issue_id: 'i-stall',
        cleanup_workspace: false,
        reason: 'stall_timeout'
      }
    ]);
    expect(retryEntry?.attempt).toBe(1);
    expect(retryEntry?.error).toBe('worker stalled');
    expect(snapshot.codex_totals.seconds_running).toBe(3);
    const stalled = logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.workerStalled);
    expect(stalled?.context.issue_id).toBe('i-stall');
    expect(stalled?.context.issue_identifier).toBe('ABC-1');
  });

  it('tracks failed dispatch validation in health state', async () => {
    const harness = createHarness();
    const dispatchDenied = new OrchestratorCore({
      config: {
        poll_interval_ms: 30_000,
        max_concurrent_agents: 2,
        max_concurrent_agents_by_state: {},
        max_retry_backoff_ms: 300_000,
        active_states: ['Todo', 'In Progress'],
        terminal_states: ['Done'],
        stall_timeout_ms: 300_000
      },
      ports: {
        tracker: harness.tracker,
        dispatchPreflight: () => ({ dispatch_allowed: false, reason: 'missing runtime token' }),
        spawnWorker: async () => ({ ok: false, error: 'blocked' }),
        terminateWorker: async () => undefined,
        scheduleRetryTimer: () => ({}),
        cancelRetryTimer: () => undefined,
        notifyObservers: () => undefined
      },
      nowMs: () => harness.now.value
    });

    await dispatchDenied.tick('interval');
    const snapshot = dispatchDenied.getStateSnapshot();
    expect(snapshot.health.dispatch_validation).toBe('failed');
    expect(snapshot.health.last_error).toContain('missing runtime token');
  });

  it('emits dispatch validation recovered when preflight transitions failed->ok', async () => {
    const tracker = makeTracker();
    const now = { value: 1_000_000 };
    const logs: Array<{ event: string; level: 'info' | 'warn' | 'error' }> = [];
    const dispatchAllowed = { value: false };
    const logger: StructuredLogger = {
      log: ({ level, event }) => {
        logs.push({ level, event });
      }
    };

    const orchestrator = new OrchestratorCore({
      config: {
        poll_interval_ms: 30_000,
        max_concurrent_agents: 2,
        max_concurrent_agents_by_state: {},
        max_retry_backoff_ms: 300_000,
        active_states: ['Todo', 'In Progress'],
        terminal_states: ['Done'],
        stall_timeout_ms: 300_000
      },
      ports: {
        tracker,
        dispatchPreflight: () =>
          dispatchAllowed.value
            ? { dispatch_allowed: true }
            : { dispatch_allowed: false, reason: 'missing runtime token' },
        spawnWorker: async () => ({ ok: false, error: 'blocked' }),
        terminateWorker: async () => undefined,
        scheduleRetryTimer: () => ({}),
        cancelRetryTimer: () => undefined,
        notifyObservers: () => undefined
      },
      nowMs: () => now.value,
      logger
    });

    await orchestrator.tick('interval');
    dispatchAllowed.value = true;
    await orchestrator.tick('manual_refresh');

    expect(logs.some((entry) => entry.event === CANONICAL_EVENT.orchestration.dispatchValidationFailed)).toBe(true);
    expect(logs.some((entry) => entry.event === CANONICAL_EVENT.orchestration.dispatchValidationRecovered)).toBe(true);
    expect(orchestrator.getStateSnapshot().health.dispatch_validation).toBe('ok');
    expect(orchestrator.getStateSnapshot().health.last_error).toBeNull();
  });

  it('[SPEC-14.1-1] logs tracker state refresh failure and keeps workers running', async () => {
    const logs: Array<{ event: string }> = [];
    const logger: StructuredLogger = {
      log: ({ event }) => {
        logs.push({ event });
      }
    };
    const harness = createHarness({ logger });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-refresh-fail' })]);
    await harness.orchestrator.tick('interval');

    harness.tracker.fetch_issue_states_by_ids.mockRejectedValue(new Error('unavailable'));
    await harness.orchestrator.reconcileRunningIssues();

    expect(harness.orchestrator.getStateSnapshot().running.has('i-refresh-fail')).toBe(true);
    expect(logs.some((entry) => entry.event === CANONICAL_EVENT.tracker.stateRefreshFailed)).toBe(true);
  });

  it('logs retry candidate fetch failure and requeues retry with incremented attempt', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    const harness = createHarness({ logger });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-retry-fetch-fail' })]);
    await harness.orchestrator.tick('interval');

    await harness.orchestrator.onWorkerExit('i-retry-fetch-fail', 'normal');
    harness.tracker.fetch_candidate_issues.mockRejectedValue(new Error('tracker unavailable'));
    await harness.orchestrator.onRetryTimer('i-retry-fetch-fail');

    const retryEntry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-retry-fetch-fail');
    expect(retryEntry?.attempt).toBe(2);
    expect(retryEntry?.error).toBe('retry poll failed');
    expect(logs.some((entry) => entry.event === CANONICAL_EVENT.tracker.retryFetchFailed)).toBe(true);
    const failureLog = logs.find((entry) => entry.event === CANONICAL_EVENT.tracker.retryFetchFailed);
    expect(failureLog?.context.issue_identifier).toBe('ABC-1');
    expect(failureLog?.context).not.toHaveProperty('identifier');
  });

  it('emits deterministic lifecycle logs for dispatch, retry scheduling, worker exits, and terminal transitions', async () => {
    const logs: Array<{ event: string; message: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, message, context }) => {
        logs.push({ event, message, context: context ?? {} });
      }
    };
    const harness = createHarness({ logger });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-lifecycle', identifier: 'ABC-42' })]);

    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit('i-lifecycle', 'normal');

    const dispatchStart = logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.dispatchAttemptStarted);
    expect(dispatchStart?.context.issue_id).toBe('i-lifecycle');
    expect(dispatchStart?.context.issue_identifier).toBe('ABC-42');

    const dispatchSuccess = logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.dispatchSpawnSucceeded);
    expect(dispatchSuccess?.message).toBe('dispatch spawn succeeded');
    expect(dispatchSuccess?.context.issue_identifier).toBe('ABC-42');

    const workerExit = logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.workerExitHandled);
    expect(workerExit?.message).toBe('worker exit handled: completed; retrying continuation');
    expect(workerExit?.context.issue_id).toBe('i-lifecycle');
    expect(workerExit?.context.issue_identifier).toBe('ABC-42');
    expect(workerExit?.context).toHaveProperty('session_id');

    const retryScheduled = logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.retryScheduled);
    expect(retryScheduled?.context.issue_id).toBe('i-lifecycle');
    expect(retryScheduled?.context.issue_identifier).toBe('ABC-42');
    expect(retryScheduled?.context.delay_type).toBe('continuation');

    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-terminal', identifier: 'ABC-99' })]);
    await harness.orchestrator.tick('interval');
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([makeIssue({ id: 'i-terminal', identifier: 'ABC-99', state: 'Done' })]);
    await harness.orchestrator.reconcileRunningIssues();

    const terminated = logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.workerTerminated);
    expect(terminated?.context.issue_id).toBe('i-terminal');
    expect(terminated?.context.issue_identifier).toBe('ABC-99');
    expect(terminated?.context.reason).toBe('terminal_state_transition');
    expect(terminated?.context.cleanup_workspace).toBe(true);
  });

  it('includes issue/session context when session persistence logging fails', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'run-1',
      recordSession: async () => {
        throw new Error('persistence unavailable');
      },
      recordEvent: async () => undefined,
      completeRun: async () => undefined
    };
    const harness = createHarness({ logger, persistence });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-session-fail', identifier: 'ABC-5' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-session-fail', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      session_id: 'thread-9-turn-1'
    });
    await new Promise((resolve) => setImmediate(resolve));

    const persistenceFailure = logs.find((entry) => entry.event === CANONICAL_EVENT.persistence.recordSessionFailed);
    expect(persistenceFailure?.context.issue_id).toBe('i-session-fail');
    expect(persistenceFailure?.context.issue_identifier).toBe('ABC-5');
    expect(persistenceFailure?.context.session_id).toBe('thread-9-turn-1');
  });

  it('aggregates worker event usage and turn counts deterministically', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-usage' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-usage', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      codex_app_server_pid: 4321
    });
    harness.orchestrator.onWorkerEvent('i-usage', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.turnCompleted,
      session_id: 'thread-1-turn-1',
      thread_id: 'thread-1',
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        total_tokens: 14,
        cached_input_tokens: 3,
        reasoning_output_tokens: 2,
        model_context_window: 8192
      },
      detail: 'done'
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    const running = snapshot.running.get('i-usage');
    expect(running?.turn_count).toBe(1);
    expect(running?.session_id).toBe('thread-1-turn-1');
    expect(running?.thread_id).toBe('thread-1');
    expect(running?.turn_id).toBe('turn-1');
    expect(running?.codex_app_server_pid).toBe('4321');
    expect(running?.last_event_summary).toBe('codex turn completed: done');
    expect(running?.tokens.total_tokens).toBe(14);
    expect(running?.tokens.cached_input_tokens).toBe(3);
    expect(running?.tokens.reasoning_output_tokens).toBe(2);
    expect(running?.tokens.model_context_window).toBe(8192);
    expect(running?.recent_events).toHaveLength(2);
    expect(snapshot.codex_totals.total_tokens).toBe(14);
    expect(snapshot.codex_totals.cached_input_tokens).toBe(3);
    expect(snapshot.codex_totals.reasoning_output_tokens).toBe(2);
    expect(snapshot.codex_totals.model_context_window).toBe(8192);
  });

  it('ignores usage aggregation when worker event thread_id mismatches active running thread', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-thread-mismatch' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-thread-mismatch', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-1',
      turn_id: 'turn-1'
    });

    harness.orchestrator.onWorkerEvent('i-thread-mismatch', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.turnCompleted,
      thread_id: 'thread-2',
      usage: {
        input_tokens: 99,
        output_tokens: 99,
        total_tokens: 99
      }
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    const running = snapshot.running.get('i-thread-mismatch');
    expect(running?.tokens.total_tokens).toBe(0);
    expect(snapshot.codex_totals.total_tokens).toBe(0);
  });
});
