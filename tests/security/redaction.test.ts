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
});
