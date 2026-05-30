import { describe, expect, it } from 'vitest';

import { buildAgentConversationProjection } from '../../src/api/agent-conversation';
import { CANONICAL_EVENT } from '../../src/observability/events';
import type { DurableRunHistoryRecord } from '../../src/persistence';
import { makeRunningEntry, makeState } from './server-test-harness';

describe('agent conversation projection', () => {
  it('merges bounded runtime, app-server ledger, and thread lineage evidence', () => {
    const startedAt = Date.parse('2026-05-30T10:00:00.000Z');
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            identifier: 'NIE-300',
            thread_id: 'thread-live',
            turn_id: 'turn-live',
            session_id: 'session-live',
            started_at_ms: startedAt,
            last_codex_timestamp_ms: startedAt + 5_000,
            last_message: 'runtime assistant latest',
            pending_input_preview: {
              type: 'text',
              prompt_preview: 'operator user prompt',
              option_count: null
            },
            awaiting_input_since_ms: startedAt + 4_000,
            recent_events: [
              {
                at_ms: startedAt + 1_000,
                event: CANONICAL_EVENT.codex.turnStarted,
                message: 'assistant started'
              },
              {
                at_ms: startedAt + 2_000,
                event: CANONICAL_EVENT.codex.toolCallStarted,
                message: 'linear lookup',
                tool_name: 'linear_graphql',
                tool_call_id: 'call-1'
              }
            ]
          })
        ]
      ])
    });
    const runHistory: DurableRunHistoryRecord[] = [
      {
        run_id: 'run-history',
        issue_id: 'issue-1',
        issue_identifier: 'NIE-300',
        identity: null,
        identity_projection: null,
        started_at: '2026-05-30T09:59:00.000Z',
        ended_at: null,
        completed_at: null,
        terminal_status: null,
        error_code: null,
        terminal_reason_code: null,
        terminal_reason_detail: null,
        root_cause_status: null,
        root_cause_reason_code: null,
        root_cause_reason_detail: null,
        root_cause_at: null,
        session_id: 'session-history',
        thread_id: 'thread-history',
        turn_id: 'turn-history',
        session_ids: [],
        app_server_events: [
          {
            app_server_event_id: 'event-1',
            issue_run_id: 'issue-run-1',
            attempt_id: 'attempt-1',
            thread_id: 'thread-history',
            turn_id: 'turn-history',
            observed_at: '2026-05-30T09:59:30.000Z',
            payload_class: 'assistant_text',
            detail_status: 'summary_only',
            redaction_status: 'redacted',
            source_event_id: 'source-1',
            source_event_name: 'assistant_text.delta',
            summary: 'persisted assistant message',
            summary_fields: {},
            redacted_excerpt: null,
            truncation: {
              truncated: false,
              original_bytes: 0,
              excerpt_bytes: 0,
              max_excerpt_bytes: 512
            },
            unavailable_reason_code: null,
            full_payload_stored: false,
            policy_version: 1
          }
        ],
        missing_tool_output_recovery: null,
        token_model_facts: []
      }
    ];

    const projection = buildAgentConversationProjection({
      state,
      issueIdentifier: 'NIE-300',
      runHistory,
      lineage: {
        issue_run: {
          issue_run_id: 'issue-run-1',
          issue_id: 'issue-1',
          issue_identifier: 'NIE-300',
          identity: null,
          started_at: '2026-05-30T09:59:00.000Z',
          ended_at: null,
          status: 'running',
          reason_code: null,
          reason_detail: null
        },
        attempt: {
          attempt_id: 'attempt-1',
          issue_run_id: 'issue-run-1',
          attempt_number: 0,
          started_at: '2026-05-30T09:59:01.000Z',
          ended_at: null,
          status: 'running',
          reason_code: null,
          reason_detail: null
        },
        thread: {
          thread_id: 'thread-history',
          attempt_id: 'attempt-1',
          started_at: '2026-05-30T09:59:02.000Z',
          ended_at: null,
          status: 'running',
          reason_code: null,
          reason_detail: null
        },
        turns: [],
        state_transitions: [
          {
            state_transition_id: 'transition-1',
            issue_run_id: 'issue-run-1',
            attempt_id: 'attempt-1',
            thread_id: 'thread-history',
            turn_id: null,
            from_status: 'Backlog',
            to_status: 'In Progress',
            transitioned_at: '2026-05-30T09:59:05.000Z',
            status: 'running',
            reason_code: 'claimed',
            reason_detail: 'agent claimed work'
          }
        ],
        token_model_facts: []
      }
    });

    expect(projection.metadata.sources).toEqual(['app_server_ledger', 'runtime_event', 'thread_diagnostics']);
    expect(projection.metadata.role_counts.assistant).toBeGreaterThanOrEqual(2);
    expect(projection.metadata.role_counts.tool).toBe(1);
    expect(projection.metadata.role_counts.user).toBe(1);
    expect(projection.latest.summary).toBe('runtime assistant latest');
    expect(projection.messages.map((message) => message.content)).toContain('persisted assistant message');
    expect(projection.messages.map((message) => message.content)).toContain('agent claimed work');
  });

  it('truncates and bounds payloads deterministically', () => {
    const longMessage = 'x'.repeat(800);
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            identifier: 'NIE-300',
            recent_events: Array.from({ length: 4 }, (_value, index) => ({
              at_ms: Date.parse('2026-05-30T10:00:00.000Z') + index,
              event: CANONICAL_EVENT.codex.turnCompleted,
              message: index === 3 ? longMessage : `message-${index}`
            }))
          })
        ]
      ])
    });

    const projection = buildAgentConversationProjection({
      state,
      issueIdentifier: 'NIE-300',
      limit: 2,
      messageMaxChars: 120
    });

    expect(projection.messages).toHaveLength(2);
    expect(projection.metadata.truncated).toBe(true);
    expect(projection.messages.at(-1)?.content.length).toBeLessThanOrEqual(120);
    expect(projection.messages.at(-1)?.truncated).toBe(true);
  });
});
