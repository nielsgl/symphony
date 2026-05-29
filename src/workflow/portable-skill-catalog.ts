export type PortableSkillId =
  | 'commit'
  | 'pull'
  | 'push'
  | 'land'
  | 'linear-graphql'
  | 'linear-ui-evidence';

export type PortableSkillPrerequisiteKind =
  | 'codex-skill-runtime'
  | 'git'
  | 'github-cli'
  | 'linear-mcp'
  | 'linear-graphql'
  | 'node'
  | 'python'
  | 'uv';

export interface PortableSkillPrerequisite {
  kind: PortableSkillPrerequisiteKind;
  required: boolean;
  description: string;
}

export interface PortableSkillHelperScript {
  path: string;
  destinationPath: string;
  runtime: 'node' | 'python';
  required: boolean;
  description: string;
}

export interface PortableSkillCatalogEntry {
  id: PortableSkillId;
  name: string;
  sourceDirectory: string;
  destinationDirectory: string;
  description: string;
  defaultRecommended: boolean;
  helperScripts: readonly PortableSkillHelperScript[];
  prerequisites: readonly PortableSkillPrerequisite[];
}

export interface PortableSkillSelection {
  selectedSkillIds: readonly PortableSkillId[];
  selectedSkills: readonly PortableSkillCatalogEntry[];
  defaultRecommendedSkillIds: readonly PortableSkillId[];
  optInSkillIds: readonly PortableSkillId[];
}

export const PORTABLE_SKILL_DESTINATION_ROOT = '.codex/skills';

const COMMON_PREREQUISITES: readonly PortableSkillPrerequisite[] = [
  {
    kind: 'codex-skill-runtime',
    required: true,
    description: 'Codex must load project-local skills from .codex/skills in the target project.'
  }
];

const GIT_PREREQUISITE: PortableSkillPrerequisite = {
  kind: 'git',
  required: true,
  description: 'Git CLI is required for branch, commit, pull, push, and merge operations.'
};

const GITHUB_CLI_PREREQUISITE: PortableSkillPrerequisite = {
  kind: 'github-cli',
  required: true,
  description: 'GitHub CLI authentication is required for PR publishing, review, checks, and landing.'
};

