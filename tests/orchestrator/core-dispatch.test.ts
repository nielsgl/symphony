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

describe('OrchestratorCore dispatch and backpressure', () => {
  it('summary snapshots omit raw transcript diagnostic clone work for high-volume active entries', async () => {
    const harness = createHarness({ configOverrides: { max_concurrent_agents: 4 } });
    harness.tracker.fetch_candidate_issues.mockResolvedValue(
      Array.from({ length: 4 }, (_, index) =>
        makeIssue({
          id: `i-summary-${index + 1}`,
          identifier: `ABC-SUMMARY-${index + 1}`
        })
      )
    );
    await harness.orchestrator.tick('interval');

    let detailFieldReads = 0;
    const makeDiagnostic = (index: number): TranscriptToolCallDiagnostic => {
      const lineage = (['active_owned', 'prior_stale', 'external_manual', 'unattributed'] as TranscriptToolCallLineage[])[
        index % 4
      ];
      const diagnostic = {
        kind: index % 2 === 0 ? 'function_call' : 'function_call_output',
        call_id: `call-${index}`,
        tool_name: 'exec_command',
        thread_id: `thread-${index % 5}`,
        turn_id: `turn-${index % 7}`,
        session_id: `session-${index % 11}`,
        issue_id: `issue-${index % 4}`,
        issue_identifier: `ABC-${index % 4}`,
        run_id: `run-${index % 4}`,
        issue_run_id: `issue-run-${index % 4}`,
        attempt_id: `attempt-${index % 4}`,
        codex_app_server_pid: `${1000 + index}`,
        observed_at_ms: 1_000_000 + index,
        lineage,
        active_issue_identifier: 'ABC-ACTIVE',
        active_run_id: 'run-active',
        active_issue_run_id: 'issue-run-active',
        active_attempt_id: 'attempt-active',
        active_codex_app_server_pid: '9999',
        active_thread_id: 'thread-active',
        active_turn_id: 'turn-active',
        active_session_id: 'session-active'
      } as Omit<TranscriptToolCallDiagnostic, 'reason' | 'active_issue_id'>;
      return Object.defineProperties(diagnostic, {
        reason: {
          enumerable: true,
          get: () => {
            detailFieldReads += 1;
            return `${lineage} diagnostic`;
          }
        },
        active_issue_id: {
          enumerable: true,
          get: () => {
            detailFieldReads += 1;
            return 'issue-active';
          }
        }
      }) as TranscriptToolCallDiagnostic;
    };

    const runtimeState = (harness.orchestrator as unknown as { state: OrchestratorState }).state;
    for (const [entryIndex, entry] of Array.from(runtimeState.running.values()).entries()) {
      entry.transcript_tool_call_diagnostics = Array.from({ length: 200 }, (_, diagnosticIndex) =>
        makeDiagnostic(entryIndex * 200 + diagnosticIndex)
      );
    }

    const summarySnapshot = harness.orchestrator.getStateSnapshot({
      includeTranscriptToolCallDiagnostics: false
    });

    expect(detailFieldReads).toBe(0);
    expect(summarySnapshot.running.size).toBe(4);
    for (const entry of summarySnapshot.running.values()) {
      expect(entry.transcript_tool_call_diagnostics).toBeUndefined();
      expect(entry.transcript_tool_call_diagnostic_stats).toMatchObject({
        total_count: 200,
        counts_by_lineage: {
          active_owned: 50,
          prior_stale: 50,
          external_manual: 50,
          unattributed: 50
        },
        counts_by_kind: {
          function_call: 100,
          function_call_output: 100
        }
      });
    }

    const fullSnapshot = harness.orchestrator.getStateSnapshot();
    expect(detailFieldReads).toBeGreaterThan(0);
    expect(fullSnapshot.running.get('i-summary-1')?.transcript_tool_call_diagnostics).toHaveLength(200);
  });

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

  it('blocks startup, interval, manual refresh, duplicate dispatch, and retry dispatch while Drain Mode is active', async () => {
    const firstIssue = makeIssue({ id: 'i-drain-running', identifier: 'ABC-DRAIN-RUN' });
    const intervalIssue = makeIssue({ id: 'i-drain-interval', identifier: 'ABC-DRAIN-INTERVAL' });
    const startupIssue = makeIssue({ id: 'i-drain-startup', identifier: 'ABC-DRAIN-STARTUP' });
    const manualIssue = makeIssue({ id: 'i-drain-manual', identifier: 'ABC-DRAIN-MANUAL' });
    const retryIssue = makeIssue({ id: 'i-drain-retry', identifier: 'ABC-DRAIN-RETRY' });
    const harness = createHarness({ configOverrides: { max_concurrent_agents: 4 } });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([firstIssue]);
    await harness.orchestrator.tick('interval');
    const runningBeforeDrain = harness.orchestrator.getStateSnapshot().running.get(firstIssue.id);
    expect(runningBeforeDrain).toBeDefined();

    ((harness.orchestrator as unknown as { state: OrchestratorState }).state.running.get(firstIssue.id) as any).codex_app_server_pid =
      '4242';
    (harness.orchestrator as any).enterDrainMode({ reason: 'safe runtime restart' });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([startupIssue]);
    await harness.orchestrator.tick('startup');
    harness.tracker.fetch_candidate_issues.mockResolvedValue([intervalIssue]);
    await harness.orchestrator.tick('interval');
    harness.tracker.fetch_candidate_issues.mockResolvedValue([manualIssue]);
    await harness.orchestrator.tick('manual_refresh');

    await (harness.orchestrator as any).scheduleRetry({
      issue_id: retryIssue.id,
      identifier: retryIssue.identifier,
      attempt: 1,
      delay_type: 'failure',
      error: 'retry while draining',
      worker_host: null,
      workspace_path: null,
      provisioner_type: null,
      branch_name: null,
      repo_root: null,
      workspace_exists: false,
      workspace_git_status: null,
      workspace_provisioned: false,
      workspace_is_git_worktree: false,
      stop_reason_code: 'test_retry',
      stop_reason_detail: 'retry while draining',
      issue_snapshot: retryIssue
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([retryIssue]);
    await harness.scheduled.get(retryIssue.id)?.callback();

    expect(harness.spawned.map((entry) => entry.issue_id)).toEqual([firstIssue.id]);
    expect(harness.tracker.fetch_candidate_issues).toHaveBeenCalledTimes(4);
    const snapshot = harness.orchestrator.getStateSnapshot() as any;
    expect(snapshot.retry_attempts.has(retryIssue.id)).toBe(true);
    expect(snapshot.drain_mode).toMatchObject({
      active: true,
      reason: 'safe runtime restart'
    });
    expect(snapshot.quiescence.safe_to_shutdown).toBe(false);
    expect(snapshot.quiescence.blocker_counts).toMatchObject({
      active_worker: 1,
      live_codex_app_server_process: 1,
      pending_retry: 1
    });
    expect(harness.terminated).toEqual([]);
    expect(snapshot.recent_runtime_events.map((event: any) => event.event)).toContain('runtime.drain.entered');
    expect(snapshot.recent_runtime_events.map((event: any) => event.event)).toContain('runtime.quiescence.changed');
  });

  it('supports reading and exiting Drain Mode so dispatch can resume after restart safety work is complete', async () => {
    const harness = createHarness();

    expect((harness.orchestrator as any).readDrainMode()).toMatchObject({
      active: false,
      entered_at_ms: null
    });

    (harness.orchestrator as any).enterDrainMode({ reason: 'maintenance window' });
    expect((harness.orchestrator as any).readDrainMode()).toMatchObject({
      active: true,
      reason: 'maintenance window'
    });

    (harness.orchestrator as any).exitDrainMode({ reason: 'restart complete' });
    expect((harness.orchestrator as any).readDrainMode()).toMatchObject({
      active: false,
      entered_at_ms: null,
      reason: 'restart complete'
    });

    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-after-drain', identifier: 'ABC-AFTER-DRAIN' })]);
    await harness.orchestrator.tick('interval');

    expect(harness.spawned.map((entry) => entry.issue_id)).toEqual(['i-after-drain']);
    expect(harness.orchestrator.getStateSnapshot().recent_runtime_events.map((event) => event.event)).toContain('runtime.drain.exited');
  });

  it('computes persistence/history health blockers from the real quiescence source', () => {
    const harness = createHarness({
      getPersistenceHealth: () => ({
        enabled: true,
        db_path: '/tmp/symphony.db',
        retention_days: 14,
        run_count: 1,
        last_pruned_at: null,
        last_prune_failure_at: null,
        last_prune_failure_reason: null,
        last_prune_failure_detail: null,
        integrity_ok: false,
        history_schema: {
          schema_name: 'project_execution_history',
          target_version: 4,
          applied_version: 3,
          status: 'degraded',
          degraded_reason_code: 'migration_failed',
          degraded_detail: 'history migration failed',
          updated_at: new Date('2026-05-21T12:00:00.000Z').toISOString(),
          migrations: []
        },
        recent_write_failures: [
          {
            operation: 'append_state_transition',
            reason_code: 'write_failed',
            detail: 'database is locked',
            recorded_at: new Date('2026-05-21T12:00:00.000Z').toISOString()
          }
        ]
      })
    });

    (harness.orchestrator as any).enterDrainMode({ reason: 'safe runtime restart' });
    const snapshot = harness.orchestrator.getStateSnapshot();

    expect(snapshot.quiescence.safe_to_shutdown).toBe(false);
    expect(snapshot.quiescence.blocker_counts.persistence_history_write).toBe(1);
    expect(snapshot.quiescence.blockers).toContainEqual(
      expect.objectContaining({
        category: 'persistence_history_write',
        count: 1,
        detail: 'history migration failed'
      })
    );
  });

  it('computes in-flight tracker write blockers while tracker mutations are pending', async () => {
    const harness = createHarness();
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-cancel-drain', identifier: 'ABC-CANCEL-DRAIN' })]);
    await harness.orchestrator.tick('interval');
    await harness.orchestrator.onWorkerExit(
      'i-cancel-drain',
      'abnormal',
      'workspace_conflict:{"code":"operator_action_required_workspace_conflict","detail":"workspace conflict","conflict_files":[],"resolution_hints":["Resolve and resume."]}'
    );

    let resolveTrackerWrite!: () => void;
    harness.tracker.update_issue_state.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveTrackerWrite = resolve;
        })
    );

    (harness.orchestrator as any).enterDrainMode({ reason: 'safe runtime restart' });
    const cancelPromise = harness.orchestrator.cancelBlockedIssue('ABC-CANCEL-DRAIN', 'operator_cancel_return_to_backlog', {
      actor: 'operator@example.test',
      reason_note: 'operator_cancel_return_to_backlog',
      confirmed: true
    });
    await Promise.resolve();

    const pendingSnapshot = harness.orchestrator.getStateSnapshot();
    expect(pendingSnapshot.quiescence.safe_to_shutdown).toBe(false);
    expect(pendingSnapshot.quiescence.blocker_counts.in_flight_tracker_write).toBe(1);
    expect(pendingSnapshot.quiescence.blockers).toContainEqual(
      expect.objectContaining({
        category: 'in_flight_tracker_write',
        count: 1
      })
    );

    resolveTrackerWrite();
    await cancelPromise;

    const settledSnapshot = harness.orchestrator.getStateSnapshot();
    expect(settledSnapshot.quiescence.blocker_counts.in_flight_tracker_write).toBe(0);
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

  it('allows dispatch under healthy control-plane conditions', async () => {
    const harness = createHarness({
      getControlPlaneHealth: () => makeControlPlaneHealthSummary('ok', harness.now.value)
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-healthy' })]);

    await harness.orchestrator.tick('interval');

    expect(harness.spawned.map((entry) => entry.issue_id)).toEqual(['i-healthy']);
    expect(harness.orchestrator.getStateSnapshot().health.dispatch_backpressure?.active).toBe(false);
  });

  it('allows dispatch when control-plane diagnostics are token-enrichment-only degraded', async () => {
    let controlPlaneHealth = makeControlPlaneHealthSummary('ok', 1_000_000);
    const harness = createHarness({
      configOverrides: {
        max_concurrent_agents: 3,
        dispatch_backpressure: {
          retry_delay_ms: 15_000,
          min_running_agents: 1,
          control_plane_health: 'degraded'
        }
      },
      getControlPlaneHealth: () => controlPlaneHealth
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-running', identifier: 'ABC-RUN' })]);
    await harness.orchestrator.tick('interval');

    controlPlaneHealth = makeControlPlaneHealthSummary('degraded', harness.now.value, {
      last_duration_ms: 40,
      max_duration_ms: 40,
      avg_duration_ms: 40,
      last_payload_bytes: 20_000,
      max_payload_bytes: 20_000,
      avg_payload_bytes: 20_000,
      last_enrichment_status: 'degraded',
      last_enrichment_degraded: true,
      last_enrichment_reason_code: REASON_CODES.liveTokenFallbackNotOnHotPath
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-token-only', identifier: 'ABC-TOKEN' })]);
    await harness.orchestrator.tick('manual_refresh');

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(harness.spawned.map((entry) => entry.issue_id)).toEqual(['i-running', 'i-token-only']);
    expect(snapshot.retry_attempts.has('i-token-only')).toBe(false);
    expect(snapshot.health.dispatch_backpressure?.active).toBe(false);
  });

  it('delays new dispatch under degraded control-plane pressure without killing running agents', async () => {
    const logs: Array<{ event: string; context: Record<string, unknown> }> = [];
    const logger: StructuredLogger = {
      log: ({ event, context }) => {
        logs.push({ event, context: context ?? {} });
      }
    };
    let controlPlaneHealth = makeControlPlaneHealthSummary('ok', 1_000_000);
    const harness = createHarness({
      logger,
      configOverrides: {
        max_concurrent_agents: 3,
        dispatch_backpressure: {
          retry_delay_ms: 15_000,
          min_running_agents: 1,
          control_plane_health: 'degraded'
        }
      },
      getControlPlaneHealth: () => controlPlaneHealth
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-running', identifier: 'ABC-RUN' })]);
    await harness.orchestrator.tick('interval');

    controlPlaneHealth = makeControlPlaneHealthSummary('degraded', harness.now.value);
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-delayed', identifier: 'ABC-DELAY' })]);
    await harness.orchestrator.tick('manual_refresh');

    const snapshot = harness.orchestrator.getStateSnapshot();
    const retryEntry = snapshot.retry_attempts.get('i-delayed');
    expect(snapshot.running.has('i-running')).toBe(true);
    expect(harness.terminated).toEqual([]);
    expect(harness.spawned.map((entry) => entry.issue_id)).toEqual(['i-running']);
    expect(retryEntry).toMatchObject({
      issue_id: 'i-delayed',
      attempt: 1,
      stop_reason_code: REASON_CODES.dispatchBackpressureControlPlane,
      error: 'dispatch delayed by local backpressure'
    });
    expect(retryEntry?.due_at_ms).toBe(harness.now.value + 15_000);
    expect(snapshot.health.dispatch_backpressure).toMatchObject({
      active: true,
      reason_code: REASON_CODES.dispatchBackpressureControlPlane,
      source: 'control_plane',
      retry_delay_ms: 15_000
    });
    expect(logs.find((entry) => entry.event === CANONICAL_EVENT.orchestration.dispatchBackpressureActive)?.context).toMatchObject({
      issue_id: 'i-delayed',
      issue_identifier: 'ABC-DELAY',
      reason_code: REASON_CODES.dispatchBackpressureControlPlane,
      source: 'control_plane'
    });
  });

  it('clears backpressure after health recovers and dispatches a delayed retry', async () => {
    let controlPlaneHealth = makeControlPlaneHealthSummary('ok', 1_000_000);
    const harness = createHarness({
      configOverrides: {
        max_concurrent_agents: 3,
        dispatch_backpressure: {
          retry_delay_ms: 15_000,
          min_running_agents: 1,
          control_plane_health: 'degraded'
        }
      },
      getControlPlaneHealth: () => controlPlaneHealth
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-running', identifier: 'ABC-RUN' })]);
    await harness.orchestrator.tick('interval');
    controlPlaneHealth = makeControlPlaneHealthSummary('degraded', harness.now.value);
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-recover', identifier: 'ABC-RECOVER' })]);
    await harness.orchestrator.tick('interval');

    controlPlaneHealth = makeControlPlaneHealthSummary('ok', harness.now.value + 1_000);
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-recover', identifier: 'ABC-RECOVER' })]);
    await harness.orchestrator.onRetryTimer('i-recover');

    const snapshot = harness.orchestrator.getStateSnapshot();
    expect(harness.spawned.map((entry) => entry.issue_id)).toEqual(['i-running', 'i-recover']);
    expect(snapshot.retry_attempts.has('i-recover')).toBe(false);
    expect(snapshot.running.has('i-recover')).toBe(true);
    expect(snapshot.health.dispatch_backpressure?.active).toBe(false);
  });

  it('keeps host-load backpressure distinct from slot exhaustion on retry', async () => {
    const harness = createHarness({
      configOverrides: {
        max_concurrent_agents: 2,
        dispatch_backpressure: {
          retry_delay_ms: 20_000,
          min_running_agents: 1,
          host_load_per_cpu: 1
        }
      },
      getHostLoad: () => ({ load_average_1m: 4, cpu_count: 2 })
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([
      makeIssue({ id: 'i-running', identifier: 'ABC-1-RUN' }),
      makeIssue({ id: 'i-host-pressure', identifier: 'ABC-2-HOST' })
    ]);
    await harness.orchestrator.tick('interval');

    const retryEntry = harness.orchestrator.getStateSnapshot().retry_attempts.get('i-host-pressure');
    expect(retryEntry?.stop_reason_code).toBe(REASON_CODES.dispatchBackpressureHostLoad);
    expect(retryEntry?.due_at_ms).toBe(harness.now.value + 20_000);
    expect(harness.orchestrator.getStateSnapshot().health.last_error).toContain('dispatch backpressure active');
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
});
