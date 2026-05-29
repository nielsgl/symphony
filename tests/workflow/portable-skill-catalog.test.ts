import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PORTABLE_SKILL_DESTINATION_ROOT,
  listDefaultPortableSkillIds,
  listOptInPortableSkillIds,
  listPortableSkills,
  resolvePortableSkillAssetSet,
  resolvePortableSkillSelection
} from '../../src/workflow/portable-skill-catalog';
import { summarizePortableSkillCatalogForDoctor } from '../../src/runtime/local-doctor';

const repoRoot = path.resolve(__dirname, '..', '..');

describe('portable skill catalog', () => {
  it('contains exactly the initial portable skills in stable order', () => {
    expect(listPortableSkills().map((skill) => skill.id)).toEqual([
      'commit',
      'pull',
      'push',
      'land',
      'linear-graphql',
      'linear-ui-evidence'
    ]);
  });

  it('targets only project-local Codex skill destinations', () => {
    expect(PORTABLE_SKILL_DESTINATION_ROOT).toBe('.codex/skills');
    for (const skill of listPortableSkills()) {
      expect(skill.destinationDirectory).toBe(`${PORTABLE_SKILL_DESTINATION_ROOT}/${skill.id}`);
      expect(skill.sourceDirectory).toBe(`.codex/skills/${skill.id}`);
      expect(skill.destinationDirectory).not.toContain('.symphony/skills');
      expect(skill.sourceDirectory).not.toContain('.symphony/skills');
    }
  });

  it('represents helper scripts as first-class metadata', () => {
    const helpersBySkill = Object.fromEntries(
      listPortableSkills().map((skill) => [skill.id, skill.helperScripts.map((script) => script.path)])
    );

    expect(helpersBySkill).toMatchObject({
      commit: [],
      pull: [],
      push: [],
      land: ['.codex/skills/land/scripts/land_watch.py'],
      'linear-graphql': [],
      'linear-ui-evidence': ['.codex/skills/linear-ui-evidence/scripts/publish-linear-ui-evidence.js']
    });
  });

  it('records prerequisite metadata for every catalog entry', () => {
    for (const skill of listPortableSkills()) {
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.prerequisites.length).toBeGreaterThan(0);
      expect(skill.prerequisites.every((prerequisite) => prerequisite.required)).toBe(true);
      expect(skill.prerequisites.map((prerequisite) => prerequisite.kind)).toContain('codex-skill-runtime');
    }

    expect(
      listPortableSkills()
        .find((skill) => skill.id === 'push')
        ?.prerequisites.map((prerequisite) => prerequisite.kind)
    ).toContain('github-cli');
    expect(
      listPortableSkills()
        .find((skill) => skill.id === 'linear-ui-evidence')
        ?.prerequisites.map((prerequisite) => prerequisite.kind)
    ).toEqual(['codex-skill-runtime', 'node', 'linear-mcp']);
  });

  it('separates default recommended skills from opt-in skills', () => {
    expect(listDefaultPortableSkillIds()).toEqual(['commit', 'pull', 'push', 'land']);
    expect(listOptInPortableSkillIds()).toEqual(['linear-graphql', 'linear-ui-evidence']);

    expect(resolvePortableSkillSelection().selectedSkillIds).toEqual(['commit', 'pull', 'push', 'land']);
    expect(resolvePortableSkillSelection(['commit', 'linear-ui-evidence']).selectedSkillIds).toEqual([
      'commit',
      'linear-ui-evidence'
    ]);
  });

  it('is consumable by doctor without using .symphony/skills as a source', () => {
    expect(summarizePortableSkillCatalogForDoctor()).toMatchObject({
      skillIds: ['commit', 'pull', 'push', 'land', 'linear-graphql', 'linear-ui-evidence'],
      defaultRecommendedSkillIds: ['commit', 'pull', 'push', 'land'],
      optInSkillIds: ['linear-graphql', 'linear-ui-evidence'],
      targetMaterializationRoot: '.codex/skills',
      reservedRuntimeSource: '.symphony/skills',
      runtimeLoadingSupported: false
    });
  });

  it('resolves source-checkout portable skill assets and helper scripts', () => {
    const assetSet = resolvePortableSkillAssetSet(
      listPortableSkills().map((skill) => skill.id),
      { packageRoot: repoRoot, moduleDirectory: path.join(repoRoot, 'src', 'workflow') }
    );

    expect(assetSet.source).toBe('source');
    expect(assetSet.assetRoot).toBe(path.join(repoRoot, '.codex', 'skills'));
    for (const skill of assetSet.selectedSkills) {
      expect(fs.statSync(skill.absoluteSourceDirectory).isDirectory()).toBe(true);
      expect(fs.existsSync(path.join(skill.absoluteSourceDirectory, 'SKILL.md'))).toBe(true);
      for (const helper of skill.helperScripts) {
        expect(fs.statSync(helper.absolutePath).isFile()).toBe(true);
      }
    }
  });

  it('resolves built dist portable skill assets without falling back to source paths', () => {
    const packageRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-portable-skills-dist-')));
    fs.writeFileSync(path.join(packageRoot, 'package.json'), '{"name":"symphony-test"}\n', 'utf8');

    for (const skill of listPortableSkills()) {
      const skillDirectory = path.join(packageRoot, 'dist', skill.sourceDirectory);
      fs.mkdirSync(skillDirectory, { recursive: true });
      fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), `# ${skill.name}\n`, 'utf8');
      for (const helper of skill.helperScripts) {
        const helperPath = path.join(packageRoot, 'dist', helper.path);
        fs.mkdirSync(path.dirname(helperPath), { recursive: true });
        fs.writeFileSync(helperPath, '# helper\n', 'utf8');
      }
    }

    const assetSet = resolvePortableSkillAssetSet(
      listPortableSkills().map((skill) => skill.id),
      { packageRoot, moduleDirectory: path.join(packageRoot, 'dist', 'src', 'workflow') }
    );

    expect(assetSet.source).toBe('dist');
    expect(assetSet.assetRoot).toBe(path.join(packageRoot, 'dist', '.codex', 'skills'));
    expect(assetSet.selectedSkills.map((skill) => skill.absoluteSourceDirectory)).toEqual(
      listPortableSkills().map((skill) => path.join(packageRoot, 'dist', skill.sourceDirectory))
    );
  });

  it('fails dist asset lookup when a selected helper script is missing from the packaged runtime set', () => {
    const packageRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-portable-skills-missing-')));
    fs.writeFileSync(path.join(packageRoot, 'package.json'), '{"name":"symphony-test"}\n', 'utf8');

    for (const skill of listPortableSkills()) {
      const skillDirectory = path.join(packageRoot, 'dist', skill.sourceDirectory);
      fs.mkdirSync(skillDirectory, { recursive: true });
      fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), `# ${skill.name}\n`, 'utf8');
    }

    expect(() =>
      resolvePortableSkillAssetSet(['linear-ui-evidence'], {
        packageRoot,
        moduleDirectory: path.join(packageRoot, 'dist', 'src', 'workflow')
      })
    ).toThrow('.codex/skills/linear-ui-evidence/scripts/publish-linear-ui-evidence.js');
  });
});