export const PORTABLE_SKILL_CATALOG: readonly PortableSkillCatalogEntry[] = [
  {
    id: 'commit',
    name: 'commit',
    sourceDirectory: '.codex/skills/commit',
    destinationDirectory: `${PORTABLE_SKILL_DESTINATION_ROOT}/commit`,
    description: 'Create small, atomic Commitizen-style commits with explicit validation evidence.',
    defaultRecommended: true,
    helperScripts: [],
    prerequisites: [...COMMON_PREREQUISITES, GIT_PREREQUISITE]
  },
  {
    id: 'pull',
    name: 'pull',
    sourceDirectory: '.codex/skills/pull',
    destinationDirectory: `${PORTABLE_SKILL_DESTINATION_ROOT}/pull`,
    description: 'Sync a feature branch with origin/main using a merge-based update flow.',
    defaultRecommended: true,
    helperScripts: [],
    prerequisites: [...COMMON_PREREQUISITES, GIT_PREREQUISITE]
  },
  {
    id: 'push',
    name: 'push',
    sourceDirectory: '.codex/skills/push',
    destinationDirectory: `${PORTABLE_SKILL_DESTINATION_ROOT}/push`,
    description: 'Push branch updates and create or update the corresponding pull request.',
    defaultRecommended: true,
    helperScripts: [],
    prerequisites: [...COMMON_PREREQUISITES, GIT_PREREQUISITE, GITHUB_CLI_PREREQUISITE]
  },
  {
    id: 'land',
    name: 'land',
    sourceDirectory: '.codex/skills/land',
    destinationDirectory: `${PORTABLE_SKILL_DESTINATION_ROOT}/land`,
    description: 'Watch PR readiness and land approved work through the governed merge loop.',
    defaultRecommended: true,
    helperScripts: [
      {
        path: '.codex/skills/land/scripts/land_watch.py',
        destinationPath: `${PORTABLE_SKILL_DESTINATION_ROOT}/land/scripts/land_watch.py`,
        runtime: 'python',
        required: true,
        description: 'Polls PR state, checks, and merge readiness during the land loop.'
      }
    ],
    prerequisites: [
      ...COMMON_PREREQUISITES,
      GIT_PREREQUISITE,
      GITHUB_CLI_PREREQUISITE,
      {
        kind: 'uv',
        required: true,
        description: 'uv is required to run the land watcher helper with its Python dependencies.'
      },
      {
        kind: 'python',
        required: true,
        description: 'Python is required by the land watcher helper.'
      }
    ]
  },
  {
    id: 'linear-graphql',
    name: 'linear-graphql',
    sourceDirectory: '.codex/skills/linear-graphql',
    destinationDirectory: `${PORTABLE_SKILL_DESTINATION_ROOT}/linear-graphql`,
    description: 'Use narrow raw Linear GraphQL operations for cases not covered by Linear MCP tools.',
    defaultRecommended: false,
    helperScripts: [],
    prerequisites: [
      ...COMMON_PREREQUISITES,
      {
        kind: 'linear-graphql',
        required: true,
        description: 'A configured Linear GraphQL client is required for exceptional raw GraphQL operations.'
      }
    ]
  },
  {
    id: 'linear-ui-evidence',
    name: 'linear-ui-evidence',
    sourceDirectory: '.codex/skills/linear-ui-evidence',
    destinationDirectory: `${PORTABLE_SKILL_DESTINATION_ROOT}/linear-ui-evidence`,
    description: 'Publish Playwright screenshots and screencasts to Linear as rendered rich media.',
    defaultRecommended: false,
    helperScripts: [
      {
        path: '.codex/skills/linear-ui-evidence/scripts/publish-linear-ui-evidence.js',
        destinationPath: `${PORTABLE_SKILL_DESTINATION_ROOT}/linear-ui-evidence/scripts/publish-linear-ui-evidence.js`,
        runtime: 'node',
        required: true,
        description: 'Uploads UI evidence media and writes Linear rich-media comments.'
      }
    ],
    prerequisites: [
      ...COMMON_PREREQUISITES,
      {
        kind: 'node',
        required: true,
        description: 'Node.js is required to run the UI evidence publisher helper.'
      },
      {
        kind: 'linear-mcp',
        required: true,
        description: 'Linear MCP or equivalent Linear upload access is required to publish rich media evidence.'
      }
    ]
  }
];

const PORTABLE_SKILLS_BY_ID = new Map(PORTABLE_SKILL_CATALOG.map((skill) => [skill.id, skill]));

export function listPortableSkills(): PortableSkillCatalogEntry[] {
  return [...PORTABLE_SKILL_CATALOG];
}

export function getPortableSkill(id: string): PortableSkillCatalogEntry | undefined {
  return PORTABLE_SKILLS_BY_ID.get(id as PortableSkillId);
}

export function listDefaultPortableSkillIds(): PortableSkillId[] {
  return PORTABLE_SKILL_CATALOG.filter((skill) => skill.defaultRecommended).map((skill) => skill.id);
}

export function listOptInPortableSkillIds(): PortableSkillId[] {
  return PORTABLE_SKILL_CATALOG.filter((skill) => !skill.defaultRecommended).map((skill) => skill.id);
}

export function resolvePortableSkillSelection(
  requestedSkillIds: readonly PortableSkillId[] = listDefaultPortableSkillIds()
): PortableSkillSelection {
  const uniqueSkillIds = [...new Set(requestedSkillIds)];
  const selectedSkills = uniqueSkillIds.map((id) => {
    const skill = getPortableSkill(id);
    if (!skill) {
      throw new Error(`Unknown portable skill '${id}'.`);
    }
    return skill;
  });

  return {
    selectedSkillIds: uniqueSkillIds,
    selectedSkills,
    defaultRecommendedSkillIds: listDefaultPortableSkillIds(),
    optInSkillIds: listOptInPortableSkillIds()
  };
}
