import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseWorkflowFrontMatter } from '../../src/workflow/frontmatter';

describe('workflow command examples', () => {
  it('uses typed model selection instead of shell-interpolated codex app-server commands', () => {
    const workflowPath = path.join(process.cwd(), 'WORKFLOW.md');
    const workflow = readFileSync(workflowPath, 'utf8');

    expect(workflow).not.toMatch(/--model\s+\S+\s+app-server/);
    expect(workflow).not.toMatch(/CODEX_HOME=.*codex .*app-server/);
    expect(workflow).toMatch(/codex:\n(?:  .+\n)*  model: [^\s]+\n/);
    expect(workflow).toMatch(/  reasoning_effort: medium\n/);
  });

  it('keeps review handoff states out of implementation active states', () => {
    const workflowPath = path.join(process.cwd(), 'WORKFLOW.md');
    const workflow = readFileSync(workflowPath, 'utf8');
    const parsed = parseWorkflowFrontMatter(workflow);

    const tracker = parsed.config.tracker as { active_states?: unknown };

    expect(tracker.active_states).toEqual(['Todo', 'In Progress', 'Merging', 'Rework']);
    expect(tracker.active_states).not.toContain('Agent Review');
    expect(tracker.active_states).not.toContain('Human Review');
    expect(workflow).toContain('`Agent Review` is intentionally not in `active_states`');
  });
});
