export type ProfilePackDimension = 'tracker' | 'workspace' | 'toolchain' | 'workflow';

export type ProfilePackId =
  | 'tracker:linear'
  | 'tracker:github'
  | 'tracker:memory'
  | 'workspace:worktree'
  | 'workspace:clone'
  | 'workspace:none'
  | 'toolchain:node'
  | 'toolchain:generic'
  | 'workflow:solo-local'
  | 'workflow:team-review'
  | 'workflow:symphony-internal';

export type ProfileBundleId = 'linear-node' | 'github-node' | 'memory-generic';

export interface ProfilePack {
  id: ProfilePackId;
  dimension: ProfilePackDimension;
  name: string;
  title: string;
  summary: string;
  intendedUse: string;
  conflictsWith?: readonly ProfilePackId[];
  protected?: boolean;
  binding?: {
    kind: 'checked-in-workflow';
    path: string;
    description: string;
  };
}

export interface ProfileBundle {
  id: ProfileBundleId;
  title: string;
  summary: string;
  intendedUse: string;
  packs: readonly ProfilePackId[];
}

export interface ProfileResolution {
  requested: readonly string[];
  expandedBundles: Array<{
    bundle: ProfileBundle;
    packs: readonly ProfilePackId[];
  }>;
  packs: ProfilePack[];
  dimensions: Partial<Record<ProfilePackDimension, ProfilePack>>;
  errors: string[];
  warnings: string[];
  protectedBindings: ProfilePack[];
}

const REQUIRED_DIMENSIONS: readonly ProfilePackDimension[] = ['tracker', 'workspace', 'toolchain', 'workflow'];

const PROFILE_PACKS: readonly ProfilePack[] = [
  {
    id: 'tracker:linear',
    dimension: 'tracker',
    name: 'linear',
    title: 'Linear tracker',
    summary: 'Use Linear issues, statuses, comments, and PR links as the tracker source.',
    intendedUse: 'Team work coordinated through Linear.'
  },
  {
    id: 'tracker:github',
    dimension: 'tracker',
    name: 'github',
    title: 'GitHub tracker',
    summary: 'Use GitHub issues, pull requests, labels, and checks as the tracker source.',
    intendedUse: 'Repository-native work tracked in GitHub.'
  },
  {
    id: 'tracker:memory',
    dimension: 'tracker',
    name: 'memory',
    title: 'Memory tracker',
    summary: 'Use local in-memory tracker state for demos, dry-runs, and isolated development.',
    intendedUse: 'Local and demo workflows that must not call hosted tracker APIs.'
  },
  {
    id: 'workspace:worktree',
    dimension: 'workspace',
    name: 'worktree',
    title: 'Git worktree workspace',
    summary: 'Create isolated Git worktrees for issue work while sharing the repository object store.',
    intendedUse: 'Normal repository-backed implementation work.'
  },
  {
    id: 'workspace:clone',
    dimension: 'workspace',
    name: 'clone',
    title: 'Git clone workspace',
    summary: 'Create independent clones for issue work when worktree sharing is not appropriate.',
    intendedUse: 'Hosted or strongly isolated workspaces.'
  },
  {
    id: 'workspace:none',
    dimension: 'workspace',
    name: 'none',
    title: 'No managed workspace',
    summary: 'Run without Symphony creating or managing a repository workspace.',
    intendedUse: 'Read-only, documentation, or externally managed workspace flows.'
  },
  {
    id: 'toolchain:node',
    dimension: 'toolchain',
    name: 'node',
    title: 'Node toolchain',
    summary: 'Expect npm scripts, TypeScript, and Node-based validation commands.',
    intendedUse: 'JavaScript and TypeScript repositories.'
  },
  {
    id: 'toolchain:generic',
    dimension: 'toolchain',
    name: 'generic',
    title: 'Generic toolchain',
    summary: 'Use shell-first validation without assuming a language-specific package manager.',
    intendedUse: 'Mixed-language, docs-only, or custom validation repositories.'
  },
  {
    id: 'workflow:solo-local',
    dimension: 'workflow',
    name: 'solo-local',
    title: 'Solo local workflow',
    summary: 'Favor local execution, local tracker state, and lightweight review handoff.',
    intendedUse: 'Single-operator local development and demos.'
  },
  {
    id: 'workflow:team-review',
    dimension: 'workflow',
    name: 'team-review',
    title: 'Team review workflow',
    summary: 'Use implementation, review, PR, and merge handoff states for team collaboration.',
    intendedUse: 'Tracked team work that needs review and merge governance.'
  },
  {
    id: 'workflow:symphony-internal',
    dimension: 'workflow',
    name: 'symphony-internal',
    title: 'Symphony internal workflow',
    summary: 'Protected golden binding to this repository checked-in WORKFLOW.md.',
    intendedUse: 'Developing Symphony itself from the checked-in workflow contract.',
    protected: true,
    binding: {
      kind: 'checked-in-workflow',
      path: 'WORKFLOW.md',
      description:
        'Uses the repository checked-in Symphony WORKFLOW.md directly; it is not a generated workflow template.'
    }
  }
];

