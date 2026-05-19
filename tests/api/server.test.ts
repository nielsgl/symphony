import { describe, expect, it } from 'vitest';

describe('LocalApiServer split suite', () => {
  it('keeps the legacy server.test.ts entrypoint as a compatibility marker', () => {
    expect(true).toBe(true);
  });
});
