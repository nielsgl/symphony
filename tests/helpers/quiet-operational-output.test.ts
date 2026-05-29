import { describe, expect, it } from 'vitest';

import { operationalCommandStdio, shouldShowOperationalTestOutput } from './quiet-operational-output';

describe('quiet operational test output helpers', () => {
  it('pipes routine child-process stderr by default during tests', () => {
    expect(shouldShowOperationalTestOutput({})).toBe(false);
    expect(operationalCommandStdio({})).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('keeps an opt-in verbose path for debugging operational child output', () => {
    expect(shouldShowOperationalTestOutput({ SYMPHONY_TEST_OPERATIONAL_OUTPUT: '1' })).toBe(true);
    expect(shouldShowOperationalTestOutput({ SYMPHONY_TEST_LOGS: 'stderr' })).toBe(true);
    expect(operationalCommandStdio({ SYMPHONY_TEST_OPERATIONAL_OUTPUT: '1' })).toEqual([
      'ignore',
      'pipe',
      'inherit'
    ]);
  });
});