const PROFILE_BUNDLES: readonly ProfileBundle[] = [
  {
    id: 'linear-node',
    title: 'Linear / Node',
    summary: 'Team-review workflow for a Node repository tracked in Linear.',
    intendedUse: 'Default team implementation flow for Node/TypeScript projects using Linear.',
    packs: ['tracker:linear', 'workspace:worktree', 'toolchain:node', 'workflow:team-review']
  },
  {
    id: 'github-node',
    title: 'GitHub / Node',
    summary: 'Team-review workflow for a Node repository tracked in GitHub.',
    intendedUse: 'Repository-native Node/TypeScript projects using GitHub issues and pull requests.',
    packs: ['tracker:github', 'workspace:worktree', 'toolchain:node', 'workflow:team-review']
  },
  {
    id: 'memory-generic',
    title: 'Memory / Generic',
    summary: 'Local dry-run bundle using the memory tracker and generic shell validation.',
    intendedUse: 'Demos, smoke tests, and offline dry-runs without hosted tracker APIs.',
    packs: ['tracker:memory', 'workspace:none', 'toolchain:generic', 'workflow:solo-local']
  }
];

const PACKS_BY_ID = new Map(PROFILE_PACKS.map((pack) => [pack.id, pack]));
const BUNDLES_BY_ID = new Map(PROFILE_BUNDLES.map((bundle) => [bundle.id, bundle]));

export function listProfilePacks(): ProfilePack[] {
  return [...PROFILE_PACKS];
}

export function listProfileBundles(): ProfileBundle[] {
  return [...PROFILE_BUNDLES];
}

export function getProfilePack(id: string): ProfilePack | undefined {
  return PACKS_BY_ID.get(normalizePackAlias(id));
}

export function getProfileBundle(id: string): ProfileBundle | undefined {
  return BUNDLES_BY_ID.get(id as ProfileBundleId);
}

export function normalizePackAlias(id: string): ProfilePackId {
  return id === 'symphony-internal' ? 'workflow:symphony-internal' : (id as ProfilePackId);
}

export function resolveProfileSelection(selection: readonly string[]): ProfileResolution {
  const expandedPackIds: ProfilePackId[] = [];
  const expandedBundles: ProfileResolution['expandedBundles'] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const raw of selection) {
    const item = raw.trim();
    if (!item) {
      continue;
    }

    const bundle = getProfileBundle(item);
    if (bundle) {
      expandedBundles.push({ bundle, packs: bundle.packs });
      expandedPackIds.push(...bundle.packs);
      continue;
    }

    const packId = normalizePackAlias(item);
    if (PACKS_BY_ID.has(packId)) {
      expandedPackIds.push(packId);
      continue;
    }

    errors.push(`Unknown profile selection '${item}'. Use a known pack id or bundle id.`);
  }

  const packs = expandedPackIds.map((id) => PACKS_BY_ID.get(id)).filter((pack): pack is ProfilePack => Boolean(pack));
  const dimensions: Partial<Record<ProfilePackDimension, ProfilePack>> = {};
  const packsByDimension = new Map<ProfilePackDimension, ProfilePack[]>();

  for (const pack of packs) {
    const dimensionPacks = packsByDimension.get(pack.dimension) ?? [];
    dimensionPacks.push(pack);
    packsByDimension.set(pack.dimension, dimensionPacks);
  }

  for (const dimension of REQUIRED_DIMENSIONS) {
    const dimensionPacks = packsByDimension.get(dimension) ?? [];
    const uniquePacks = uniqueById(dimensionPacks);
    if (uniquePacks.length === 1) {
      dimensions[dimension] = uniquePacks[0];
    } else if (uniquePacks.length > 1) {
      errors.push(
        `Conflicting ${dimension} packs: ${uniquePacks.map((pack) => pack.id).join(', ')}. Choose exactly one ${dimension} pack.`
      );
    } else {
      errors.push(`Missing required ${dimension} pack. Choose one ${dimension}:* pack or a bundle that includes it.`);
    }
  }

  for (const pack of uniqueById(packs)) {
    for (const conflictId of pack.conflictsWith ?? []) {
      if (expandedPackIds.includes(conflictId)) {
        errors.push(`Pack ${pack.id} conflicts with ${conflictId}. Remove one of the conflicting packs.`);
      }
    }
  }

  const protectedBindings = uniqueById(packs).filter((pack) => pack.protected);
  if (protectedBindings.length > 0) {
    warnings.push(
      'Protected workflow bindings are discovery-only golden bindings; init must not generate templates for them.'
    );
  }

  return {
    requested: selection,
    expandedBundles,
    packs: uniqueById(packs),
    dimensions,
    errors,
    warnings,
    protectedBindings
  };
}

function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
}
