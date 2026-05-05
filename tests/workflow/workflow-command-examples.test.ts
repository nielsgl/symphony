import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('workflow command examples', () => {
  it('uses typed model selection instead of shell-interpolated codex app-server commands', () => {
    const workflowPath = path.join(process.cwd(), 'WORKFLOW.md');
    const workflow = readFileSync(workflowPath, 'utf8');

    expect(workflow).not.toMatch(/--model\s+\S+\s+app-server/);
    expect(workflow).not.toMatch(/CODEX_HOME=.*codex .*app-server/);
    expect(workflow).toMatch(/codex:\n(?:  .+\n)*  model: [^\s]+\n/);
    expect(workflow).toMatch(/  reasoning_effort: medium\n/);
  });
});
