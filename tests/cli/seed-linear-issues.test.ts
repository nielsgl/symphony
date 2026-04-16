import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const seedLinear = require('../../scripts/seed-linear-issues.js') as {
  parseArgs: (argv: string[]) => {
    input: string;
    projectSlug?: string;
    teamKey?: string;
    apply: boolean;
    strict: boolean;
  };
  stateIdByName: (states: Array<{ id: string; name: string }>, stateName: string) => string | null;
  validateSeedItem: (item: unknown, index: number) => string[];
  buildIssueInput: (
    seedItem: { title: string; description: string; priority?: number },
    context: { teamId: string; projectId: string },
    stateId: string
  ) => {
    teamId: string;
    projectId: string;
    stateId: string;
    title: string;
    description: string;
    priority?: number;
  };
};

describe('seed linear issues helpers', () => {
  it('parses CLI args for apply and strict modes', () => {
    const parsed = seedLinear.parseArgs([
      '--input=fixtures.json',
      '--project-slug=SYMPHONY',
      '--team-key=SYM',
      '--apply',
      '--strict'
    ]);

    expect(parsed.input).toBe('fixtures.json');
    expect(parsed.projectSlug).toBe('SYMPHONY');
    expect(parsed.teamKey).toBe('SYM');
    expect(parsed.apply).toBe(true);
    expect(parsed.strict).toBe(true);
  });

  it('maps state names case-insensitively', () => {
    const states = [
      { id: 'state_1', name: 'Todo' },
      { id: 'state_2', name: 'In Progress' }
    ];

    expect(seedLinear.stateIdByName(states, 'todo')).toBe('state_1');
    expect(seedLinear.stateIdByName(states, 'IN PROGRESS')).toBe('state_2');
    expect(seedLinear.stateIdByName(states, 'Done')).toBeNull();
  });

  it('validates required seed fields', () => {
    const errors = seedLinear.validateSeedItem(
      {
        identifier: '',
        title: '',
        description: '',
        state: ''
      },
      0
    );

    expect(errors.length).toBe(4);
    expect(errors.join(' ')).toContain('missing identifier');
    expect(errors.join(' ')).toContain('missing title');
    expect(errors.join(' ')).toContain('missing description');
    expect(errors.join(' ')).toContain('missing state');
  });

  it('builds issue input payload including optional priority', () => {
    const input = seedLinear.buildIssueInput(
      {
        title: 'Implement endpoint',
        description: 'Add a new API endpoint',
        priority: 2
      },
      {
        teamId: 'team_1',
        projectId: 'project_1'
      },
      'state_todo'
    );

    expect(input.teamId).toBe('team_1');
    expect(input.projectId).toBe('project_1');
    expect(input.stateId).toBe('state_todo');
    expect(input.title).toBe('Implement endpoint');
    expect(input.description).toBe('Add a new API endpoint');
    expect(input.priority).toBe(2);
  });
});
