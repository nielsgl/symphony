import { describe, expect, it } from 'vitest';

import { buildProjectHistoryConsumerSummaryResponse } from '../../src/api/project-history';
import type { DurableIdentity, TicketTimelineRecord } from '../../src/persistence';

function identity(overrides: Partial<DurableIdentity['ticket']> = {}): DurableIdentity {
  return {
    project: {
      key: 'project-main',
      project_root: '/repo/main',
      workflow_path: '/repo/main/WORKFLOW.md',
      workflow_hash: { status: 'present', value: 'workflow-hash' },
      repository_remote: { status: 'present', value: 'git@github.com:nielsgl/symphony.git' }
    },
    ticket: {
      key: overrides.key ?? 'ticket-abc-1',
      tracker_kind: 'linear',
      tracker_scope: { status: 'present', value: 'symphony' },
      remote_issue_id: overrides.remote_issue_id ?? 'remote-abc-1',
      human_issue_identifier: overrides.human_issue_identifier ?? 'ABC-1'
    }
  };
}

function timeline(overrides: Partial<TicketTimelineRecord> = {}): TicketTimelineRecord {
  const durableIdentity = identity();
  return {
    identity: durableIdentity,
    issue_runs: [
      {
        issue_run_id: 'issue-run-1',
        issue_id: durableIdentity.ticket.remote_issue_id,
        issue_identifier: durableIdentity.ticket.human_issue_identifier,
        identity: durableIdentity,
        started_at: '2026-04-10T10:00:00.000Z',
        ended_at: '2026-04-10T10:30:00.000Z',
        status: 'succeeded',
        reason_code: null,
        reason_detail: null
      }
    ],
    attempts: [
      {
        attempt_id: 'attempt-1',
        issue_run_id: 'issue-run-1',
        attempt_number: 1,
        started_at: '2026-04-10T10:00:01.000Z',
        ended_at: '2026-04-10T10:30:00.000Z',
        status: 'succeeded',
        reason_code: null,
        reason_detail: null
      }
    ],
    threads: [
      {
        thread_id: 'thread-1',
        attempt_id: 'attempt-1',
        started_at: '2026-04-10T10:00:02.000Z',
        ended_at: '2026-04-10T10:29:00.000Z',
        status: 'succeeded',
        reason_code: null,
        reason_detail: null
      }
    ],
    turns: [
      {
        turn_id: 'turn-1',
        thread_id: 'thread-1',
        turn_index: 0,
        started_at: '2026-04-10T10:00:03.000Z',
        ended_at: '2026-04-10T10:20:00.000Z',
        status: 'succeeded',
        reason_code: null,
        reason_detail: null
      }
    ],
    phase_spans: [
      {
        phase_span_id: 'phase-1',
        turn_id: 'turn-1',
        phase: 'implementation',
        started_at: '2026-04-10T10:01:00.000Z',
        ended_at: '2026-04-10T10:19:00.000Z',
        status: 'succeeded',
        reason_code: null,
        reason_detail: null
      }
    ],
    state_transitions: [
      {
        state_transition_id: 'state-1',
        issue_run_id: 'issue-run-1',
        attempt_id: 'attempt-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        from_status: 'In Progress',
        to_status: 'Agent Review',
        transitioned_at: '2026-04-10T10:29:30.000Z',
        status: 'succeeded',
        reason_code: 'review_ready',
        reason_detail: null
      }
    ],
    terminal_outcomes: [
      {
        terminal_outcome_id: 'outcome-1',
        issue_run_id: 'issue-run-1',
        attempt_id: 'attempt-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        outcome: 'succeeded',
        reason_code: 'agent_review_ready',
        reason_detail: null,
        recorded_at: '2026-04-10T10:30:00.000Z'
      }
    ],
    blockers: [
      {
        blocker_id: 'blocker-1',
        issue_run_id: 'issue-run-1',
        attempt_id: 'attempt-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        blocker_type: 'review_feedback',
        status: 'resolved',
        reason_code: 'review_comment_addressed',
        reason_detail: 'fixed reviewer note',
        blocked_at: '2026-04-10T10:10:00.000Z',
        resolved_at: '2026-04-10T10:15:00.000Z'
      }
    ],
    evidence_references: [
      {
        evidence_reference_id: 'evidence-1',
        issue_run_id: 'issue-run-1',
        attempt_id: 'attempt-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        evidence_kind: 'validation',
        uri: 'file://validation.txt',
        title: 'targeted validation',
        metadata: { command: 'npm test -- tests/api/project-history.test.ts' },
        recorded_at: '2026-04-10T10:28:00.000Z'
      }
    ],
    tracker_snapshots: [
      {
        tracker_snapshot_id: 'tracker-1',
        project_key: 'project-main',
        ticket_key: 'ticket-abc-1',
        issue_run_id: 'issue-run-1',
        attempt_id: 'attempt-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        tracker_kind: 'linear',
        tracker_scope_status: 'present',
        tracker_scope_value: 'symphony',
        tracker_scope_reason: null,
        remote_issue_id: durableIdentity.ticket.remote_issue_id,
        human_issue_identifier: durableIdentity.ticket.human_issue_identifier,
        title: 'Ticket ABC-1',
        tracker_status: 'Agent Review',
        assignee_status: 'unknown',
        assignee_identifier: null,
        assignee_reason: null,
        labels: ['ready-for-agent'],
        project_status: 'available',
        project_identifier: 'project-main',
        project_reason: null,
        team_status: 'available',
        team_identifier: 'Nielsgl',
        team_reason: null,
        observed_at: '2026-04-10T10:30:00.000Z',
        observation_hash: 'tracker-hash',
        duplicate_count: 1,
        last_observed_at: '2026-04-10T10:30:00.000Z'
      }
    ],
    ticket_references: [],
    operator_actions: [],
    blocked_input_events: [],
    app_server_events: [
      {
        app_server_event_id: 'app-event-1',
        issue_run_id: 'issue-run-1',
        attempt_id: 'attempt-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        observed_at: '2026-04-10T10:25:00.000Z',
        policy_version: 1,
        payload_class: 'protocol_lifecycle',
        detail_status: 'summary_only',
        redaction_status: 'not_required',
        source_event_id: 'event-1',
        source_event_name: 'thread/tokenUsage/updated',
        summary: 'token update',
        summary_fields: { total_tokens: 42 },
        redacted_excerpt: null,
        truncation: { truncated: false, original_bytes: 24, excerpt_bytes: 24, max_excerpt_bytes: 4096 },
        unavailable_reason_code: null,
        full_payload_stored: false
      }
    ],
    token_model_facts: [
      {
        token_model_fact_id: 'token-1',
        issue_run_id: 'issue-run-1',
        attempt_id: 'attempt-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        requested_model: 'gpt-5.4',
        effective_model: 'gpt-5.4',
        model_source: 'terminal_turn_summary',
        input_tokens: 20,
        output_tokens: 22,
        cached_input_tokens: null,
        reasoning_output_tokens: null,
        total_tokens: 42,
        model_context_window: null,
        telemetry_confidence: 'observed_live',
        observed_at: '2026-04-10T10:25:00.000Z'
      }
    ],
    ...overrides
  };
}

