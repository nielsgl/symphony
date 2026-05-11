import { describe, expect, it } from 'vitest';

import { buildHistoryPayloadDetails, HISTORY_PAYLOAD_EXCERPT_MAX_BYTES } from '../../src/persistence/history-payload-policy';

describe('history payload policy', () => {
  it('builds bounded redacted excerpts with truncation metadata', () => {
    const details = buildHistoryPayloadDetails({
      payloadClass: 'protocol_request_response',
      sourceEventId: 'event-1',
      sourceEventName: 'rawResponseItem/completed',
      rawPayload: {
        cwd: '/Users/alice/private/project',
        authorization: 'Bearer secret-token',
        body: `token=abcd ${'x'.repeat(HISTORY_PAYLOAD_EXCERPT_MAX_BYTES)}`
      },
      summary: 'response completed from /Users/alice/private/project'
    });

    expect(details).toMatchObject({
      payload_class: 'protocol_request_response',
      detail_status: 'redacted_truncated_excerpt',
      redaction_status: 'redacted',
      source_event_id: 'event-1',
      source_event_name: 'rawResponseItem/completed',
      full_payload_stored: false
    });
    expect(details.summary).toContain('***REDACTED_PATH***');
    expect(details.redacted_excerpt).not.toContain('/Users/alice');
    expect(details.redacted_excerpt).not.toContain('secret-token');
    expect(details.redacted_excerpt).not.toContain('abcd');
    expect(details.truncation.truncated).toBe(true);
    expect(details.truncation.excerpt_bytes).toBeLessThanOrEqual(HISTORY_PAYLOAD_EXCERPT_MAX_BYTES);
  });

  it('removes bearer credentials from free-form persisted excerpts', () => {
    const details = buildHistoryPayloadDetails({
      payloadClass: 'command_output',
      sourceEventId: 'event-bearer',
      sourceEventName: 'exec_command/output',
      rawPayload:
        'request failed with Authorization: Bearer sk-live-secret-value and retry used bearer ghp_another-secret',
      summary: 'command failed after authenticated request'
    });

    expect(details).toMatchObject({
      detail_status: 'redacted_excerpt',
      redaction_status: 'redacted',
      full_payload_stored: false
    });
    expect(details.redacted_excerpt).toContain('***REDACTED***');
    expect(details.redacted_excerpt).not.toContain('sk-live-secret-value');
    expect(details.redacted_excerpt).not.toContain('ghp_another-secret');
  });

  it('keeps transcript and tool payload details unavailable by policy', () => {
    const transcript = buildHistoryPayloadDetails({
      payloadClass: 'conversation_transcript',
      sourceEventId: 'event-transcript',
      sourceEventName: 'thread/realtime/transcript/delta',
      rawPayload: 'full transcript token=do-not-store',
      summary: 'transcript delta observed'
    });
    const tool = buildHistoryPayloadDetails({
      payloadClass: 'tool_payload',
      sourceEventId: 'event-tool',
      sourceEventName: 'item/mcpToolCall/progress',
      rawPayload: { tool: 'linear_graphql', variables: { api_key: 'do-not-store' } },
      summaryFields: { tool_name: 'linear_graphql' }
    });

    expect(transcript).toMatchObject({
      detail_status: 'unavailable_policy',
      redaction_status: 'unavailable_policy',
      redacted_excerpt: null,
      unavailable_reason_code: 'conversation_transcript_payload_not_stored',
      full_payload_stored: false
    });
    expect(JSON.stringify(transcript)).not.toContain('do-not-store');
    expect(tool).toMatchObject({
      detail_status: 'unavailable_policy',
      unavailable_reason_code: 'tool_payload_payload_not_stored',
      summary_fields: { tool_name: 'linear_graphql' }
    });
    expect(JSON.stringify(tool)).not.toContain('api_key');
  });

  it('distinguishes absent and summary-only payload details', () => {
    expect(
      buildHistoryPayloadDetails({
        payloadClass: 'protocol_lifecycle',
        sourceEventId: 'event-empty',
        sourceEventName: 'thread/started'
      })
    ).toMatchObject({
      detail_status: 'absent',
      redaction_status: 'not_required'
    });

    expect(
      buildHistoryPayloadDetails({
        payloadClass: 'assistant_text',
        sourceEventId: 'event-summary',
        sourceEventName: 'item/agentMessage/delta',
        rawPayload: 'large assistant text is intentionally not stored',
        summary: 'assistant text delta observed'
      })
    ).toMatchObject({
      detail_status: 'summary_only',
      redacted_excerpt: null,
      full_payload_stored: false
    });
  });
});
