import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('workflow command examples', () => {
  it('uses config-based model selection for codex app-server commands', () => {
    const workflowPath = path.join(process.cwd(), 'WORKFLOW.md');
    const workflow = readFileSync(workflowPath, 'utf8');

    expect(workflow).not.toMatch(/--model\s+\S+\s+app-server/);
    expect(workflow).toMatch(/--config\s+'model=\"[^\"]+\"'\s+.*app-server/);
  });
});
