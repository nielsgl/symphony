import fs from 'node:fs';
import path from 'node:path';

import { WorkflowConfigError } from './errors';
import { parseWorkflowFrontMatter } from './frontmatter';
import type { WorkflowDefinition } from './types';

export const DEFAULT_PROMPT_TEMPLATE = [
  'You are Symphony working on issue {{ issue.identifier }} (attempt {{ attempt }}).',
  '',
  'Title: {{ issue.title }}',
  'Description: {{ issue.description }}',
  '',
  'Implement the smallest correct change, run relevant tests, and summarize results.'
].join('\n');

export interface WorkflowLoaderInput {
  explicitPath?: string;
  cwd?: string;
}

export class WorkflowLoader {
  resolvePath(input: WorkflowLoaderInput = {}): string {
    if (input.explicitPath && input.explicitPath.trim().length > 0) {
      return input.explicitPath;
    }

    return path.join(input.cwd ?? process.cwd(), 'WORKFLOW.md');
  }

  load(input: WorkflowLoaderInput = {}): WorkflowDefinition {
    const workflowPath = this.resolvePath(input);

    let content: string;
    try {
      content = fs.readFileSync(workflowPath, 'utf8');
    } catch {
      throw new WorkflowConfigError(
        'missing_workflow_file',
        `workflow file is not readable at ${workflowPath}`
      );
    }

    return this.parse(content);
  }

  parse(content: string): WorkflowDefinition {
    const parsed = parseWorkflowFrontMatter(content);

    return {
      config: parsed.config,
      prompt_template: parsed.promptTemplate.length > 0 ? parsed.promptTemplate : DEFAULT_PROMPT_TEMPLATE
    };
  }
}
