import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { materializeWorkflowDryRun, materializeWorkflowPlan } from '../../src/workflow/materializer';
import { resolveProfileSelection } from '../../src/workflow/profile-registry';
import { ConfigResolver } from '../../src/workflow/resolver';
import { ConfigValidator } from '../../src/workflow/validator';
import { WorkflowLoader } from '../../src/workflow/loader';

const FORBIDDEN_INTERNAL_OUTPUT_TERMS = [
  'Agent Review',
  'Merging',
  'Human Review',
  'Codex Workpad',
  'workflow:symphony-internal',
  'self-hosting',
  'handoff'
];

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

    expect(plan.files.map((file) => file.path)).toEqual([
      'WORKFLOW.md',
      path.join('.symphony', 'system', '.gitignore'),
      '.gitignore'
    ]);
    expect(plan.files[0]).toMatchObject({
      action: 'create',
      overwriteStatus: 'absent',
      wouldWrite: true
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

  it('keeps generated external bundle workflows free of protected internal lifecycle terms', () => {
    for (const bundle of ['linear-node', 'github-node', 'memory-generic']) {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `symphony-materializer-${bundle}-`)));
      const resolution = resolveProfileSelection([bundle]);

      const plan = materializeWorkflowDryRun({
        resolution,
        projectFacts: { root, packageManager: 'npm', existingWorkflowPath: null },
        choices: { dryRun: true, selections: [bundle] }
      });
      const workflow = plan.files.find((file) => file.path === 'WORKFLOW.md')?.content ?? '';

      expect(plan.validation).toMatchObject({ ok: true });
      expect(workflow).toContain('profile=solo-local');
      for (const forbidden of FORBIDDEN_INTERNAL_OUTPUT_TERMS) {
        expect(workflow, `${bundle} leaked ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('only emits review lifecycle states when team-review is explicitly selected', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-materializer-team-review-')));
    const resolution = resolveProfileSelection([
      'tracker:memory',
      'workspace:none',
      'toolchain:generic',
      'workflow:team-review'
    ]);

    const plan = materializeWorkflowDryRun({
      resolution,
      projectFacts: { root, packageManager: 'generic', existingWorkflowPath: null },
      choices: {
        dryRun: true,
        selections: ['tracker:memory', 'workspace:none', 'toolchain:generic', 'workflow:team-review']
      }
    });
    const workflow = plan.files.find((file) => file.path === 'WORKFLOW.md')?.content ?? '';

    expect(plan.validation).toMatchObject({ ok: true });
    expect(workflow).toContain('active_states: ["Todo", "In Progress", "Agent Review"]');
    expect(workflow).toContain('handoff_states: ["Agent Review"]');
    expect(workflow).not.toContain('Merging');
    expect(workflow).not.toContain('Human Review');
    expect(workflow).not.toContain('Codex Workpad');
    expect(workflow).not.toContain('workflow:symphony-internal');
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
      wouldWrite: true,
      requiresOverwriteApproval: true
    });
    expect(fs.readFileSync(path.join(root, 'WORKFLOW.md'), 'utf8')).toBe('existing workflow\n');
  });

  it('rejects protected internal workflows before planning generated files', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-materializer-internal-')));
    const resolution = resolveProfileSelection([
      'tracker:memory',
      'workspace:none',
      'toolchain:generic',
      'workflow:symphony-internal'
    ]);

    expect(() =>
      materializeWorkflowDryRun({
        resolution,
        projectFacts: { root, packageManager: 'generic', existingWorkflowPath: null },
        choices: {
          dryRun: true,
          selections: ['tracker:memory', 'workspace:none', 'toolchain:generic', 'workflow:symphony-internal']
        }
      })
    ).toThrow('Protected workflow bindings cannot be generated by init');
  });

  it('plans conservative root gitignore insertion idempotently', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-materializer-gitignore-')));
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n', 'utf8');
    const resolution = resolveProfileSelection(['memory-generic']);

    const plan = materializeWorkflowPlan({
      resolution,
      projectFacts: { root, packageManager: 'generic', existingWorkflowPath: null },
      choices: { dryRun: false, selections: ['memory-generic'] }
    });

    expect(plan.files[2]).toMatchObject({
      path: '.gitignore',
      action: 'overwrite',
      overwriteStatus: 'exists',
      wouldWrite: true,
      requiresOverwriteApproval: false
    });
    expect(plan.files[2].content).toBe('node_modules\n.symphony/system/\n');

    fs.writeFileSync(path.join(root, '.gitignore'), plan.files[2].content ?? '', 'utf8');
    const second = materializeWorkflowPlan({
      resolution,
      projectFacts: { root, packageManager: 'generic', existingWorkflowPath: null },
      choices: { dryRun: false, selections: ['memory-generic'] }
    });

    expect(second.files[2]).toMatchObject({
      path: '.gitignore',
      action: 'skip',
      wouldWrite: false
    });
  });

  it('generates a valid Linear Node worktree workflow with credential support files', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-materializer-linear-')));
    const resolution = resolveProfileSelection(['linear-node']);

    const plan = materializeWorkflowDryRun({
      resolution,
      projectFacts: { root, packageManager: 'pnpm', existingWorkflowPath: null },
      choices: {
        dryRun: true,
        selections: ['linear-node'],
        linearProjectSlug: 'SYMPHONY'
      }
    });

    expect(plan.validation).toMatchObject({ ok: true });
    expect(plan.files.map((file) => file.path)).toEqual([
      'WORKFLOW.md',
      '.env.example',
      '.worktreeinclude',
      path.join('.symphony', 'system', '.gitignore'),
      '.gitignore'
    ]);
    expect(plan.files.find((file) => file.path === '.env.example')?.content).toContain('LINEAR_API_KEY=');
    expect(plan.files.find((file) => file.path === '.worktreeinclude')?.content).toContain('.env.local');
    expect(plan.files[0].content).toContain('api_key: "$LINEAR_API_KEY"');
    expect(plan.files[0].content).toContain('project_slug: "SYMPHONY"');
    expect(plan.files[0].content).toContain('package_manager: "pnpm"');
    expect(plan.files[0].content).toContain('after_create: "pnpm install"');

    const definition = new WorkflowLoader().parse(plan.files[0].content ?? '');
    const effective = new ConfigResolver({
      env: { LINEAR_API_KEY: 'test-token' },
      homedir: () => root
    }).resolve(definition, { workflowPath: path.join(root, 'WORKFLOW.md') });

    expect(new ConfigValidator().validate(effective)).toMatchObject({ ok: true });
    expect(effective.tracker.kind).toBe('linear');
    expect(effective.tracker.project_slug).toBe('SYMPHONY');
    expect(effective.workspace.provisioner.type).toBe('worktree');
    expect(effective.workspace.copy_ignored.enabled).toBe(true);
    expect(effective.hooks.after_create).toBe('pnpm install');
  });

  it('generates a valid GitHub Node workflow from detected repository facts', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-materializer-github-')));
    const resolution = resolveProfileSelection(['github-node']);

    const plan = materializeWorkflowDryRun({
      resolution,
      projectFacts: {
        root,
        packageManager: 'yarn',
        existingWorkflowPath: null,
        githubRepository: { owner: 'nielsgl', repo: 'symphony', remote: 'origin' }
      },
      choices: { dryRun: true, selections: ['github-node'] }
    });

    expect(plan.validation).toMatchObject({ ok: true });
    expect(plan.files.find((file) => file.path === '.env.example')?.content).toContain('GITHUB_TOKEN=');
    expect(plan.files[0].content).toContain('owner: "nielsgl"');
    expect(plan.files[0].content).toContain('repo: "symphony"');
    expect(plan.files[0].content).toContain('- GitHub owner: nielsgl (detected from git remote)');
    expect(plan.files[0].content).toContain('- Setup: yarn install');

    const definition = new WorkflowLoader().parse(plan.files[0].content ?? '');
    const effective = new ConfigResolver({
      env: { GITHUB_TOKEN: 'test-token' },
      homedir: () => root
    }).resolve(definition, { workflowPath: path.join(root, 'WORKFLOW.md') });

    expect(new ConfigValidator().validate(effective)).toMatchObject({ ok: true });
    expect(effective.tracker.kind).toBe('github');
    expect(effective.tracker.owner).toBe('nielsgl');
    expect(effective.tracker.repo).toBe('symphony');
  });

  it('keeps memory generic workflows free of hosted env and worktree support files', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-materializer-generic-')));
    const resolution = resolveProfileSelection(['memory-generic']);

    const plan = materializeWorkflowDryRun({
      resolution,
      projectFacts: { root, packageManager: null, existingWorkflowPath: null },
      choices: { dryRun: true, selections: ['memory-generic'] }
    });

    expect(plan.validation).toMatchObject({ ok: true });
    expect(plan.files.map((file) => file.path)).not.toContain('.env.example');
    expect(plan.files.map((file) => file.path)).not.toContain('.worktreeinclude');
    expect(plan.files[0].content).toContain('kind: "generic"');
    expect(plan.files[0].content).toContain('- Setup: none');
    expect(plan.files[0].content).not.toContain('npm install');
  });
});
