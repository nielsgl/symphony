import { describe, expect, it } from 'vitest';

import {
  createForensicsBundle,
  diffForensicsBundles,
  replayForensicsBundle,
  type ForensicsBundle
} from '../../src/api/forensics';
import { buildThreadDiagnosticsFromLineage } from '../../src/api/thread-diagnostics';
import type { ApiDiagnosticsResponse } from '../../src/api/types';
import type { ExecutionGraphThreadLineage } from '../../src/persistence';

function makeLineage(overrides: {
  phase?: string;
  tool?: string;
  reason?: string;
  reasonDetail?: string;
} = {}): ExecutionGraphThreadLineage {
  const reason = overrides.reason ?? 'turn_waiting_threshold_exceeded';
  const reasonDetail = overrides.reasonDetail ?? 'codex.turn.waiting heartbeat loop exceeded threshold';
  return {
    issue_run: {
      issue_run_id: 'issue-run-1',
      issue_id: 'issue-1',
      issue_identifier: 'ABC-1',
      started_at: '2026-04-11T10:00:00.000Z',
      ended_at: null,
      status: 'running',
      reason_code: 'dispatch_started',
      reason_detail: null
    },
    attempt: {
      attempt_id: 'attempt-1',
      issue_run_id: 'issue-run-1',
      attempt_number: 1,
      started_at: '2026-04-11T10:00:01.000Z',
      ended_at: null,
      status: 'running',
      reason_code: 'attempt_started',
      reason_detail: null
    },
    thread: {
      thread_id: 'thread-1',
      attempt_id: 'attempt-1',
      started_at: '2026-04-11T10:00:02.000Z',
      ended_at: null,
      status: 'blocked',
      reason_code: reason,
      reason_detail: reasonDetail
    },
    turns: [
      {
        turn_id: 'turn-1',
        thread_id: 'thread-1',
        turn_index: 0,
        started_at: '2026-04-11T10:00:03.000Z',
        ended_at: null,
        status: 'blocked',
        reason_code: reason,
        reason_detail: reasonDetail,
        phase_spans: [
          {
            phase_span_id: 'phase-span-1',
            turn_id: 'turn-1',
            phase: overrides.phase ?? 'implementation',
            started_at: '2026-04-11T10:00:04.000Z',
            ended_at: null,
            status: 'blocked',
            reason_code: reason,
            reason_detail: reasonDetail
          }
        ],
        tool_spans: [
          {
            tool_span_id: 'tool-span-1',
            turn_id: 'turn-1',
            tool_name: overrides.tool ?? 'exec_command',
            started_at: '2026-04-11T10:00:05.000Z',
            ended_at: null,
            status: 'blocked',
            reason_code: reason,
            reason_detail: reasonDetail
          }
        ],
        state_transitions: [
          {
            state_transition_id: 'transition-1',
            issue_run_id: 'issue-run-1',
            attempt_id: 'attempt-1',
            thread_id: 'thread-1',
            turn_id: 'turn-1',
            from_status: 'running',
            to_status: 'blocked',
            transitioned_at: '2026-04-11T10:05:00.000Z',
            status: 'blocked',
            reason_code: reason,
            reason_detail: reasonDetail
          }
        ]
      }
    ],
    state_transitions: [
      {
        state_transition_id: 'transition-1',
        issue_run_id: 'issue-run-1',
        attempt_id: 'attempt-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        from_status: 'running',
        to_status: 'blocked',
        transitioned_at: '2026-04-11T10:05:00.000Z',
        status: 'blocked',
        reason_code: reason,
        reason_detail: reasonDetail
      }
    ]
  };
}

