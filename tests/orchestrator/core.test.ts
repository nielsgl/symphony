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

function createHarness(options: {
  configOverrides?: Partial<OrchestratorConfig>;
  spawnWorker?: OrchestratorPorts['spawnWorker'];
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

    const resumed = await harness.orchestrator.resumeBlockedIssue('ABC-BLOCK');
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

    const resumed = await harness.orchestrator.resumeBlockedIssue('ABC-RESTORE', null, 'manual override');
    expect(resumed).toEqual({ ok: true, issue_id: 'i-restored' });
    expect(harness.spawned.find((entry) => entry.issue_id === 'i-restored')).toBeDefined();
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

    const resumed = await harness.orchestrator.resumeBlockedIssue('ABC-RESUME');
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
    const resumed = await harness.orchestrator.resumeBlockedIssue('ABC-PROGRESS');
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
    const withoutOverride = await harness.orchestrator.resumeBlockedIssue('ABC-OVERRIDE');
    expect(withoutOverride).toEqual({
      ok: false,
      code: 'resume_failed',
      message: 'Issue ABC-OVERRIDE requires progress or an explicit resume override reason'
    });

    const withOverride = await harness.orchestrator.resumeBlockedIssue(
      'ABC-OVERRIDE',
      null,
      'operator approved redispatch without new progress'
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

    const cancelled = await harness.orchestrator.cancelBlockedIssue('ABC-CANCEL', 'operator_cancel_return_to_backlog');
    expect(cancelled).toEqual({ ok: true, issue_id: 'i-cancel', moved_to_state: 'Todo' });
    expect(harness.tracker.update_issue_state).toHaveBeenCalledWith('i-cancel', 'Todo');
    expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-cancel')).toBe(false);
    const cancelLog = logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.cancelToBacklogExecuted);
    expect(cancelLog?.context?.issue_id).toBe('i-cancel');
    expect(cancelLog?.context?.next_operator_action).toBe('issue.state.todo');
  });

  it('submits blocked operator input and injects answer into resumed dispatch context', async () => {
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
      answer: { question_id: 'q1', option_label: 'Yes' }
    });

    expect(result).toMatchObject({
      ok: true,
      issue_id: 'i-submit',
      request_id: 'req-123',
      resume_mode: 'fallback',
      resume_reason_code: 'transport_unsupported'
    });
    const resumedSpawn = harness.spawned.find((entry) => entry.issue_id === 'i-submit' && entry.resume_context);
    expect(resumedSpawn?.resume_context).toContain('Request ID: req-123');
    expect(resumedSpawn?.resume_context).toContain('Question: Deploy now?');
    expect(resumedSpawn?.resume_context).toContain('Answer: Yes');
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
    const resumed = await harness.orchestrator.resumeBlockedIssue('ABC-1');
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
