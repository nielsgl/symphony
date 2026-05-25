import { describe, expect, it } from 'vitest';

import {
  getProfilePack,
  listProfileBundles,
  listProfilePacks,
  resolveProfileSelection
} from '../../src/workflow/profile-registry';

describe('profile registry', () => {
  it('lists the initial tracker, workspace, toolchain, and workflow packs', () => {
    const packIds = listProfilePacks().map((pack) => pack.id);

    expect(packIds).toEqual(
      expect.arrayContaining([
        'tracker:linear',
        'tracker:github',
        'tracker:memory',
        'workspace:worktree',
        'workspace:clone',
        'workspace:none',
        'toolchain:node',
        'toolchain:generic',
        'workflow:solo-local',
        'workflow:team-review',
        'workflow:symphony-internal'
      ])
    );
    expect(packIds).not.toContain('tracker:memory-demo');
    expect(packIds).not.toContain('memory-demo');
  });

  it('lists visible bundles that expand into explicit packs', () => {
    expect(listProfileBundles()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'linear-node',
          packs: ['tracker:linear', 'workspace:worktree', 'toolchain:node', 'workflow:solo-local']
        }),
        expect.objectContaining({
          id: 'github-node',
          packs: ['tracker:github', 'workspace:worktree', 'toolchain:node', 'workflow:solo-local']
        })
      ])
    );
  });

  it('resolves named bundles into complete dimensions', () => {
    const resolution = resolveProfileSelection(['linear-node']);

    expect(resolution.errors).toEqual([]);
    expect(resolution.expandedBundles).toHaveLength(1);
    expect(resolution.expandedBundles[0].packs).toEqual([
      'tracker:linear',
      'workspace:worktree',
      'toolchain:node',
      'workflow:solo-local'
    ]);
    expect(resolution.dimensions.tracker?.id).toBe('tracker:linear');
    expect(resolution.dimensions.workspace?.id).toBe('workspace:worktree');
    expect(resolution.dimensions.toolchain?.id).toBe('toolchain:node');
    expect(resolution.dimensions.workflow?.id).toBe('workflow:solo-local');
  });

  it('reports actionable conflicts for multiple packs in one dimension', () => {
    const resolution = resolveProfileSelection([
      'tracker:linear',
      'tracker:github',
      'workspace:worktree',
      'toolchain:node',
      'workflow:team-review'
    ]);

    expect(resolution.errors).toContain(
      'Conflicting tracker packs: tracker:linear, tracker:github. Choose exactly one tracker pack.'
    );
  });

  it('validates missing required dimensions', () => {
    const resolution = resolveProfileSelection(['tracker:memory']);

    expect(resolution.errors).toEqual(
      expect.arrayContaining([
        'Missing required workspace pack. Choose one workspace:* pack or a bundle that includes it.',
        'Missing required toolchain pack. Choose one toolchain:* pack or a bundle that includes it.',
        'Missing required workflow pack. Choose one workflow:* pack or a bundle that includes it.'
      ])
    );
  });

  it('preserves symphony-internal as a protected checked-in workflow binding', () => {
    const pack = getProfilePack('symphony-internal');
    const resolution = resolveProfileSelection([
      'tracker:linear',
      'workspace:worktree',
      'toolchain:node',
      'symphony-internal'
    ]);

    expect(pack).toMatchObject({
      id: 'workflow:symphony-internal',
      protected: true,
      binding: {
        kind: 'checked-in-workflow',
        path: 'WORKFLOW.md'
      }
    });
    expect(resolution.protectedBindings.map((binding) => binding.id)).toEqual(['workflow:symphony-internal']);
    expect(resolution.warnings.join('\n')).toContain('must not generate templates');
  });

  it('rejects protected internal workflows combined with generated bundles', () => {
    const resolution = resolveProfileSelection(['memory-generic', 'workflow:symphony-internal']);

    expect(resolution.protectedBindings.map((binding) => binding.id)).toEqual(['workflow:symphony-internal']);
    expect(resolution.errors).toContain(
      'Protected workflow pack workflow:symphony-internal cannot be combined with generated bundles. Select symphony-internal by itself for the checked-in workflow binding.'
    );
  });
});
