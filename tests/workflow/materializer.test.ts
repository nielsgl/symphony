import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { materializeWorkflowDryRun } from '../../src/workflow/materializer';
import { resolveProfileSelection } from '../../src/workflow/profile-registry';
import { ConfigResolver } from '../../src/workflow/resolver';
import { ConfigValidator } from '../../src/workflow/validator';
import { WorkflowLoader } from '../../src/workflow/loader';

describe('workflow materializer', () => {
  it('returns an ordered dry-run file plan with a parser-valid generated workflow', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-materializer-')));
    const resolution = resolveProfileSelection(['memory-generic']);
    const plan = materializeWorkflowDryRun({
      resolution,
      projectFacts: { root, packageManager: 'generic', existingWorkflowPath: null },
      choices: { dryRun: true, selections: ['memory-generic'] },
      clock: () => new Date('2026-05-25T12:00:00.000Z')
    });

    expect(plan.files.map((file) => file.path)).toEqual(['WORKFLOW.md', path.join('.symphony', 'system', '.gitignore')]);
    expect(plan.files[0]).toMatchObject({
      action: 'create',
      overwriteStatus: 'absent',
      wouldWrite: false
    });
    expect(plan.files[0].content).toContain('symphony-generated-profile');
    expect(plan.files[0].content).toContain('bundle_provenance=memory-generic->tracker:memory,workspace:none,toolchain:generic,workflow:solo-local');
    expect(plan.files[0].content).toContain('- Project root: .');
    expect(plan.files[0].content).not.toContain(`- Project root: ${root}`);
    expect(plan.validation).toMatchObject({ ok: true });

    const definition = new WorkflowLoader().parse(plan.files[0].content ?? '');
    const effective = new ConfigResolver({ env: {}, homedir: () => root }).resolve(definition, {
      workflowPath: path.join(root, 'WORKFLOW.md')
    });

    expect(new ConfigValidator().validate(effective)).toMatchObject({ ok: true });
    expect(effective.tracker.kind).toBe('memory');
    expect(effective.workspace.provisioner.type).toBe('none');
  });

  it('marks existing workflow files as overwrites without writing them', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-materializer-existing-')));
    fs.writeFileSync(path.join(root, 'WORKFLOW.md'), 'existing workflow\n', 'utf8');
    const resolution = resolveProfileSelection([
      'tracker:memory',
      'workspace:none',
      'toolchain:generic',
      'workflow:solo-local'
    ]);

    const plan = materializeWorkflowDryRun({
      resolution,
      projectFacts: { root, packageManager: null, existingWorkflowPath: path.join(root, 'WORKFLOW.md') },
      choices: {
        dryRun: true,
        selections: ['tracker:memory', 'workspace:none', 'toolchain:generic', 'workflow:solo-local']
      }
    });

    expect(plan.files[0]).toMatchObject({
      path: 'WORKFLOW.md',
      action: 'overwrite',
      overwriteStatus: 'exists',
      wouldWrite: false
    });
    expect(fs.readFileSync(path.join(root, 'WORKFLOW.md'), 'utf8')).toBe('existing workflow\n');
  });
});