function makeApiDiagnostics(): ApiDiagnosticsResponse {
  return {
    active_profile: {
      name: 'balanced',
      approval_policy: 'on-request',
      thread_sandbox: 'workspace-write',
      turn_sandbox_policy: { type: 'workspace-write' },
      user_input_policy: 'fail_attempt'
    },
    persistence: {
      enabled: true,
      db_path: '/tmp/symphony.sqlite',
      retention_days: 14,
      run_count: 1,
      last_pruned_at: null,
      last_prune_failure_at: null,
      last_prune_failure_reason: null,
      last_prune_failure_detail: null,
      integrity_ok: true
    },
    logging: { root: '/tmp/logs', active_file: '/tmp/logs/symphony.log', rotation: { max_bytes: 1000, max_files: 2 }, sinks: ['stderr'] },
    event_vocabulary_version: 'v2',
    token_accounting: {
      mode: 'strict_canonical',
      canonical_precedence: [
        'terminal_turn_summary',
        'thread/tokenUsage/updated.params.tokenUsage.total',
        'params.info.total_token_usage',
        'params.info.totalTokenUsage',
        'params.total_token_usage',
        'params.totalTokenUsage',
        'params.usage.total_token_usage',
        'params.usage.totalTokenUsage',
        'last_token_usage',
        'persisted_fallback_usage'
      ],
      excludes_generic_usage_for_totals: true,
      excludes_last_usage_for_totals: false,
      no_telemetry_warning_threshold_ms: 120_000,
      optional_dimensions: ['cached_input_tokens', 'reasoning_output_tokens', 'model_context_window'],
      observed_dimensions: { cached_input_tokens: false, reasoning_output_tokens: false, model_context_window: false }
    },
    token_telemetry_status: 'available',
    token_telemetry_last_source: 'worker_event_usage',
    token_telemetry_last_at_ms: Date.parse('2026-04-11T10:05:00.000Z'),
    workflow: { prompt_fallback_active: false },
    runtime_resolution: {
      workflow_path: '/tmp/WORKFLOW.md',
      workflow_dir: '/tmp',
      workspace_root: '/tmp/workspaces',
      workspace_root_source: 'workflow',
      server: { host: '127.0.0.1', port: 3000 },
      provisioner_type: 'worktree',
      repo_root: '/tmp/repo',
      base_ref: 'origin/main',
      branch_name_template: 'feature/{{issue_identifier}}',
      effective_codex_home: '/tmp/codex',
      effective_codex_model: 'gpt-5.2',
      effective_reasoning_effort: 'medium',
      effective_extra_flags_count: 0,
      codex_resolution_mode: 'typed'
    },
    workspace_provisioner: {
      provisioner_type: 'worktree',
      repo_root: '/tmp/repo',
      base_ref: 'origin/main',
      branch_name_template: 'feature/{{issue_identifier}}',
      last_provision_result: 'provisioned',
      last_teardown_result: null,
      last_error_code: null,
      last_verification_result: 'verified',
      last_cleanup_on_failure_result: 'not_attempted',
      verification_mode: 'strict'
    },
    workspace_copy_ignored: {
      enabled: false,
      include_file: '.symphony-copy-ignored',
      from: 'primary_worktree',
      conflict_policy: 'skip',
      require_gitignored: true,
      max_files: 0,
      max_total_bytes: 0,
      last_status: null,
      last_error_code: null,
      last_error_message: null,
      source_path: null,
      copied_files: 0,
      skipped_existing: 0,
      blocked_files: 0,
      bytes_copied: 0,
      duration_ms: 0
    },
    phase_markers: { enabled: true, timeline_limit: 30, last_emit_error_code: null },
    breaker_statuses: [],
    blocked_latch: {
      blocked_latch_active_count: 0,
      blocked_event_quarantine_total: 0,
      blocked_event_allowlist_total: 0,
      blocked_event_reject_total: 0,
      blocked_latch_violation_total: 0
    },
    stream: {
      live_client_count: 0,
      last_client_connected_at: null,
      last_client_disconnected_at: null,
      last_snapshot_broadcast_at: null,
      last_snapshot_broadcast_latency_ms: null,
      last_snapshot_broadcast_status: null,
      last_snapshot_broadcast_error: null
    },
    control_plane: {
      generated_at: '2026-04-11T10:06:00.000Z',
      sample_limit: 40,
      thresholds: {
        slow_ms: 1000,
        degraded_ms: 5000,
        large_payload_bytes: 1_000_000,
        degraded_payload_bytes: 5_000_000
      },
      endpoint_count: 0,
      worst_health: 'ok',
      endpoints: []
    }
  };
}

function makeBundle(lineage = makeLineage(), tokens = 42): ForensicsBundle {
  return createForensicsBundle({
    diagnostics: buildThreadDiagnosticsFromLineage({
      lineage,
      now_ms: Date.parse('2026-04-11T10:06:00.000Z')
    }),
    api_diagnostics: makeApiDiagnostics(),
    lineage,
    token_snapshot: {
      input_tokens: 20,
      output_tokens: Math.max(0, tokens - 20),
      total_tokens: tokens
    },
    generated_at_ms: Date.parse('2026-04-11T10:06:00.000Z')
  });
}

