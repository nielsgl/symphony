#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const catalogPath = path.join(repoRoot, 'dist', 'src', 'workflow', 'portable-skill-catalog.js');

if (!fs.existsSync(catalogPath)) {
  throw new Error(`Portable skill catalog build artifact is missing: ${catalogPath}`);
}

const { listPortableSkills } = require(catalogPath);
const distSkillRoot = path.join(repoRoot, 'dist', '.codex', 'skills');

fs.rmSync(distSkillRoot, { recursive: true, force: true });

for (const skill of listPortableSkills()) {
  const sourceDirectory = path.join(repoRoot, skill.sourceDirectory);
  const destinationDirectory = path.join(repoRoot, 'dist', skill.sourceDirectory);

  if (!fs.existsSync(sourceDirectory) || !fs.statSync(sourceDirectory).isDirectory()) {
    throw new Error(`Portable skill source directory is missing: ${skill.sourceDirectory}`);
  }
  const sourceTemplate = path.join(sourceDirectory, 'SKILL.md');
  if (!fs.existsSync(sourceTemplate) || !fs.statSync(sourceTemplate).isFile()) {
    throw new Error(`Portable skill template is missing: ${skill.sourceDirectory}/SKILL.md`);
  }

  fs.mkdirSync(path.dirname(destinationDirectory), { recursive: true });
  fs.cpSync(sourceDirectory, destinationDirectory, { recursive: true, force: true });

  const packagedTemplate = path.join(destinationDirectory, 'SKILL.md');
  if (!fs.existsSync(packagedTemplate) || !fs.statSync(packagedTemplate).isFile()) {
    throw new Error(`Portable skill template was not packaged: ${skill.sourceDirectory}/SKILL.md`);
  }

  for (const helper of skill.helperScripts) {
    const helperPath = path.join(repoRoot, 'dist', helper.path);
    if (!fs.existsSync(helperPath) || !fs.statSync(helperPath).isFile()) {
      throw new Error(`Portable skill helper script was not packaged: ${helper.path}`);
    }
  }
}

console.log(`Copied ${listPortableSkills().length} portable skill template(s) to ${path.relative(repoRoot, distSkillRoot)}`);
