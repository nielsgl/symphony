import { describe, expect, it } from 'vitest';

import { REDACTED, redactLogInput, redactUnknown } from '../../src/security/redaction';

describe('secret redaction', () => {
  it('redacts sensitive context keys and inline message secrets', () => {
    const redacted = redactLogInput({
      message: 'request failed token=abcd1234',
      context: {
        issue_id: 'i-1',
        api_key: 'super-secret-key'
      }
    });

    expect(redacted.message).not.toContain('abcd1234');
    expect(redacted.message).toContain(REDACTED);
    expect(redacted.context.api_key).toBe(REDACTED);
    expect(redacted.context.issue_id).toBe('i-1');
  });

  it('recursively redacts nested API/persistence payloads', () => {
    const payload = {
      health: { ok: true },
      tracker: { authorization: 'Bearer top-secret-token' },
      runs: [{ error_code: 'token=abcdef' }]
    };

    const redacted = redactUnknown(payload) as {
      tracker: { authorization: string };
      runs: Array<{ error_code: string }>;
    };

    expect(redacted.tracker.authorization).toBe(REDACTED);
    expect(redacted.runs[0].error_code).toContain(REDACTED);
  });

  it('preserves telemetry token counters that are not secrets', () => {
    const payload = {
      tokens: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15
      }
    };

    const redacted = redactUnknown(payload) as {
      tokens: { input_tokens: number; output_tokens: number; total_tokens: number };
    };

    expect(redacted.tokens.input_tokens).toBe(10);
    expect(redacted.tokens.output_tokens).toBe(5);
    expect(redacted.tokens.total_tokens).toBe(15);
  });
});
