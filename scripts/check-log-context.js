#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const repoRoot = process.cwd();
const srcRoot = path.join(repoRoot, 'src');
const files = [];

function collectTypeScriptFiles(directoryPath) {
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      collectTypeScriptFiles(absolutePath);
      continue;
    }

    if (entry.isFile() && absolutePath.endsWith('.ts')) {
      files.push(path.relative(repoRoot, absolutePath));
    }
  }
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function scanContextObject({ sourceFile, relativeFile, objectLiteral, violations }) {
  for (const property of objectLiteral.properties) {
    if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
      const propertyName = propertyNameText(property.name);
      if (propertyName === 'identifier') {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(property.name.getStart(sourceFile));
        violations.push(`${relativeFile}:${line + 1}:${character + 1}: identifier`);
      }
    }

    if (ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer)) {
      scanContextObject({
        sourceFile,
        relativeFile,
        objectLiteral: property.initializer,
        violations
      });
    }
  }
}

function scanFile(relativeFile, content) {
  const sourceFile = ts.createSourceFile(relativeFile, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations = [];

  function visit(node) {
    if (!ts.isCallExpression(node)) {
      ts.forEachChild(node, visit);
      return;
    }

    if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'log') {
      ts.forEachChild(node, visit);
      return;
    }

    const firstArg = node.arguments[0];
    if (!firstArg || !ts.isObjectLiteralExpression(firstArg)) {
      ts.forEachChild(node, visit);
      return;
    }

    const contextProperty = firstArg.properties.find((property) => {
      if (!ts.isPropertyAssignment(property)) {
        return false;
      }
      const name = propertyNameText(property.name);
      return name === 'context' && ts.isObjectLiteralExpression(property.initializer);
    });

    if (!contextProperty || !ts.isPropertyAssignment(contextProperty)) {
      ts.forEachChild(node, visit);
      return;
    }

    scanContextObject({
      sourceFile,
      relativeFile,
      objectLiteral: contextProperty.initializer,
      violations
    });

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

if (!fs.existsSync(srcRoot)) {
  console.error(`Log context check failed: missing source directory ${srcRoot}`);
  process.exit(1);
}

collectTypeScriptFiles(srcRoot);

const violations = [];

for (const relativeFile of files) {
  const absoluteFile = path.join(repoRoot, relativeFile);
  let content;
  try {
    content = fs.readFileSync(absoluteFile, 'utf8');
  } catch (error) {
    console.error(`Log context check failed: cannot read ${relativeFile}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const fileViolations = scanFile(relativeFile, content);
  for (const violation of fileViolations) {
    violations.push(violation);
  }
}

if (violations.length > 0) {
  console.error('Log context check failed: non-canonical `identifier` key found in logging context blocks.');
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}

console.log('Log context check passed');
