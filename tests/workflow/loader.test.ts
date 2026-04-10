import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { WorkflowConfigError } from '../../src/workflow/errors';
import { WorkflowLoader } from '../../src/workflow/loader';
import { createTempDir, writeWorkflowFile } from './helpers';

describe('WorkflowLoader', () => {
  it('prefers explicit path over cwd default', () => {
    const loader = new WorkflowLoader();
    const temp = createTempDir('wf-loader-');
    const explicit = path.join(temp, 'custom-workflow.md');
    fs.writeFileSync(explicit, 'hello', 'utf8');

    const resolved = loader.resolvePath({ explicitPath: explicit, cwd: '/unused' });
    expect(resolved).toBe(explicit);
  });

  it('uses WORKFLOW.md in cwd by default', () => {
    const loader = new WorkflowLoader();
    const resolved = loader.resolvePath({ cwd: '/tmp/example' });
    expect(resolved).toBe('/tmp/example/WORKFLOW.md');
  });

  it('parses YAML front matter and prompt body', () => {
    const loader = new WorkflowLoader();
    const definition = loader.parse('---\ntracker:\n  kind: linear\n---\n\nPrompt body\n');

    expect(definition.config).toEqual({ tracker: { kind: 'linear' } });
    expect(definition.prompt_template).toBe('Prompt body');
  });

  it('supports files without YAML front matter', () => {
    const loader = new WorkflowLoader();
    const definition = loader.parse('plain prompt');

    expect(definition.config).toEqual({});
    expect(definition.prompt_template).toBe('plain prompt');
  });

  it('rejects non-map front matter payload', () => {
    const loader = new WorkflowLoader();

    expect(() => loader.parse('---\n- one\n- two\n---\nbody')).toThrowError(WorkflowConfigError);

    try {
      loader.parse('---\n- one\n- two\n---\nbody');
    } catch (error) {
      expect((error as WorkflowConfigError).code).toBe('workflow_front_matter_not_a_map');
    }
  });

  it('returns typed missing file error when workflow is not readable', () => {
    const loader = new WorkflowLoader();
    const temp = createTempDir('wf-loader-missing-');

    expect(() => loader.load({ explicitPath: path.join(temp, 'missing.md') })).toThrowError(
      WorkflowConfigError
    );

    try {
      loader.load({ explicitPath: path.join(temp, 'missing.md') });
    } catch (error) {
      expect((error as WorkflowConfigError).code).toBe('missing_workflow_file');
    }
  });

  it('loads from disk using default cwd path', () => {
    const loader = new WorkflowLoader();
    const temp = createTempDir('wf-loader-load-');
    writeWorkflowFile(temp, '---\ntracker:\n  kind: linear\n---\nhello');

    const definition = loader.load({ cwd: temp });
    expect(definition.prompt_template).toBe('hello');
  });
});
