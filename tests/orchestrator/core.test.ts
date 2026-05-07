import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { OrchestratorCore } from '../../src/orchestrator/core';
import type { OrchestratorConfig, OrchestratorPersistencePort, OrchestratorPorts } from '../../src/orchestrator/types';
import type { StructuredLogger } from '../../src/observability';
import { CANONICAL_EVENT } from '../../src/observability/events';
import { REASON_CODES } from '../../src/observability/reason-codes';
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
  create_comment: ReturnType<typeof vi.fn>;
  update_issue_state: ReturnType<typeof vi.fn>;
} {
  return {
    fetch_candidate_issues: vi.fn(async () => []),
    fetch_issues_by_states: vi.fn(async () => []),
    fetch_issue_states_by_ids: vi.fn(async () => []),
    create_comment: vi.fn(async () => undefined),
    update_issue_state: vi.fn(async () => undefined)
  };
}

interface Harness {
  orchestrator: OrchestratorCore;
  tracker: ReturnType<typeof makeTracker>;
  now: { value: number };
  scheduled: Map<string, { callback: () => Promise<void>; due_at_ms: number; handle: object }>;
  terminated: Array<{ issue_id: string; cleanup_workspace: boolean; reason: string }>;
  spawned: Array<{ issue_id: string; attempt: number | null; worker_host?: string | null; resume_context?: string | null }>;
}

