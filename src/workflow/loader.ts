import fs from 'node:fs';
import path from 'node:path';
import YAML from 'js-yaml';

import { WorkflowConfigError } from './errors';
import type { WorkflowDefinition } from './types';

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
    if (!content.startsWith('---')) {
      return {
        config: {},
        prompt_template: content.trim()
      };
    }

    const normalized = content.replace(/\r\n/g, '\n');
    const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

    if (!match) {
      throw new WorkflowConfigError(
        'workflow_parse_error',
        'workflow front matter is not closed with a second --- delimiter'
      );
    }

    const [, rawFrontMatter, promptBody] = match;

    let parsed: unknown;
    try {
      parsed = YAML.load(rawFrontMatter);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown YAML parse failure';
      throw new WorkflowConfigError('workflow_parse_error', message);
    }

    if (parsed == null) {
      parsed = {};
    }

    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new WorkflowConfigError(
        'workflow_front_matter_not_a_map',
        'workflow front matter must decode to a map/object'
      );
    }

    return {
      config: parsed as Record<string, unknown>,
      prompt_template: promptBody.trim()
    };
  }
}