describe('forensics export bundle', () => {
  it('emits the locked schema fields needed for offline incident replay', () => {
    const bundle = makeBundle();

    expect(bundle.schema_version).toBe('symphony.forensics.bundle.v1');
    expect(bundle.timeline_events.map((event) => event.event)).toContain('state.transition');
    expect(bundle.spans.phase[0]).toMatchObject({ phase: 'implementation' });
    expect(bundle.spans.tool[0]).toMatchObject({ tool_name: 'exec_command' });
    expect(bundle.config_fingerprint.value).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.workflow_hash.value).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.reason_taxonomy_version).toBe('2026-05-11.v1');
  });

  it('exports redacted missing-output recovery lineage for offline review', () => {
    const bundle = createForensicsBundle({
      diagnostics: buildThreadDiagnosticsFromLineage({
        lineage: makeLineage({ tool: 'linear_graphql', reason: 'missing_tool_output', reasonDetail: 'tool_name=linear_graphql call_id=call-1' }),
        now_ms: Date.parse('2026-04-11T10:06:00.000Z')
      }),
      api_diagnostics: makeApiDiagnostics(),
      terminal_run: {
        run_id: 'run-recovery',
        issue_id: 'issue-1',
        issue_identifier: 'ABC-1',
        started_at: '2026-04-11T10:00:00.000Z',
        ended_at: '2026-04-11T10:04:00.000Z',
        completed_at: '2026-04-11T10:04:00.000Z',
        terminal_status: 'cancelled',
        error_code: 'missing_tool_output_recovery_interrupted',
        terminal_reason_code: 'missing_tool_output_recovery_interrupted',
        terminal_reason_detail: null,
        root_cause_status: 'blocked',
        root_cause_reason_code: 'missing_tool_output',
        root_cause_reason_detail: 'tool_name=linear_graphql call_id=call-1 secret=super-secret-token',
        root_cause_at: '2026-04-11T10:02:00.000Z',
        session_id: 'session-recovery',
        thread_id: 'thread-1',
        turn_id: 'turn-recovery',
        session_ids: ['session-recovery'],
        missing_tool_output_recovery: {
          status: 'succeeded',
          original_tool_name: 'linear_graphql',
          original_call_id: 'call-1',
          interrupt_cancel_result: {
            status: 'failed',
            reason_code: 'worker_cancel_unsupported',
            detail: 'foreign worker handle secret=super-secret-token',
            termination_result: {
              cancellation_supported: false,
              cancellation_requested: false,
              worker_settled: null,
              graceful_exit_observed: null,
              forced_kill_requested: false,
              forced_kill_settled: null,
              cleanup_requested: false,
              cleanup_succeeded: null,
              result: 'unsupported',
              reason_code: 'worker_cancel_unsupported',
              detail: 'foreign worker handle secret=super-secret-token'
            }
          },
          replacement_turn: {
            thread_id: 'thread-1',
            turn_id: 'turn-recovery',
            session_id: 'session-recovery'
          },
          final_outcome: {
            result: 'succeeded',
            detail: 'token=super-secret-token'
          }
        }
      },
      generated_at_ms: Date.parse('2026-04-11T10:06:00.000Z')
    });

    expect(bundle.missing_tool_output_recovery).toMatchObject({
      status: 'succeeded',
      original_tool_name: 'linear_graphql',
      original_call_id: 'call-1',
      interrupt_cancel_result: {
        status: 'failed',
        reason_code: 'worker_cancel_unsupported',
        detail: 'foreign worker handle secret=***REDACTED***',
        termination_result: {
          result: 'unsupported',
          reason_code: 'worker_cancel_unsupported',
          detail: 'foreign worker handle secret=***REDACTED***'
        }
      },
      replacement_turn: {
        thread_id: 'thread-1',
        turn_id: 'turn-recovery',
        session_id: 'session-recovery'
      },
      final_outcome: {
        result: 'succeeded',
        detail: 'token=***REDACTED***'
      }
    });
    expect(JSON.stringify(bundle)).not.toContain('super-secret-token');
  });

  it('replays lineage bundles deterministically with generated-at time', () => {
    const bundle = makeBundle();
    const first = replayForensicsBundle(bundle, Date.parse('2026-04-11T10:10:00.000Z'));
    const second = replayForensicsBundle(bundle, Date.parse('2026-04-11T10:20:00.000Z'));

    expect(first.deterministic).toBe(true);
    expect(second.deterministic).toBe(true);
    expect(first.diagnostics).toEqual(second.diagnostics);
    expect(first.diagnostics.current_blocker?.time_since_progress).toBe(359_000);
  });

  it.each([
    ['phase', makeBundle(makeLineage({ phase: 'validation' })), 'phase'],
    ['tool', makeBundle(makeLineage({ tool: 'linear_graphql' })), 'tool_name'],
    ['reason', makeBundle(makeLineage({ reason: 'turn_input_required', reasonDetail: 'operator input required' })), 'reason_code'],
    ['tokens', makeBundle(makeLineage(), 99), 'token_snapshot']
  ])('reports the first %s divergence for synthetic good/bad bundles', (_name, badBundle, field) => {
    const result = diffForensicsBundles(makeBundle(), badBundle);

    expect(result.equal).toBe(false);
    expect(result.first_divergence?.field).toBe(field);
  });
});
