import { describe, expect, it } from 'vitest';

const { normalizeMarkdownBody, assertHumanReadableMarkdownBody } = require('../../scripts/lib/markdown-body.js');

describe('markdown body normalization', () => {
  it('normalizes escaped newline sequences into markdown line breaks', () => {
    const normalized = normalizeMarkdownBody('## Summary\\n- one\\n- two');
    expect(normalized).toBe('## Summary\n- one\n- two');
  });

  it('rejects double-escaped malformed payloads', () => {
    expect(() => assertHumanReadableMarkdownBody('## Summary\\\\n- one')).toThrow(
      'pr_body_escaped_newlines: body contains escaped newline sequences; normalize before submit'
    );
  });

  it('preserves markdown code fences during normalization', () => {
    const raw = '```bash\\necho test\\n```\\nDone';
    const normalized = normalizeMarkdownBody(raw);
    expect(normalized).toBe('```bash\necho test\n```\nDone');
  });
});
