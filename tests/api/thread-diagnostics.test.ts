import { describe, expect, it } from 'vitest';

import { buildThreadDiagnosticsByIssueIdentifier, classifyThreadBlocker } from '../../src/api';
import type { BlockedEntry, OrchestratorState, RetryEntry, RunningEntry } from '../../src/orchestrator';
import {
  createDynamicToolCapabilityMismatchDetail,
  DYNAMIC_TOOL_CONSOLE_RECOVERY_ACTION,
  serializeDynamicToolCapabilityMismatchDetail,
  UNSUPPORTED_DYNAMIC_TOOL_CONSOLE_RESUME_REASON_CODE
} from '../../src/observability/dynamic-tool-capability';
import { CANONICAL_EVENT } from '../../src/observability/events';
import { REASON_CODES } from '../../src/observability/reason-codes';
import type { ExecutionGraphThreadLineage } from '../../src/persistence';
import type { Issue } from '../../src/tracker';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
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
    created_at: new Date('2026-04-10T10:00:00.000Z'),
    updated_at: new Date('2026-04-10T10:00:00.000Z'),
    ...overrides
  };
}

function makeRunningEntry(overrides: Partial<RunningEntry> = {}): RunningEntry {
  return {
    issue: makeIssue(),
    identifier: 'ABC-1',
    run_id: 'run-1',
    worker_handle: {},
    monitor_handle: {},
    retry_attempt: 0,
    workspace_path: '/tmp/symphony/ABC-1',
    provisioner_type: 'none',
    branch_name: null,
    repo_root: null,
    workspace_exists: true,
    workspace_git_status: 'unknown',
    workspace_provisioned: false,
    workspace_is_git_worktree: false,
    session_id: 'thread-1-turn-1',
    thread_id: 'thread-1',
    turn_id: 'turn-1',
    codex_app_server_pid: '12345',
    turn_count: 1,
    last_event: CANONICAL_EVENT.codex.turnWaiting,
    last_event_summary: 'codex turn waiting: waiting_for_turn_completion elapsed_s=390',
    last_message: 'waiting_for_turn_completion elapsed_s=390',
    awaiting_input_since_ms: null,
    pending_input_preview: null,
    stalled_waiting_since_ms: null,
    stalled_waiting_reason: null,
    running_waiting_started_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
    last_progress_transition_at_ms: Date.parse('2026-04-10T10:06:30.000Z'),
    last_heartbeat_at_ms: Date.parse('2026-04-10T10:06:30.000Z'),
    heartbeat_only_event_emitted: true,
    running_wait_stall_event_emitted: false,
    tokens: {
      input_tokens: 20,
      output_tokens: 15,
      total_tokens: 35
    },
    last_reported_tokens: {
      input_tokens: 20,
      output_tokens: 15,
      total_tokens: 35
    },
    token_telemetry_status: 'available',
    token_telemetry_last_source: 'worker_event_usage',
    token_telemetry_last_at_ms: Date.parse('2026-04-10T10:06:00.000Z'),
    token_telemetry_turn_started_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
    token_telemetry_warning_emitted: false,
    recent_events: [
      {
        at_ms: Date.parse('2026-04-10T10:06:30.000Z'),
        event: CANONICAL_EVENT.codex.turnWaiting,
        message: 'waiting_for_turn_completion elapsed_s=390'
      }
    ],
    started_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
    last_codex_timestamp_ms: Date.parse('2026-04-10T10:06:30.000Z'),
    ...overrides
  };
}

