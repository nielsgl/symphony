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

describe('OrchestratorCore phase markers', () => {
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

  it('records blocked-input phase after a prior attempt reached planning', async () => {
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
    await harness.orchestrator.onWorkerExit(
      'i-redispatch',
      'abnormal',
      'tool requestUserInput could not be auto-answered (turn_input_required)'
    );
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
      '1:blocked_input'
    ]);

    const ignoredDispatchStartedAttemptOne = logEntries.find(
      (entry) =>
        entry.event === CANONICAL_EVENT.orchestration.phaseMarkerIgnored &&
        entry.context?.phase === 'dispatch_started' &&
        entry.context?.attempt === 1
    );
    expect(ignoredDispatchStartedAttemptOne?.context?.previous_phase).toBe('blocked_input');
  });
});
