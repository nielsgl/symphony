import { describe, expect, it, vi } from 'vitest';

import {
  CANONICAL_EVENT,
  LocalApiServer,
  OrchestratorCore,
  REASON_CODES,
  SnapshotService,
  SqlitePersistenceStore,
  buildDurableIdentity,
  createHarness,
  fs,
  makeControlPlaneHealthSummary,
  makeIssue,
  makeTerminationResult,
  makeTracker,
  os,
  path,
  toWorkerEvent,
  withTemporaryCodexHome,
  writeSessionTranscript
} from './core-test-harness';
import type {
  Harness,
  Issue,
  OrchestratorPersistencePort,
  OrchestratorPorts,
  OrchestratorState,
  StructuredLogger,
  TranscriptToolCallDiagnostic,
  TranscriptToolCallLineage
} from './core-test-harness';

describe('OrchestratorCore stalled waiting', () => {
  it('keeps prolonged codex.turn.waiting running at the warning threshold', async () => {
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
    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.running.has('i-wait')).toBe(true);
    expect(snapshot.retry_attempts.has('i-wait')).toBe(false);
    expect(snapshot.blocked_inputs.has('i-wait')).toBe(false);
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

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.running.has('i-wait-heartbeat')).toBe(true);
    expect(snapshot.retry_attempts.has('i-wait-heartbeat')).toBe(false);
    expect(snapshot.blocked_inputs.has('i-wait-heartbeat')).toBe(false);
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

  it('keeps prolonged codex.turn.waiting running when fresh activity metadata is observed', async () => {
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

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.running.has('i-active-thread')).toBe(true);
    expect(snapshot.retry_attempts.has('i-active-thread')).toBe(false);
    expect(snapshot.blocked_inputs.has('i-active-thread')).toBe(false);
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

  it('keeps synthetic wait-loop planning heartbeats and metadata running after the warning threshold', async () => {
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
      detail: 'waiting_for_turn_completion elapsed_s=0',
      thread_id: 'thread-phase',
      session_id: 'thread-phase-turn-1'
    });
    harness.now.value += 300;
    harness.orchestrator.onWorkerEvent('i-wait-phase', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.rateLimitsUpdated,
      detail: 'rate limits updated',
      thread_id: 'thread-phase',
      session_id: 'thread-phase-turn-1',
      rate_limits: {
        primary: {
          used_percent: 10,
          window_minutes: 300,
          resets_at: 1_000_000
        }
      }
    });
    harness.now.value += 100;
    harness.orchestrator.onWorkerEvent('i-wait-phase', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.protocolWarning,
      detail: 'guardian policy warning',
      thread_id: 'thread-phase',
      session_id: 'thread-phase-turn-1',
      protocol_warning: {
        method: 'warning',
        reason_code: REASON_CODES.codexProtocolGuardianWarning,
        message: 'guardian policy warning',
        severity: 'warn',
        source: 'app_server_protocol'
      }
    });
    harness.now.value += 100;
    harness.orchestrator.onWorkerEvent('i-wait-phase', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.modelRerouted,
      detail: 'model/account metadata',
      thread_id: 'thread-phase',
      session_id: 'thread-phase-turn-1',
      requested_model: 'gpt-5.2',
      effective_model: 'gpt-5.2-mini',
      model_reroute: {
        requested_model: 'gpt-5.2',
        effective_model: 'gpt-5.2-mini',
        reason_code: 'model_metadata_observed',
        source: 'app_server_protocol'
      }
    });
    harness.now.value += 200;
    harness.orchestrator.onWorkerEvent('i-wait-phase', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting heartbeat 2',
      thread_id: 'thread-phase',
      session_id: 'thread-phase-turn-1'
    });
    harness.now.value += 200;
    harness.orchestrator.onWorkerEvent('i-wait-phase', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.rateLimitsUpdated,
      detail: 'rate limits updated again',
      thread_id: 'thread-phase',
      session_id: 'thread-phase-turn-1',
      rate_limits: {
        primary: {
          used_percent: 11,
          window_minutes: 300,
          resets_at: 1_000_000
        }
      }
    });
    await harness.orchestrator.tick('interval');

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.running.has('i-wait-phase')).toBe(true);
    expect(snapshot.retry_attempts.has('i-wait-phase')).toBe(false);
    expect(snapshot.blocked_inputs.has('i-wait-phase')).toBe(false);
  });

  it('replays the NIE-146 heartbeat-only stall through API-visible retry and manual-resume states', async () => withTemporaryCodexHome(async () => {
    const harness = createHarness({
      configOverrides: {
        progress_heartbeat_only_warn_ms: 500,
        progress_stalled_waiting_ms: 1_000,
        running_wait_stall_threshold_ms: 1_000,
        worker_opaque_activity_hard_timeout_ms: 1_000,
        stall_timeout_ms: 60_000,
        respawn_window_minutes: 30,
        respawn_max_attempts_without_progress: 1
      },
      spawnWorker: async ({ issue, attempt, worker_host, resume_context }) => {
        const worker_instance_id = `${issue.id}-worker-${harness.spawned.length + 1}`;
        harness.spawned.push({ issue_id: issue.id, attempt, worker_host, resume_context });
        return {
          ok: true,
          worker_handle: { issue_id: issue.id, worker_instance_id },
          worker_instance_id,
          monitor_handle: { issue_id: issue.id },
          workspace_path: '/tmp/symphony-workspaces/i-nie-146-replay',
          provisioner_type: 'git-worktree',
          branch_name: 'feature/NIE-146',
          repo_root: '/repo/symphony',
          workspace_exists: true,
          workspace_git_status: 'dirty',
          workspace_provisioned: true,
          workspace_is_git_worktree: true
        };
      }
    });
    const issue = makeIssue({ id: 'i-nie-146-replay', identifier: 'NIE-146' });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
    await harness.orchestrator.tick('interval');

    const server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: (options) => harness.orchestrator.getStateSnapshot(options)
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      nowMs: () => harness.now.value
    });
    await server.listen();
    try {
      const address = server.address();
      const fetchJson = async (pathName: string) => {
        const response = await fetch(`http://127.0.0.1:${address.port}${pathName}`, {
          headers: { connection: 'close' }
        });
        return {
          response,
          payload: (await response.json()) as Record<string, unknown>
        };
      };

      harness.orchestrator.onWorkerEvent('i-nie-146-replay', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        detail: 'turn started after build failure context',
        thread_id: 'thread-nie-146',
        turn_id: 'turn-nie-146',
        session_id: 'session-nie-146'
      });
      harness.now.value += 100;
      harness.orchestrator.onWorkerEvent('i-nie-146-replay', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.phaseValidation,
        detail: 'npm run build failed before the live stall began',
        thread_id: 'thread-nie-146',
        turn_id: 'turn-nie-146',
        session_id: 'session-nie-146'
      });
      harness.now.value += 100;
      harness.orchestrator.onWorkerEvent('i-nie-146-replay', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting_for_turn_completion elapsed_s=0',
        thread_id: 'thread-nie-146',
        turn_id: 'turn-nie-146',
        session_id: 'session-nie-146'
      });
      harness.now.value += 600;
      harness.orchestrator.onWorkerEvent('i-nie-146-replay', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.phasePlanning,
        detail: 'waiting_for_turn_completion elapsed_s=1',
        thread_id: 'thread-nie-146',
        turn_id: 'turn-nie-146',
        session_id: 'session-nie-146'
      });
      harness.orchestrator.onWorkerEvent('i-nie-146-replay', {
        timestamp_ms: harness.now.value + 1,
        event: CANONICAL_EVENT.codex.rateLimitsUpdated,
        detail: 'rate limits updated during wait loop',
        thread_id: 'thread-nie-146',
        turn_id: 'turn-nie-146',
        session_id: 'session-nie-146',
        rate_limits: {
          primary: {
            used_percent: 97,
            window_minutes: 300,
            resets_at: harness.now.value + 600_000
          }
        }
      });
      await harness.orchestrator.tick('manual_refresh');

      const heartbeatState = await fetchJson('/api/v1/state');
      expect(heartbeatState.response.status).toBe(200);
      expect(((heartbeatState.payload.running as Array<Record<string, unknown>>)[0] ?? {}).progress_signal_state).toBe('heartbeat_only');
      expect(harness.orchestrator.getStateSnapshot().recent_runtime_events.some((event) => event.event === CANONICAL_EVENT.progress.heartbeatOnlyDetected)).toBe(
        true
      );
      expect(harness.orchestrator.getStateSnapshot().recent_runtime_events.some((event) => event.event === CANONICAL_EVENT.orchestration.dispatchDuplicateSkipped)).toBe(
        true
      );

      harness.now.value += 700;
      harness.orchestrator.onWorkerEvent('i-nie-146-replay', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnWaiting,
        detail: 'waiting_for_turn_completion elapsed_s=2',
        thread_id: 'thread-nie-146',
        turn_id: 'turn-nie-146',
        session_id: 'session-nie-146'
      });
      harness.orchestrator.onWorkerEvent('i-nie-146-replay', {
        timestamp_ms: harness.now.value + 1,
        event: CANONICAL_EVENT.codex.rateLimitsUpdated,
        detail: 'rate limits updated again during wait loop',
        thread_id: 'thread-nie-146',
        turn_id: 'turn-nie-146',
        session_id: 'session-nie-146',
        rate_limits: {
          primary: {
            used_percent: 98,
            window_minutes: 300,
            resets_at: harness.now.value + 600_000
          }
        }
      });
      await harness.orchestrator.tick('interval');

      const retryState = await fetchJson('/api/v1/state');
      expect(retryState.response.status).toBe(200);
      expect(retryState.payload.running).toEqual([]);
      expect((retryState.payload.retrying as Array<Record<string, unknown>>)[0]).toMatchObject({
        issue_identifier: 'NIE-146',
        stop_reason_code: REASON_CODES.workerOpaqueActivityHardTimeout,
        previous_thread_id: 'thread-nie-146',
        previous_session_id: 'session-nie-146'
      });
      expect(
        (retryState.payload.recent_runtime_events as Array<Record<string, unknown>>).some(
          (event) => event.event === CANONICAL_EVENT.orchestration.workerStalled
        )
      ).toBe(true);

      const retryDiagnostics = await fetchJson('/api/v1/issues/NIE-146/diagnostics');
      expect(retryDiagnostics.response.status).toBe(200);
      expect(retryDiagnostics.payload.current_blocker).toMatchObject({
        classification: 'retry_backoff_wait',
        reason_code: REASON_CODES.workerOpaqueActivityHardTimeout,
        recommended_actions: expect.arrayContaining(['Wait for the scheduled retry or manually resume if the backoff should be bypassed.'])
      });
      expect(retryDiagnostics.payload.last_meaningful_progress_at_ms).toBe(1_000_100);

      harness.tracker.fetch_candidate_issues.mockResolvedValue([issue]);
      await harness.orchestrator.onRetryTimer('i-nie-146-replay');

      const blockedState = await fetchJson('/api/v1/state');
      expect(blockedState.response.status).toBe(200);
      expect((blockedState.payload.blocked as Array<Record<string, unknown>>)[0]).toMatchObject({
        issue_identifier: 'NIE-146',
        stop_reason_code: REASON_CODES.operatorNoProgressRedispatchBlocked,
        pending_input: null,
        requires_manual_resume: false,
        awaiting_operator: false,
        breaker_active: true,
        breaker_hit_count: 1
      });
      expect(harness.orchestrator.getCircuitBreakerSnapshot()[0]).toMatchObject({
        issue_identifier: 'NIE-146',
        breaker_active: true,
        breaker_hit_count: 1,
        breaker_window_minutes: 30
      });
      expect(harness.orchestrator.getStateSnapshot().blocked_inputs.has('i-nie-146-replay')).toBe(false);
      expect(harness.orchestrator.getStateSnapshot().retry_attempts.has('i-nie-146-replay')).toBe(false);
      expect(harness.orchestrator.getStateSnapshot().recent_runtime_events.some((event) => event.event === CANONICAL_EVENT.orchestration.redispatchCompletionGateBlocked)).toBe(
        true
      );
      expect(
        harness.orchestrator.getStateSnapshot().recent_runtime_events.some(
          (event) => event.event === CANONICAL_EVENT.orchestration.blockedInputScheduled
        )
      ).toBe(false);

      const blockedDiagnostics = await fetchJson('/api/v1/issues/NIE-146/diagnostics');
      expect(blockedDiagnostics.response.status).toBe(200);
      expect(blockedDiagnostics.payload.current_blocker).toMatchObject({
        classification: 'codex_no_progress',
        reason_code: REASON_CODES.operatorNoProgressRedispatchBlocked,
        recommended_actions: expect.any(Array)
      });
      const blocker = blockedDiagnostics.payload.current_blocker as { reason_detail?: string | null; tool_output_wait?: unknown } | null;
      expect(blockedDiagnostics.payload.last_meaningful_progress_at_ms).toBeNull();
      expect(blockedDiagnostics.payload.issue_identifier).toBe('NIE-146');
      expect(blockedDiagnostics.payload.status).toBe('stalled');
      expect(blocker?.reason_detail).toContain('no progress signal');
      expect(blocker?.tool_output_wait).toBeUndefined();
      expect(harness.orchestrator.getCircuitBreakerSnapshot()[0]).toMatchObject({
        issue_identifier: 'NIE-146',
        breaker_active: true
      });
    } finally {
      await server.close();
    }
  }), 60_000);

  it('recovers live stalled waiting turns by terminating ownership and scheduling retry with workspace metadata', async () => withTemporaryCodexHome(async () => {
    const completedRuns: Parameters<NonNullable<OrchestratorPersistencePort['completeRun']>>[0][] = [];
    const harness = createHarness({
      configOverrides: {
        progress_stalled_waiting_ms: 1_000,
        running_wait_stall_threshold_ms: 1_000,
        worker_opaque_activity_hard_timeout_ms: 1_000,
        stall_timeout_ms: 60_000,
        max_retry_backoff_ms: 25_000
      },
      persistence: {
        startRun: async () => 'run-stalled-wait',
        appendIssueRun: async () => 'issue-run-stalled-wait',
        appendAttempt: async () => 'attempt-stalled-wait',
        recordSession: async () => undefined,
        recordEvent: async () => undefined,
        completeRun: async (params) => {
          completedRuns.push(params);
        }
      },
      spawnWorker: async ({ issue }) => ({
        ok: true,
        worker_handle: { issue_id: issue.id, worker_instance_id: 'worker-stalled-wait' },
        worker_instance_id: 'worker-stalled-wait',
        monitor_handle: { issue_id: issue.id },
        workspace_path: '/tmp/symphony-workspaces/i-stalled-wait',
        worker_host: 'host-a',
        provisioner_type: 'git-worktree',
        branch_name: 'feature/stalled-wait',
        repo_root: '/repo/symphony',
        workspace_exists: true,
        workspace_git_status: 'dirty',
        workspace_provisioned: true,
        workspace_is_git_worktree: true,
        copy_ignored_applied: true,
        copy_ignored_status: 'success',
        copy_ignored_summary: {
          copied_files: 2,
          skipped_existing: 1,
          blocked_files: 0,
          bytes_copied: 128,
          duration_ms: 9
        }
      })
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-stalled-wait', identifier: 'ABC-STALLED-WAIT' })]);
    harness.tracker.fetch_issue_states_by_ids.mockResolvedValue([]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-stalled-wait', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting heartbeat',
      thread_id: 'thread-stalled-wait',
      turn_id: 'turn-stalled-wait',
      session_id: 'thread-stalled-wait-turn-stalled-wait'
    });
    harness.now.value += 1_250;
    await harness.orchestrator.tick('interval');

    const snapshot = harness.orchestrator.getStateSnapshot();
    const retryEntry = snapshot.retry_attempts.get('i-stalled-wait');
    expect(snapshot.running.has('i-stalled-wait')).toBe(false);
    expect(harness.terminated).toEqual([
      {
        issue_id: 'i-stalled-wait',
        cleanup_workspace: false,
        reason: REASON_CODES.workerOpaqueActivityHardTimeout
      }
    ]);
    expect(completedRuns).toEqual([
      expect.objectContaining({
        run_id: 'run-stalled-wait',
        terminal_status: 'stalled',
        terminal_reason_code: REASON_CODES.workerOpaqueActivityHardTimeout,
        terminal_reason_detail: expect.stringContaining('active but opaque hard timeout')
      })
    ]);
    expect(retryEntry).toMatchObject({
      attempt: 1,
      error: 'active but opaque hard timeout',
      stop_reason_code: REASON_CODES.workerOpaqueActivityHardTimeout,
      previous_thread_id: 'thread-stalled-wait',
      previous_turn_id: 'turn-stalled-wait',
      previous_session_id: 'thread-stalled-wait-turn-stalled-wait',
      workspace_path: '/tmp/symphony-workspaces/i-stalled-wait',
      provisioner_type: 'git-worktree',
      branch_name: 'feature/stalled-wait',
      repo_root: '/repo/symphony',
      workspace_exists: true,
      workspace_git_status: 'dirty',
      workspace_provisioned: true,
      workspace_is_git_worktree: true,
      copy_ignored_applied: true,
      copy_ignored_status: 'success',
      recover_workspace_attempt_residue: true
    });
    expect(retryEntry?.due_at_ms).toBe(harness.now.value + 10_000);
    expect(harness.scheduled.has('i-stalled-wait')).toBe(true);

    expect(harness.orchestrator.getStateSnapshot().running.has('i-stalled-wait')).toBe(false);
  }), 20_000);

  it('does not recover stalled waiting while the live turn is awaiting operator input', async () => {
    const harness = createHarness({
      configOverrides: {
        progress_stalled_waiting_ms: 1_000,
        running_wait_stall_threshold_ms: 1_000,
        stall_timeout_ms: 60_000
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-input-wait', identifier: 'ABC-INPUT-WAIT' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-input-wait', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnInputRequired,
      detail: 'choose an option',
      thread_id: 'thread-input',
      turn_id: 'turn-input',
      session_id: 'thread-input-turn-input'
    });
    harness.orchestrator.onWorkerEvent('i-input-wait', {
      timestamp_ms: harness.now.value + 1,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting for operator',
      thread_id: 'thread-input',
      turn_id: 'turn-input',
      session_id: 'thread-input-turn-input'
    });
    harness.now.value += 1_250;
    await harness.orchestrator.tick('interval');

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.running.has('i-input-wait')).toBe(true);
    expect(snapshot.retry_attempts.has('i-input-wait')).toBe(false);
    expect(harness.terminated).toEqual([]);
  });

  it('blocks repeated no-progress stalled-wait recoveries with the redispatch circuit breaker', async () => {
    const harness = createHarness({
      configOverrides: {
        progress_stalled_waiting_ms: 1_000,
        running_wait_stall_threshold_ms: 1_000,
        worker_opaque_activity_hard_timeout_ms: 1_000,
        stall_timeout_ms: 60_000,
        respawn_window_minutes: 30,
        respawn_max_attempts_without_progress: 1
      }
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-wait-breaker', identifier: 'ABC-WAIT-BREAKER' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-wait-breaker', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnWaiting,
      detail: 'waiting heartbeat',
      thread_id: 'thread-breaker',
      turn_id: 'turn-breaker',
      session_id: 'thread-breaker-turn-breaker'
    });
    harness.now.value += 1_250;
    await harness.orchestrator.tick('interval');

    expect(harness.orchestrator.getStateSnapshot().retry_attempts.get('i-wait-breaker')?.stop_reason_code).toBe(
      REASON_CODES.workerOpaqueActivityHardTimeout
    );

    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-wait-breaker', identifier: 'ABC-WAIT-BREAKER' })]);
    await harness.orchestrator.onRetryTimer('i-wait-breaker');

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(snapshot.running.has('i-wait-breaker')).toBe(false);
    expect(snapshot.retry_attempts.has('i-wait-breaker')).toBe(false);
    expect(snapshot.blocked_inputs.has('i-wait-breaker')).toBe(false);
    expect(snapshot.circuit_breakers.get('i-wait-breaker')).toMatchObject({
      breaker_active: true,
      breaker_hit_count: 1,
      breaker_window_minutes: 30
    });
  });
});