function makeBlockedEntry(overrides: Partial<BlockedEntry> = {}): BlockedEntry {
  return {
    issue_id: 'issue-1',
    issue_identifier: 'ABC-1',
    attempt: 1,
    worker_host: null,
    workspace_path: '/tmp/symphony/ABC-1',
    provisioner_type: 'none',
    branch_name: null,
    repo_root: null,
    workspace_exists: true,
    workspace_git_status: 'unknown',
    workspace_provisioned: false,
    workspace_is_git_worktree: false,
    stop_reason_code: REASON_CODES.missingToolOutput,
    stop_reason_detail:
      'tool_name=linear_graphql call_id=call-1 thread_id=thread-1 turn_id=turn-1 session_id=thread-1-turn-1 evidence_source=session_transcript elapsed_wait_ms=120000',
    conflict_files: [],
    resolution_hints: ['Inspect the Codex thread', 'Resume the blocked run', 'Cancel the blocked run'],
    previous_thread_id: 'thread-1',
    previous_session_id: 'thread-1-turn-1',
    blocked_at_ms: Date.parse('2026-04-10T10:02:00.000Z'),
    requires_manual_resume: true,
    required_actions: ['Inspect the Codex thread', 'Resume the blocked run', 'Cancel the blocked run'],
    pending_input: null,
    tool_output_wait: {
      tool_name: 'linear_graphql',
      call_id: 'call-1',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'thread-1-turn-1',
      elapsed_wait_ms: 120_000,
      last_agent_message: 'waiting_for_turn_completion elapsed_s=120',
      evidence_source: 'session_transcript',
      recommended_actions: ['Inspect the Codex thread', 'Resume the blocked run', 'Cancel the blocked run']
    },
    session_console: [],
    ...overrides
  };
}

function makeRetryEntry(overrides: Partial<RetryEntry> = {}): RetryEntry {
  return {
    issue_id: 'issue-1',
    identifier: 'ABC-1',
    attempt: 2,
    issue_run_id: 'issue-run-1',
    previous_attempt_id: 'attempt-prev',
    due_at_ms: Date.parse('2026-04-10T10:04:00.000Z'),
    error: 'retry scheduled',
    worker_host: null,
    workspace_path: '/tmp/symphony/ABC-1',
    provisioner_type: 'none',
    branch_name: null,
    repo_root: null,
    workspace_exists: true,
    workspace_git_status: 'unknown',
    workspace_provisioned: false,
    workspace_is_git_worktree: false,
    stop_reason_code: REASON_CODES.missingToolOutput,
    stop_reason_detail: 'retry scheduled after missing tool output recovery',
    previous_thread_id: 'thread-prev',
    previous_session_id: 'thread-prev-turn-prev',
    recovery: {
      attempt_count: 1,
      started_at_ms: Date.parse('2026-04-10T10:01:30.000Z'),
      reason_code: REASON_CODES.missingToolOutput,
      mode: 'same_thread_guarded_continuation',
      previous_thread_id: 'thread-prev',
      previous_turn_id: 'turn-prev',
      previous_session_id: 'thread-prev-turn-prev',
      replacement_thread_id: 'thread-prev',
      replacement_turn_id: 'turn-replacement-success',
      replacement_session_id: 'session-replacement-success',
      previous_worker_handle_known: true,
      previous_codex_app_server_pid: '12345',
      last_tool_name: 'linear_graphql',
      last_call_id: 'call-retry-1',
      evidence_source: 'session_transcript',
      elapsed_wait_ms: 180_000,
      last_agent_message: 'waiting_for_turn_completion elapsed_s=180',
      last_observed_phase: null,
      last_observed_phase_detail: null,
      recent_event_count: 5,
      quarantined_event_count: 0,
      prompt_hash: 'hash-retry',
      prompt_summary: 'guarded recovery prompt',
      interrupt_cancel_result: {
        status: 'succeeded',
        reason_code: REASON_CODES.missingToolOutputRecoveryInterrupted,
        detail: 'interrupted previous turn'
      },
      last_result: 'succeeded'
    },
    timer_handle: {},
    ...overrides
  };
}