function withTemporaryCodexHome<T>(callback: (codexHome: string) => Promise<T>): Promise<T> {
  const previousCodexHome = process.env.SYMPHONY_CODEX_HOME;
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-home-'));
  process.env.SYMPHONY_CODEX_HOME = codexHome;
  return callback(codexHome).finally(() => {
    if (previousCodexHome === undefined) {
      delete process.env.SYMPHONY_CODEX_HOME;
    } else {
      process.env.SYMPHONY_CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(codexHome, { recursive: true, force: true });
  });
}

function writeSessionTranscript(codexHome: string, filename: string, records: unknown[]): string {
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '05', '07');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const transcriptPath = path.join(sessionsDir, filename);
  fs.writeFileSync(transcriptPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return transcriptPath;
}

function createHarness(options: {
  configOverrides?: Partial<OrchestratorConfig>;
  spawnWorker?: OrchestratorPorts['spawnWorker'];
  recoverMissingToolOutput?: OrchestratorPorts['recoverMissingToolOutput'];
  terminateWorker?: OrchestratorPorts['terminateWorker'];
  submitBlockedIssueInputNative?: OrchestratorPorts['submitBlockedIssueInputNative'];
  resolveProgressSignals?: OrchestratorPorts['resolveProgressSignals'];
  logger?: StructuredLogger;
  persistence?: OrchestratorPersistencePort;
} = {}): Harness {
  const tracker = makeTracker();
  const now = { value: 1_000_000 };
  const scheduled = new Map<string, { callback: () => Promise<void>; due_at_ms: number; handle: object }>();
  const terminated: Array<{ issue_id: string; cleanup_workspace: boolean; reason: string }> = [];
  const spawned: Array<{ issue_id: string; attempt: number | null; worker_host?: string | null; resume_context?: string | null }> = [];

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
    (async ({ issue, attempt, worker_host, resume_context }) => {
      spawned.push({ issue_id: issue.id, attempt, worker_host, resume_context });
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
      recoverMissingToolOutput: options.recoverMissingToolOutput,
      terminateWorker:
        options.terminateWorker ??
        (async ({ issue_id, cleanup_workspace, reason }) => {
          terminated.push({ issue_id, cleanup_workspace, reason });
        }),
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
      submitBlockedIssueInputNative: options.submitBlockedIssueInputNative,
      resolveProgressSignals: options.resolveProgressSignals,
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

  it('prevents duplicate dispatch while overlapping ticks wait for worker spawn', async () => {
    const issue = makeIssue({ id: 'i-overlap', identifier: 'ABC-OVERLAP' });
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const harness = createHarness({
      spawnWorker: async ({ issue: spawnedIssue, attempt, worker_host, resume_context }) => {
        harness.spawned.push({ issue_id: spawnedIssue.id, attempt, worker_host, resume_context });
        await spawnGate;
        return {
          ok: true,
          worker_handle: { issue_id: spawnedIssue.id },
          monitor_handle: { issue_id: spawnedIssue.id },
          worker_host
        };
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);

    const firstTick = harness.orchestrator.tick('interval');
    await vi.waitFor(() => expect(harness.spawned).toHaveLength(1));

    const secondTick = harness.orchestrator.tick('manual_refresh');
    await Promise.resolve();
    releaseSpawn();
    await Promise.all([firstTick, secondTick]);

    expect(harness.spawned).toEqual([{ issue_id: 'i-overlap', attempt: null, worker_host: null, resume_context: null }]);
    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.running.has('i-overlap')).toBe(true);
    expect(
      snapshot.recent_runtime_events.some((event) => event.event === CANONICAL_EVENT.orchestration.dispatchDuplicateSkipped)
    ).toBe(true);
  });

  it('releases pre-spawn claim after spawn failure so a later eligible tick retries', async () => {
    const issue = makeIssue({ id: 'i-spawn-release', identifier: 'ABC-SPAWN-RELEASE' });
    const harness = createHarness({
      spawnWorker: async ({ issue: spawnedIssue, attempt, worker_host, resume_context }) => {
        harness.spawned.push({ issue_id: spawnedIssue.id, attempt, worker_host, resume_context });
        if (harness.spawned.length === 1) {
          return { ok: false, error: 'workspace provisioning failed' };
        }
        return {
          ok: true,
          worker_handle: { issue_id: spawnedIssue.id },
          monitor_handle: { issue_id: spawnedIssue.id },
          worker_host
        };
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);

    await harness.orchestrator.tick('interval');

    let snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.claimed.has('i-spawn-release')).toBe(true);
    expect(snapshot.running.has('i-spawn-release')).toBe(false);
    expect(snapshot.retry_attempts.get('i-spawn-release')?.stop_reason_code).toBe(REASON_CODES.spawnFailed);

    const internals = harness.orchestrator as unknown as {
      state: {
        redispatch_progress: Map<
          string,
          Array<{ at_ms: number; commit_sha: string | null; checklist_checkpoint: string | null; state_marker: string | null; pr_open: boolean }>
        >;
      };
    };
    internals.state.redispatch_progress = new Map([
      [
        'i-spawn-release',
        [{ at_ms: harness.now.value - 1, commit_sha: 'sha-old', checklist_checkpoint: 'chk-old', state_marker: null, pr_open: false }]
      ]
    ]);

    await harness.scheduled.get('i-spawn-release')?.callback();

    snapshot = harness.orchestrator.getStateSnapshot();
    expect(harness.spawned.map((entry) => entry.issue_id)).toEqual(['i-spawn-release', 'i-spawn-release']);
    expect(snapshot.running.has('i-spawn-release')).toBe(true);
    expect(snapshot.retry_attempts.has('i-spawn-release')).toBe(false);
  });

  it('skips dispatch when github-linking mode is required and issue has no linked GitHub issue', async () => {
    const harness = createHarness({ configOverrides: { github_linking_mode: 'required' } });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-missing-link', identifier: 'ABC-GL-1', has_github_issue_link: false })
    ]);

    await harness.orchestrator.tick('interval');

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(harness.spawned).toHaveLength(0);
    expect(snapshot.health.last_error).toContain('missing linked GitHub issue');
    expect(snapshot.recent_runtime_events.some((entry) => entry.event === CANONICAL_EVENT.tracker.githubIssueLinkMissing)).toBe(
      true
    );
  });

  it('logs github-link warning but still dispatches when mode is warn', async () => {
    const harness = createHarness({ configOverrides: { github_linking_mode: 'warn' } });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-warn-link', identifier: 'ABC-GL-2', has_github_issue_link: false })
    ]);

    await harness.orchestrator.tick('interval');

    expect(harness.spawned.map((entry) => entry.issue_id)).toEqual(['i-warn-link']);
    expect(
      harness.orchestrator
        .getStateSnapshot()
        .recent_runtime_events.some((entry) => entry.event === CANONICAL_EVENT.tracker.githubIssueLinkMissing)
    ).toBe(true);
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
      { issue_id: 'i-host-1', attempt: null, worker_host: 'build-1', resume_context: null },
      { issue_id: 'i-host-2', attempt: null, worker_host: 'build-2', resume_context: null }
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
    expect(retryEntry?.stop_reason_code).toBe('slots_exhausted');
    expect(harness.spawned).toEqual([{ issue_id: 'i-capacity-1', attempt: null, worker_host: 'build-1', resume_context: null }]);
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
    expect(retryEntry?.stop_reason_code).toBe('normal_completion');
    expect(retryEntry?.due_at_ms).toBe(harness.now.value + 1000);
  });

  it('does not schedule continuation retry when normal exit reached a handoff state', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-handoff' })]);
    await harness.orchestrator.tick('interval');

    await harness.orchestrator.onWorkerExit('i-handoff', 'normal', undefined, {
      completion_reason: 'handoff_state_reached',
      refreshed_state: 'Agent Review'
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.retry_attempts.has('i-handoff')).toBe(false);
    expect(snapshot.completed.has('i-handoff')).toBe(true);
    expect(harness.terminated).toEqual([]);
  });

  it('dispatches Agent Review after handoff as a fresh run without implementation context', async () => {
    const harness = createHarness({
      configOverrides: {
        active_states: ['Todo', 'In Progress', 'Agent Review'],
        fresh_dispatch_states: ['Agent Review']
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-agent-review', state: 'In Progress' })]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-agent-review', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'implementation-thread',
      turn_id: 'implementation-turn',
      session_id: 'implementation-session'
    });

    await harness.orchestrator.onWorkerExit('i-agent-review', 'normal', undefined, {
      completion_reason: REASON_CODES.handoffStateReached,
      refreshed_state: 'Agent Review'
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-agent-review', state: 'Agent Review' })]);
    await harness.orchestrator.tick('interval');

    expect(harness.spawned).toEqual([
      { issue_id: 'i-agent-review', attempt: null, worker_host: null, resume_context: null },
      { issue_id: 'i-agent-review', attempt: null, worker_host: null, resume_context: null }
    ]);
    const running = harness.orchestrator.getStateSnapshot().running.get('i-agent-review');
    expect(running?.retry_attempt).toBe(0);
    expect(running?.thread_id).toBeNull();
    expect(running?.session_id).toBeNull();
  });

  it('claimed/running protection prevents duplicate Agent Review fresh runs', async () => {
    const harness = createHarness({
      configOverrides: {
        active_states: ['Todo', 'In Progress', 'Agent Review'],
        fresh_dispatch_states: ['Agent Review']
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-review-claimed', state: 'Agent Review' })]);

    await harness.orchestrator.tick('interval');
    await harness.orchestrator.tick('interval');

    expect(harness.spawned).toEqual([
      { issue_id: 'i-review-claimed', attempt: null, worker_host: null, resume_context: null }
    ]);
    expect(harness.orchestrator.getStateSnapshot().claimed.has('i-review-claimed')).toBe(true);
  });

  it('dispatches stale retry state in Agent Review as fresh without prior thread lineage', async () => {
    const harness = createHarness({
      configOverrides: {
        active_states: ['Todo', 'In Progress', 'Agent Review'],
        fresh_dispatch_states: ['Agent Review']
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-stale-review', state: 'In Progress' })]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-stale-review', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'implementation-thread',
      turn_id: 'implementation-turn',
      session_id: 'implementation-session'
    });
    await harness.orchestrator.onWorkerExit('i-stale-review', 'abnormal', 'transient implementation failure');

    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-stale-review', state: 'Agent Review' })]);
    await harness.orchestrator.onRetryTimer('i-stale-review');

    expect(harness.spawned).toEqual([
      { issue_id: 'i-stale-review', attempt: null, worker_host: null, resume_context: null },
      { issue_id: 'i-stale-review', attempt: null, worker_host: null, resume_context: null }
    ]);
    const running = harness.orchestrator.getStateSnapshot().running.get('i-stale-review');
    expect(running?.retry_attempt).toBe(0);
    expect(running?.thread_id).toBeNull();
    expect(running?.session_id).toBeNull();
  });

  it('records Agent Review handoff and routed fresh review completion as healthy non-cleanup exits', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    const harness = createHarness({
      logger,
      configOverrides: {
        active_states: ['Todo', 'In Progress', 'Agent Review', 'Merging', 'Rework'],
        fresh_dispatch_states: ['Agent Review']
      }
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-review-lifecycle', state: 'In Progress' })]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-review-lifecycle', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'implementation-thread',
      turn_id: 'implementation-turn',
      session_id: 'implementation-session'
    });

    await harness.orchestrator.onWorkerExit('i-review-lifecycle', 'normal', undefined, {
      completion_reason: REASON_CODES.handoffStateReached,
      refreshed_state: 'Agent Review'
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-review-lifecycle', state: 'Agent Review' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit('i-review-lifecycle', 'normal', undefined, {
      completion_reason: REASON_CODES.freshDispatchStateRouted,
      refreshed_state: 'In Progress'
    });

    expect(harness.spawned).toEqual([
      { issue_id: 'i-review-lifecycle', attempt: null, worker_host: null, resume_context: null },
      { issue_id: 'i-review-lifecycle', attempt: null, worker_host: null, resume_context: null }
    ]);
    expect(harness.terminated).toEqual([]);
    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.retry_attempts.has('i-review-lifecycle')).toBe(false);
    expect(snapshot.completed.has('i-review-lifecycle')).toBe(true);
    expect(logs.filter((entry) => entry.event === CANONICAL_EVENT.orchestration.workerExitHandled).map((entry) => entry.context)).toEqual([
      expect.objectContaining({
        issue_id: 'i-review-lifecycle',
        outcome: 'completed',
        completion_reason: REASON_CODES.handoffStateReached,
        stop_reason_code: REASON_CODES.handoffStateReached,
        cleanup_workspace: false
      }),
      expect.objectContaining({
        issue_id: 'i-review-lifecycle',
        outcome: 'completed',
        completion_reason: REASON_CODES.freshDispatchStateRouted,
        stop_reason_code: REASON_CODES.freshDispatchStateRouted,
        refreshed_state: 'In Progress',
        cleanup_workspace: false
      })
    ]);
    expect(logs.some((entry) => entry.event === CANONICAL_EVENT.orchestration.workerStalled)).toBe(false);
    expect(
      logs.some(
        (entry) =>
          entry.context.stop_reason_code === REASON_CODES.workerExitAbnormal ||
          entry.context.stop_reason_code === REASON_CODES.workerStalled
      )
    ).toBe(false);
  });

  it('quarantines late prior-review events after a fresh same-issue fix dispatch without polluting active run activity', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    const harness = createHarness({
      logger,
      configOverrides: {
        active_states: ['In Progress', 'Agent Review'],
        fresh_dispatch_states: ['Agent Review', 'In Progress']
      }
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-review-to-fix', identifier: 'NIE-79', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-review-to-fix', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session',
      codex_app_server_pid: 1001
    });
    await harness.orchestrator.onWorkerExit('i-review-to-fix', 'normal', undefined, {
      completion_reason: REASON_CODES.freshDispatchStateRouted,
      refreshed_state: 'In Progress'
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-review-to-fix', identifier: 'NIE-79', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-review-to-fix', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'fix-thread',
      turn_id: 'fix-turn',
      session_id: 'fix-session',
      codex_app_server_pid: 2002
    });

    harness.orchestrator.onWorkerEvent('i-review-to-fix', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'late review heartbeat',
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session',
      codex_app_server_pid: 1001
    });
    harness.orchestrator.onWorkerEvent('i-review-to-fix', {
      timestamp_ms: harness.now.value + 30,
      event: CANONICAL_EVENT.codex.turnCompleted,
      detail: 'late review completion',
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session',
      codex_app_server_pid: 1001
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    const running = snapshot.running.get('i-review-to-fix');
    expect(running?.thread_id).toBe('fix-thread');
    expect(running?.turn_id).toBe('fix-turn');
    expect(running?.session_id).toBe('fix-session');
    expect(running?.codex_app_server_pid).toBe('2002');
    expect(running?.last_event).toBe(CANONICAL_EVENT.codex.turnStarted);
    expect(running?.last_codex_timestamp_ms).toBe(harness.now.value + 10);
    expect(running?.recent_events).toEqual([
      {
        at_ms: harness.now.value + 10,
        event: CANONICAL_EVENT.codex.turnStarted,
        message: null
      }
    ]);
    expect(running?.quarantined_event_count).toBe(2);
    expect(running?.quarantined_events).toEqual([
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.turnWaiting,
        message: 'late review heartbeat',
        thread_id: 'review-thread',
        turn_id: 'review-turn',
        session_id: 'review-session',
        active_thread_id: 'fix-thread',
        active_turn_id: 'fix-turn',
        active_session_id: 'fix-session',
        reason: 'inactive_worker_pid'
      }),
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.turnCompleted,
        message: 'late review completion',
        thread_id: 'review-thread',
        turn_id: 'review-turn',
        session_id: 'review-session',
        active_thread_id: 'fix-thread',
        active_turn_id: 'fix-turn',
        active_session_id: 'fix-session',
        reason: 'inactive_worker_pid'
      })
    ]);
    expect(
      snapshot.recent_runtime_events.some((event) => event.event === CANONICAL_EVENT.orchestration.staleWorkerEventIgnored)
    ).toBe(false);
    expect(logs.filter((entry) => entry.event === CANONICAL_EVENT.orchestration.staleWorkerEventIgnored)).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          active_thread_id: 'fix-thread',
          event_thread_id: 'review-thread',
          active_turn_id: 'fix-turn',
          event_turn_id: 'review-turn',
          active_session_id: 'fix-session',
          event_session_id: 'review-session',
          event: CANONICAL_EVENT.codex.turnWaiting
        })
      }),
      expect.objectContaining({
        context: expect.objectContaining({
          active_thread_id: 'fix-thread',
          event_thread_id: 'review-thread',
          active_turn_id: 'fix-turn',
          event_turn_id: 'review-turn',
          active_session_id: 'fix-session',
          event_session_id: 'review-session',
          event: CANONICAL_EVENT.codex.turnCompleted
        })
      })
    ]);
  });

  it('does not schedule continuation retry when normal exit left active states', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-paused' })]);
    await harness.orchestrator.tick('interval');

    await harness.orchestrator.onWorkerExit('i-paused', 'normal', undefined, {
      completion_reason: 'issue_left_active_states',
      refreshed_state: 'Paused'
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.retry_attempts.has('i-paused')).toBe(false);
    expect(snapshot.completed.has('i-paused')).toBe(true);
    expect(harness.terminated).toEqual([]);
  });

  it('does not schedule continuation retry when normal exit has no refreshed issue', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-missing-refresh' })]);
    await harness.orchestrator.tick('interval');

    await harness.orchestrator.onWorkerExit('i-missing-refresh', 'normal', undefined, {
      completion_reason: 'issue_state_missing'
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.retry_attempts.has('i-missing-refresh')).toBe(false);
    expect(snapshot.completed.has('i-missing-refresh')).toBe(true);
    expect(harness.terminated).toEqual([]);
  });

  it('applies terminal cleanup without scheduling continuation when normal exit reached a terminal state', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-terminal' })]);
    await harness.orchestrator.tick('interval');

    await harness.orchestrator.onWorkerExit('i-terminal', 'normal', undefined, {
      completion_reason: 'terminal_state_reached',
      refreshed_state: 'Done'
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.retry_attempts.has('i-terminal')).toBe(false);
    expect(snapshot.completed.has('i-terminal')).toBe(true);
    expect(harness.terminated).toEqual([
      { issue_id: 'i-terminal', cleanup_workspace: true, reason: 'terminal_state_transition' }
    ]);
  });

  it('moves abnormal retry to blocked no-progress state when redispatch gate fails', async () => {
    const harness = createHarness({ configOverrides: { max_retry_backoff_ms: 25_000 } });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-abnormal' })]);
    await harness.orchestrator.tick('interval');

    harness.now.value += 1;
    await harness.orchestrator.onWorkerExit('i-abnormal', 'abnormal');

    const firstRetry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-abnormal');
    expect(firstRetry?.attempt).toBe(1);
    expect(firstRetry?.stop_reason_code).toBe('worker_exit_abnormal');
    expect(firstRetry?.due_at_ms).toBe(harness.now.value + 10_000);

    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-abnormal' })]);
    await harness.orchestrator.onRetryTimer('i-abnormal');
    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.retry_attempts.has('i-abnormal')).toBe(false);
    expect(snapshot.blocked_inputs.get('i-abnormal')?.stop_reason_code).toBe('operator_action_required_no_progress_redispatch_blocked');
  });

  it('moves turn_input_required exits into blocked input state without scheduling retries', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-blocked-input' })]);
    await harness.orchestrator.tick('interval');

    await harness.orchestrator.onWorkerExit(
      'i-blocked-input',
      'abnormal',
      'tool requestUserInput could not be auto-answered (turn_input_required)'
    );

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.retry_attempts.has('i-blocked-input')).toBe(false);
    expect(snapshot.blocked_inputs.get('i-blocked-input')?.stop_reason_code).toBe('turn_input_required');
    expect(snapshot.blocked_inputs.get('i-blocked-input')?.requires_manual_resume).toBe(true);
    expect(snapshot.blocked_inputs.get('i-blocked-input')?.conflict_files).toEqual([]);
    expect(snapshot.blocked_inputs.get('i-blocked-input')?.resolution_hints).toEqual([]);
  });

  it('moves workspace conflict exits into blocked input state without scheduling retries', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-workspace-conflict' })]);
    await harness.orchestrator.tick('interval');

    await harness.orchestrator.onWorkerExit(
      'i-workspace-conflict',
      'abnormal',
      'workspace_conflict:{"code":"operator_action_required_workspace_conflict","detail":"workspace_unprovisioned_conflict: worktree_branch_conflict","conflict_files":[{"path":"src/orchestrator/core.ts","status":"unstaged"}],"resolution_hints":["Resolve worktree branch mismatch and resume manually."]}'
    );

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.retry_attempts.has('i-workspace-conflict')).toBe(false);
    expect(snapshot.blocked_inputs.get('i-workspace-conflict')).toMatchObject({
      stop_reason_code: 'operator_action_required_workspace_conflict',
      requires_manual_resume: true,
      conflict_files: [{ path: 'src/orchestrator/core.ts', status: 'unstaged' }],
      resolution_hints: ['Resolve worktree branch mismatch and resume manually.']
    });
  });

  it('infers conflict_files for non-prefixed workspace conflict details', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-workspace-conflict-inferred' })]);
    await harness.orchestrator.tick('interval');

    await harness.orchestrator.onWorkerExit(
      'i-workspace-conflict-inferred',
      'abnormal',
      'workspace_unprovisioned_conflict: worktree_branch_conflict'
    );

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.retry_attempts.has('i-workspace-conflict-inferred')).toBe(false);
    expect(snapshot.blocked_inputs.get('i-workspace-conflict-inferred')).toMatchObject({
      stop_reason_code: 'operator_action_required_workspace_conflict',
      requires_manual_resume: true,
      conflict_files: [{ path: '.git/HEAD', status: 'unknown' }]
    });
  });

  it('does not map unrelated destination-conflict text to workspace conflict stop reason', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-non-workspace-conflict' })]);
    await harness.orchestrator.tick('interval');

    await harness.orchestrator.onWorkerExit(
      'i-non-workspace-conflict',
      'abnormal',
      'upload validation failed: destination conflict in artifacts directory'
    );

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.blocked_inputs.has('i-non-workspace-conflict')).toBe(false);
    expect(snapshot.retry_attempts.get('i-non-workspace-conflict')?.stop_reason_code).toBe('worker_exit_abnormal');
  });

  it('does not redispatch blocked workspace-conflict issues across repeated scheduler ticks until explicit resume', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-workspace-conflict-blocked', identifier: 'ABC-BLOCK' })]);
    await harness.orchestrator.tick('interval');

    await harness.orchestrator.onWorkerExit(
      'i-workspace-conflict-blocked',
      'abnormal',
      'workspace_conflict:{"code":"operator_action_required_workspace_conflict","detail":"workspace_unprovisioned_conflict: worktree_branch_conflict","conflict_files":[{"path":"src/api/server.ts","status":"staged"}],"resolution_hints":["Resolve and resume."]}'
    );

    const spawnedBeforeTicks = harness.spawned.length;
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-workspace-conflict-blocked', identifier: 'ABC-BLOCK', state: 'In Progress' })
    ]);
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-workspace-conflict-blocked', identifier: 'ABC-BLOCK', state: 'In Progress' })
    ]);

    await harness.orchestrator.tick('interval');
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.tick('interval');

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.blocked_inputs.has('i-workspace-conflict-blocked')).toBe(true);
    expect(snapshot.retry_attempts.has('i-workspace-conflict-blocked')).toBe(false);
    expect(harness.spawned.length).toBe(spawnedBeforeTicks);

    const resumed = await harness.orchestrator.resumeBlockedIssue('ABC-BLOCK', null, null, {
      actor: 'operator@example.test',
      reason_note: 'workspace conflict resolved'
    });
    expect(resumed).toEqual({ ok: true, issue_id: 'i-workspace-conflict-blocked' });
    expect(harness.spawned.length).toBe(spawnedBeforeTicks + 1);
  });

  it('keeps restored blocked suppression active until explicit resume', async () => {
    const harness = createHarness();
    harness.orchestrator.restoreSuppressionState({
      blocked_entries: [
        {
          issue_id: 'i-restored',
          issue_identifier: 'ABC-RESTORE',
          attempt: 2,
          worker_host: null,
          workspace_path: null,
          provisioner_type: null,
          branch_name: null,
          repo_root: null,
          workspace_exists: true,
          workspace_git_status: 'dirty',
          workspace_provisioned: true,
          workspace_is_git_worktree: true,
          copy_ignored_applied: false,
          copy_ignored_status: null,
          copy_ignored_summary: null,
          stop_reason_code: 'operator_action_required_no_progress_redispatch_blocked',
          stop_reason_detail: 'blocked',
          conflict_files: [],
          resolution_hints: [],
          previous_thread_id: null,
          previous_session_id: null,
          last_phase: null,
          last_phase_at_ms: null,
          last_phase_detail: null,
          blocked_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
          requires_manual_resume: true,
          pending_input: null,
          last_input_submit: null,
          resume_history: [],
          session_console: []
        }
      ],
      breaker_entries: []
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-restored', identifier: 'ABC-RESTORE', state: 'In Progress' })
    ]);
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-restored', identifier: 'ABC-RESTORE', state: 'In Progress' })
    ]);

    await harness.orchestrator.tick('interval');
    await harness.orchestrator.tick('interval');
    expect(harness.spawned.find((entry) => entry.issue_id === 'i-restored')).toBeUndefined();

    const resumed = await harness.orchestrator.resumeBlockedIssue('ABC-RESTORE', null, 'manual override', {
      actor: 'operator@example.test',
      reason_note: 'manual override accepted'
    });
    expect(resumed).toEqual({ ok: true, issue_id: 'i-restored' });
    expect(harness.spawned.find((entry) => entry.issue_id === 'i-restored')).toBeDefined();
  });

  it('persists and restores operator action outcomes around manual resume', async () => {
    const persistedActions = new Map<string, string>();
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'run-operator-action',
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async () => undefined,
      upsertOperatorActions: async (issueId, payload) => {
        persistedActions.set(issueId, payload);
      }
    };
    const harness = createHarness({
      configOverrides: { respawn_max_attempts_without_progress: 1 },
      persistence
    });
    harness.orchestrator.restoreSuppressionState({
      blocked_entries: [
        {
          issue_id: 'i-action-trail',
          issue_identifier: 'ABC-ACTION',
          attempt: 1,
          worker_host: null,
          workspace_path: null,
          provisioner_type: null,
          branch_name: null,
          repo_root: null,
          workspace_exists: true,
          workspace_git_status: 'clean',
          workspace_provisioned: true,
          workspace_is_git_worktree: true,
          stop_reason_code: 'operator_action_required_no_progress_redispatch_blocked',
          stop_reason_detail: 'completion gate blocked redispatch because no progress signal was detected',
          conflict_files: [],
          resolution_hints: [],
          previous_thread_id: null,
          previous_session_id: null,
          blocked_at_ms: harness.now.value,
          requires_manual_resume: true,
          progress_signals: { commit_sha: null, checklist_checkpoint: null, state_marker: null },
          pending_input: null,
          session_console: []
        }
      ],
      breaker_entries: []
    });
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-action-trail', identifier: 'ABC-ACTION', state: 'In Progress' })
    ]);

    const rejected = await harness.orchestrator.resumeBlockedIssue('ABC-ACTION', null, null, {
      actor: 'operator@example.test',
      reason_note: 'progress evidence missing'
    });
    expect(rejected.ok).toBe(false);
    expect(persistedActions.get('i-action-trail')).toContain('resume_failed');

    const restored = createHarness();
    restored.orchestrator.restoreSuppressionState({
      blocked_entries: Array.from(harness.orchestrator.getStateSnapshot().blocked_inputs.values()),
      breaker_entries: [],
      operator_actions: new Map([['i-action-trail', JSON.parse(persistedActions.get('i-action-trail') ?? '[]')]])
    });
    expect(restored.orchestrator.getStateSnapshot().operator_actions?.get('i-action-trail')).toEqual([
      expect.objectContaining({
        action: 'resume',
        result: 'rejected',
        result_code: 'resume_failed'
      })
    ]);

    restored.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-action-trail', identifier: 'ABC-ACTION', state: 'In Progress' })
    ]);
    const accepted = await restored.orchestrator.resumeBlockedIssue('ABC-ACTION', null, 'operator reviewed trail', {
      actor: 'operator@example.test',
      reason_note: 'operator reviewed trail'
    });
    expect(accepted).toEqual({ ok: true, issue_id: 'i-action-trail' });
    expect(restored.orchestrator.getStateSnapshot().operator_actions?.get('i-action-trail')).toEqual([
      expect.objectContaining({ result: 'rejected' }),
      expect.objectContaining({ result: 'accepted' })
    ]);
  });

  it('resumes blocked issue via manual resume API path and dispatches immediately when eligible', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-resume', identifier: 'ABC-RESUME' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit(
      'i-resume',
      'abnormal',
      'tool requestUserInput could not be auto-answered (turn_input_required)'
    );

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-resume', identifier: 'ABC-RESUME', state: 'In Progress' })
    ]);

    const resumed = await harness.orchestrator.resumeBlockedIssue('ABC-RESUME', null, null, {
      actor: 'operator@example.test',
      reason_note: 'input request answered'
    });
    expect(resumed).toEqual({ ok: true, issue_id: 'i-resume' });
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-resume')).toBe(false);
    expect(harness.spawned.map((entry) => entry.issue_id)).toContain('i-resume');
  });

  it('allows resume without override when real progress signals changed', async () => {
    let commit = 'sha-old';
    const harness = createHarness({
      configOverrides: { respawn_max_attempts_without_progress: 1 },
      resolveProgressSignals: async ({ fallback_state_marker }) => ({
        commit_sha: commit,
        checklist_checkpoint: 'chk-1',
        state_marker: fallback_state_marker
      })
    });
    const issue = makeIssue({
      id: 'i-progress',
      identifier: 'ABC-PROGRESS',
      state: 'In Progress',
      tracker_meta: {
        tracker_kind: 'github',
        repository: 'repo/name',
        pr_links: [{ number: 1, url: 'https://example.test/pr/1', state: 'open', merged: false }]
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit('i-progress', 'abnormal', 'worker exited');
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get('i-progress')?.callback();

    commit = 'sha-new';
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([issue]);
    const resumed = await harness.orchestrator.resumeBlockedIssue('ABC-PROGRESS', null, null, {
      actor: 'operator@example.test',
      reason_note: 'progress signal changed'
    });
    expect(resumed).toEqual({ ok: true, issue_id: 'i-progress' });
  });

  it('blocks redispatch immediately with explicit no-progress reason when completion gate fails', async () => {
    const logs: Array<{ event: string; context?: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context });
      }
    };
    const harness = createHarness({
      logger,
      configOverrides: { respawn_max_attempts_without_progress: 3, respawn_window_minutes: 30 },
      resolveProgressSignals: async ({ fallback_state_marker }) => ({
        commit_sha: 'sha-same',
        checklist_checkpoint: 'chk-same',
        state_marker: fallback_state_marker
      })
    });
    const issue = makeIssue({ id: 'i-gate-block', identifier: 'ABC-GATE', state: 'In Progress' });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit('i-gate-block', 'abnormal', 'worker exited');
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get('i-gate-block')?.callback();

    const blocked = harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-gate-block');
    expect(blocked?.stop_reason_code).toBe('operator_action_required_no_progress_redispatch_blocked');
    expect(blocked?.required_actions).toEqual([
      'Mark acceptance complete and resume',
      'Push additional commit and resume',
      'Cancel and return to backlog'
    ]);
    expect(
      harness.orchestrator
        .getStateSnapshot()
        .recent_runtime_events.some((entry) => entry.event === CANONICAL_EVENT.orchestration.redispatchCompletionGateBlocked)
    ).toBe(true);
    const completionGateLog = logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.redispatchCompletionGateBlocked);
    expect(completionGateLog?.context?.issue_id).toBe('i-gate-block');
    expect(completionGateLog?.context?.issue_identifier).toBe('ABC-GATE');
    expect(completionGateLog?.context?.stop_reason_code).toBe('operator_action_required_no_progress_redispatch_blocked');
    expect(completionGateLog?.context?.next_operator_action).toBe('issue.resume');
    expect(harness.spawned.filter((entry) => entry.issue_id === 'i-gate-block')).toHaveLength(1);
  });

  it('maps no-progress redispatch to awaiting_human_review_scope_incomplete when PR is open', async () => {
    const harness = createHarness({
      resolveProgressSignals: async ({ fallback_state_marker }) => ({
        commit_sha: 'sha-same',
        checklist_checkpoint: 'chk-same',
        state_marker: fallback_state_marker
      })
    });
    const issue = makeIssue({
      id: 'i-awaiting-human',
      identifier: 'ABC-AWAIT',
      state: 'In Progress',
      tracker_meta: {
        tracker_kind: 'github',
        repository: 'repo/name',
        pr_links: [{ number: 7, url: 'https://example.test/pr/7', state: 'open', merged: false }]
      },
      description: '- [ ] Acceptance item remains open'
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit('i-awaiting-human', 'abnormal', 'worker exited');
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get('i-awaiting-human')?.callback();

    const blocked = harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-awaiting-human');
    expect(blocked?.stop_reason_code).toBe('awaiting_human_review_scope_incomplete');
    expect(
      harness.orchestrator
        .getStateSnapshot()
        .recent_runtime_events.some(
          (entry) => entry.event === CANONICAL_EVENT.orchestration.stateAwaitingHumanReviewScopeIncomplete
        )
    ).toBe(true);
  });

  it('emits circuit-breaker-opened event when no-progress attempts in window exceed threshold', async () => {
    const logs: Array<{ event: string; context?: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context });
      }
    };
    const harness = createHarness({
      logger,
      configOverrides: { respawn_max_attempts_without_progress: 1, respawn_window_minutes: 30 },
      resolveProgressSignals: async ({ fallback_state_marker }) => ({
        commit_sha: 'sha-same',
        checklist_checkpoint: 'chk-same',
        state_marker: fallback_state_marker
      })
    });
    const issue = makeIssue({ id: 'i-breaker', identifier: 'ABC-BREAKER', state: 'In Progress' });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit('i-breaker', 'abnormal', 'worker exited');
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get('i-breaker')?.callback();

    expect(
      harness.orchestrator
        .getStateSnapshot()
        .recent_runtime_events.some((entry) => entry.event === CANONICAL_EVENT.orchestration.redispatchCircuitBreakerOpened)
    ).toBe(true);
    const breakerLog = logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.redispatchCircuitBreakerOpened);
    expect(breakerLog?.context?.issue_id).toBe('i-breaker');
    expect(breakerLog?.context?.issue_identifier).toBe('ABC-BREAKER');
    expect(breakerLog?.context?.next_operator_action_endpoint).toBe('/api/v1/issues/:issue_identifier/resume');
  });

  it('emits completion gate and breaker transition events once for an already blocked issue', async () => {
    const logs: Array<{ event: string; context?: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context });
      }
    };
    const harness = createHarness({
      logger,
      configOverrides: { respawn_max_attempts_without_progress: 1, respawn_window_minutes: 30 },
      resolveProgressSignals: async ({ fallback_state_marker }) => ({
        commit_sha: 'sha-same',
        checklist_checkpoint: 'chk-same',
        state_marker: fallback_state_marker
      })
    });
    const issue = makeIssue({ id: 'i-once', identifier: 'ABC-ONCE', state: 'In Progress' });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit('i-once', 'abnormal', 'worker exited');
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get('i-once')?.callback();
    await harness.orchestrator.onWorkerExit('i-once', 'abnormal', 'worker exited');
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get('i-once')?.callback();

    const completionEventCount = logs.filter(
      (entry) => entry.event === CANONICAL_EVENT.orchestration.redispatchCompletionGateBlocked
    ).length;
    const breakerEventCount = logs.filter(
      (entry) => entry.event === CANONICAL_EVENT.orchestration.redispatchCircuitBreakerOpened
    ).length;
    expect(completionEventCount).toBe(1);
    expect(breakerEventCount).toBe(1);
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.size).toBe(1);
  });

  it('requires override for no-progress resume and allows resume with explicit override reason', async () => {
    const harness = createHarness({
      configOverrides: { respawn_max_attempts_without_progress: 1 },
      resolveProgressSignals: async () => ({
        commit_sha: 'sha-same',
        checklist_checkpoint: 'chk-same',
        state_marker: 'marker-same'
      })
    });
    const issue = makeIssue({ id: 'i-resume-override', identifier: 'ABC-OVERRIDE', state: 'In Progress' });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit('i-resume-override', 'abnormal', 'worker exited');
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get('i-resume-override')?.callback();

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([issue]);
    const withoutOverride = await harness.orchestrator.resumeBlockedIssue('ABC-OVERRIDE', null, null, {
      actor: 'operator@example.test',
      reason_note: 'resume requested'
    });
    expect(withoutOverride).toEqual({
      ok: false,
      code: 'resume_failed',
      message: 'Issue ABC-OVERRIDE requires progress or an explicit resume override reason'
    });

    const withOverride = await harness.orchestrator.resumeBlockedIssue(
      'ABC-OVERRIDE',
      null,
      'operator approved redispatch without new progress',
      {
        actor: 'operator@example.test',
        reason_note: 'operator approved redispatch without new progress'
      }
    );
    expect(withOverride).toEqual({ ok: true, issue_id: 'i-resume-override' });
  });

  it('cancels blocked issue to Todo/backlog state via dedicated path', async () => {
    const logs: Array<{ event: string; context?: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context });
      }
    };
    const harness = createHarness({ logger });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-cancel', identifier: 'ABC-CANCEL' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit(
      'i-cancel',
      'abnormal',
      'workspace_conflict:{"code":"operator_action_required_workspace_conflict","detail":"workspace conflict","conflict_files":[],"resolution_hints":["Resolve and resume."]}'
    );

    const rejected = await harness.orchestrator.cancelBlockedIssue('ABC-CANCEL', 'operator_cancel_return_to_backlog');
    expect(rejected).toEqual({
      ok: false,
      code: 'confirmation_required',
      message: 'Cancel requires explicit confirmation'
    });
    expect(harness.tracker.update_issue_state).not.toHaveBeenCalled();
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-cancel')).toBe(true);

    const cancelled = await harness.orchestrator.cancelBlockedIssue('ABC-CANCEL', 'operator_cancel_return_to_backlog', {
      actor: 'operator@example.test',
      reason_note: 'operator_cancel_return_to_backlog',
      confirmed: true
    });
    expect(cancelled).toEqual({ ok: true, issue_id: 'i-cancel', moved_to_state: 'Todo' });
    expect(harness.tracker.update_issue_state).toHaveBeenCalledWith('i-cancel', 'Todo');
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-cancel')).toBe(false);
    expect(harness.orchestrator.getStateSnapshot().operator_actions?.get('i-cancel')).toEqual([
      expect.objectContaining({
        action: 'cancel',
        actor: 'operator',
        reason_note: 'operator_cancel_return_to_backlog',
        result: 'rejected',
        result_code: 'confirmation_required',
        target_identifiers: expect.objectContaining({
          issue_id: 'i-cancel',
          issue_identifier: 'ABC-CANCEL'
        }),
        pre_state: expect.objectContaining({ runtime_state: 'blocked' }),
        post_state: expect.objectContaining({ runtime_state: 'blocked' })
      }),
      expect.objectContaining({
        action: 'cancel',
        actor: 'operator@example.test',
        reason_note: 'operator_cancel_return_to_backlog',
        result: 'accepted',
        result_code: 'Todo',
        target_identifiers: expect.objectContaining({
          issue_id: 'i-cancel',
          issue_identifier: 'ABC-CANCEL'
        }),
        pre_state: expect.objectContaining({ runtime_state: 'blocked', issue_identifier: 'ABC-CANCEL' }),
        post_state: expect.objectContaining({ runtime_state: 'untracked' })
      })
    ]);
    const cancelLog = logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.cancelToBacklogExecuted);
    expect(cancelLog?.context?.issue_id).toBe('i-cancel');
    expect(cancelLog?.context?.next_operator_action).toBe('issue.state.todo');
  });

  it('requires confirmation before cancelling a running turn and records audit context', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-cancel-turn', identifier: 'ABC-CANCEL-TURN' })]);
    await harness.orchestrator.tick('interval');

    const rejected = await harness.orchestrator.cancelCurrentTurn('ABC-CANCEL-TURN', {
      actor: 'operator@example.test',
      reason_note: 'wrong branch'
    });
    expect(rejected).toEqual({
      ok: false,
      code: 'confirmation_required',
      message: 'Cancel current turn requires explicit confirmation'
    });
    expect(harness.terminated).toEqual([]);

    const accepted = await harness.orchestrator.cancelCurrentTurn('ABC-CANCEL-TURN', {
      actor: 'operator@example.test',
      reason_note: 'wrong branch',
      confirmed: true
    });
    expect(accepted).toEqual({ ok: true, issue_id: 'i-cancel-turn' });
    expect(harness.terminated).toEqual([
      { issue_id: 'i-cancel-turn', cleanup_workspace: false, reason: 'wrong branch' }
    ]);
    expect(harness.orchestrator.getStateSnapshot().operator_actions?.get('i-cancel-turn')).toEqual([
      expect.objectContaining({
        action: 'cancel',
        actor: 'operator@example.test',
        reason_note: 'wrong branch',
        result: 'rejected',
        result_code: 'confirmation_required',
        pre_state: expect.objectContaining({ runtime_state: 'running' }),
        post_state: expect.objectContaining({ runtime_state: 'running' })
      }),
      expect.objectContaining({
        action: 'cancel',
        actor: 'operator@example.test',
        reason_note: 'wrong branch',
        result: 'accepted',
        result_code: 'current_turn_cancelled',
        pre_state: expect.objectContaining({ runtime_state: 'running' }),
        post_state: expect.objectContaining({ runtime_state: 'untracked' })
      })
    ]);
  });

  it('requeues blocked issues and persists immutable audit state transition details', async () => {
    const persistedActions = new Map<string, string>();
    const harness = createHarness({
      persistence: {
        startRun: async () => 'run-requeue',
        recordSession: async () => undefined,
        recordEvent: async () => undefined,
        completeRun: async () => undefined,
        deleteBlockedInput: async () => undefined,
        upsertOperatorActions: async (issueId, payload) => {
          persistedActions.set(issueId, payload);
        }
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-requeue', identifier: 'ABC-REQUEUE' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit(
      'i-requeue',
      'abnormal',
      'workspace_conflict:{"code":"operator_action_required_workspace_conflict","detail":"workspace conflict","conflict_files":[],"resolution_hints":["Resolve and resume."]}'
    );

    const result = await harness.orchestrator.requeueIssue('ABC-REQUEUE', {
      actor: 'operator@example.test',
      reason_note: 'workspace repaired'
    });

    expect(result).toEqual({ ok: true, issue_id: 'i-requeue', retry_attempt: 1 });
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-requeue')).toBe(false);
    expect(harness.orchestrator.getStateSnapshot().retry_attempts.get('i-requeue')).toMatchObject({
      identifier: 'ABC-REQUEUE',
      stop_reason_code: 'operator_requeue_requested'
    });
    const persisted = JSON.parse(persistedActions.get('i-requeue') ?? '[]') as Array<Record<string, unknown>>;
    expect(persisted).toEqual([
      expect.objectContaining({
        action: 'requeue',
        actor: 'operator@example.test',
        reason_note: 'workspace repaired',
        result: 'accepted',
        pre_state: expect.objectContaining({ runtime_state: 'blocked' }),
        post_state: expect.objectContaining({ runtime_state: 'retrying' }),
        target_identifiers: expect.objectContaining({
          issue_id: 'i-requeue',
          issue_identifier: 'ABC-REQUEUE'
        })
      })
    ]);
  });

  it('retries the last failed or stalled retry step where supported', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-retry-step', identifier: 'ABC-RETRY' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit('i-retry-step', 'abnormal', 'worker exited');

    const result = await harness.orchestrator.retryLastFailedStep('ABC-RETRY', {
      actor: 'operator@example.test',
      reason_note: 'transient failure cleared'
    });
    const unsupported = await harness.orchestrator.retryLastFailedStep('ABC-MISSING', {
      actor: 'operator@example.test',
      reason_note: 'try missing'
    });

    expect(result).toEqual({ ok: true, issue_id: 'i-retry-step', retry_attempt: 1 });
    expect(harness.orchestrator.getStateSnapshot().operator_actions?.get('i-retry-step')).toEqual([
      expect.objectContaining({
        action: 'retry_step',
        actor: 'operator@example.test',
        reason_note: 'transient failure cleared',
        result: 'accepted',
        result_code: 'retry_step_scheduled',
        pre_state: expect.objectContaining({ runtime_state: 'retrying' }),
        post_state: expect.objectContaining({ runtime_state: 'retrying' })
      })
    ]);
    expect(unsupported).toEqual({
      ok: false,
      code: 'unsupported_transition',
      message: 'Issue ABC-MISSING has no failed or stalled retry step'
    });
  });

  it('rejects missing reason notes before mutating operator action paths', async () => {
    const runningHarness = createHarness();
    runningHarness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-running-reason', identifier: 'ABC-RUNNING-REASON' })
    ]);
    await runningHarness.orchestrator.tick('interval');
    const cancelMissingReason = await runningHarness.orchestrator.cancelCurrentTurn('ABC-RUNNING-REASON', {
      confirmed: true
    });
    expect(cancelMissingReason).toEqual({ ok: false, code: 'reason_note_required', message: 'reason_note is required' });
    expect(runningHarness.terminated).toEqual([]);
    expect(runningHarness.orchestrator.getStateSnapshot().operator_actions?.get('i-running-reason')).toBeUndefined();

    const blockedHarness = createHarness();
    blockedHarness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-blocked-reason', identifier: 'ABC-BLOCKED-REASON' })
    ]);
    await blockedHarness.orchestrator.tick('interval');
    await blockedHarness.orchestrator.onWorkerExit(
      'i-blocked-reason',
      'abnormal',
      'workspace_conflict:{"code":"operator_action_required_workspace_conflict","detail":"workspace conflict","conflict_files":[],"resolution_hints":["Resolve and resume."]}'
    );
    blockedHarness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-blocked-reason', identifier: 'ABC-BLOCKED-REASON', state: 'In Progress' })
    ]);
    await expect(blockedHarness.orchestrator.requeueIssue('ABC-BLOCKED-REASON', { reason_note: '   ' })).resolves.toEqual({
      ok: false,
      code: 'reason_note_required',
      message: 'reason_note is required'
    });
    await expect(blockedHarness.orchestrator.resumeBlockedIssue('ABC-BLOCKED-REASON')).resolves.toEqual({
      ok: false,
      code: 'reason_note_required',
      message: 'reason_note is required'
    });
    await expect(blockedHarness.orchestrator.cancelBlockedIssue('ABC-BLOCKED-REASON', null, { confirmed: true })).resolves.toEqual({
      ok: false,
      code: 'reason_note_required',
      message: 'reason_note is required'
    });
    expect(blockedHarness.orchestrator.getStateSnapshot().blocked_inputs.has('i-blocked-reason')).toBe(true);
    expect(blockedHarness.orchestrator.getStateSnapshot().retry_attempts.has('i-blocked-reason')).toBe(false);
    expect(blockedHarness.orchestrator.getStateSnapshot().operator_actions?.get('i-blocked-reason')).toBeUndefined();

    const retryHarness = createHarness();
    retryHarness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-retry-reason', identifier: 'ABC-RETRY-REASON' })
    ]);
    await retryHarness.orchestrator.tick('interval');
    await retryHarness.orchestrator.onWorkerExit('i-retry-reason', 'abnormal', 'worker exited');
    const retryMissingReason = await retryHarness.orchestrator.retryLastFailedStep('ABC-RETRY-REASON');
    expect(retryMissingReason).toEqual({ ok: false, code: 'reason_note_required', message: 'reason_note is required' });
    expect(retryHarness.orchestrator.getStateSnapshot().operator_actions?.get('i-retry-reason')).toBeUndefined();

    const submitHarness = createHarness();
    submitHarness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-submit-reason', identifier: 'ABC-SUBMIT-REASON' })
    ]);
    await submitHarness.orchestrator.tick('interval');
    await submitHarness.orchestrator.onWorkerExit(
      'i-submit-reason',
      'abnormal',
      'turn_input_required:{"detail":"operator input required","request_id":"req-reason","prompt_text":"Continue?","questions":[{"id":"q1","prompt":"Continue?","options":[{"label":"Yes"},{"label":"No"}]}]}'
    );
    const submitMissingReason = await submitHarness.orchestrator.submitBlockedIssueInput({
      issue_identifier: 'ABC-SUBMIT-REASON',
      request_id: 'req-reason',
      answer: { question_id: 'q1', option_label: 'Yes' }
    });
    expect(submitMissingReason).toEqual({ ok: false, code: 'reason_note_required', message: 'reason_note is required' });
    expect(submitHarness.orchestrator.getStateSnapshot().operator_actions?.get('i-submit-reason')).toBeUndefined();
  });

  it('returns typed not-answerable error when native blocked input transport is unavailable', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-submit', identifier: 'ABC-SUBMIT' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit(
      'i-submit',
      'abnormal',
      'turn_input_required:{"detail":"operator input required","request_id":"req-123","prompt_text":"Choose deployment action","questions":[{"id":"q1","prompt":"Deploy now?","options":[{"label":"Yes"},{"label":"No"}]}]}'
    );

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-submit', identifier: 'ABC-SUBMIT', state: 'In Progress' })
    ]);

    const result = await harness.orchestrator.submitBlockedIssueInput({
      issue_identifier: 'ABC-SUBMIT',
      request_id: 'req-123',
      actor: 'operator@example.test',
      reason_note: 'answer selected',
      answer: { question_id: 'q1', option_label: 'Yes' }
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'input_submission_transport_unavailable'
    });
  });

  it('submits blocked operator input through native transport when available', async () => {
    const harness = createHarness({
      submitBlockedIssueInputNative: async () => ({ applied: true, code: 'native_applied' })
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-native', identifier: 'ABC-NATIVE' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit(
      'i-native',
      'abnormal',
      'turn_input_required:{"detail":"operator input required","request_id":"req-native","prompt_text":"Continue?","questions":[{"id":"q1","prompt":"Continue?","options":[{"label":"Yes"},{"label":"No"}]}]}'
    );

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-native', identifier: 'ABC-NATIVE', state: 'In Progress' })
    ]);

    const result = await harness.orchestrator.submitBlockedIssueInput({
      issue_identifier: 'ABC-NATIVE',
      request_id: 'req-native',
      actor: 'operator@example.test',
      reason_note: 'continue with selected answer',
      answer: { question_id: 'q1', option_label: 'Yes' }
    });

    expect(result).toMatchObject({
      ok: true,
      issue_id: 'i-native',
      request_id: 'req-native',
      resume_mode: 'native',
      resume_reason_code: 'native_applied'
    });
    const resumedSpawn = harness.spawned.find((entry) => entry.issue_id === 'i-native' && entry.attempt === 2);
    expect(resumedSpawn?.resume_context ?? null).toBeNull();
  });

  it('quarantines late worker events for blocked issues awaiting operator action', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-quarantine', identifier: 'ABC-QUAR' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit(
      'i-quarantine',
      'abnormal',
      'workspace_conflict:{"code":"operator_action_required_workspace_conflict","detail":"workspace conflict","conflict_files":[],"resolution_hints":["Resolve and resume."]}'
    );

    harness.orchestrator.onWorkerEvent('i-quarantine', {
      timestamp_ms: Date.now(),
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'late event after blocked state',
      thread_id: 'thread-stale',
      session_id: 'thread-stale-turn-1'
    });

    const blocked = harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-quarantine');
    expect(blocked?.awaiting_operator).toBe(true);
    expect(blocked?.quarantined_event_count).toBe(1);
    expect(blocked?.quarantined_events?.[0]?.event).toBe(CANONICAL_EVENT.codex.turnWaiting);
    expect(
      harness.orchestrator
        .getStateSnapshot()
        .recent_runtime_events.some((entry) => entry.event === CANONICAL_EVENT.orchestration.blockedWorkerEventQuarantined)
    ).toBe(true);
  });

  it('classifies prolonged codex.turn.waiting as stalled waiting without moving issue to blocked', async () => {
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-wait', identifier: 'ABC-WAIT' })]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-wait', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting for next turn state'
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    const running = harness.orchestrator.getStateSnapshot().running.get('i-wait');
    expect(running?.stalled_waiting_reason).toBe('turn_waiting_threshold_exceeded');
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-wait')).toBe(false);
  });

  it('blocks a dynamic tool call that never records matching tool output by call id', async () => {
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-missing-tool', identifier: 'ABC-MISS-TOOL' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-missing-tool', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-missing',
      turn_id: 'turn-1',
      session_id: 'session-missing'
    });
    harness.orchestrator.onWorkerEvent('i-missing-tool', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      detail: 'dynamic_tool',
      thread_id: 'thread-missing',
      turn_id: 'turn-1',
      session_id: 'session-missing',
      tool_name: 'dynamic_tool',
      tool_call_id: 'call_dynamic_1'
    });
    harness.orchestrator.onWorkerEvent('i-missing-tool', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting for dynamic tool output',
      thread_id: 'thread-missing',
      turn_id: 'turn-1',
      session_id: 'session-missing'
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    await new Promise((resolve) => setImmediate(resolve));

    const blocked = harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-missing-tool');
    expect(blocked).toMatchObject({
      stop_reason_code: REASON_CODES.missingToolOutput,
      requires_manual_resume: true,
      previous_thread_id: 'thread-missing',
      previous_session_id: 'session-missing',
      tool_output_wait: {
        tool_name: 'dynamic_tool',
        call_id: 'call_dynamic_1',
        thread_id: 'thread-missing',
        turn_id: 'turn-1',
        session_id: 'session-missing',
        last_agent_message: 'waiting for dynamic tool output'
      }
    });
    expect(blocked?.tool_output_wait?.elapsed_wait_ms).toBeGreaterThanOrEqual(1_990);
    expect(blocked?.required_actions).toEqual(['Inspect the Codex thread', 'Resume the blocked run', 'Cancel the blocked run']);
    expect(harness.orchestrator.getStateSnapshot().running.has('i-missing-tool')).toBe(false);
    expect(harness.terminated).toEqual([
      { issue_id: 'i-missing-tool', cleanup_workspace: false, reason: REASON_CODES.missingToolOutput }
    ]);
  });

  it('blocks a linear_graphql MCP-style tool call that never records matching tool output by call id', async () => {
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-linear-tool', identifier: 'ABC-LINEAR-TOOL' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-linear-tool', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-linear',
      turn_id: 'turn-linear',
      session_id: 'session-linear'
    });
    harness.orchestrator.onWorkerEvent('i-linear-tool', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      detail: 'linear_graphql',
      thread_id: 'thread-linear',
      turn_id: 'turn-linear',
      session_id: 'session-linear',
      tool_name: 'linear_graphql',
      tool_call_id: 'call_pfKTUH5GFubLHpXfln7UScnU'
    });
    harness.orchestrator.onWorkerEvent('i-linear-tool', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting for linear_graphql output',
      thread_id: 'thread-linear',
      turn_id: 'turn-linear',
      session_id: 'session-linear'
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    await new Promise((resolve) => setImmediate(resolve));

    const blocked = harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-linear-tool');
    expect(blocked?.stop_reason_code).toBe(REASON_CODES.missingToolOutput);
    expect(blocked?.tool_output_wait).toMatchObject({
      tool_name: 'linear_graphql',
      call_id: 'call_pfKTUH5GFubLHpXfln7UScnU',
      thread_id: 'thread-linear',
      turn_id: 'turn-linear',
      session_id: 'session-linear'
    });
  });

  it('blocks a transcript-derived linear_graphql function_call without matching output', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-linear', identifier: 'ABC-TRANSCRIPT-LINEAR' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-linear', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-transcript',
        turn_id: 'turn-transcript',
        session_id: 'session-transcript'
      });
      writeSessionTranscript(codexHome, 'session-transcript.jsonl', [
        {
          timestamp: new Date(harness.now.value + 10).toISOString(),
          session_id: 'session-transcript',
          thread_id: 'thread-transcript',
          turn_id: 'turn-transcript',
          response_item: {
            type: 'function_call',
            name: 'linear_graphql',
            call_id: 'call_transcript_linear'
          }
        }
      ]);
      harness.orchestrator.onWorkerEvent('i-transcript-linear', {
        timestamp_ms: harness.now.value + 20,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting_for_turn_completion elapsed_s=5',
        thread_id: 'thread-transcript',
        turn_id: 'turn-transcript',
        session_id: 'session-transcript'
      });
      harness.now.value += 500;
      await harness.orchestrator.tick('interval');
      expect(harness.orchestrator.getStateSnapshot().running.get('i-transcript-linear')?.tool_call_ledger?.call_transcript_linear).toMatchObject({
        tool_name: 'linear_graphql',
        call_id: 'call_transcript_linear',
        thread_id: 'thread-transcript',
        turn_id: 'turn-transcript',
        session_id: 'session-transcript',
        completion_status: 'pending',
        evidence_sources: ['session_transcript'],
        start_evidence_source: 'session_transcript',
        completion_evidence_source: null
      });
      expect(harness.orchestrator.getStateSnapshot().running.get('i-transcript-linear')?.transcript_tool_call_diagnostics).toContainEqual(
        expect.objectContaining({
          kind: 'function_call',
          call_id: 'call_transcript_linear',
          lineage: 'active_owned',
          reason: 'matches active runtime lineage'
        })
      );

      harness.now.value += 1_500;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      const blocked = harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-transcript-linear');
      expect(blocked?.stop_reason_code).toBe(REASON_CODES.missingToolOutput);
      expect(blocked?.tool_output_wait).toMatchObject({
        tool_name: 'linear_graphql',
        call_id: 'call_transcript_linear',
        thread_id: 'thread-transcript',
        turn_id: 'turn-transcript',
        session_id: 'session-transcript',
        evidence_source: 'session_transcript',
        last_agent_message: 'waiting_for_turn_completion elapsed_s=5'
      });
      expect(blocked?.tool_output_wait?.elapsed_wait_ms).toBeGreaterThanOrEqual(1_990);
    });
  });

  it('classifies transcript missing-tool output by outstanding call age even when planning heartbeats reset generic progress', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-live-regression', identifier: 'NIE-87-LIVE' })]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-live-regression', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-live',
        turn_id: 'turn-live',
        session_id: 'session-live'
      });
      writeSessionTranscript(codexHome, 'session-live.jsonl', [
        {
          timestamp: new Date(harness.now.value + 10).toISOString(),
          session_id: 'session-live',
          thread_id: 'thread-live',
          turn_id: 'turn-live',
          response_item: {
            type: 'function_call',
            name: 'linear_graphql',
            call_id: 'call_live_linear'
          }
        }
      ]);
      harness.orchestrator.onWorkerEvent('i-live-regression', {
        timestamp_ms: harness.now.value + 1_500,
        event: CANONICAL_EVENT.codex.phasePlanning,
        detail: 'waiting_for_turn_completion elapsed_s=1',
        thread_id: 'thread-live',
        turn_id: 'turn-live',
        session_id: 'session-live'
      });
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      expect(harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-live-regression')?.tool_output_wait).toMatchObject({
        tool_name: 'linear_graphql',
        call_id: 'call_live_linear',
        evidence_source: 'session_transcript'
      });
    });
  });

  it('starts guarded same-thread recovery for missing tool output and quarantines interrupted worker events', async () => {
    const recoveries: Array<Parameters<NonNullable<OrchestratorPorts['recoverMissingToolOutput']>>[0]> = [];
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 },
      recoverMissingToolOutput: async (params) => {
        recoveries.push(params);
        return {
          ok: true,
          worker_handle: { recovery: true },
          monitor_handle: { recovery: true },
          worker_host: params.worker_host
        };
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-recover-tool', identifier: 'ABC-RECOVER' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-recover-tool', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-recover',
      turn_id: 'turn-old',
      session_id: 'session-old',
      codex_app_server_pid: 111
    });
    harness.orchestrator.onWorkerEvent('i-recover-tool', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      detail: 'linear_graphql',
      tool_name: 'linear_graphql',
      tool_call_id: 'call_recover',
      thread_id: 'thread-recover',
      turn_id: 'turn-old',
      session_id: 'session-old',
      codex_app_server_pid: 111
    });
    harness.orchestrator.onWorkerEvent('i-recover-tool', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting for linear_graphql output',
      thread_id: 'thread-recover',
      turn_id: 'turn-old',
      session_id: 'session-old',
      codex_app_server_pid: 111
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    await new Promise((resolve) => setImmediate(resolve));

    expect(harness.terminated).toEqual([
      { issue_id: 'i-recover-tool', cleanup_workspace: false, reason: REASON_CODES.missingToolOutputRecoveryInterrupted }
    ]);
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]).toMatchObject({
      previous_thread_id: 'thread-recover',
      previous_turn_id: 'turn-old',
      previous_session_id: 'session-old'
    });
    expect(recoveries[0].recovery_prompt).toContain('Treat the last tool action outcome as indeterminate');
    expect(recoveries[0].recovery_prompt).toContain('Before retrying anything, inspect current local and external state');
    expect(recoveries[0].recovery_prompt).toContain('If the action already took effect, do not repeat it');
    expect(recoveries[0].recovery_prompt).toContain('If the action did not take effect, retry it once');
    expect(recoveries[0].recovery_prompt).toContain('cannot be verified safely');

    harness.orchestrator.onWorkerEvent('i-recover-tool', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'late old heartbeat',
      thread_id: 'thread-recover',
      turn_id: 'turn-old',
      session_id: 'session-old'
    });
    const afterLateOldEvent = harness.orchestrator.getStateSnapshot().running.get('i-recover-tool');
    expect(afterLateOldEvent?.last_event).toBe(CANONICAL_EVENT.orchestration.missingToolOutputRecoveryStarted);
    expect(afterLateOldEvent?.last_message).not.toBe('late old heartbeat');
    expect(afterLateOldEvent?.turn_id).toBe('turn-old');
    expect(afterLateOldEvent?.session_id).toBe('session-old');
    expect(afterLateOldEvent?.outstanding_tool_calls).toEqual({});
    expect(afterLateOldEvent?.quarantined_event_count).toBe(1);
    expect(afterLateOldEvent?.quarantined_events?.[0]).toMatchObject({
      reason: 'lineage_mismatch',
      event: CANONICAL_EVENT.codex.turnWaiting,
      thread_id: 'thread-recover',
      turn_id: 'turn-old',
      session_id: 'session-old',
      codex_app_server_pid: null
    });

    harness.orchestrator.onWorkerEvent('i-recover-tool', {
      timestamp_ms: harness.now.value + 200,
      event: CANONICAL_EVENT.codex.turnStarted,
      detail: 'recovery turn started',
      thread_id: 'thread-recover',
      turn_id: 'turn-recovery',
      session_id: 'session-recovery',
      codex_app_server_pid: 222
    });

    const running = harness.orchestrator.getStateSnapshot().running.get('i-recover-tool');
    expect(running?.recovery).toMatchObject({
      attempt_count: 1,
      mode: 'same_thread_guarded_continuation',
      last_result: 'started',
      previous_thread_id: 'thread-recover',
      previous_turn_id: 'turn-old',
      last_tool_name: 'linear_graphql',
      last_call_id: 'call_recover'
    });
    expect(running?.quarantined_event_count).toBe(1);
    expect(running?.quarantined_events?.[0]?.reason).toBe('lineage_mismatch');
    expect(running?.turn_id).toBe('turn-recovery');
    expect(running?.codex_app_server_pid).toBe('222');
  });

  it.each([
    ['thread/resume failed'],
    ['turn/interrupt failed'],
    ['turn/start failed']
  ])('blocks typed recovery startup failure instead of scheduling a generic retry: %s', async (error) => {
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 },
      recoverMissingToolOutput: async (params) => ({
        ok: true,
        worker_handle: { recovery: true, error },
        monitor_handle: { recovery: true, error },
        worker_host: params.worker_host
      })
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-recover-start-fails', identifier: 'ABC-START-FAIL' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-recover-start-fails', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-start-fail',
      turn_id: 'turn-start-fail',
      session_id: 'session-start-fail'
    });
    harness.orchestrator.onWorkerEvent('i-recover-start-fails', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      tool_name: 'linear_graphql',
      tool_call_id: 'call_start_fail',
      thread_id: 'thread-start-fail',
      turn_id: 'turn-start-fail',
      session_id: 'session-start-fail'
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    await new Promise((resolve) => setImmediate(resolve));

    await harness.orchestrator.onWorkerExit('i-recover-start-fails', 'abnormal', error);

    expect(harness.scheduled.has('i-recover-start-fails')).toBe(false);
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-recover-start-fails')).toMatchObject({
      stop_reason_code: REASON_CODES.missingToolOutputRecoveryStartFailed,
      tool_output_wait: {
        tool_name: 'linear_graphql',
        call_id: 'call_start_fail',
        thread_id: 'thread-start-fail',
        turn_id: 'turn-start-fail',
        session_id: 'session-start-fail'
      },
      recovery: {
        last_result: 'failed',
        last_result_reason_code: REASON_CODES.missingToolOutputRecoveryStartFailed,
        previous_thread_id: 'thread-start-fail',
        previous_turn_id: 'turn-start-fail',
        previous_session_id: 'session-start-fail',
        last_tool_name: 'linear_graphql',
        last_call_id: 'call_start_fail'
      }
    });
  });

  it('treats an intentional replacement recovery turn as the active-owned transcript lineage', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 },
        recoverMissingToolOutput: async (params) => ({
          ok: true,
          worker_handle: { recovery: true },
          monitor_handle: { recovery: true },
          worker_host: params.worker_host
        })
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-recover-owned-transcript', identifier: 'ABC-RECOVER-OWNED' })]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-recover-owned-transcript', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-replacement',
        turn_id: 'turn-original',
        session_id: 'session-original'
      });
      harness.orchestrator.onWorkerEvent('i-recover-owned-transcript', {
        timestamp_ms: harness.now.value + 10,
        event: CANONICAL_EVENT.codex.toolCallStarted,
        tool_name: 'linear_graphql',
        tool_call_id: 'call_original_missing',
        thread_id: 'thread-replacement',
        turn_id: 'turn-original',
        session_id: 'session-original'
      });
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));
      harness.orchestrator.onWorkerEvent('i-recover-owned-transcript', {
        timestamp_ms: harness.now.value + 100,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-replacement',
        turn_id: 'turn-replacement',
        session_id: 'session-replacement',
        codex_app_server_pid: 222
      });
      writeSessionTranscript(codexHome, 'session-replacement.jsonl', [
        {
          timestamp: new Date(harness.now.value + 150).toISOString(),
          thread_id: 'thread-replacement',
          turn_id: 'turn-replacement',
          session_id: 'session-replacement',
          codex_app_server_pid: 222,
          response_item: {
            type: 'function_call',
            name: 'linear_graphql',
            call_id: 'call_replacement_owned'
          }
        }
      ]);
      harness.orchestrator.onWorkerEvent('i-recover-owned-transcript', {
        timestamp_ms: harness.now.value + 200,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting after replacement turn transcript',
        thread_id: 'thread-replacement',
        turn_id: 'turn-replacement',
        session_id: 'session-replacement',
        codex_app_server_pid: 222
      });
      await harness.orchestrator.tick('interval');

      const running = harness.orchestrator.getStateSnapshot().running.get('i-recover-owned-transcript');
      expect(running?.turn_id).toBe('turn-replacement');
      expect(running?.session_id).toBe('session-replacement');
      expect(running?.tool_call_ledger?.call_replacement_owned).toMatchObject({
        completion_status: 'pending',
        thread_id: 'thread-replacement',
        turn_id: 'turn-replacement',
        session_id: 'session-replacement',
        start_evidence_source: 'session_transcript'
      });
      expect(running?.transcript_tool_call_diagnostics).toContainEqual(
        expect.objectContaining({
          call_id: 'call_replacement_owned',
          lineage: 'active_owned',
          active_turn_id: 'turn-replacement',
          active_session_id: 'session-replacement',
          active_codex_app_server_pid: '222'
        })
      );
    });
  });

  it('records recovery success metadata before scheduling same-thread continuation', async () => {
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 },
      recoverMissingToolOutput: async (params) => ({
        ok: true,
        worker_handle: { recovery: true },
        monitor_handle: { recovery: true },
        worker_host: params.worker_host
      })
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-recover-succeeds', identifier: 'ABC-RECOVER-SUCCESS' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-recover-succeeds', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-recover-success',
      turn_id: 'turn-old-success',
      session_id: 'session-old-success'
    });
    harness.orchestrator.onWorkerEvent('i-recover-succeeds', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      tool_name: 'linear_graphql',
      tool_call_id: 'call_recover_success',
      thread_id: 'thread-recover-success',
      turn_id: 'turn-old-success',
      session_id: 'session-old-success'
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    await new Promise((resolve) => setImmediate(resolve));

    await harness.orchestrator.onWorkerExit('i-recover-succeeds', 'normal', undefined, {
      completion_reason: REASON_CODES.maxTurnsReached
    });

    expect(harness.orchestrator.getStateSnapshot().retry_attempts.get('i-recover-succeeds')).toMatchObject({
      stop_reason_code: REASON_CODES.normalCompletion,
      recovery: {
        last_result: 'succeeded',
        last_result_reason_code: REASON_CODES.maxTurnsReached,
        last_tool_name: 'linear_graphql',
        last_call_id: 'call_recover_success'
      }
    });
  });

  it('blocks missing tool output without a previous turn id instead of spawning unrelated recovery', async () => {
    const recover = vi.fn<NonNullable<OrchestratorPorts['recoverMissingToolOutput']>>();
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 },
      recoverMissingToolOutput: recover
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-recover-no-turn', identifier: 'ABC-NO-TURN' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-recover-no-turn', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      detail: 'linear_graphql',
      tool_name: 'linear_graphql',
      tool_call_id: 'call_no_turn'
    });
    harness.orchestrator.onWorkerEvent('i-recover-no-turn', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting for linear_graphql output'
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    await new Promise((resolve) => setImmediate(resolve));

    expect(recover).not.toHaveBeenCalled();
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-recover-no-turn')).toMatchObject({
      stop_reason_code: REASON_CODES.missingToolOutputRecoveryStartFailed,
      recovery: {
        last_result: 'failed',
        last_result_reason_code: REASON_CODES.missingToolOutputRecoveryStartFailed
      }
    });
  });

  it('blocks with recovery exhausted when the automatic recovery limit is reached', async () => {
    const recover = vi.fn<NonNullable<OrchestratorPorts['recoverMissingToolOutput']>>();
    const harness = createHarness({
      configOverrides: {
        running_wait_stall_threshold_ms: 1_000,
        stall_timeout_ms: 60_000,
        missing_tool_output_max_recoveries_per_run: 0
      },
      recoverMissingToolOutput: recover
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-recover-exhausted', identifier: 'ABC-EXHAUST' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-recover-exhausted', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-exhaust',
      turn_id: 'turn-exhaust',
      session_id: 'session-exhaust'
    });
    harness.orchestrator.onWorkerEvent('i-recover-exhausted', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      detail: 'linear_graphql',
      tool_name: 'linear_graphql',
      tool_call_id: 'call_exhaust',
      thread_id: 'thread-exhaust',
      turn_id: 'turn-exhaust',
      session_id: 'session-exhaust'
    });
    harness.orchestrator.onWorkerEvent('i-recover-exhausted', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting for linear_graphql output',
      thread_id: 'thread-exhaust',
      turn_id: 'turn-exhaust',
      session_id: 'session-exhaust'
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    await new Promise((resolve) => setImmediate(resolve));

    expect(recover).not.toHaveBeenCalled();
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-recover-exhausted')).toMatchObject({
      stop_reason_code: REASON_CODES.missingToolOutputRecoveryExhausted,
      recovery: {
        last_result: 'blocked',
        last_result_reason_code: REASON_CODES.missingToolOutputRecoveryExhausted
      }
    });
  });

  it('blocks a real Codex rollout transcript function_call without matching output', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const workspacePath = path.join(codexHome, 'workspaces', 'NIE-79');
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 },
        spawnWorker: async ({ issue, worker_host }) => {
          return {
            ok: true,
            worker_handle: { issue_id: issue.id },
            monitor_handle: { issue_id: issue.id },
            worker_host,
            workspace_path: workspacePath
          };
        }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-rollout', identifier: 'ABC-TRANSCRIPT-ROLLOUT' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-rollout', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-rollout',
        turn_id: 'turn-rollout',
        session_id: 'session-rollout'
      });
      writeSessionTranscript(codexHome, 'rollout-2026-05-07T13-40-00-000Z-abc123.jsonl', [
        {
          timestamp: new Date(harness.now.value + 5).toISOString(),
          type: 'turn_context',
          payload: {
            cwd: workspacePath
          }
        },
        {
          timestamp: new Date(harness.now.value + 10).toISOString(),
          session_id: 'session-rollout',
          thread_id: 'thread-rollout',
          turn_id: 'turn-rollout',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'linear_graphql',
            call_id: 'call_rollout_linear'
          }
        }
      ]);
      harness.orchestrator.onWorkerEvent('i-transcript-rollout', {
        timestamp_ms: harness.now.value + 20,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting_for_turn_completion elapsed_s=5',
        thread_id: 'thread-rollout',
        turn_id: 'turn-rollout',
        session_id: 'session-rollout'
      });
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      expect(harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-transcript-rollout')?.tool_output_wait).toMatchObject({
        tool_name: 'linear_graphql',
        call_id: 'call_rollout_linear',
        thread_id: 'thread-rollout',
        turn_id: 'turn-rollout',
        session_id: 'session-rollout',
        evidence_source: 'session_transcript'
      });
    });
  });

  it('ignores stale same-workspace rollout function_call records from a prior run', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const workspacePath = path.join(codexHome, 'workspaces', 'NIE-79-reused');
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 },
        spawnWorker: async ({ issue, worker_host }) => {
          return {
            ok: true,
            worker_handle: { issue_id: issue.id },
            monitor_handle: { issue_id: issue.id },
            worker_host,
            workspace_path: workspacePath
          };
        }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-rollout-stale', identifier: 'ABC-TRANSCRIPT-ROLLOUT-STALE' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-rollout-stale', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-rollout-current',
        turn_id: 'turn-rollout-current',
        session_id: 'session-rollout-current'
      });
      writeSessionTranscript(codexHome, 'rollout-2026-05-07T12-30-00-000Z-prior.jsonl', [
        {
          timestamp: new Date(harness.now.value - 10_000).toISOString(),
          type: 'turn_context',
          payload: {
            cwd: workspacePath
          }
        },
        {
          timestamp: new Date(harness.now.value - 9_000).toISOString(),
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'linear_graphql',
            call_id: 'call_prior_rollout_same_workspace'
          }
        }
      ]);
      harness.orchestrator.onWorkerEvent('i-transcript-rollout-stale', {
        timestamp_ms: harness.now.value + 20,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting with prior same-workspace transcript present',
        thread_id: 'thread-rollout-current',
        turn_id: 'turn-rollout-current',
        session_id: 'session-rollout-current'
      });
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-transcript-rollout-stale')).toBe(false);
      const running = harness.orchestrator.getStateSnapshot().running.get('i-transcript-rollout-stale');
      expect(running?.outstanding_tool_calls ?? {}).toEqual({});
      expect(running?.tool_call_ledger ?? {}).toEqual({});
      expect(running?.transcript_tool_call_diagnostics).toContainEqual(
        expect.objectContaining({
          kind: 'function_call',
          call_id: 'call_prior_rollout_same_workspace',
          lineage: 'prior_stale',
          reason: 'transcript record predates active run start'
        })
      );
    });
  });

  it('does not block when a transcript function_call_output matches the transcript function_call', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-output', identifier: 'ABC-TRANSCRIPT-OUTPUT' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-output', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-output',
        turn_id: 'turn-output',
        session_id: 'session-output'
      });
      writeSessionTranscript(codexHome, 'session-output.jsonl', [
        {
          timestamp: new Date(harness.now.value + 10).toISOString(),
          session_id: 'session-output',
          thread_id: 'thread-output',
          turn_id: 'turn-output',
          response_item: {
            type: 'function_call',
            name: 'linear_graphql',
            call_id: 'call_transcript_output'
          }
        },
        {
          timestamp: new Date(harness.now.value + 100).toISOString(),
          session_id: 'session-output',
          thread_id: 'thread-output',
          turn_id: 'turn-output',
          response_item: {
            type: 'function_call_output',
            call_id: 'call_transcript_output',
            output: '{}'
          }
        }
      ]);
      harness.orchestrator.onWorkerEvent('i-transcript-output', {
        timestamp_ms: harness.now.value + 20,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting after transcript tool output',
        thread_id: 'thread-output',
        turn_id: 'turn-output',
        session_id: 'session-output'
      });
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-transcript-output')).toBe(false);
      expect(harness.orchestrator.getStateSnapshot().running.get('i-transcript-output')?.stalled_waiting_reason).toBe(
        REASON_CODES.turnWaitingThresholdExceeded
      );
      expect(harness.orchestrator.getStateSnapshot().running.get('i-transcript-output')?.tool_call_ledger?.call_transcript_output).toMatchObject({
        tool_name: 'linear_graphql',
        call_id: 'call_transcript_output',
        session_id: 'session-output',
        completion_status: 'completed',
        evidence_sources: ['session_transcript'],
        start_evidence_source: 'session_transcript',
        completion_evidence_source: 'session_transcript'
      });
    });
  });

  it('clears a real Codex rollout transcript function_call with a matching output payload', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const workspacePath = path.join(codexHome, 'workspaces', 'NIE-79-output');
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 },
        spawnWorker: async ({ issue, worker_host }) => {
          return {
            ok: true,
            worker_handle: { issue_id: issue.id },
            monitor_handle: { issue_id: issue.id },
            worker_host,
            workspace_path: workspacePath
          };
        }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-rollout-output', identifier: 'ABC-TRANSCRIPT-ROLLOUT-OUTPUT' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-rollout-output', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-rollout-output',
        turn_id: 'turn-rollout-output',
        session_id: 'session-rollout-output'
      });
      writeSessionTranscript(codexHome, 'rollout-2026-05-07T13-45-00-000Z-def456.jsonl', [
        {
          timestamp: new Date(harness.now.value + 5).toISOString(),
          type: 'turn_context',
          payload: {
            cwd: workspacePath
          }
        },
        {
          timestamp: new Date(harness.now.value + 10).toISOString(),
          type: 'response_item',
          thread_id: 'thread-rollout-output',
          turn_id: 'turn-rollout-output',
          session_id: 'session-rollout-output',
          payload: {
            type: 'function_call',
            name: 'linear_graphql',
            call_id: 'call_rollout_output'
          }
        },
        {
          timestamp: new Date(harness.now.value + 100).toISOString(),
          type: 'response_item',
          thread_id: 'thread-rollout-output',
          turn_id: 'turn-rollout-output',
          session_id: 'session-rollout-output',
          payload: {
            type: 'function_call_output',
            call_id: 'call_rollout_output',
            output: '{}'
          }
        }
      ]);
      harness.orchestrator.onWorkerEvent('i-transcript-rollout-output', {
        timestamp_ms: harness.now.value + 20,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting after rollout transcript output',
        thread_id: 'thread-rollout-output',
        turn_id: 'turn-rollout-output',
        session_id: 'session-rollout-output'
      });
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-transcript-rollout-output')).toBe(false);
      expect(
        harness.orchestrator.getStateSnapshot().running.get('i-transcript-rollout-output')?.outstanding_tool_calls ?? {}
      ).toEqual({});
    });
  });

  it('keeps transcript function_call outstanding when only a stale mismatched output appears', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-stale-output', identifier: 'ABC-TRANSCRIPT-STALE-OUTPUT' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-stale-output', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-stale-output',
        turn_id: 'turn-stale-output',
        session_id: 'session-stale-output'
      });
      writeSessionTranscript(codexHome, 'session-stale-output.jsonl', [
        {
          timestamp: new Date(harness.now.value + 10).toISOString(),
          session_id: 'session-stale-output',
          thread_id: 'thread-stale-output',
          turn_id: 'turn-stale-output',
          response_item: {
            type: 'function_call',
            name: 'linear_graphql',
            call_id: 'call_still_missing'
          }
        },
        {
          timestamp: new Date(harness.now.value + 100).toISOString(),
          session_id: 'session-stale-output',
          response_item: {
            type: 'function_call_output',
            call_id: 'call_old_completed',
            output: '{}'
          }
        }
      ]);
      harness.orchestrator.onWorkerEvent('i-transcript-stale-output', {
        timestamp_ms: harness.now.value + 20,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting with stale output present',
        thread_id: 'thread-stale-output',
        turn_id: 'turn-stale-output',
        session_id: 'session-stale-output'
      });
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      expect(harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-transcript-stale-output')?.tool_output_wait).toMatchObject({
        tool_name: 'linear_graphql',
        call_id: 'call_still_missing',
        evidence_source: 'session_transcript'
      });
    });
  });

  it('does not clear active missing-tool evidence from an unlineaged external transcript output', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-unlineaged-output', identifier: 'ABC-TRANSCRIPT-UNLINEAGED-OUTPUT' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-unlineaged-output', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-owned-output',
        turn_id: 'turn-owned-output',
        session_id: 'session-owned-output'
      });
      writeSessionTranscript(codexHome, 'session-owned-output.jsonl', [
        {
          timestamp: new Date(harness.now.value + 10).toISOString(),
          session_id: 'session-owned-output',
          thread_id: 'thread-owned-output',
          turn_id: 'turn-owned-output',
          response_item: {
            type: 'function_call',
            name: 'linear_graphql',
            call_id: 'call_owned_missing'
          }
        },
        {
          timestamp: new Date(harness.now.value + 100).toISOString(),
          response_item: {
            type: 'function_call_output',
            call_id: 'call_owned_missing',
            output: '{}'
          }
        }
      ]);
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      expect(harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-transcript-unlineaged-output')?.tool_output_wait).toMatchObject({
        tool_name: 'linear_graphql',
        call_id: 'call_owned_missing',
        evidence_source: 'session_transcript'
      });
      expect(
        harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-transcript-unlineaged-output')?.transcript_tool_call_diagnostics
      ).toContainEqual(
        expect.objectContaining({
          kind: 'function_call_output',
          call_id: 'call_owned_missing',
          lineage: 'unattributed',
          reason: 'no active runtime lineage identifiers matched'
        })
      );
    });
  });

  it('keeps manual resume transcript output diagnostic-only when it only shares the active session', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-manual-resume', identifier: 'ABC-TRANSCRIPT-MANUAL' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-manual-resume', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-owned-manual',
        turn_id: 'turn-owned-manual',
        session_id: 'session-owned-manual'
      });
      harness.orchestrator.onWorkerEvent('i-transcript-manual-resume', {
        timestamp_ms: harness.now.value + 10,
        event: CANONICAL_EVENT.codex.toolCallStarted,
        tool_name: 'linear_graphql',
        tool_call_id: 'call_manual_resume_overlap',
        thread_id: 'thread-owned-manual',
        turn_id: 'turn-owned-manual',
        session_id: 'session-owned-manual'
      });
      writeSessionTranscript(codexHome, 'session-owned-manual.jsonl', [
        {
          timestamp: new Date(harness.now.value + 100).toISOString(),
          session_id: 'session-owned-manual',
          response_item: {
            type: 'function_call_output',
            call_id: 'call_manual_resume_overlap',
            output: '{}'
          }
        }
      ]);
      harness.orchestrator.onWorkerEvent('i-transcript-manual-resume', {
        timestamp_ms: harness.now.value + 200,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting after external manual resume transcript append',
        thread_id: 'thread-owned-manual',
        turn_id: 'turn-owned-manual',
        session_id: 'session-owned-manual'
      });
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      const blocked = harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-transcript-manual-resume');
      expect(blocked?.transcript_tool_call_diagnostics).toContainEqual(
        expect.objectContaining({
          kind: 'function_call_output',
          call_id: 'call_manual_resume_overlap',
          session_id: 'session-owned-manual',
          lineage: 'external_manual',
          reason: 'partial active lineage is insufficient for ownership: session_id',
          active_thread_id: 'thread-owned-manual',
          active_turn_id: 'turn-owned-manual',
          active_session_id: 'session-owned-manual'
        })
      );
      expect(blocked?.tool_output_wait).toMatchObject({
        tool_name: 'linear_graphql',
        call_id: 'call_manual_resume_overlap',
        evidence_source: 'worker_event'
      });
    });
  });

  it('blocks a non-Linear transcript function_call generically', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-nonlinear', identifier: 'ABC-TRANSCRIPT-NONLINEAR' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-nonlinear', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-nonlinear',
        turn_id: 'turn-nonlinear',
        session_id: 'session-nonlinear'
      });
      writeSessionTranscript(codexHome, 'session-nonlinear.jsonl', [
        {
          timestamp: new Date(harness.now.value + 10).toISOString(),
          session_id: 'session-nonlinear',
          thread_id: 'thread-nonlinear',
          turn_id: 'turn-nonlinear',
          response_item: {
            type: 'function_call',
            name: 'github_graphql',
            call_id: 'call_transcript_github'
          }
        }
      ]);
      harness.orchestrator.onWorkerEvent('i-transcript-nonlinear', {
        timestamp_ms: harness.now.value + 20,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting for github_graphql output',
        thread_id: 'thread-nonlinear',
        turn_id: 'turn-nonlinear',
        session_id: 'session-nonlinear'
      });
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      expect(harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-transcript-nonlinear')?.tool_output_wait).toMatchObject({
        tool_name: 'github_graphql',
        call_id: 'call_transcript_github',
        evidence_source: 'session_transcript'
      });
    });
  });

  it('ignores unrelated no-lineage transcript function_call records', async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const harness = createHarness({
        configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
      });
      harness.tracker.fetch_candidate_issues.mockResolvedValue([
        makeIssue({ id: 'i-transcript-unrelated', identifier: 'ABC-TRANSCRIPT-UNRELATED' })
      ]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-transcript-unrelated', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-related',
        turn_id: 'turn-related',
        session_id: 'session-related'
      });
      writeSessionTranscript(codexHome, 'unrelated-session.jsonl', [
        {
          timestamp: new Date(harness.now.value + 10).toISOString(),
          response_item: {
            type: 'function_call',
            name: 'linear_graphql',
            call_id: 'call_unrelated_no_lineage'
          }
        }
      ]);
      harness.orchestrator.onWorkerEvent('i-transcript-unrelated', {
        timestamp_ms: harness.now.value + 20,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting with unrelated transcript present',
        thread_id: 'thread-related',
        turn_id: 'turn-related',
        session_id: 'session-related'
      });
      harness.now.value += 2_000;
      await harness.orchestrator.tick('interval');
      await new Promise((resolve) => setImmediate(resolve));

      expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-transcript-unrelated')).toBe(false);
      expect(harness.orchestrator.getStateSnapshot().running.get('i-transcript-unrelated')?.outstanding_tool_calls ?? {}).toEqual({});
    });
  });

  it('keeps missing tool output from being overwritten by generic stall timeout in the same tick', async () => {
    const completedRuns: Array<{ terminal_status: string; error_code: string | null }> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'run-missing-timeout',
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async ({ terminal_status, error_code }) => {
        completedRuns.push({ terminal_status, error_code: error_code ?? null });
      }
    };
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 1_000 },
      persistence
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-missing-timeout', identifier: 'ABC-MISS-TIMEOUT' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-missing-timeout', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      detail: 'linear_graphql',
      tool_name: 'linear_graphql',
      tool_call_id: 'call_timeout_collision',
      thread_id: 'thread-timeout',
      turn_id: 'turn-timeout',
      session_id: 'session-timeout'
    });
    harness.orchestrator.onWorkerEvent('i-missing-timeout', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting for linear_graphql output',
      thread_id: 'thread-timeout',
      turn_id: 'turn-timeout',
      session_id: 'session-timeout'
    });

    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    await new Promise((resolve) => setImmediate(resolve));

    const snapshot = harness.orchestrator.getStateSnapshot();
    const blocked = snapshot.blocked_inputs.get('i-missing-timeout');
    expect(blocked?.stop_reason_code).toBe(REASON_CODES.missingToolOutput);
    expect(blocked?.requires_manual_resume).toBe(true);
    expect(blocked?.tool_output_wait).toMatchObject({
      tool_name: 'linear_graphql',
      call_id: 'call_timeout_collision',
      thread_id: 'thread-timeout',
      turn_id: 'turn-timeout',
      session_id: 'session-timeout'
    });
    expect(snapshot.running.has('i-missing-timeout')).toBe(false);
    expect(snapshot.retry_attempts.has('i-missing-timeout')).toBe(false);
    expect(harness.terminated).toEqual([
      { issue_id: 'i-missing-timeout', cleanup_workspace: false, reason: REASON_CODES.missingToolOutput }
    ]);
    expect(completedRuns).toEqual([{ terminal_status: 'cancelled', error_code: REASON_CODES.missingToolOutput }]);
    expect(
      snapshot.recent_runtime_events.some(
        (entry) =>
          entry.event === CANONICAL_EVENT.orchestration.workerStalled && entry.issue_identifier === 'ABC-MISS-TIMEOUT'
      )
    ).toBe(false);
  });

  it('does not block when matching tool output arrives before the waiting threshold', async () => {
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-tool-ok', identifier: 'ABC-TOOL-OK' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-tool-ok', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      detail: 'dynamic_tool',
      tool_name: 'dynamic_tool',
      tool_call_id: 'call_ok'
    });
    harness.orchestrator.onWorkerEvent('i-tool-ok', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.toolCallCompleted,
      detail: 'dynamic_tool',
      tool_name: 'dynamic_tool',
      tool_call_id: 'call_ok'
    });
    harness.orchestrator.onWorkerEvent('i-tool-ok', {
      timestamp_ms: harness.now.value + 200,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting after tool output'
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    await new Promise((resolve) => setImmediate(resolve));

    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-tool-ok')).toBe(false);
    expect(harness.orchestrator.getStateSnapshot().running.get('i-tool-ok')?.stalled_waiting_reason).toBe(
      REASON_CODES.turnWaitingThresholdExceeded
    );
    expect(harness.orchestrator.getStateSnapshot().running.get('i-tool-ok')?.tool_call_ledger?.call_ok).toMatchObject({
      call_id: 'call_ok',
      tool_name: 'dynamic_tool',
      issue_id: 'i-tool-ok',
      issue_identifier: 'ABC-TOOL-OK',
      completion_status: 'completed',
      first_seen_at_ms: harness.now.value - 2_000,
      last_seen_at_ms: harness.now.value - 1_900,
      completed_at_ms: harness.now.value - 1_900,
      evidence_sources: ['worker_event'],
      start_evidence_source: 'worker_event',
      completion_evidence_source: 'worker_event'
    });
    expect(harness.orchestrator.getStateSnapshot().running.get('i-tool-ok')?.outstanding_tool_calls ?? {}).toEqual({});
  });

  it('preserves app-server protocol evidence for completed function calls', async () => {
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-protocol-tool', identifier: 'ABC-PROTOCOL-TOOL' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-protocol-tool', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-protocol',
      turn_id: 'turn-protocol',
      session_id: 'session-protocol'
    });
    harness.orchestrator.onWorkerEvent('i-protocol-tool', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      detail: 'linear_graphql',
      thread_id: 'thread-protocol',
      turn_id: 'turn-protocol',
      session_id: 'session-protocol',
      tool_name: 'linear_graphql',
      tool_call_id: 'call_protocol_ledger',
      tool_call_evidence_source: 'app_server_protocol'
    });
    harness.orchestrator.onWorkerEvent('i-protocol-tool', {
      timestamp_ms: harness.now.value + 120,
      event: CANONICAL_EVENT.codex.toolCallCompleted,
      detail: 'function_call_output',
      thread_id: 'thread-protocol',
      turn_id: 'turn-protocol',
      session_id: 'session-protocol',
      tool_call_id: 'call_protocol_ledger',
      tool_call_evidence_source: 'app_server_protocol'
    });

    expect(harness.orchestrator.getStateSnapshot().running.get('i-protocol-tool')?.tool_call_ledger?.call_protocol_ledger).toMatchObject({
      call_id: 'call_protocol_ledger',
      tool_name: 'linear_graphql',
      thread_id: 'thread-protocol',
      turn_id: 'turn-protocol',
      session_id: 'session-protocol',
      completion_status: 'completed',
      first_seen_at_ms: harness.now.value + 10,
      last_seen_at_ms: harness.now.value + 120,
      completed_at_ms: harness.now.value + 120,
      evidence_sources: ['app_server_protocol'],
      start_evidence_source: 'app_server_protocol',
      completion_evidence_source: 'app_server_protocol'
    });
    expect(harness.orchestrator.getStateSnapshot().running.get('i-protocol-tool')?.outstanding_tool_calls ?? {}).toEqual({});
  });

  it('does not classify healthy MCP tool events as missing dynamic GraphQL output', async () => {
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-mcp-healthy', identifier: 'ABC-MCP-HEALTHY' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-mcp-healthy', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      detail: 'linear_mcp',
      tool_name: 'linear_mcp',
      tool_call_id: 'call_mcp_healthy'
    });
    harness.orchestrator.onWorkerEvent('i-mcp-healthy', {
      timestamp_ms: harness.now.value + 50,
      event: CANONICAL_EVENT.codex.toolCallCompleted,
      detail: 'linear_mcp',
      tool_name: 'linear_mcp',
      tool_call_id: 'call_mcp_healthy'
    });
    harness.orchestrator.onWorkerEvent('i-mcp-healthy', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting after healthy MCP operation'
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');

    const running = harness.orchestrator.getStateSnapshot().running.get('i-mcp-healthy');
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-mcp-healthy')).toBe(false);
    expect(running?.tool_call_ledger?.call_mcp_healthy).toMatchObject({
      tool_name: 'linear_mcp',
      completion_status: 'completed',
      evidence_sources: ['worker_event']
    });
    expect(
      Object.values(running?.tool_call_ledger ?? {}).some(
        (call) => call.tool_name === 'linear_graphql' && call.completion_status === 'pending'
      )
    ).toBe(false);
  });

  it('quarantines duplicate or late tool output after missing-output blocked classification', async () => {
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-tool-late', identifier: 'ABC-TOOL-LATE' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-tool-late', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-late',
      turn_id: 'turn-late',
      session_id: 'session-late'
    });
    harness.orchestrator.onWorkerEvent('i-tool-late', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      detail: 'dynamic_tool',
      tool_name: 'dynamic_tool',
      tool_call_id: 'call_late',
      thread_id: 'thread-late',
      turn_id: 'turn-late',
      session_id: 'session-late'
    });
    harness.orchestrator.onWorkerEvent('i-tool-late', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting for tool output',
      thread_id: 'thread-late',
      turn_id: 'turn-late',
      session_id: 'session-late'
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    await new Promise((resolve) => setImmediate(resolve));

    harness.orchestrator.onWorkerEvent('i-tool-late', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.toolCallCompleted,
      detail: 'dynamic_tool',
      tool_name: 'dynamic_tool',
      tool_call_id: 'call_late',
      thread_id: 'thread-late',
      turn_id: 'turn-late',
      session_id: 'session-late'
    });

    const blocked = harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-tool-late');
    expect(blocked?.stop_reason_code).toBe(REASON_CODES.missingToolOutput);
    expect(blocked?.quarantined_event_count).toBe(1);
    expect(blocked?.tool_output_wait?.call_id).toBe('call_late');
  });

  it('preserves missing-tool-output root cause when tracker state later leaves active states', async () => {
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-tool-terminal', identifier: 'ABC-TOOL-TERM' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-tool-terminal', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-terminal',
      turn_id: 'turn-terminal',
      session_id: 'session-terminal'
    });
    harness.orchestrator.onWorkerEvent('i-tool-terminal', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.toolCallStarted,
      detail: 'linear_graphql',
      tool_name: 'linear_graphql',
      tool_call_id: 'call_terminal',
      thread_id: 'thread-terminal',
      turn_id: 'turn-terminal',
      session_id: 'session-terminal'
    });
    harness.orchestrator.onWorkerEvent('i-tool-terminal', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting for tool output',
      thread_id: 'thread-terminal',
      turn_id: 'turn-terminal',
      session_id: 'session-terminal'
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    await new Promise((resolve) => setImmediate(resolve));

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-tool-terminal', identifier: 'ABC-TOOL-TERM', state: 'Done' })
    ]);
    await harness.orchestrator.reconcileBlockedInputs();

    const blocked = harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-tool-terminal');
    expect(blocked?.stop_reason_code).toBe(REASON_CODES.missingToolOutput);
    expect(blocked?.tool_output_wait?.call_id).toBe('call_terminal');
  });

  it('does not reset stalled-wait classification when waiting heartbeats continue', async () => {
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-wait-heartbeat', identifier: 'ABC-WAIT-HB' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-wait-heartbeat', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting heartbeat 1',
      thread_id: 'thread-wait',
      session_id: 'thread-wait-turn-1'
    });
    harness.now.value += 750;
    harness.orchestrator.onWorkerEvent('i-wait-heartbeat', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting heartbeat 2',
      thread_id: 'thread-wait',
      session_id: 'thread-wait-turn-1'
    });
    harness.now.value += 500;
    await harness.orchestrator.tick('interval');

    const running = harness.orchestrator.getStateSnapshot().running.get('i-wait-heartbeat');
    expect(running?.stalled_waiting_since_ms).toBe(1_001_000);
    expect(running?.stalled_waiting_reason).toBe('turn_waiting_threshold_exceeded');
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-wait-heartbeat')).toBe(false);
  });

  it('does not classify prolonged codex.turn.waiting as stalled when token usage moves during the wait episode', async () => {
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-active-wait', identifier: 'ABC-ACTIVE-WAIT' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-active-wait', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting heartbeat 1',
      thread_id: 'thread-active-wait',
      session_id: 'thread-active-wait-turn-1',
      usage: {
        input_tokens: 10,
        output_tokens: 0,
        total_tokens: 10
      }
    });
    harness.now.value += 750;
    harness.orchestrator.onWorkerEvent('i-active-wait', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting heartbeat 2 with fresh token usage',
      thread_id: 'thread-active-wait',
      session_id: 'thread-active-wait-turn-1',
      usage: {
        input_tokens: 10,
        output_tokens: 8,
        total_tokens: 18
      }
    });
    harness.now.value += 500;
    await harness.orchestrator.tick('interval');

    const running = harness.orchestrator.getStateSnapshot().running.get('i-active-wait');
    expect(running?.stalled_waiting_reason).toBeNull();
    expect(running?.stalled_waiting_since_ms).toBe(1_001_750);
    expect(running?.last_progress_transition_at_ms).toBe(1_000_750);
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-active-wait')).toBe(false);
  });

  it('does not classify prolonged codex.turn.waiting as stalled when fresh thread activity is observed', async () => {
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-active-thread', identifier: 'ABC-ACTIVE-THREAD' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-active-thread', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting heartbeat',
      thread_id: 'thread-active',
      session_id: 'thread-active-turn-1'
    });
    harness.now.value += 750;
    harness.orchestrator.updateCodexTimestamp('i-active-thread', harness.now.value);
    harness.now.value += 500;
    await harness.orchestrator.tick('interval');

    const running = harness.orchestrator.getStateSnapshot().running.get('i-active-thread');
    expect(running?.stalled_waiting_reason).toBeNull();
    expect(running?.stalled_waiting_since_ms).toBe(1_001_750);
    expect(running?.last_progress_transition_at_ms).toBe(1_000_750);
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-active-thread')).toBe(false);
  });

  it('emits stalled-wait threshold event once per waiting episode', async () => {
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-wait-event', identifier: 'ABC-WAIT-EVENT' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-wait-event', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting heartbeat',
      thread_id: 'thread-event',
      session_id: 'thread-event-turn-1'
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-wait-event', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting heartbeat after threshold',
      thread_id: 'thread-event',
      session_id: 'thread-event-turn-1'
    });
    harness.now.value += 2_000;
    await harness.orchestrator.tick('interval');

    const stallEvents = harness.orchestrator
      .getStateSnapshot()
      .recent_runtime_events.filter((entry) => entry.event === CANONICAL_EVENT.orchestration.runningWaitStallThresholdExceeded);
    expect(stallEvents).toHaveLength(1);
    expect(stallEvents[0]?.severity).toBe('warn');
    expect(stallEvents[0]?.issue_identifier).toBe('ABC-WAIT-EVENT');
    expect(stallEvents[0]?.session_id).toBe('thread-event-turn-1');
    expect(stallEvents[0]?.detail).toContain('thread_id=thread-event');
    expect(stallEvents[0]?.detail).toContain('elapsed_ms=2000');
    const progressEvents = harness.orchestrator
      .getStateSnapshot()
      .recent_runtime_events.filter((entry) => entry.event === CANONICAL_EVENT.progress.stalledWaitingDetected);
    expect(progressEvents).toHaveLength(1);
  });

  it('emits heartbeat-only detection before stalled waiting threshold', async () => {
    const harness = createHarness({
      configOverrides: {
        progress_heartbeat_only_warn_ms: 500,
        progress_stalled_waiting_ms: 5_000,
        running_wait_stall_threshold_ms: 5_000,
        stall_timeout_ms: 60_000
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-heartbeat-only', identifier: 'ABC-HB' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-heartbeat-only', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting heartbeat',
      thread_id: 'thread-hb',
      session_id: 'thread-hb-turn-1'
    });
    harness.now.value += 750;
    await harness.orchestrator.tick('interval');

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.running.get('i-heartbeat-only')?.stalled_waiting_reason).toBeNull();
    expect(snapshot.recent_runtime_events.some((entry) => entry.event === CANONICAL_EVENT.progress.heartbeatOnlyDetected)).toBe(true);
    expect(snapshot.recent_runtime_events.some((entry) => entry.event === CANONICAL_EVENT.progress.stalledWaitingDetected)).toBe(false);
  });

  it('does not classify prolonged codex.turn.waiting as stalled when phase progress interleaves with waiting heartbeats', async () => {
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-wait-phase', identifier: 'ABC-WAIT-PHASE' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-wait-phase', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting heartbeat 1',
      thread_id: 'thread-phase',
      session_id: 'thread-phase-turn-1'
    });
    harness.now.value += 400;
    harness.orchestrator.onWorkerEvent('i-wait-phase', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.phasePlanning,
      detail: 'planning heartbeat',
      thread_id: 'thread-phase',
      session_id: 'thread-phase-turn-1'
    });
    harness.now.value += 700;
    harness.orchestrator.onWorkerEvent('i-wait-phase', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting heartbeat 2',
      thread_id: 'thread-phase',
      session_id: 'thread-phase-turn-1'
    });
    await harness.orchestrator.tick('interval');

    const running = harness.orchestrator.getStateSnapshot().running.get('i-wait-phase');
    expect(running?.stalled_waiting_since_ms).toBe(1_001_400);
    expect(running?.stalled_waiting_reason).toBeNull();
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-wait-phase')).toBe(false);
  });

  it('clears blocked issue state when tracker reports non-active or terminal state', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-clear', identifier: 'ABC-CLEAR' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit(
      'i-clear',
      'abnormal',
      'tool requestUserInput could not be auto-answered (turn_input_required)'
    );

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-clear', identifier: 'ABC-CLEAR', state: 'Done' })
    ]);

    await harness.orchestrator.tick('interval');
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-clear')).toBe(false);
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
    expect(retryEntry?.stop_reason_code).toBe('slots_exhausted');
  });

  it('requeues fresh-dispatch retry on slot exhaustion without implementation thread lineage', async () => {
    const harness = createHarness({
      configOverrides: {
        max_concurrent_agents: 1,
        active_states: ['Todo', 'In Progress', 'Agent Review'],
        fresh_dispatch_states: ['Agent Review']
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-fresh-slots', state: 'In Progress' })]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-fresh-slots', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'implementation-thread',
      turn_id: 'implementation-turn',
      session_id: 'implementation-session'
    });
    await harness.orchestrator.onWorkerExit('i-fresh-slots', 'abnormal', 'transient implementation failure');

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-occupying-slot', identifier: 'ABC-2', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-fresh-slots', state: 'Agent Review' })]);
    await harness.orchestrator.onRetryTimer('i-fresh-slots');

    const retryEntry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-fresh-slots');
    expect(retryEntry?.attempt).toBe(2);
    expect(retryEntry?.error).toBe('no available orchestrator slots');
    expect(retryEntry?.stop_reason_code).toBe('slots_exhausted');
    expect(retryEntry?.previous_thread_id).toBeNull();
    expect(retryEntry?.previous_session_id).toBeNull();
    expect(retryEntry?.issue_run_id).toBeNull();
    expect(harness.spawned).toEqual([
      { issue_id: 'i-fresh-slots', attempt: null, worker_host: null, resume_context: null },
      { issue_id: 'i-occupying-slot', attempt: null, worker_host: null, resume_context: null }
    ]);
  });

  it('preserves non-fresh active-state continuation retry metadata', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-normal-retry', state: 'In Progress' })]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-normal-retry', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'implementation-thread',
      turn_id: 'implementation-turn',
      session_id: 'implementation-session'
    });
    await harness.orchestrator.onWorkerExit('i-normal-retry', 'normal');

    const retryEntry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-normal-retry');
    expect(retryEntry?.attempt).toBe(1);
    expect(retryEntry?.previous_thread_id).toBe('implementation-thread');
    expect(retryEntry?.previous_session_id).toBe('implementation-session');
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

  it('releases stale implementation worker when refreshed into Agent Review fresh-dispatch handoff', async () => {
    const completedRuns: Array<Parameters<NonNullable<OrchestratorPersistencePort['completeRun']>>[0]> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'run-handoff-release',
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async (params) => {
        completedRuns.push(params);
      }
    };
    const harness = createHarness({
      configOverrides: {
        active_states: ['Todo', 'In Progress', 'Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review']
      },
      persistence
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-stale-handoff', identifier: 'ABC-HANDOFF', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-stale-handoff', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'implementation-thread',
      turn_id: 'implementation-turn',
      session_id: 'implementation-session'
    });
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-stale-handoff', identifier: 'ABC-HANDOFF', state: 'Agent Review' })
    ]);

    await harness.orchestrator.reconcileRunningIssues();

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(harness.terminated).toEqual([
      {
        issue_id: 'i-stale-handoff',
        cleanup_workspace: false,
        reason: REASON_CODES.handoffRelease
      }
    ]);
    expect(snapshot.running.has('i-stale-handoff')).toBe(false);
    expect(snapshot.claimed.has('i-stale-handoff')).toBe(false);
    expect(snapshot.retry_attempts.has('i-stale-handoff')).toBe(false);
    expect(completedRuns).toEqual([
      expect.objectContaining({
        terminal_status: 'cancelled',
        error_code: REASON_CODES.handoffRelease,
        terminal_reason_code: REASON_CODES.handoffRelease,
        session_id: 'implementation-session',
        thread_id: 'implementation-thread',
        turn_id: 'implementation-turn'
      })
    ]);

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-stale-handoff', identifier: 'ABC-HANDOFF', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');

    const freshReview = harness.orchestrator.getStateSnapshot().running.get('i-stale-handoff');
    expect(harness.spawned).toEqual([
      { issue_id: 'i-stale-handoff', attempt: null, worker_host: null, resume_context: null },
      { issue_id: 'i-stale-handoff', attempt: null, worker_host: null, resume_context: null }
    ]);
    expect(freshReview?.retry_attempt).toBe(0);
    expect(freshReview?.thread_id).toBeNull();
    expect(freshReview?.session_id).toBeNull();
  });

  it('releases completed Agent Review ownership when issue routes back to In Progress for fresh dispatch', async () => {
    const completedRuns: Array<Parameters<NonNullable<OrchestratorPersistencePort['completeRun']>>[0]> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'run-review-terminal-release',
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async (params) => {
        completedRuns.push(params);
      }
    };
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const harness = createHarness({
      configOverrides: {
        active_states: ['Todo', 'In Progress', 'Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review', 'In Progress']
      },
      logger: {
        log: ({ event, context }) => {
          logs.push({ event, context: context ?? {} });
        }
      },
      persistence
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-review-terminal-release', identifier: 'NIE-87', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-review-terminal-release', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session',
      codex_app_server_pid: 7931
    });
    harness.orchestrator.onWorkerEvent('i-review-terminal-release', {
      timestamp_ms: harness.now.value + 2,
      event: CANONICAL_EVENT.codex.turnCompleted,
      detail: 'task_complete',
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session',
      codex_app_server_pid: 7931
    });

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-review-terminal-release', identifier: 'NIE-87', state: 'In Progress' })
    ]);
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-review-terminal-release', identifier: 'NIE-87', state: 'In Progress' })
    ]);

    await harness.orchestrator.tick('interval');

    expect(harness.terminated).toEqual([
      {
        issue_id: 'i-review-terminal-release',
        cleanup_workspace: false,
        reason: REASON_CODES.handoffRelease
      }
    ]);
    expect(completedRuns).toEqual([
      expect.objectContaining({
        terminal_status: 'cancelled',
        error_code: REASON_CODES.handoffRelease,
        terminal_reason_code: REASON_CODES.handoffRelease,
        session_id: 'review-session',
        thread_id: 'review-thread',
        turn_id: 'review-turn'
      })
    ]);
    expect(harness.spawned).toEqual([
      { issue_id: 'i-review-terminal-release', attempt: null, worker_host: null, resume_context: null },
      { issue_id: 'i-review-terminal-release', attempt: null, worker_host: null, resume_context: null }
    ]);
    harness.orchestrator.onWorkerEvent('i-review-terminal-release', {
      timestamp_ms: harness.now.value + 3,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'late waiting after task_complete',
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session'
    });
    harness.orchestrator.onWorkerEvent('i-review-terminal-release', {
      timestamp_ms: harness.now.value + 4,
      event: CANONICAL_EVENT.codex.phasePlanning,
      detail: 'late planning after task_complete',
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session'
    });
    const running = harness.orchestrator.getStateSnapshot().running.get('i-review-terminal-release');
    expect(running?.started_issue_state).toBe('In Progress');
    expect(running?.thread_id).toBeNull();
    expect(running?.last_event).toBeNull();
    expect(running?.last_codex_timestamp_ms).toBeNull();
    expect(running?.recent_events).toEqual([]);
    expect(running?.quarantined_event_count).toBe(2);
    expect(running?.quarantined_events?.map((event) => event.event)).toEqual([
      CANONICAL_EVENT.codex.turnWaiting,
      CANONICAL_EVENT.codex.phasePlanning
    ]);
    expect(running?.quarantined_events?.every((event) => event.reason === 'lineage_mismatch')).toBe(true);
    expect(
      logs.some(
        (entry) =>
          entry.event === CANONICAL_EVENT.orchestration.dispatchDuplicateSkipped &&
          entry.context.issue_id === 'i-review-terminal-release'
      )
    ).toBe(false);
  });

  it('keeps fresh review worker running while Agent Review remains active', async () => {
    const harness = createHarness({
      configOverrides: {
        active_states: ['Todo', 'In Progress', 'Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review']
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-review-running', identifier: 'ABC-REVIEW', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-review-running', identifier: 'ABC-REVIEW', state: 'Agent Review' })
    ]);

    await harness.orchestrator.reconcileRunningIssues();

    const running = harness.orchestrator.getStateSnapshot().running.get('i-review-running');
    expect(running?.issue.state).toBe('Agent Review');
    expect(harness.terminated).toEqual([]);
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

  it('preserves stalled root-cause diagnostics when non-active reconciliation cancels a run', async () => {
    const completedRuns: Array<Parameters<NonNullable<OrchestratorPersistencePort['completeRun']>>[0]> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'run-nonactive-stalled',
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async (params) => {
        completedRuns.push(params);
      }
    };
    const harness = createHarness({
      configOverrides: { running_wait_stall_threshold_ms: 1_000, stall_timeout_ms: 60_000 },
      persistence
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-nonactive-stalled', identifier: 'ABC-STOP' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-nonactive-stalled', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting for tool output',
      thread_id: 'thread-stop',
      turn_id: 'turn-stop',
      session_id: 'session-stop'
    });
    harness.now.value += 2_000;
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-nonactive-stalled', identifier: 'ABC-STOP', state: 'Agent Review' })
    ]);

    await harness.orchestrator.reconcileRunningIssues();

    expect(harness.terminated).toEqual([
      {
        issue_id: 'i-nonactive-stalled',
        cleanup_workspace: false,
        reason: 'non_active_state_transition'
      }
    ]);
    expect(completedRuns).toEqual([
      expect.objectContaining({
        run_id: 'run-nonactive-stalled',
        terminal_status: 'cancelled',
        error_code: 'non_active_state_transition',
        terminal_reason_code: 'non_active_state_transition',
        root_cause_status: 'blocked',
        root_cause_reason_code: REASON_CODES.turnWaitingThresholdExceeded,
        root_cause_reason_detail: 'codex turn waiting: waiting for tool output',
        root_cause_at: new Date(1_001_000).toISOString(),
        session_id: 'session-stop',
        thread_id: 'thread-stop',
        turn_id: 'turn-stop'
      })
    ]);
    expect(harness.orchestrator.getStateSnapshot().running.has('i-nonactive-stalled')).toBe(false);
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
    expect(retryEntry?.stop_reason_code).toBe('worker_stalled');
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
    expect(retryEntry?.stop_reason_code).toBe('retry_fetch_failed');
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

  it('persists normalized execution graph from real dispatch and worker lifecycle events', async () => {
    const issueRuns: Array<Record<string, unknown>> = [];
    const attempts: Array<Record<string, unknown>> = [];
    const threads: Array<Record<string, unknown>> = [];
    const turns: Array<Record<string, unknown>> = [];
    const phaseSpans: Array<Record<string, unknown>> = [];
    const toolSpans: Array<Record<string, unknown>> = [];
    const transitions: Array<Record<string, unknown>> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'legacy-run-1',
      appendIssueRun: async (params) => {
        issueRuns.push(params);
        return 'issue_run_1';
      },
      appendAttempt: async (params) => {
        attempts.push(params);
        return 'attempt_1';
      },
      appendThread: async (params) => {
        threads.push(params);
        return String(params.thread_id);
      },
      appendTurn: async (params) => {
        turns.push(params);
        return String(params.turn_id);
      },
      appendPhaseSpan: async (params) => {
        phaseSpans.push(params);
        return `phase_${phaseSpans.length}`;
      },
      appendToolSpan: async (params) => {
        toolSpans.push(params);
        return `tool_${toolSpans.length}`;
      },
      appendStateTransition: async (params) => {
        transitions.push(params);
        return `transition_${transitions.length}`;
      },
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async () => undefined
    };
    const harness = createHarness({ persistence });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-lineage', identifier: 'ABC-LIN' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-lineage', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-1',
      turn_id: 'turn-1'
    });
    harness.orchestrator.onWorkerEvent('i-lineage', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.phasePlanning,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      detail: 'waiting_for_turn_completion elapsed_s=0'
    });
    harness.orchestrator.onWorkerEvent('i-lineage', {
      timestamp_ms: harness.now.value + 30,
      event: CANONICAL_EVENT.codex.toolCallCompleted,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      detail: 'exec_command'
    });
    harness.orchestrator.onWorkerEvent('i-lineage', {
      timestamp_ms: harness.now.value + 40,
      event: CANONICAL_EVENT.codex.turnCompleted,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      detail: 'done'
    });
    await new Promise((resolve) => setImmediate(resolve));
    await harness.orchestrator.onWorkerExit('i-lineage', 'normal');

    expect(issueRuns).toEqual([
      expect.objectContaining({
        issue_id: 'i-lineage',
        issue_identifier: 'ABC-LIN',
        status: 'running',
        reason_code: 'dispatch_started'
      })
    ]);
    expect(attempts).toEqual([expect.objectContaining({ issue_run_id: 'issue_run_1', attempt_number: 0 })]);
    expect(threads).toEqual([expect.objectContaining({ attempt_id: 'attempt_1', thread_id: 'thread-1' })]);
    expect(turns).toEqual([expect.objectContaining({ thread_id: 'thread-1', turn_id: 'turn-1', turn_index: 0 })]);
    expect(phaseSpans).toHaveLength(2);
    expect(phaseSpans).toEqual(expect.arrayContaining([
      expect.objectContaining({ turn_id: 'turn-1', phase: 'planning', reason_code: 'codex_phase_planning' }),
      expect.objectContaining({ turn_id: 'turn-1', phase: 'validation', reason_code: 'codex_turn_completed' })
    ]));
    expect(toolSpans).toEqual([expect.objectContaining({ turn_id: 'turn-1', tool_name: 'exec_command', status: 'succeeded' })]);
    expect(transitions).toHaveLength(4);
    expect(transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ issue_run_id: 'issue_run_1', attempt_id: 'attempt_1', to_status: 'running', reason_code: 'dispatch_started' }),
      expect.objectContaining({ thread_id: 'thread-1', turn_id: 'turn-1', to_status: 'running', reason_code: 'codex_turn_started' }),
      expect.objectContaining({ thread_id: 'thread-1', turn_id: 'turn-1', to_status: 'succeeded', reason_code: 'codex_turn_completed' }),
      expect.objectContaining({ thread_id: 'thread-1', turn_id: 'turn-1', to_status: 'retrying', reason_code: 'normal_completion' })
    ]));
  });

  it('persists retry timer redispatch attempts under the original issue run', async () => {
    const issueRuns: Array<Record<string, unknown>> = [];
    const attempts: Array<Record<string, unknown>> = [];
    const threads: Array<Record<string, unknown>> = [];
    const transitions: Array<Record<string, unknown>> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => `legacy-run-${attempts.length + 1}`,
      appendIssueRun: async (params) => {
        issueRuns.push(params);
        return `issue_run_${issueRuns.length}`;
      },
      appendAttempt: async (params) => {
        attempts.push(params);
        return `attempt_${attempts.length}`;
      },
      appendThread: async (params) => {
        threads.push(params);
        return String(params.thread_id);
      },
      appendTurn: async (params) => String(params.turn_id),
      appendStateTransition: async (params) => {
        transitions.push(params);
        return `transition_${transitions.length}`;
      },
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async () => undefined
    };
    const harness = createHarness({
      persistence,
      resolveProgressSignals: async ({ fallback_state_marker }) => ({
        commit_sha: 'sha-new',
        checklist_checkpoint: 'chk-new',
        state_marker: fallback_state_marker
      })
    });
    const issue = makeIssue({ id: 'i-retry-lineage', identifier: 'ABC-RETRY', state: 'In Progress' });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-retry-lineage', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-0',
      turn_id: 'turn-0'
    });
    await new Promise((resolve) => setImmediate(resolve));
    await harness.orchestrator.onWorkerExit('i-retry-lineage', 'normal');

    const internals = harness.orchestrator as unknown as {
      state: {
        redispatch_progress: Map<
          string,
          Array<{ at_ms: number; commit_sha: string | null; checklist_checkpoint: string | null; state_marker: string | null; pr_open: boolean }>
        >;
      };
    };
    internals.state.redispatch_progress = new Map([
      [
        'i-retry-lineage',
        [{ at_ms: harness.now.value - 1, commit_sha: 'sha-old', checklist_checkpoint: 'chk-old', state_marker: null, pr_open: false }]
      ]
    ]);
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get('i-retry-lineage')?.callback();
    harness.orchestrator.onWorkerEvent('i-retry-lineage', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-1',
      turn_id: 'turn-1'
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(issueRuns).toHaveLength(1);
    expect(attempts).toEqual([
      expect.objectContaining({ issue_run_id: 'issue_run_1', attempt_number: 0 }),
      expect.objectContaining({ issue_run_id: 'issue_run_1', attempt_number: 1 })
    ]);
    expect(threads).toEqual([
      expect.objectContaining({ attempt_id: 'attempt_1', thread_id: 'thread-0' }),
      expect.objectContaining({ attempt_id: 'attempt_2', thread_id: 'thread-1' })
    ]);
    expect(transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ issue_run_id: 'issue_run_1', attempt_id: 'attempt_1', reason_code: 'normal_completion' }),
      expect.objectContaining({ issue_run_id: 'issue_run_1', attempt_id: 'attempt_2', reason_code: 'dispatch_started' })
    ]));
    expect(harness.spawned.filter((entry) => entry.issue_id === 'i-retry-lineage').map((entry) => entry.attempt)).toEqual([null, 1]);
  });

  it('persists redispatch gate blocks on the retry lineage issue run', async () => {
    const issueRuns: Array<Record<string, unknown>> = [];
    const attempts: Array<Record<string, unknown>> = [];
    const transitions: Array<Record<string, unknown>> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'legacy-run-1',
      appendIssueRun: async (params) => {
        issueRuns.push(params);
        return `issue_run_${issueRuns.length}`;
      },
      appendAttempt: async (params) => {
        attempts.push(params);
        return `attempt_${attempts.length}`;
      },
      appendThread: async (params) => String(params.thread_id),
      appendTurn: async (params) => String(params.turn_id),
      appendStateTransition: async (params) => {
        transitions.push(params);
        return `transition_${transitions.length}`;
      },
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async () => undefined
    };
    const harness = createHarness({
      persistence,
      resolveProgressSignals: async ({ fallback_state_marker }) => ({
        commit_sha: 'sha-same',
        checklist_checkpoint: 'chk-same',
        state_marker: fallback_state_marker
      })
    });
    const issue = makeIssue({ id: 'i-retry-blocked', identifier: 'ABC-BLOCK', state: 'In Progress' });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-retry-blocked', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-0',
      turn_id: 'turn-0'
    });
    await new Promise((resolve) => setImmediate(resolve));
    await harness.orchestrator.onWorkerExit('i-retry-blocked', 'normal');

    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get('i-retry-blocked')?.callback();

    const blocked = harness.orchestrator.getStateSnapshot().blocked_inputs.get('i-retry-blocked');
    expect(issueRuns).toHaveLength(1);
    expect(blocked?.issue_run_id).toBe('issue_run_1');
    expect(blocked?.previous_attempt_id).toBe('attempt_1');
    expect(transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issue_run_id: 'issue_run_1',
        attempt_id: 'attempt_1',
        thread_id: 'thread-0',
        to_status: 'blocked',
        reason_code: 'operator_action_required_no_progress_redispatch_blocked'
      })
    ]));
    expect(harness.spawned.filter((entry) => entry.issue_id === 'i-retry-blocked')).toHaveLength(1);
  });

  it('persists spawn failure retries under one issue run when the retry timer succeeds', async () => {
    const issueRuns: Array<Record<string, unknown>> = [];
    const attempts: Array<Record<string, unknown>> = [];
    const threads: Array<Record<string, unknown>> = [];
    const transitions: Array<Record<string, unknown>> = [];
    let spawnCount = 0;
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => `legacy-run-${spawnCount}`,
      appendIssueRun: async (params) => {
        issueRuns.push(params);
        return `issue_run_${issueRuns.length}`;
      },
      appendAttempt: async (params) => {
        attempts.push(params);
        return `attempt_${attempts.length}`;
      },
      appendThread: async (params) => {
        threads.push(params);
        return String(params.thread_id);
      },
      appendTurn: async (params) => String(params.turn_id),
      appendStateTransition: async (params) => {
        transitions.push(params);
        return `transition_${transitions.length}`;
      },
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async () => undefined
    };
    const harness = createHarness({
      persistence,
      spawnWorker: async ({ issue, attempt, worker_host, resume_context }) => {
        spawnCount += 1;
        harness.spawned.push({ issue_id: issue.id, attempt, worker_host, resume_context });
        if (spawnCount === 1) {
          return { ok: false, error: 'agent binary missing' };
        }
        return {
          ok: true,
          worker_handle: { issue_id: issue.id },
          monitor_handle: { issue_id: issue.id },
          worker_host
        };
      },
      resolveProgressSignals: async ({ fallback_state_marker }) => ({
        commit_sha: 'sha-new',
        checklist_checkpoint: 'chk-new',
        state_marker: fallback_state_marker
      })
    });
    const issue = makeIssue({ id: 'i-spawn-retry-lineage', identifier: 'ABC-SPAWN', state: 'In Progress' });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.orchestrator.tick('interval');

    const retryEntry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-spawn-retry-lineage');
    expect(retryEntry?.issue_run_id).toBe('issue_run_1');
    expect(retryEntry?.previous_attempt_id).toBe('attempt_1');
    expect(retryEntry?.stop_reason_code).toBe('spawn_failed');

    const internals = harness.orchestrator as unknown as {
      state: {
        redispatch_progress: Map<
          string,
          Array<{ at_ms: number; commit_sha: string | null; checklist_checkpoint: string | null; state_marker: string | null; pr_open: boolean }>
        >;
      };
    };
    internals.state.redispatch_progress = new Map([
      [
        'i-spawn-retry-lineage',
        [{ at_ms: harness.now.value - 1, commit_sha: 'sha-old', checklist_checkpoint: 'chk-old', state_marker: null, pr_open: false }]
      ]
    ]);
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.scheduled.get('i-spawn-retry-lineage')?.callback();
    harness.orchestrator.onWorkerEvent('i-spawn-retry-lineage', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-after-spawn-retry',
      turn_id: 'turn-after-spawn-retry'
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(issueRuns).toHaveLength(1);
    expect(attempts).toEqual([
      expect.objectContaining({
        issue_run_id: 'issue_run_1',
        attempt_number: 0,
        status: 'failed',
        reason_code: 'spawn_failed',
        reason_detail: 'agent binary missing'
      }),
      expect.objectContaining({
        issue_run_id: 'issue_run_1',
        attempt_number: 1,
        status: 'running',
        reason_code: 'attempt_started'
      })
    ]);
    expect(threads).toEqual([expect.objectContaining({ attempt_id: 'attempt_2', thread_id: 'thread-after-spawn-retry' })]);
    expect(transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ issue_run_id: 'issue_run_1', attempt_id: 'attempt_1', to_status: 'failed', reason_code: 'spawn_failed' }),
      expect.objectContaining({ issue_run_id: 'issue_run_1', attempt_id: 'attempt_1', to_status: 'retrying', reason_code: 'spawn_failed' }),
      expect.objectContaining({ issue_run_id: 'issue_run_1', attempt_id: 'attempt_2', to_status: 'running', reason_code: 'dispatch_started' })
    ]));
    expect(harness.spawned.filter((entry) => entry.issue_id === 'i-spawn-retry-lineage').map((entry) => entry.attempt)).toEqual([null, 1]);
  });

  it('persists worker-host capacity retries with graph lineage before a worker is spawned', async () => {
    const issueRuns: Array<Record<string, unknown>> = [];
    const attempts: Array<Record<string, unknown>> = [];
    const transitions: Array<Record<string, unknown>> = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => `legacy-run-${attempts.length + 1}`,
      appendIssueRun: async (params) => {
        issueRuns.push(params);
        return `issue_run_${issueRuns.length}`;
      },
      appendAttempt: async (params) => {
        attempts.push(params);
        return `attempt_${attempts.length}`;
      },
      appendThread: async (params) => String(params.thread_id),
      appendTurn: async (params) => String(params.turn_id),
      appendStateTransition: async (params) => {
        transitions.push(params);
        return `transition_${transitions.length}`;
      },
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async () => undefined
    };
    const harness = createHarness({
      persistence,
      configOverrides: {
        max_concurrent_agents: 2,
        worker_hosts: ['build-1'],
        max_concurrent_agents_per_host: 1
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-capacity-lineage-1', identifier: 'ABC-CAP-1' }),
      makeIssue({ id: 'i-capacity-lineage-2', identifier: 'ABC-CAP-2' })
    ]);

    await harness.orchestrator.tick('interval');

    const retryEntry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-capacity-lineage-2');
    expect(retryEntry?.issue_run_id).toBe('issue_run_2');
    expect(retryEntry?.previous_attempt_id).toBe('attempt_2');
    expect(retryEntry?.stop_reason_code).toBe('slots_exhausted');
    expect(issueRuns).toHaveLength(2);
    expect(attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ issue_run_id: 'issue_run_1', attempt_number: 0, status: 'running' }),
      expect.objectContaining({
        issue_run_id: 'issue_run_2',
        attempt_number: 0,
        status: 'blocked',
        reason_code: 'slots_exhausted',
        reason_detail: 'no available worker host slots'
      })
    ]));
    expect(transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ issue_run_id: 'issue_run_2', attempt_id: 'attempt_2', to_status: 'blocked', reason_code: 'slots_exhausted' }),
      expect.objectContaining({ issue_run_id: 'issue_run_2', attempt_id: 'attempt_2', to_status: 'retrying', reason_code: 'slots_exhausted' })
    ]));
    expect(harness.spawned).toEqual([{ issue_id: 'i-capacity-lineage-1', attempt: null, worker_host: 'build-1', resume_context: null }]);
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
      token_telemetry_status: 'available',
      token_telemetry_last_source: 'terminal_turn_summary',
      token_telemetry_last_at_ms: harness.now.value + 100,
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
    expect(running?.token_telemetry_status).toBe('available');
    expect(running?.token_telemetry_last_source).toBe('terminal_turn_summary');
    expect(running?.token_telemetry_last_at_ms).toBe(harness.now.value + 100);
    expect(running?.tokens.cached_input_tokens).toBe(3);
    expect(running?.tokens.reasoning_output_tokens).toBe(2);
    expect(running?.tokens.model_context_window).toBe(8192);
    expect(running?.recent_events).toHaveLength(2);
    expect(snapshot.codex_totals.total_tokens).toBe(14);
    expect(snapshot.codex_totals.cached_input_tokens).toBe(3);
    expect(snapshot.codex_totals.reasoning_output_tokens).toBe(2);
    expect(snapshot.codex_totals.model_context_window).toBe(8192);
  });

  it('tracks pending telemetry and emits a threshold warning while a turn is active', async () => {
    const harness = createHarness({
      configOverrides: { no_telemetry_warning_threshold_ms: 120_000 }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-pending-telemetry' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-pending-telemetry', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-1',
      turn_id: 'turn-1'
    });
    harness.orchestrator.onWorkerEvent('i-pending-telemetry', {
      timestamp_ms: harness.now.value + 120_001,
      event: CANONICAL_EVENT.codex.turnWaiting,
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      detail: 'waiting_for_turn_completion elapsed_s=120'
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    const running = snapshot.running.get('i-pending-telemetry');
    expect(running?.token_telemetry_status).toBe('pending');
    expect(
      snapshot.recent_runtime_events.some(
        (event) => event.event === CANONICAL_EVENT.codex.tokenTelemetryMissingThresholdExceeded && event.severity === 'warn'
      )
    ).toBe(true);
  });

  it('marks terminal no-usage turns unavailable instead of pending', async () => {
    const terminalEvents = [
      CANONICAL_EVENT.codex.turnCompleted,
      CANONICAL_EVENT.codex.turnFailed,
      CANONICAL_EVENT.codex.turnCancelled
    ];

    for (const terminalEvent of terminalEvents) {
      const harness = createHarness();
      harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-no-usage-terminal' })]);
      await harness.orchestrator.tick('interval');

      harness.orchestrator.onWorkerEvent('i-no-usage-terminal', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-1',
        turn_id: 'turn-1'
      });
      harness.orchestrator.onWorkerEvent('i-no-usage-terminal', {
        timestamp_ms: harness.now.value + 100,
        event: terminalEvent,
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        detail: 'terminal event without usage payload'
      });

      const snapshot = harness.orchestrator.getStateSnapshot();
      const running = snapshot.running.get('i-no-usage-terminal');
      expect(running?.token_telemetry_status).toBe('unavailable');
      expect(running?.token_telemetry_last_source).toBeNull();
      expect(running?.token_telemetry_last_at_ms).toBeNull();
      expect(typeof running?.tokens.input_tokens).toBe('number');
      expect(typeof running?.tokens.output_tokens).toBe('number');
      expect(typeof running?.tokens.total_tokens).toBe('number');
    }
  });

  it('emits budget warning threshold crossed from canonical telemetry', async () => {
    const harness = createHarness({
      configOverrides: {
        budget: {
          per_run_total_tokens: 100,
          rolling_window_minutes: 1440,
          warning_threshold_ratio: 0.8,
          hard_limit_policy: 'block_requires_resume'
        }
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-budget-warning' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-budget-warning', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.turnCompleted,
      usage: {
        input_tokens: 40,
        output_tokens: 40,
        total_tokens: 80
      },
      token_telemetry_status: 'available'
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.running.get('i-budget-warning')?.budget?.budget_status).toBe('warning');
    expect(
      snapshot.recent_runtime_events.some((event) => event.event === CANONICAL_EVENT.budget.warningThresholdCrossed)
    ).toBe(true);
  });

  it('evaluates per-run and rolling budget scopes independently when both are configured', async () => {
    const rollingNearLimit = createHarness({
      configOverrides: {
        budget: {
          per_run_total_tokens: 100,
          per_issue_rolling_tokens: 1000,
          rolling_window_minutes: 1440,
          warning_threshold_ratio: 0.8,
          hard_limit_policy: 'block_requires_resume'
        }
      }
    });
    rollingNearLimit.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-budget-mixed-rolling' })]);
    await rollingNearLimit.orchestrator.tick('interval');
    (rollingNearLimit.orchestrator as unknown as { state: { budget_usage_samples: Map<string, Array<{ at_ms: number; total_tokens: number }>> } }).state.budget_usage_samples.set('i-budget-mixed-rolling', [
      { at_ms: rollingNearLimit.now.value - 100, total_tokens: 950 }
    ]);

    rollingNearLimit.orchestrator.onWorkerEvent('i-budget-mixed-rolling', {
      timestamp_ms: rollingNearLimit.now.value + 100,
      event: CANONICAL_EVENT.codex.turnCompleted,
      usage: {
        input_tokens: 5,
        output_tokens: 5,
        total_tokens: 10
      },
      token_telemetry_status: 'available'
    });

    let snapshot = rollingNearLimit.orchestrator.getStateSnapshot();
    expect(snapshot.running.get('i-budget-mixed-rolling')?.budget).toMatchObject({
      budget_status: 'warning',
      budget_usage_tokens: 960,
      budget_limit_tokens: 1000
    });
    expect(snapshot.running.has('i-budget-mixed-rolling')).toBe(true);

    const perRunNearLimit = createHarness({
      configOverrides: {
        budget: {
          per_run_total_tokens: 100,
          per_issue_rolling_tokens: 1000,
          rolling_window_minutes: 1440,
          warning_threshold_ratio: 0.8,
          hard_limit_policy: 'block_requires_resume'
        }
      }
    });
    perRunNearLimit.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-budget-mixed-run' })]);
    await perRunNearLimit.orchestrator.tick('interval');

    perRunNearLimit.orchestrator.onWorkerEvent('i-budget-mixed-run', {
      timestamp_ms: perRunNearLimit.now.value + 100,
      event: CANONICAL_EVENT.codex.turnCompleted,
      usage: {
        input_tokens: 45,
        output_tokens: 45,
        total_tokens: 90
      },
      token_telemetry_status: 'available'
    });

    snapshot = perRunNearLimit.orchestrator.getStateSnapshot();
    expect(snapshot.running.get('i-budget-mixed-run')?.budget).toMatchObject({
      budget_status: 'warning',
      budget_usage_tokens: 90,
      budget_limit_tokens: 100
    });
    expect(snapshot.running.has('i-budget-mixed-run')).toBe(true);

    const rollingHardLimit = createHarness({
      configOverrides: {
        budget: {
          per_run_total_tokens: 100,
          per_issue_rolling_tokens: 1000,
          rolling_window_minutes: 1440,
          warning_threshold_ratio: 0.8,
          hard_limit_policy: 'block_requires_resume'
        }
      }
    });
    rollingHardLimit.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-budget-mixed-hard' })]);
    await rollingHardLimit.orchestrator.tick('interval');
    (rollingHardLimit.orchestrator as unknown as { state: { budget_usage_samples: Map<string, Array<{ at_ms: number; total_tokens: number }>> } }).state.budget_usage_samples.set('i-budget-mixed-hard', [
      { at_ms: rollingHardLimit.now.value - 100, total_tokens: 995 }
    ]);

    rollingHardLimit.orchestrator.onWorkerEvent('i-budget-mixed-hard', {
      timestamp_ms: rollingHardLimit.now.value + 100,
      event: CANONICAL_EVENT.codex.turnCompleted,
      usage: {
        input_tokens: 5,
        output_tokens: 5,
        total_tokens: 10
      },
      token_telemetry_status: 'available'
    });
    await new Promise((resolve) => setImmediate(resolve));

    snapshot = rollingHardLimit.orchestrator.getStateSnapshot();
    expect(snapshot.running.has('i-budget-mixed-hard')).toBe(false);
    expect(snapshot.blocked_inputs.get('i-budget-mixed-hard')).toMatchObject({
      budget: {
        budget_status: 'hard_limited',
        budget_usage_tokens: 1005,
        budget_limit_tokens: 1000
      }
    });
    expect(snapshot.blocked_inputs.get('i-budget-mixed-hard')?.stop_reason_detail).toContain('rolling issue budget');
  });

  it('blocks for manual resume when budget hard limit policy requires resume', async () => {
    const harness = createHarness({
      configOverrides: {
        budget: {
          per_run_total_tokens: 100,
          rolling_window_minutes: 1440,
          warning_threshold_ratio: 0.8,
          hard_limit_policy: 'block_requires_resume'
        }
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-budget-block', identifier: 'ABC-BUDGET' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-budget-block', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.turnCompleted,
      usage: {
        input_tokens: 60,
        output_tokens: 45,
        total_tokens: 105
      },
      token_telemetry_status: 'available'
    });
    await new Promise((resolve) => setImmediate(resolve));

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.running.has('i-budget-block')).toBe(false);
    expect(harness.terminated).toEqual([
      { issue_id: 'i-budget-block', cleanup_workspace: false, reason: 'operator_action_required_budget_limit_exceeded' }
    ]);
    expect(snapshot.blocked_inputs.get('i-budget-block')).toMatchObject({
      stop_reason_code: 'operator_action_required_budget_limit_exceeded',
      requires_manual_resume: true,
      budget: {
        budget_status: 'hard_limited',
        budget_policy: 'block_requires_resume',
        budget_usage_tokens: 105,
        budget_limit_tokens: 100
      }
    });
  });

  it('latches budget hard limits before async termination can finish', async () => {
    const terminateError = new Error('termination timed out');
    const harness = createHarness({
      configOverrides: {
        budget: {
          per_run_total_tokens: 50,
          rolling_window_minutes: 1440,
          warning_threshold_ratio: 0.8,
          hard_limit_policy: 'block_requires_resume'
        }
      },
      terminateWorker: async () => {
        throw terminateError;
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-budget-latch', identifier: 'ABC-LATCH' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-budget-latch', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.turnCompleted,
      usage: {
        input_tokens: 30,
        output_tokens: 25,
        total_tokens: 55
      },
      token_telemetry_status: 'available'
    });

    let snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.running.has('i-budget-latch')).toBe(false);
    expect(snapshot.blocked_inputs.get('i-budget-latch')).toMatchObject({
      stop_reason_code: 'operator_action_required_budget_limit_exceeded',
      quarantined_event_count: 0
    });
    expect(snapshot.codex_totals.total_tokens).toBe(55);

    harness.orchestrator.onWorkerEvent('i-budget-latch', {
      timestamp_ms: harness.now.value + 101,
      event: CANONICAL_EVENT.codex.turnCompleted,
      usage: {
        input_tokens: 500,
        output_tokens: 500,
        total_tokens: 1000
      },
      token_telemetry_status: 'available'
    });
    await new Promise((resolve) => setImmediate(resolve));

    snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.codex_totals.total_tokens).toBe(55);
    expect(snapshot.blocked_inputs.get('i-budget-latch')?.quarantined_event_count).toBe(1);
    expect(snapshot.health.last_error).toContain('Budget hard limit cleanup failed: termination timed out');
  });

  it('terminates attempt without retry when budget hard limit policy terminates attempts', async () => {
    const harness = createHarness({
      configOverrides: {
        budget: {
          per_run_total_tokens: 50,
          rolling_window_minutes: 1440,
          warning_threshold_ratio: 0.8,
          hard_limit_policy: 'terminate_attempt'
        }
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-budget-terminate' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-budget-terminate', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.turnCompleted,
      usage: {
        input_tokens: 30,
        output_tokens: 25,
        total_tokens: 55
      },
      token_telemetry_status: 'available'
    });
    await new Promise((resolve) => setImmediate(resolve));

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.running.has('i-budget-terminate')).toBe(false);
    expect(snapshot.retry_attempts.has('i-budget-terminate')).toBe(false);
    expect(snapshot.blocked_inputs.has('i-budget-terminate')).toBe(false);
    expect(harness.terminated).toEqual([
      { issue_id: 'i-budget-terminate', cleanup_workspace: false, reason: 'attempt_terminated_budget_limit_exceeded' }
    ]);
    expect(snapshot.health.last_error).toContain('Attempt terminated by budget policy');
  });

  it('emits budget telemetry unavailable warning without zero accounting', async () => {
    const harness = createHarness({
      configOverrides: {
        budget: {
          per_run_total_tokens: 100,
          rolling_window_minutes: 1440,
          warning_threshold_ratio: 0.8,
          hard_limit_policy: 'block_requires_resume'
        }
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-budget-no-telemetry' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-budget-no-telemetry', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-1',
      turn_id: 'turn-1'
    });
    harness.orchestrator.onWorkerEvent('i-budget-no-telemetry', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.turnCompleted,
      thread_id: 'thread-1',
      turn_id: 'turn-1'
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.running.get('i-budget-no-telemetry')?.budget).toMatchObject({
      budget_usage_tokens: null,
      budget_status: 'telemetry_unavailable'
    });
    expect(
      snapshot.recent_runtime_events.some((event) => event.event === CANONICAL_EVENT.budget.telemetryUnavailable)
    ).toBe(true);
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

  it('ignores stale worker events that mismatch the active running thread lineage', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-stale-thread', identifier: 'ABC-STALE' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-stale-thread', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-current',
      session_id: 'session-current'
    });
    harness.orchestrator.onWorkerEvent('i-stale-thread', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'late stale waiting heartbeat',
      thread_id: 'thread-stale',
      turn_id: 'turn-stale',
      session_id: 'session-stale'
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    const running = snapshot.running.get('i-stale-thread');
    expect(running).toMatchObject({
      last_event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-current',
      session_id: 'session-current',
      stalled_waiting_reason: null,
      running_waiting_started_at_ms: null
    });
    expect(snapshot.phase_timeline?.get('i-stale-thread')?.map((marker) => marker.phase)).toEqual([
      'dispatch_started',
      'workspace_ready',
      'codex_turn_started'
    ]);
    expect(running?.quarantined_event_count).toBe(1);
    expect(running?.quarantined_events?.[0]).toEqual(
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.turnWaiting,
        thread_id: 'thread-stale',
        turn_id: 'turn-stale',
        session_id: 'session-stale',
        active_thread_id: 'thread-current',
        active_turn_id: 'turn-current',
        active_session_id: 'session-current',
        reason: 'lineage_mismatch'
      })
    );
    expect(snapshot.recent_runtime_events.some((event) => event.event === CANONICAL_EVENT.orchestration.staleWorkerEventIgnored)).toBe(
      false
    );
  });

  it('quarantines old implementation PID events after fresh Agent Review handoff even when they echo the fresh lineage', async () => {
    const harness = createHarness({
      configOverrides: {
        active_states: ['In Progress', 'Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review']
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-handoff-pid', identifier: 'NIE-84', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-handoff-pid', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'implementation-thread',
      turn_id: 'implementation-turn',
      session_id: 'implementation-session',
      codex_app_server_pid: 46181
    });
    await harness.orchestrator.onWorkerExit('i-handoff-pid', 'normal', undefined, {
      completion_reason: REASON_CODES.handoffStateReached,
      refreshed_state: 'Agent Review'
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-handoff-pid', identifier: 'NIE-84', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-handoff-pid', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'old implementation heartbeat elapsed_s=1151',
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session',
      codex_app_server_pid: 46181
    });
    harness.orchestrator.onWorkerEvent('i-handoff-pid', {
      timestamp_ms: harness.now.value + 30,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'fresh review heartbeat elapsed_s=110',
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session',
      codex_app_server_pid: 94799
    });
    harness.orchestrator.onWorkerEvent('i-handoff-pid', {
      timestamp_ms: harness.now.value + 40,
      event: CANONICAL_EVENT.codex.phasePlanning,
      detail: 'old implementation planning elapsed_s=1160',
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session',
      codex_app_server_pid: 46181
    });

    const running = harness.orchestrator.getStateSnapshot().running.get('i-handoff-pid');
    expect(running).toMatchObject({
      thread_id: 'review-thread',
      turn_id: 'review-turn',
      session_id: 'review-session',
      codex_app_server_pid: '94799',
      last_event: CANONICAL_EVENT.codex.turnWaiting,
      last_message: 'fresh review heartbeat elapsed_s=110'
    });
    expect(running?.quarantined_event_count).toBe(2);
    expect(running?.quarantined_events).toEqual([
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.turnWaiting,
        codex_app_server_pid: '46181',
        active_codex_app_server_pid: null,
        active_thread_id: null,
        active_turn_id: null,
        active_session_id: null,
        reason: 'inactive_worker_pid'
      }),
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.phasePlanning,
        codex_app_server_pid: '46181',
        active_codex_app_server_pid: '94799',
        active_thread_id: 'review-thread',
        active_turn_id: 'review-turn',
        active_session_id: 'review-session',
        reason: 'inactive_worker_pid'
      })
    ]);
  });

  it('accepts a fresh worker reusing an inactive PID after the TTL expires', async () => {
    const harness = createHarness({
      configOverrides: {
        active_states: ['In Progress', 'Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review'],
        inactive_worker_pid_ttl_ms: 1_000
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-reused-pid-after-ttl', identifier: 'NIE-86', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-reused-pid-after-ttl', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'old-thread',
      turn_id: 'old-turn',
      session_id: 'old-session',
      codex_app_server_pid: 46181
    });
    await harness.orchestrator.onWorkerExit('i-reused-pid-after-ttl', 'normal', undefined, {
      completion_reason: REASON_CODES.handoffStateReached,
      refreshed_state: 'Agent Review'
    });

    harness.now.value += 1_001;
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-reused-pid-after-ttl', identifier: 'NIE-86', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-reused-pid-after-ttl', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'fresh-thread',
      turn_id: 'fresh-turn',
      session_id: 'fresh-session',
      codex_app_server_pid: 46181
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    const running = snapshot.running.get('i-reused-pid-after-ttl');
    expect(running).toMatchObject({
      thread_id: 'fresh-thread',
      turn_id: 'fresh-turn',
      session_id: 'fresh-session',
      codex_app_server_pid: '46181',
      quarantined_event_count: 0
    });
    expect(snapshot.inactive_worker_pids?.has('i-reused-pid-after-ttl')).toBe(false);
  });

  it('keeps reused inactive PID events quarantined before the TTL expires', async () => {
    const harness = createHarness({
      configOverrides: {
        active_states: ['In Progress', 'Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review'],
        inactive_worker_pid_ttl_ms: 1_000
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-reused-pid-before-ttl', identifier: 'NIE-86', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-reused-pid-before-ttl', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'old-thread',
      turn_id: 'old-turn',
      session_id: 'old-session',
      codex_app_server_pid: 46181
    });
    await harness.orchestrator.onWorkerExit('i-reused-pid-before-ttl', 'normal', undefined, {
      completion_reason: REASON_CODES.handoffStateReached,
      refreshed_state: 'Agent Review'
    });

    harness.now.value += 999;
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-reused-pid-before-ttl', identifier: 'NIE-86', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-reused-pid-before-ttl', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'fresh-thread',
      turn_id: 'fresh-turn',
      session_id: 'fresh-session',
      codex_app_server_pid: 46181
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    const running = snapshot.running.get('i-reused-pid-before-ttl');
    expect(running).toMatchObject({
      thread_id: null,
      turn_id: null,
      session_id: null,
      codex_app_server_pid: null,
      quarantined_event_count: 1
    });
    expect(running?.quarantined_events?.[0]).toEqual(
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.turnStarted,
        codex_app_server_pid: '46181',
        reason: 'inactive_worker_pid'
      })
    );
    expect(snapshot.inactive_worker_pids?.get('i-reused-pid-before-ttl')).toEqual([
      expect.objectContaining({ pid: '46181' })
    ]);
  });

  it('prunes expired inactive PID entries before matching stale events', async () => {
    const harness = createHarness({
      configOverrides: {
        active_states: ['In Progress', 'Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review'],
        inactive_worker_pid_ttl_ms: 1_000
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-prune-expired-pid', identifier: 'NIE-86', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-prune-expired-pid', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'old-thread',
      turn_id: 'old-turn',
      session_id: 'old-session',
      codex_app_server_pid: 46181
    });
    await harness.orchestrator.onWorkerExit('i-prune-expired-pid', 'normal', undefined, {
      completion_reason: REASON_CODES.handoffStateReached,
      refreshed_state: 'Agent Review'
    });

    harness.now.value += 1_000;
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-prune-expired-pid', identifier: 'NIE-86', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-prune-expired-pid', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnWaiting,
      thread_id: 'fresh-thread',
      turn_id: 'fresh-turn',
      session_id: 'fresh-session',
      codex_app_server_pid: 46181
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.inactive_worker_pids?.has('i-prune-expired-pid')).toBe(false);
    expect(snapshot.running.get('i-prune-expired-pid')?.quarantined_event_count).toBe(0);
  });

  it('quarantines old implementation and canceled review PID events after Cancel Turn retry', async () => {
    const harness = createHarness({
      configOverrides: {
        active_states: ['In Progress', 'Agent Review'],
        handoff_states: ['Agent Review'],
        fresh_dispatch_states: ['Agent Review']
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-cancel-retry-pid', identifier: 'NIE-84', state: 'In Progress' })
    ]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-cancel-retry-pid', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'implementation-thread',
      turn_id: 'implementation-turn',
      session_id: 'implementation-session',
      codex_app_server_pid: 46181
    });
    await harness.orchestrator.onWorkerExit('i-cancel-retry-pid', 'normal', undefined, {
      completion_reason: REASON_CODES.handoffStateReached,
      refreshed_state: 'Agent Review'
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-cancel-retry-pid', identifier: 'NIE-84', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');
    harness.orchestrator.onWorkerEvent('i-cancel-retry-pid', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'first-review-thread',
      turn_id: 'first-review-turn',
      session_id: 'first-review-session',
      codex_app_server_pid: 94799
    });

    const cancelled = await harness.orchestrator.cancelCurrentTurn('NIE-84', {
      confirmed: true,
      reason_note: 'linear bug'
    });
    expect(cancelled).toEqual({ ok: true, issue_id: 'i-cancel-retry-pid' });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-cancel-retry-pid', identifier: 'NIE-84', state: 'Agent Review' })
    ]);
    await harness.orchestrator.tick('interval');

    for (const [pid, elapsed] of [
      [94799, 601],
      [46181, 1643]
    ] as const) {
      harness.orchestrator.onWorkerEvent('i-cancel-retry-pid', {
        timestamp_ms: harness.now.value + elapsed,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: `stale heartbeat elapsed_s=${elapsed}`,
        thread_id: 'retry-thread',
        turn_id: 'retry-turn',
        session_id: 'retry-session',
        codex_app_server_pid: pid
      });
    }
    harness.orchestrator.onWorkerEvent('i-cancel-retry-pid', {
      timestamp_ms: harness.now.value + 5,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'fresh retry heartbeat elapsed_s=5',
      thread_id: 'retry-thread',
      turn_id: 'retry-turn',
      session_id: 'retry-session',
      codex_app_server_pid: 5737
    });
    harness.orchestrator.onWorkerEvent('i-cancel-retry-pid', {
      timestamp_ms: harness.now.value + 700,
      event: CANONICAL_EVENT.codex.phasePlanning,
      detail: 'canceled worker planning elapsed_s=700',
      thread_id: 'retry-thread',
      turn_id: 'retry-turn',
      session_id: 'retry-session',
      codex_app_server_pid: 94799
    });

    const running = harness.orchestrator.getStateSnapshot().running.get('i-cancel-retry-pid');
    expect(running).toMatchObject({
      thread_id: 'retry-thread',
      turn_id: 'retry-turn',
      session_id: 'retry-session',
      codex_app_server_pid: '5737',
      last_event: CANONICAL_EVENT.codex.turnWaiting,
      last_message: 'fresh retry heartbeat elapsed_s=5'
    });
    expect(running?.quarantined_event_count).toBe(3);
    expect(running?.quarantined_events?.map((event) => [event.codex_app_server_pid, event.reason])).toEqual([
      ['94799', 'inactive_worker_pid'],
      ['46181', 'inactive_worker_pid'],
      ['94799', 'inactive_worker_pid']
    ]);
  });

  it('ignores stale turn started events from an old turn on the active thread', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-stale-turn', identifier: 'ABC-STALE-TURN' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-stale-turn', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-2',
      session_id: 'session-turn-2'
    });
    harness.orchestrator.onWorkerEvent('i-stale-turn', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-1',
      session_id: 'session-turn-1'
    });
    harness.orchestrator.onWorkerEvent('i-stale-turn', {
      timestamp_ms: harness.now.value + 200,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'late stale waiting heartbeat',
      thread_id: 'thread-current',
      turn_id: 'turn-1',
      session_id: 'session-turn-1'
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    const running = snapshot.running.get('i-stale-turn');
    expect(running).toMatchObject({
      last_event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-2',
      session_id: 'session-turn-2',
      stalled_waiting_reason: null,
      running_waiting_started_at_ms: null
    });
    expect(snapshot.phase_timeline?.get('i-stale-turn')?.map((marker) => marker.phase)).toEqual([
      'dispatch_started',
      'workspace_ready',
      'codex_turn_started'
    ]);
    expect(running?.quarantined_event_count).toBe(2);
    expect(running?.quarantined_events?.map((event) => event.event)).toEqual([
      CANONICAL_EVENT.codex.turnStarted,
      CANONICAL_EVENT.codex.turnWaiting
    ]);
    expect(running?.quarantined_events?.every((event) => event.turn_id === 'turn-1')).toBe(true);
    expect(snapshot.recent_runtime_events.some((event) => event.event === CANONICAL_EVENT.orchestration.staleWorkerEventIgnored)).toBe(
      false
    );
  });

  it('accepts continuation turn starts on the active thread after the prior turn completed', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-continuation-turn', identifier: 'ABC-CONTINUE' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-continuation-turn', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-1',
      session_id: 'session-turn-1'
    });
    harness.orchestrator.onWorkerEvent('i-continuation-turn', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.turnCompleted,
      thread_id: 'thread-current',
      turn_id: 'turn-1',
      session_id: 'session-turn-1'
    });
    harness.orchestrator.onWorkerEvent('i-continuation-turn', {
      timestamp_ms: harness.now.value + 200,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-2',
      session_id: 'session-turn-2'
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    const running = snapshot.running.get('i-continuation-turn');
    expect(running).toMatchObject({
      last_event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-2',
      session_id: 'session-turn-2',
      turn_count: 2
    });
    expect(snapshot.phase_timeline?.get('i-continuation-turn')?.map((marker) => marker.phase)).toEqual([
      'dispatch_started',
      'workspace_ready',
      'codex_turn_started',
      'validation'
    ]);
    expect(
      snapshot.recent_runtime_events.some(
        (event) =>
          event.event === CANONICAL_EVENT.orchestration.staleWorkerEventIgnored &&
          event.issue_identifier === 'ABC-CONTINUE'
      )
    ).toBe(false);
  });

  it('ignores stale turn started events from an old turn after a newer turn completed', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-stale-after-complete', identifier: 'ABC-STALE-COMPLETE' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-stale-after-complete', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-1',
      session_id: 'session-turn-1'
    });
    harness.orchestrator.onWorkerEvent('i-stale-after-complete', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.turnCompleted,
      thread_id: 'thread-current',
      turn_id: 'turn-1',
      session_id: 'session-turn-1'
    });
    harness.orchestrator.onWorkerEvent('i-stale-after-complete', {
      timestamp_ms: harness.now.value + 200,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-2',
      session_id: 'session-turn-2'
    });
    harness.orchestrator.onWorkerEvent('i-stale-after-complete', {
      timestamp_ms: harness.now.value + 300,
      event: CANONICAL_EVENT.codex.turnCompleted,
      thread_id: 'thread-current',
      turn_id: 'turn-2',
      session_id: 'session-turn-2'
    });
    harness.orchestrator.onWorkerEvent('i-stale-after-complete', {
      timestamp_ms: harness.now.value + 400,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-1',
      session_id: 'session-turn-1'
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    const running = snapshot.running.get('i-stale-after-complete');
    expect(running).toMatchObject({
      last_event: CANONICAL_EVENT.codex.turnCompleted,
      thread_id: 'thread-current',
      turn_id: 'turn-2',
      session_id: 'session-turn-2',
      turn_count: 2
    });
    expect(snapshot.phase_timeline?.get('i-stale-after-complete')?.map((marker) => marker.phase)).toEqual([
      'dispatch_started',
      'workspace_ready',
      'codex_turn_started',
      'validation'
    ]);
    expect(running?.quarantined_event_count).toBe(1);
    expect(running?.quarantined_events?.[0]).toEqual(
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-current',
        turn_id: 'turn-1',
        session_id: 'session-turn-1',
        active_thread_id: 'thread-current',
        active_turn_id: 'turn-2',
        active_session_id: 'session-turn-2',
        reason: 'lineage_mismatch'
      })
    );
    expect(snapshot.recent_runtime_events.some((event) => event.event === CANONICAL_EVENT.orchestration.staleWorkerEventIgnored)).toBe(
      false
    );
  });

  it('ignores stale turn started events with old session lineage even when thread lineage is omitted', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-stale-start-session', identifier: 'ABC-STALE-SESSION' })
    ]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-stale-start-session', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-current',
      session_id: 'session-current'
    });
    harness.orchestrator.onWorkerEvent('i-stale-start-session', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.turnStarted,
      turn_id: 'turn-stale',
      session_id: 'session-stale'
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    const running = snapshot.running.get('i-stale-start-session');
    expect(running).toMatchObject({
      last_event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-current',
      turn_id: 'turn-current',
      session_id: 'session-current'
    });
    expect(snapshot.phase_timeline?.get('i-stale-start-session')?.map((marker) => marker.phase)).toEqual([
      'dispatch_started',
      'workspace_ready',
      'codex_turn_started'
    ]);
    expect(running?.quarantined_event_count).toBe(1);
    expect(running?.quarantined_events?.[0]).toEqual(
      expect.objectContaining({
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: null,
        turn_id: 'turn-stale',
        session_id: 'session-stale',
        active_thread_id: 'thread-current',
        active_turn_id: 'turn-current',
        active_session_id: 'session-current',
        reason: 'lineage_mismatch'
      })
    );
    expect(snapshot.recent_runtime_events.some((event) => event.event === CANONICAL_EVENT.orchestration.staleWorkerEventIgnored)).toBe(
      false
    );
  });

  it('emits phase markers from explicit lifecycle events', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-explicit-phase' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-explicit-phase', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.promptSent,
      detail: 'initial_prompt'
    });
    harness.orchestrator.onWorkerEvent('i-explicit-phase', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-1',
      turn_id: 'turn-1'
    });
    harness.orchestrator.onWorkerEvent('i-explicit-phase', {
      timestamp_ms: harness.now.value + 30,
      event: CANONICAL_EVENT.codex.phasePlanning,
      detail: 'waiting_for_turn_completion elapsed_s=0'
    });
    harness.orchestrator.onWorkerEvent('i-explicit-phase', {
      timestamp_ms: harness.now.value + 40,
      event: CANONICAL_EVENT.codex.phaseImplementation,
      detail: 'shell_exec'
    });
    harness.orchestrator.onWorkerEvent('i-explicit-phase', {
      timestamp_ms: harness.now.value + 50,
      event: CANONICAL_EVENT.codex.phaseValidation
    });

    const timeline = harness.orchestrator.getStateSnapshot().phase_timeline?.get('i-explicit-phase') ?? [];
    expect(timeline.map((marker) => marker.phase)).toEqual([
      'dispatch_started',
      'workspace_ready',
      'prompt_sent',
      'codex_turn_started',
      'planning',
      'implementation',
      'validation'
    ]);
  });

  it('keeps legacy worker-event mapping as fallback when explicit lifecycle emits are absent', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-fallback-phase' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-fallback-phase', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-2',
      turn_id: 'turn-1'
    });
    harness.orchestrator.onWorkerEvent('i-fallback-phase', {
      timestamp_ms: harness.now.value + 20,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting_for_turn_completion elapsed_s=0'
    });
    harness.orchestrator.onWorkerEvent('i-fallback-phase', {
      timestamp_ms: harness.now.value + 30,
      event: CANONICAL_EVENT.codex.toolCallCompleted,
      detail: 'shell_exec'
    });
    harness.orchestrator.onWorkerEvent('i-fallback-phase', {
      timestamp_ms: harness.now.value + 40,
      event: CANONICAL_EVENT.codex.turnCompleted
    });

    const timeline = harness.orchestrator.getStateSnapshot().phase_timeline?.get('i-fallback-phase') ?? [];
    expect(timeline.map((marker) => marker.phase)).toEqual([
      'dispatch_started',
      'workspace_ready',
      'codex_turn_started',
      'planning',
      'implementation',
      'validation'
    ]);
  });

  it('accepts fresh dispatch phases for a resumed attempt after prior attempt reached planning', async () => {
    const logEntries: Array<{
      event: string;
      context?: Record<string, string | number | boolean | null | undefined>;
    }> = [];
    let commit = 'sha-1';
    const harness = createHarness({
      resolveProgressSignals: async () => ({
        commit_sha: commit,
        checklist_checkpoint: 'chk',
        state_marker: 'planning'
      }),
      logger: {
        log: (params) => {
          logEntries.push({ event: params.event, context: params.context });
        }
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-redispatch' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-redispatch', {
      timestamp_ms: harness.now.value + 10,
      event: CANONICAL_EVENT.codex.phasePlanning,
      detail: 'waiting_for_turn_completion elapsed_s=0'
    });
    await harness.orchestrator.onWorkerExit('i-redispatch', 'abnormal');

    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-redispatch' })]);
    await harness.orchestrator.onRetryTimer('i-redispatch');
    commit = 'sha-2';
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([
      makeIssue({ id: 'i-redispatch', identifier: 'ABC-1', state: 'In Progress' })
    ]);
    const resumed = await harness.orchestrator.resumeBlockedIssue('ABC-1', null, null, {
      actor: 'operator@example.test',
      reason_note: 'progress signal changed'
    });
    expect(resumed).toEqual({ ok: true, issue_id: 'i-redispatch' });

    const timeline = harness.orchestrator.getStateSnapshot().phase_timeline?.get('i-redispatch') ?? [];
    expect(timeline.map((marker) => `${marker.attempt}:${marker.phase}`)).toEqual([
      '0:dispatch_started',
      '0:workspace_ready',
      '0:planning',
      '0:failed',
      '1:dispatch_started',
      '1:workspace_ready'
    ]);

    const ignoredDispatchStartedAttemptOne = logEntries.find(
      (entry) =>
        entry.event === CANONICAL_EVENT.orchestration.phaseMarkerIgnored &&
        entry.context?.phase === 'dispatch_started' &&
        entry.context?.attempt === 1
    );
    expect(ignoredDispatchStartedAttemptOne).toBeUndefined();
  });
});