describe('Project History consumer summary', () => {
  it('projects compact read-only facts for a normal ticket', () => {
    const summary = buildProjectHistoryConsumerSummaryResponse(timeline());

    expect(summary.schema_version).toBe('symphony.project_history.consumer_summary.v1');
    expect(summary.read_only).toBe(true);
    expect(summary.deferred_capabilities).toEqual(['validation_reuse', 'phase_handoff_packets', 'drain_mode', 'operator_steering']);
    expect(summary.current_ticket_state).toMatchObject({ state: 'completed', current_status: 'Agent Review' });
    expect(summary.attempts).toMatchObject({ total: 1, repeated: false });
    expect(summary.recent_phases[0]).toMatchObject({ phase: 'implementation', status: 'succeeded' });
    expect(summary.blockers).toMatchObject({ active_count: 0, resolved_count: 1 });
    expect(summary.token_model).toMatchObject({
      status: 'present',
      total_tokens: 42,
      requested_models: ['gpt-5.4'],
      effective_models: ['gpt-5.4']
    });
    expect(summary.app_server_lite).toMatchObject({ status: 'present' });
    expect(summary.evidence_references[0]).toMatchObject({ evidence_kind: 'validation', uri: 'file://validation.txt' });
  });

  it('marks repeated attempts and returns newest attempts first', () => {
    const summary = buildProjectHistoryConsumerSummaryResponse(
      timeline({
        attempts: [
          {
            attempt_id: 'attempt-1',
            issue_run_id: 'issue-run-1',
            attempt_number: 1,
            started_at: '2026-04-10T10:00:01.000Z',
            ended_at: '2026-04-10T10:10:00.000Z',
            status: 'failed',
            reason_code: 'worker_exit_abnormal',
            reason_detail: null
          },
          {
            attempt_id: 'attempt-2',
            issue_run_id: 'issue-run-1',
            attempt_number: 2,
            started_at: '2026-04-10T10:11:00.000Z',
            ended_at: null,
            status: 'running',
            reason_code: 'attempt_started',
            reason_detail: null
          }
        ]
      })
    );

    expect(summary.attempts).toMatchObject({
      total: 2,
      repeated: true,
      latest: { attempt_id: 'attempt-2', attempt_number: 2, status: 'running' }
    });
    expect(summary.attempts.recent.map((attempt) => attempt.attempt_id)).toEqual(['attempt-2', 'attempt-1']);
  });

  it('surfaces degraded history health without hiding available facts', () => {
    const summary = buildProjectHistoryConsumerSummaryResponse(timeline(), {
      schema_name: 'project_execution_history',
      target_version: 6,
      applied_version: 6,
      status: 'degraded',
      degraded_reason_code: 'history_write_failed',
      degraded_detail: 'appendTicketTerminalOutcome failed',
      updated_at: '2026-04-10T10:31:00.000Z',
      migrations: []
    });

    expect(summary.current_ticket_state.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fact: 'history_schema',
          status: 'degraded',
          reason_code: 'history_write_failed'
        }),
        expect.objectContaining({ fact: 'token_model_summaries', status: 'present' })
      ])
    );
  });

  it('marks optional app-server-lite and token facts as missing', () => {
    const summary = buildProjectHistoryConsumerSummaryResponse(
      timeline({
        app_server_events: [],
        token_model_facts: []
      })
    );

    expect(summary.token_model).toMatchObject({
      status: 'missing',
      total_tokens: null,
      requested_models: [],
      effective_models: [],
      telemetry_confidences: [],
      recent: []
    });
    expect(summary.app_server_lite).toEqual({ status: 'missing', excerpts: [] });
    expect(summary.current_ticket_state.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fact: 'token_model_summaries',
          status: 'missing',
          reason_code: 'project_history_token_model_summaries_missing'
        }),
        expect.objectContaining({
          fact: 'app_server_lite_summaries',
          status: 'missing',
          reason_code: 'project_history_app_server_lite_summaries_missing'
        })
      ])
    );
  });
});