function makeState(
  running: RunningEntry | null,
  blocked: BlockedEntry | null = null,
  retry: RetryEntry | null = null
): OrchestratorState {
  return {
    poll_interval_ms: 30_000,
    max_concurrent_agents: 10,
    running: running ? new Map([[running.issue.id, running]]) : new Map(),
    claimed: new Set(),
    retry_attempts: retry ? new Map([[retry.issue_id, retry]]) : new Map(),
    blocked_inputs: blocked ? new Map([[blocked.issue_id, blocked]]) : new Map(),
    circuit_breakers: new Map(),
    budget_usage_samples: new Map(),
    completed: new Set(),
    codex_totals: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      seconds_running: 0
    },
    codex_rate_limits: null,
    health: {
      dispatch_validation: 'ok',
      last_error: null
    },
    throughput: {
      current_tps: 0,
      avg_tps_60s: 0,
      window_seconds: 600,
      sparkline_10m: [],
      sample_count: 0
    },
    recent_runtime_events: []
  };
}

function makeConsoleResumeLineage(includeDynamicToolMismatch: boolean): ExecutionGraphThreadLineage {
  const mismatchDetail = serializeDynamicToolCapabilityMismatchDetail(
    createDynamicToolCapabilityMismatchDetail({
      attempted_tool_name: 'linear_graphql',
      call_id: 'tool-call-7',
      unsupported_capability_message: 'Dynamic tool calls are not available in TUI yet.'
    })
  );

  return {
    issue_run: {
      issue_run_id: 'issue-run-1',
      issue_id: 'issue-1',
      issue_identifier: 'ABC-1',
      started_at: '2026-04-10T10:00:00.000Z',
      ended_at: null,
      status: 'running',
      reason_code: 'dispatch_started',
      reason_detail: null
    },
    attempt: {
      attempt_id: 'attempt-1',
      issue_run_id: 'issue-run-1',
      attempt_number: 2,
      started_at: '2026-04-10T10:00:01.000Z',
      ended_at: null,
      status: 'running',
      reason_code: 'manual_resume',
      reason_detail: 'source_environment=console_tui'
    },
    thread: {
      thread_id: 'thread-1',
      attempt_id: 'attempt-1',
      started_at: '2026-04-10T10:00:02.000Z',
      ended_at: null,
      status: 'running',
      reason_code: 'manual_resume',
      reason_detail: 'source_environment=console_tui'
    },
    turns: [
      {
        turn_id: 'turn-console',
        thread_id: 'thread-1',
        turn_index: 0,
        started_at: '2026-04-10T10:00:03.000Z',
        ended_at: '2026-04-10T10:00:20.000Z',
        status: 'succeeded',
        reason_code: 'normal_completion',
        reason_detail: null,
        phase_spans: [],
        tool_spans: includeDynamicToolMismatch
          ? [
              {
                tool_span_id: 'tool-mismatch',
                turn_id: 'turn-console',
                tool_name: 'linear_graphql',
                started_at: '2026-04-10T10:00:05.000Z',
                ended_at: '2026-04-10T10:00:05.000Z',
                status: 'failed',
                reason_code: UNSUPPORTED_DYNAMIC_TOOL_CONSOLE_RESUME_REASON_CODE,
                reason_detail: mismatchDetail
              },
              {
                tool_span_id: 'tool-fallback',
                turn_id: 'turn-console',
                tool_name: 'linear_mcp',
                started_at: '2026-04-10T10:00:08.000Z',
                ended_at: '2026-04-10T10:00:10.000Z',
                status: 'succeeded',
                reason_code: 'codex_tool_completed',
                reason_detail: 'linear_mcp'
              }
            ]
          : [],
        state_transitions: []
      }
    ],
    state_transitions: [
      {
        state_transition_id: 'transition-1',
        issue_run_id: 'issue-run-1',
        attempt_id: 'attempt-1',
        thread_id: 'thread-1',
        turn_id: 'turn-console',
        from_status: 'running',
        to_status: 'succeeded',
        transitioned_at: '2026-04-10T10:00:20.000Z',
        status: 'succeeded',
        reason_code: 'normal_completion',
        reason_detail: null
      }
    ]
  };
}

