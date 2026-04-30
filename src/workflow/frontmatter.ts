import YAML from 'js-yaml';

import { WorkflowConfigError } from './errors';

export interface ParsedWorkflowFrontMatter {
  config: Record<string, unknown>;
  promptTemplate: string;
}

export function parseWorkflowFrontMatter(content: string): ParsedWorkflowFrontMatter {
  if (!content.startsWith('---')) {
    return {
      config: {},
      promptTemplate: content.trim()
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
    promptTemplate: promptBody.trim()
  };
}
