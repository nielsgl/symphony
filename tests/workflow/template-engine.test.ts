import { describe, expect, it } from 'vitest';

import { WorkflowConfigError } from '../../src/workflow/errors';
import { TemplateEngine } from '../../src/workflow/template-engine';

describe('TemplateEngine', () => {
  it('renders issue and attempt inputs', async () => {
    const engine = new TemplateEngine();
    const template = engine.compile('Issue {{ issue.identifier }} attempt {{ attempt }}');

    const output = await template.render({
      issue: { identifier: 'ABC-123' },
      attempt: 2
    });

    expect(output).toBe('Issue ABC-123 attempt 2');
  });

  it('fails render on unknown variable in strict mode', async () => {
    const engine = new TemplateEngine();
    const template = engine.compile('Hello {{ issue.identifier }} {{ issue.nope }}');

    await expect(
      template.render({ issue: { identifier: 'ABC-123' }, attempt: null })
    ).rejects.toMatchObject({
      code: 'template_render_error'
    } satisfies Partial<WorkflowConfigError>);
  });

  it('fails on unknown filter in strict mode', async () => {
    const engine = new TemplateEngine();
    expect(() => engine.compile('{{ issue.identifier | unknown_filter }}')).toThrowError(
      WorkflowConfigError
    );
  });

  it('fails compile for invalid template syntax', () => {
    const engine = new TemplateEngine();

    expect(() => engine.compile('{% if issue.identifier %}missing endif')).toThrowError(
      WorkflowConfigError
    );
  });
});