describe('thread diagnostics blocker classification', () => {
  it.each([
    [
      'stalled_waiting',
      'required',
      {
        reason_code: 'turn_waiting_threshold_exceeded',
        reason_detail: 'codex.turn.waiting heartbeat loop exceeded threshold',
        stalled_waiting: true
      }
    ],
    [
      'missing_tool_output',
      'required',
      {
        reason_code: REASON_CODES.missingToolOutput,
        reason_detail:
          'tool_name=linear_graphql call_id=call-1 thread_id=thread-1 turn_id=turn-1 session_id=thread-1-turn-1 evidence_source=session_transcript elapsed_wait_ms=120000'
      }
    ],
    [
      'tracker_transition_pending',
      'recommended',
      {
        reason_code: 'tracker_transition_failed',
        reason_detail: 'tracker transition pending'
      }
    ],
    [
      'input_required_pending',
      'required',
      {
        reason_code: 'turn_input_required',
        reason_detail: 'operator input required',
        has_pending_input: true
      }
    ],
    [
      'codex_no_progress',
      'recommended',
      {
        reason_code: 'operator_action_required_no_progress_redispatch_blocked',
        reason_detail: 'no progress observed'
      }
    ],
    [
      'workspace_integrity_conflict',
      'required',
      {
        reason_code: 'workspace_integrity_failed',
        reason_detail: 'workspace conflict detected',
        has_conflict_files: true
      }
    ],
    [
      'retry_backoff_wait',
      'none',
      {
        reason_code: 'worker_stalled',
        reason_detail: 'retry scheduled',
        retrying: true
      }
    ]
  ])('classifies %s deterministically with locked actionability %s', (classification, actionability, input) => {
    const blocker = classifyThreadBlocker(input);

    expect(blocker).toMatchObject({
      classification,
      reason_code: input.reason_code,
      reason_detail: input.reason_detail,
      actionability
    });
    expect(['none', 'recommended', 'required']).toContain(blocker?.actionability);
    expect(blocker?.recommended_actions.length).toBeGreaterThan(0);
    expect(blocker).toHaveProperty('time_since_progress');
    expect(blocker).toHaveProperty('expected_auto_transition');
  });

  it('reports active long-running waiting turns with fresh thread activity as running with no blocker', () => {
    const diagnostics = buildThreadDiagnosticsByIssueIdentifier({
      state: makeState(makeRunningEntry()),
      issue_identifier: 'ABC-1'
    });

    expect(diagnostics?.status).toBe('running');
    expect(diagnostics?.current_blocker).toBeNull();
    expect(diagnostics?.wait_spans[0]).toMatchObject({
      status: 'running',
      reason_code: null,
      reason_detail: null
    });
  });

  it('preserves protocol hardening evidence in runtime and blocked timeline events', () => {
    const diagnostics = buildThreadDiagnosticsByIssueIdentifier({
      state: makeState(
        makeRunningEntry({
          recent_events: [
            {
              at_ms: Date.parse('2026-04-10T10:00:01.000Z'),
              event: CANONICAL_EVENT.codex.protocolWarning,
              message: 'guardian policy warning',
              reason_code: REASON_CODES.codexProtocolGuardianWarning,
              request_method: 'guardianWarning',
              request_category: 'protocol_warning',
              protocol_warning: {
                method: 'guardianWarning',
                reason_code: REASON_CODES.codexProtocolGuardianWarning,
                message: 'guardian policy warning',
                severity: 'warn',
                source: 'app_server_protocol'
              },
              model_reroute: {
                requested_model: 'gpt-requested',
                effective_model: 'gpt-effective',
                reason_code: REASON_CODES.codexModelRerouted,
                source: 'app_server_protocol'
              },
              requested_model: 'gpt-requested',
              effective_model: 'gpt-effective'
            }
          ]
        }),
        makeBlockedEntry({
          session_console: [
            {
              at_ms: Date.parse('2026-04-10T10:00:02.000Z'),
              event: CANONICAL_EVENT.codex.dynamicToolCapabilityMismatch,
              message: 'dynamic tool capability mismatch',
              reason_code: REASON_CODES.unsupportedDynamicToolConsoleResume,
              request_method: 'tools/call',
              request_category: 'dynamic_tool',
              tool_call_id: 'call-dynamic-1',
              tool_name: 'linear_graphql'
            }
          ]
        })
      ),
      issue_identifier: 'ABC-1'
    });

    expect(diagnostics?.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: CANONICAL_EVENT.codex.protocolWarning,
          reason_code: REASON_CODES.codexProtocolGuardianWarning,
          request_method: 'guardianWarning',
          request_category: 'protocol_warning',
          protocol_warning: expect.objectContaining({
            method: 'guardianWarning',
            reason_code: REASON_CODES.codexProtocolGuardianWarning
          }),
          model_reroute: expect.objectContaining({
            requested_model: 'gpt-requested',
            effective_model: 'gpt-effective'
          }),
          requested_model: 'gpt-requested',
          effective_model: 'gpt-effective'
        }),
        expect.objectContaining({
          event: CANONICAL_EVENT.codex.dynamicToolCapabilityMismatch,
          reason_code: REASON_CODES.unsupportedDynamicToolConsoleResume,
          request_method: 'tools/call',
          request_category: 'dynamic_tool',
          tool_call_id: 'call-dynamic-1',
          tool_name: 'linear_graphql'
        })
      ])
    );
  });

  it('reports genuinely stale waiting turns with a deterministic blocker', () => {
    const diagnostics = buildThreadDiagnosticsByIssueIdentifier({
      state: makeState(
        makeRunningEntry({
          stalled_waiting_since_ms: Date.parse('2026-04-10T10:05:00.000Z'),
          stalled_waiting_reason: 'turn_waiting_threshold_exceeded',
          last_progress_transition_at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
          recent_events: [
            {
              at_ms: Date.parse('2026-04-10T10:00:00.000Z'),
              event: CANONICAL_EVENT.codex.turnWaiting,
              message: 'waiting heartbeat'
            }
          ]
        })
      ),
      issue_identifier: 'ABC-1'
    });

    expect(diagnostics?.status).toBe('stalled');
    expect(diagnostics?.current_blocker).toMatchObject({
      classification: 'stalled_waiting',
      reason_code: 'turn_waiting_threshold_exceeded',
      actionability: 'required'
    });
    expect(diagnostics?.wait_spans[0]).toMatchObject({
      status: 'blocked',
      reason_code: 'turn_waiting_threshold_exceeded',
      reason_detail: 'codex.turn.waiting heartbeat loop exceeded threshold'
    });
  });

  it('reports missing tool output as a diagnostic blocker with exact call evidence', () => {
    const diagnostics = buildThreadDiagnosticsByIssueIdentifier({
      state: makeState(null, makeBlockedEntry()),
      issue_identifier: 'ABC-1',
      now_ms: Date.parse('2026-04-10T10:03:00.000Z')
    });

    expect(diagnostics?.status).toBe('stalled');
    expect(diagnostics?.current_blocker).toMatchObject({
      classification: 'missing_tool_output',
      reason_code: REASON_CODES.missingToolOutput,
      actionability: 'required',
      tool_output_wait: {
        tool_name: 'linear_graphql',
        call_id: 'call-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        session_id: 'thread-1-turn-1',
        elapsed_wait_ms: 120_000,
        evidence_source: 'session_transcript',
        recommended_actions: ['Inspect the Codex thread', 'Resume the blocked run', 'Cancel the blocked run']
      },
      missing_tool_output_recovery: {
        status: 'not_started',
        headline: 'Missing tool output detected',
        original_tool_name: 'linear_graphql',
        original_call_id: 'call-1',
        active_ownership: {
          issue_id: 'issue-1',
          issue_identifier: 'ABC-1',
          thread_id: 'thread-1',
          turn_id: 'turn-1',
          session_id: 'thread-1-turn-1',
          app_server_owned: false
        },
        interrupt_cancel_result: {
          status: 'not_started'
        },
        final_outcome: {
          result: null
        }
      }
    });
  });

  it('reports in-progress guarded recovery against the active owned runtime lineage', () => {
    const diagnostics = buildThreadDiagnosticsByIssueIdentifier({
      state: makeState(
        makeRunningEntry({
          thread_id: 'thread-1',
          turn_id: 'turn-recovery',
          session_id: 'session-recovery',
          recovery: {
            attempt_count: 1,
            started_at_ms: Date.parse('2026-04-10T10:02:00.000Z'),
            reason_code: REASON_CODES.missingToolOutput,
            mode: 'same_thread_guarded_continuation',
            previous_thread_id: 'thread-1',
            previous_turn_id: 'turn-1',
            previous_session_id: 'thread-1-turn-1',
            previous_worker_handle_known: true,
            previous_codex_app_server_pid: '12345',
            last_tool_name: 'linear_graphql',
            last_call_id: 'call-1',
            evidence_source: 'session_transcript',
            elapsed_wait_ms: 120_000,
            last_agent_message: 'waiting_for_turn_completion elapsed_s=120',
            last_observed_phase: null,
            last_observed_phase_detail: null,
            recent_event_count: 4,
            quarantined_event_count: 1,
            prompt_hash: 'abc123',
            prompt_summary: 'guarded recovery prompt: inspect state before retrying indeterminate tool action',
            interrupt_cancel_result: {
              status: 'succeeded',
              reason_code: REASON_CODES.missingToolOutputRecoveryInterrupted,
              detail: 'interrupted previous turn turn-1 on thread thread-1'
            },
            last_result: 'started'
          }
        })
      ),
      issue_identifier: 'ABC-1',
      now_ms: Date.parse('2026-04-10T10:03:00.000Z')
    });

    expect(diagnostics?.current_blocker).toMatchObject({
      classification: 'missing_tool_output',
      missing_tool_output_recovery: {
        status: 'in_progress',
        headline: 'Guarded missing-output recovery is in progress',
        original_tool_name: 'linear_graphql',
        original_call_id: 'call-1',
        active_ownership: {
          issue_id: 'issue-1',
          issue_identifier: 'ABC-1',
          run_id: 'run-1',
          thread_id: 'thread-1',
          turn_id: 'turn-recovery',
          session_id: 'session-recovery',
          codex_app_server_pid: '12345',
          app_server_owned: true
        },
        replacement_turn: {
          thread_id: 'thread-1',
          turn_id: 'turn-recovery',
          session_id: 'session-recovery'
        },
        interrupt_cancel_result: {
          status: 'succeeded',
          reason_code: REASON_CODES.missingToolOutputRecoveryInterrupted
        },
        guarded_prompt_dispatch: {
          status: 'sent',
          prompt_hash: 'abc123'
        },
        final_outcome: {
          result: 'started'
        }
      }
    });
  });

  it('does not report interrupt success for pre-interrupt recovery blocks', () => {
    const diagnostics = buildThreadDiagnosticsByIssueIdentifier({
      state: makeState(
        null,
        makeBlockedEntry({
          stop_reason_code: REASON_CODES.missingToolOutputRecoveryStartFailed,
          stop_reason_detail: 'missing previous thread or turn id for same-thread guarded recovery',
          previous_thread_id: 'thread-1',
          previous_session_id: null,
          recovery: {
            attempt_count: 1,
            started_at_ms: Date.parse('2026-04-10T10:02:00.000Z'),
            reason_code: REASON_CODES.missingToolOutput,
            mode: 'same_thread_guarded_continuation',
            previous_thread_id: 'thread-1',
            previous_turn_id: null,
            previous_session_id: null,
            previous_worker_handle_known: true,
            previous_codex_app_server_pid: '12345',
            last_tool_name: 'linear_graphql',
            last_call_id: 'call-1',
            evidence_source: 'session_transcript',
            elapsed_wait_ms: 120_000,
            last_agent_message: 'waiting_for_turn_completion elapsed_s=120',
            last_observed_phase: null,
            last_observed_phase_detail: null,
            recent_event_count: 4,
            quarantined_event_count: 0,
            prompt_hash: 'abc123',
            prompt_summary: 'guarded recovery prompt: inspect state before retrying indeterminate tool action',
            interrupt_cancel_result: {
              status: 'not_started',
              reason_code: null,
              detail: null
            },
            last_result: 'failed',
            last_result_reason_code: REASON_CODES.missingToolOutputRecoveryStartFailed
          }
        })
      ),
      issue_identifier: 'ABC-1',
      now_ms: Date.parse('2026-04-10T10:03:00.000Z')
    });

    expect(diagnostics?.current_blocker?.missing_tool_output_recovery).toMatchObject({
      status: 'failed',
      interrupt_cancel_result: {
        status: 'not_started',
        reason_code: null,
        detail: null
      },
      guarded_prompt_dispatch: {
        status: 'not_started'
      },
      final_outcome: {
        result: 'failed',
        reason_code: REASON_CODES.missingToolOutputRecoveryStartFailed
      }
    });
  });

  it('preserves missing-output recovery evidence for retrying issue diagnostics', () => {
    const diagnostics = buildThreadDiagnosticsByIssueIdentifier({
      state: makeState(null, null, makeRetryEntry()),
      issue_identifier: 'ABC-1',
      now_ms: Date.parse('2026-04-10T10:03:00.000Z')
    });

    expect(diagnostics?.status).toBe('stalled');
    expect(diagnostics?.current_blocker).toMatchObject({
      classification: 'missing_tool_output',
      reason_code: REASON_CODES.missingToolOutput,
      missing_tool_output_recovery: {
        status: 'succeeded',
        original_tool_name: 'linear_graphql',
        original_call_id: 'call-retry-1',
        active_ownership: {
          issue_id: 'issue-1',
          issue_identifier: 'ABC-1',
          attempt_id: 'attempt-prev',
          thread_id: 'thread-prev',
          turn_id: 'turn-prev',
          session_id: 'thread-prev-turn-prev',
          app_server_owned: false
        },
        interrupt_cancel_result: {
          status: 'succeeded',
          reason_code: REASON_CODES.missingToolOutputRecoveryInterrupted
        },
        guarded_prompt_dispatch: {
          status: 'sent',
          prompt_hash: 'hash-retry'
        },
        replacement_turn: {
          thread_id: 'thread-prev',
          turn_id: 'turn-replacement-success',
          session_id: 'session-replacement-success'
        },
        final_outcome: {
          result: 'succeeded'
        }
      }
    });
  });

  it('preserves console/TUI dynamic-tool capability warnings after fallback success', () => {
    const diagnostics = buildThreadDiagnosticsByIssueIdentifier({
      state: makeState(makeRunningEntry()),
      issue_identifier: 'ABC-1',
      reconstructThreadLineage: () => makeConsoleResumeLineage(true)
    });

    expect(diagnostics?.status).toBe('running');
    expect(diagnostics?.capability_warnings).toEqual([
      {
        reason_code: UNSUPPORTED_DYNAMIC_TOOL_CONSOLE_RESUME_REASON_CODE,
        source_environment: 'console_tui',
        attempted_tool_name: 'linear_graphql',
        call_id: 'tool-call-7',
        thread_id: 'thread-1',
        turn_id: 'turn-console',
        unsupported_capability_message: 'Dynamic tool calls are not available in TUI yet.',
        recommended_recovery_action: DYNAMIC_TOOL_CONSOLE_RECOVERY_ACTION
      }
    ]);
  });

  it('does not warn for normal console resume lineage without dynamic tools', () => {
    const diagnostics = buildThreadDiagnosticsByIssueIdentifier({
      state: makeState(makeRunningEntry()),
      issue_identifier: 'ABC-1',
      reconstructThreadLineage: () => makeConsoleResumeLineage(false)
    });

    expect(diagnostics?.capability_warnings).toEqual([]);
  });
});
