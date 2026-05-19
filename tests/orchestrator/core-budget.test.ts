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

describe('OrchestratorCore budget', () => {
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

  it('projects live transcript token usage updates without inflating replayed snapshots', async () => {
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
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-transcript-usage' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-transcript-usage', {
      timestamp_ms: harness.now.value,
      event: CANONICAL_EVENT.codex.turnStarted,
      thread_id: 'thread-transcript-usage',
      turn_id: 'turn-transcript-usage',
      session_id: 'thread-transcript-usage-turn-transcript-usage'
    });
    harness.orchestrator.onWorkerEvent('i-transcript-usage', {
      timestamp_ms: harness.now.value + 100,
      event: CANONICAL_EVENT.codex.tokenUsageUpdated,
      session_id: 'thread-transcript-usage-turn-transcript-usage',
      thread_id: 'thread-transcript-usage',
      turn_id: 'turn-transcript-usage',
      usage: {
        input_tokens: 12,
        output_tokens: 5,
        total_tokens: 17,
        cached_input_tokens: 4,
        reasoning_output_tokens: 2
      },
      token_telemetry_status: 'available',
      token_telemetry_last_source: 'transcript_token_count',
      token_telemetry_last_at_ms: harness.now.value + 100
    });
    harness.orchestrator.onWorkerEvent('i-transcript-usage', {
      timestamp_ms: harness.now.value + 200,
      event: CANONICAL_EVENT.codex.tokenUsageUpdated,
      session_id: 'thread-transcript-usage-turn-transcript-usage',
      thread_id: 'thread-transcript-usage',
      turn_id: 'turn-transcript-usage',
      usage: {
        input_tokens: 12,
        output_tokens: 5,
        total_tokens: 17,
        cached_input_tokens: 4,
        reasoning_output_tokens: 2
      },
      token_telemetry_status: 'available',
      token_telemetry_last_source: 'transcript_token_count',
      token_telemetry_last_at_ms: harness.now.value + 200
    });
    harness.orchestrator.onWorkerEvent('i-transcript-usage', {
      timestamp_ms: harness.now.value + 300,
      event: CANONICAL_EVENT.codex.tokenUsageUpdated,
      session_id: 'thread-transcript-usage-turn-transcript-usage',
      thread_id: 'thread-transcript-usage',
      turn_id: 'turn-transcript-usage',
      usage: {
        input_tokens: 20,
        output_tokens: 10,
        total_tokens: 30,
        cached_input_tokens: 7,
        reasoning_output_tokens: 4
      },
      token_telemetry_status: 'available',
      token_telemetry_last_source: 'transcript_token_count',
      token_telemetry_last_at_ms: harness.now.value + 300
    });

    const snapshot = harness.orchestrator.getStateSnapshot();
    const running = snapshot.running.get('i-transcript-usage');
    expect(running?.tokens).toMatchObject({
      input_tokens: 20,
      output_tokens: 10,
      total_tokens: 30,
      cached_input_tokens: 7,
      reasoning_output_tokens: 4
    });
    expect(running?.last_reported_tokens).toMatchObject({
      input_tokens: 20,
      output_tokens: 10,
      total_tokens: 30
    });
    expect(running?.token_telemetry_status).toBe('available');
    expect(running?.token_telemetry_last_source).toBe('transcript_token_count');
    expect(running?.token_telemetry_last_at_ms).toBe(harness.now.value + 300);
    expect(running?.budget).toMatchObject({
      budget_status: 'ok',
      budget_usage_tokens: 30,
      budget_limit_tokens: 100
    });
    expect(snapshot.codex_totals).toMatchObject({
      input_tokens: 20,
      output_tokens: 10,
      total_tokens: 30,
      cached_input_tokens: 7,
      reasoning_output_tokens: 4
    });
  });

  it('persists worker token snapshots and requested/effective models into history', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-worker-token-model-'));
    const store = new SqlitePersistenceStore({
      dbPath: path.join(dir, 'runtime.sqlite'),
      retentionDays: 14,
      nowMs: () => Date.parse('2026-05-11T10:00:00.000Z')
    });
    const identity = (params: { issue_id: string; issue_identifier: string }) =>
      buildDurableIdentity({
        projectRoot: dir,
        workflowPath: path.join(dir, 'WORKFLOW.md'),
        workflowHash: { status: 'present', value: 'workflow-hash' },
        repositoryRemote: { status: 'missing', reason: 'repository_remote_unavailable' },
        trackerKind: 'linear',
        trackerScope: 'TEST',
        remoteIssueId: params.issue_id,
        humanIssueIdentifier: params.issue_identifier
      });
    const persistence: OrchestratorPersistencePort = {
      startRun: async (params) => store.startRun({ ...params, identity: identity(params) }),
      recordRunStarted: async (params) => store.recordRunStarted({ ...params, identity: identity(params) }),
      appendIssueRun: async (params) => store.appendIssueRun({ ...params, identity: identity(params) }),
      appendAttempt: async (params) => store.appendAttempt(params),
      appendThread: async (params) => store.appendThread(params),
      appendTurn: async (params) => store.appendTurn(params),
      appendPhaseSpan: async (params) => store.appendPhaseSpan(params),
      appendToolSpan: async (params) => store.appendToolSpan(params),
      appendStateTransition: async (params) => store.appendStateTransition(params),
      appendTokenModelFact: async (params) => store.appendTokenModelFact(params),
      recordHistoryWriteFailure: async (params) => store.recordHistoryWriteFailure(params),
      recordSession: async ({ run_id, session_id }) => store.recordSession(run_id, session_id),
      recordEvent: async (params) => store.recordEvent(params),
      completeRun: async (params) => store.completeRun(params)
    };
    const harness = createHarness({ persistence });

    try {
      harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-token-model', identifier: 'TOK-143' })]);
      await harness.orchestrator.tick('interval');
      harness.orchestrator.onWorkerEvent('i-token-model', {
        timestamp_ms: harness.now.value,
        event: CANONICAL_EVENT.codex.turnStarted,
        thread_id: 'thread-token-model',
        turn_id: 'turn-token-model',
        session_id: 'thread-token-model-turn-token-model'
      });
      harness.orchestrator.onWorkerEvent('i-token-model', {
        timestamp_ms: harness.now.value + 100,
        event: CANONICAL_EVENT.codex.turnCompleted,
        session_id: 'thread-token-model-turn-token-model',
        thread_id: 'thread-token-model',
        turn_id: 'turn-token-model',
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
        model_reroute: {
          requested_model: 'gpt-requested',
          effective_model: 'gpt-effective',
          reason_code: 'app_server_model_reroute',
          source: 'app_server_protocol'
        },
        requested_model: 'gpt-requested',
        effective_model: 'gpt-effective'
      });
      await new Promise((resolve) => setImmediate(resolve));

      const lineage = store.reconstructThreadLineage('thread-token-model');
      expect(lineage?.token_model_facts).toEqual([
        expect.objectContaining({
          issue_run_id: expect.any(String),
          attempt_id: expect.any(String),
          thread_id: 'thread-token-model',
          turn_id: 'turn-token-model',
          requested_model: 'gpt-requested',
          effective_model: 'gpt-effective',
          model_source: 'terminal_turn_summary',
          input_tokens: 10,
          output_tokens: 4,
          cached_input_tokens: 3,
          reasoning_output_tokens: 2,
          total_tokens: 14,
          model_context_window: 8192,
          telemetry_confidence: 'observed_live',
          observed_at: new Date(harness.now.value + 100).toISOString()
        })
      ]);
      expect(store.listHistoryWriteFailures()).toEqual([]);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  it('budget resume blocks expose typed worker termination evidence', async () => {
    const completedRuns: Parameters<NonNullable<OrchestratorPersistencePort['completeRun']>>[0][] = [];
    const harness = createHarness({
      persistence: {
        startRun: async () => 'run-budget-block-unsupported',
        appendIssueRun: async () => 'issue-run-budget-block-unsupported',
        appendAttempt: async () => 'attempt-budget-block-unsupported',
        recordSession: async () => undefined,
        recordEvent: async () => undefined,
        completeRun: async (params) => {
          completedRuns.push(params);
        }
      },
      configOverrides: {
        budget: {
          per_run_total_tokens: 50,
          rolling_window_minutes: 1440,
          warning_threshold_ratio: 0.8,
          hard_limit_policy: 'block_requires_resume'
        }
      },
      terminateWorker: async () =>
        makeTerminationResult({
          cancellation_supported: false,
          cancellation_requested: false,
          worker_settled: null,
          graceful_exit_observed: null,
          result: 'unsupported',
          reason_code: 'worker_cancel_unsupported',
          detail: 'worker handle does not implement cancel(reason)'
        })
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-budget-block-unsupported' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-budget-block-unsupported', {
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
    const blocked = snapshot.blocked_inputs.get('i-budget-block-unsupported');
    expect(blocked?.stop_reason_code).toBe(REASON_CODES.operatorBudgetLimitExceeded);
    expect(blocked?.stop_reason_detail).toContain('termination_result=unsupported');
    expect(blocked?.stop_reason_detail).toContain('termination_reason_code=worker_cancel_unsupported');
    expect(blocked?.worker_termination_result).toEqual(
      expect.objectContaining({
        result: 'unsupported',
        reason_code: 'worker_cancel_unsupported',
        detail: 'worker handle does not implement cancel(reason)'
      })
    );
    expect(completedRuns[0]?.terminal_reason_detail).toContain('termination_result=unsupported');
    expect(completedRuns[0]?.terminal_reason_detail).toContain('termination_reason_code=worker_cancel_unsupported');

    const projected = new SnapshotService().projectState(snapshot);
    expect(projected.blocked[0]?.stop_reason_detail).toContain('termination_result=unsupported');
    expect(projected.blocked[0]?.worker_termination_result).toEqual(
      expect.objectContaining({
        result: 'unsupported',
        reason_code: 'worker_cancel_unsupported'
      })
    );
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

  it('records failed typed termination evidence when budget policy terminates attempts', async () => {
    const completedRuns: Parameters<NonNullable<OrchestratorPersistencePort['completeRun']>>[0][] = [];
    const persistence: OrchestratorPersistencePort = {
      startRun: async () => 'run-budget-failed-termination',
      appendIssueRun: async () => 'issue-run-budget-failed-termination',
      appendAttempt: async () => 'attempt-budget-failed-termination',
      recordSession: async () => undefined,
      recordEvent: async () => undefined,
      completeRun: async (params) => {
        completedRuns.push(params);
      }
    };
    const harness = createHarness({
      persistence,
      configOverrides: {
        budget: {
          per_run_total_tokens: 50,
          rolling_window_minutes: 1440,
          warning_threshold_ratio: 0.8,
          hard_limit_policy: 'terminate_attempt'
        }
      },
      terminateWorker: async () =>
        makeTerminationResult({
          result: 'failed',
          worker_settled: false,
          graceful_exit_observed: false,
          reason_code: 'worker_cancel_failed',
          detail: 'worker cancellation command failed'
        })
    });
    harness.tracker.fetch_candidate_issues.mockResolvedValue([makeIssue({ id: 'i-budget-failed-termination' })]);
    await harness.orchestrator.tick('interval');

    harness.orchestrator.onWorkerEvent('i-budget-failed-termination', {
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

    expect(completedRuns).toEqual([
      expect.objectContaining({
        terminal_status: 'failed',
        terminal_reason_code: REASON_CODES.attemptTerminatedBudgetLimitExceeded,
        terminal_reason_detail: expect.stringContaining('termination_result=failed')
      })
    ]);
    expect(completedRuns[0]?.terminal_reason_detail).toContain('termination_reason_code=worker_cancel_failed');
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
});
