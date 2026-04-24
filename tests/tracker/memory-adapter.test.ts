import { describe, expect, it } from 'vitest';

import { MemoryTrackerAdapter } from '../../src/tracker/memory-adapter';
import type { Issue } from '../../src/tracker/types';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    identifier: 'MEM-1',
    title: 'Memory issue',
    description: null,
    priority: null,
    state: 'Todo',
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides
  };
}

describe('MemoryTrackerAdapter', () => {
  it('filters candidates by active state', async () => {
    const adapter = new MemoryTrackerAdapter({
      activeStates: ['Todo'],
      seedIssues: [makeIssue({ id: 'a', state: 'Todo' }), makeIssue({ id: 'b', state: 'Done' })]
    });

    const issues = await adapter.fetch_candidate_issues();
    expect(issues.map((issue) => issue.id)).toEqual(['a']);
  });

  it('supports state updates and subsequent state fetches', async () => {
    const adapter = new MemoryTrackerAdapter({
      activeStates: ['Todo'],
      seedIssues: [makeIssue({ id: 'a', state: 'Todo' })]
    });

    await adapter.update_issue_state('a', 'Done');
    const issues = await adapter.fetch_issue_states_by_ids(['a']);

    expect(issues).toHaveLength(1);
    expect(issues[0].state).toBe('Done');
  });

  it('accepts comments without mutating issue selection behavior', async () => {
    const adapter = new MemoryTrackerAdapter({
      activeStates: ['Todo'],
      seedIssues: [makeIssue({ id: 'a', state: 'Todo' })]
    });

    await expect(adapter.create_comment('a', 'first comment')).resolves.toBeUndefined();
    const issues = await adapter.fetch_candidate_issues();
    expect(issues).toHaveLength(1);
    expect(issues[0].id).toBe('a');
  });
});
