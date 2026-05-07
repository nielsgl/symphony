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

  it('keeps Agent Review active only through handoff and fresh-dispatch config', () => {
    const workflowPath = path.join(process.cwd(), 'WORKFLOW.md');
    const workflow = readFileSync(workflowPath, 'utf8');
    const parsed = parseWorkflowFrontMatter(workflow);

    const tracker = parsed.config.tracker as {
      active_states?: unknown;
      handoff_states?: unknown;
      fresh_dispatch_states?: unknown;
    };

    expect(tracker.active_states).toEqual(['Todo', 'In Progress', 'Agent Review', 'Merging', 'Rework']);
    expect(tracker.handoff_states).toEqual(['Agent Review', 'Human Review']);
    expect(tracker.fresh_dispatch_states).toEqual(['Agent Review']);
    expect(tracker.active_states).not.toContain('Human Review');
    expect(workflow).toContain(
      '`Agent Review` is in `active_states` only with the paired `handoff_states` and `fresh_dispatch_states` entries'
    );
    expect(workflow).toContain(
      'The implementation worker must stop after moving the issue to `Agent Review`'
    );
    expect(workflow).toContain(
      '`Agent Review` -> run Step 3 Agent Review flow in this fresh review context'
    );
    expect(workflow).toContain(
      'If this run authored the implementation being reviewed, stop and leave the issue in `Agent Review`'
    );
    expect(workflow).toContain('Move issue from `Agent Review` to `In Progress`');
    expect(workflow).toContain('Move issue from `Agent Review` to `Rework`');
    expect(workflow).toContain('Routing: Human Review');
    expect(workflow).toContain('Routing: Merging');
  });

  it('keeps SPEC.ext.md aligned with implemented handoff runtime semantics', () => {
    const specPath = path.join(process.cwd(), 'SPEC.ext.md');
    const spec = readFileSync(specPath, 'utf8');

    expect(spec).toContain('Status: v1 reference extension');
    expect(spec).toContain('## 5. Dispatch and Reconciliation Implications');
    expect(spec).toContain('### 5.1 Local Worker State-Refresh Order');
    expect(spec).toContain('### 5.2 Orchestrator Dispatch and Retry Semantics');
    expect(spec).toContain('### 5.3 Reconciliation and Cleanup Separation');
    expect(spec).toContain('## 9. Implementation and Test Evidence');
    expect(spec).toContain('src/orchestrator/local-worker-runner.ts');
    expect(spec).toContain('tests/orchestrator/core.test.ts');
    expect(spec).not.toContain('Runtime stop, resume, and fresh-dispatch behavior is implemented by later slices');
    expect(spec).not.toContain('The following runtime behaviors are intentionally deferred');
  });
});
