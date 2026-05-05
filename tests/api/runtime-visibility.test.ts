import { describe, expect, it } from 'vitest';

import {
  resolveNotBlockedExplainer,
  resolveProgressSignal,
  resolveRunningTurnControl,
  resolveSnapshotFreshness,
  resolveTokenTelemetryQuality
} from '../../src/api/runtime-visibility';
import { CANONICAL_EVENT } from '../../src/observability/events';
import type { RunningEntry } from '../../src/orchestrator';
import type { Issue } from '../../src/tracker';

function issue(): Issue {
  return {
    id: 'issue-1',
    identifier: 'ABC-1',
    title: 'Issue ABC-1',
    description: null,
    priority: 1,
    state: 'In Progress',
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null
  };
}

function running(overrides: Partial<RunningEntry> = {}): RunningEntry {
  return {
    issue: issue(),
    identifier: 'ABC-1',
    run_id: null,
    worker_handle: {},
    monitor_handle: {},
    retry_attempt: 0,
    workspace_path: null,
    provisioner_type: null,
    branch_name: null,
    repo_root: null,
    workspace_exists: false,
    workspace_git_status: null,
    workspace_provisioned: false,
    workspace_is_git_worktree: false,
    session_id: null,
    thread_id: null,
    turn_id: null,
    codex_app_server_pid: null,
    turn_count: 0,
    last_event: CANONICAL_EVENT.codex.turnStarted,
    last_event_summary: null,
    last_message: null,
    tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    last_reported_tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    token_telemetry_status: 'unavailable',
    token_telemetry_last_source: null,
    token_telemetry_last_at_ms: null,
    token_telemetry_turn_started_at_ms: null,
    token_telemetry_warning_emitted: false,
    recent_events: [],
    started_at_ms: 1_000,
    last_codex_timestamp_ms: 1_000,
    last_progress_transition_at_ms: 1_000,
    ...overrides
  };
}

describe('runtime visibility resolvers', () => {
  it('resolves turn-control state for agent and operator turns', () => {
    expect(resolveRunningTurnControl(running()).turn_control_state).toBe('agent_turn');
    expect(resolveRunningTurnControl(running({ awaiting_input_since_ms: 2_000 }))).toEqual({
      turn_control_state: 'operator_turn',
      turn_control_reason_code: 'turn_input_required',
      turn_control_since_ms: 2_000
    });
  });

  it('classifies progress signal state for advancing, heartbeat-only, and stalled waiting', () => {
    expect(resolveProgressSignal(running()).progress_signal_state).toBe('advancing');
    expect(
      resolveProgressSignal(
        running({
          last_event: CANONICAL_EVENT.codex.turnWaiting,
          running_waiting_started_at_ms: 2_000,
          last_heartbeat_at_ms: 3_000
        })
      ).progress_signal_state
    ).toBe('heartbeat_only');
    expect(
      resolveProgressSignal(
        running({
          last_event: CANONICAL_EVENT.codex.turnWaiting,
          stalled_waiting_reason: 'turn_waiting_threshold_exceeded',
          last_heartbeat_at_ms: 4_000
        })
      ).progress_signal_state
    ).toBe('stalled_waiting');
  });

  it('maps not-blocked explainers for waiting runs', () => {
    expect(
      resolveNotBlockedExplainer({
        blocked: false,
        progress_signal_state: 'heartbeat_only',
        awaiting_input: false,
        waiting_started_at_ms: 1_000,
        now_ms: 2_000,
        stalled_waiting_ms: 300_000
      }).not_blocked_explainer_code
    ).toBe('within_wait_threshold');
    expect(
      resolveNotBlockedExplainer({
        blocked: false,
        progress_signal_state: 'stalled_waiting',
        awaiting_input: false,
        waiting_started_at_ms: 1_000,
        now_ms: 400_000,
        stalled_waiting_ms: 300_000
      }).not_blocked_explainer_code
    ).toBe('active_turn_no_stop_reason');
  });

  it('maps snapshot freshness thresholds', () => {
    expect(resolveSnapshotFreshness(1_000, 6_000).snapshot_freshness_state).toBe('fresh');
    expect(resolveSnapshotFreshness(1_000, 31_000).snapshot_freshness_state).toBe('aging');
    expect(resolveSnapshotFreshness(1_000, 32_001).snapshot_freshness_state).toBe('stale');
  });

  it('maps token telemetry confidence and source quality', () => {
    expect(
      resolveTokenTelemetryQuality({
        token_telemetry_status: 'available',
        token_telemetry_last_source: 'worker_event_usage',
        token_telemetry_last_at_ms: 1_000
      }).token_telemetry_confidence
    ).toBe('observed_live');
    expect(
      resolveTokenTelemetryQuality({
        token_telemetry_status: 'available',
        token_telemetry_last_source: 'codex_home_state_sqlite',
        token_telemetry_last_at_ms: 1_000
      }).token_telemetry_confidence
    ).toBe('backfilled');
    expect(
      resolveTokenTelemetryQuality({
        token_telemetry_status: 'unavailable',
        token_telemetry_last_source: null,
        token_telemetry_last_at_ms: null
      }).token_telemetry_confidence
    ).toBe('missing');
  });
});
